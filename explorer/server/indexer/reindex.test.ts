import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { makeDatabase, TEST_URL, checkRequired } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { IndexerStop } from "./errors.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { exportRecords, exportRecordsToFile, readRecords } from "./records.ts";
import { REINDEX_KEY, reindexRange } from "./reindex.ts";

// Everything a test makes is removed by its exact recorded path, and every database and indexer is closed when the test ends, pass or fail.
const dirs: string[] = [];
const files: string[] = [];
const opened: Indexer[] = [];
const databases: Awaited<ReturnType<typeof makeDatabase>>[] = [];
async function newDb(): Promise<Pool> {
  const db = await makeDatabase(true);
  databases.push(db);
  return db.pool;
}
function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "explorer-reindex-"));
  dirs.push(dir);
  const file = join(dir, name);
  files.push(file);
  return file;
}
async function cleanup(): Promise<void> {
  for (const i of opened.splice(0)) await i.close().catch(() => undefined);
  for (const d of databases.splice(0)) await d.drop().catch(() => undefined);
  for (const f of files.splice(0)) rmSync(f, { force: true });
  for (const d of dirs.splice(0)) rmdirSync(d);
}
async function inDb(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    await cleanup();
  }
}

const SHAPES: BlockShape[] = [{ txs: 0 }, { txs: 10, leg: 2 }, { txs: 7 }, { txs: 4, leg: 1 }, { txs: 6 }];
const GATEWAY_CODE = "0x6080604052600a";

async function open(pool: Pool, chain: SyntheticChain, genesisFile?: string): Promise<Indexer> {
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", genesisFile });
  opened.push(indexer);
  await indexer.open();
  return indexer;
}

// What a table holds, without the columns that say when it was written (those are the clock's, not the chain's).
const TABLES: Record<string, string[]> = {
  blocks: ["indexed_at"], block_records: [], proofs: [], transactions: [], tx_hashes: [], logs: [], gateway_legs: [], tx_traces: [], canton_updates: [],
  canton_parties: [], canton_templates: [], canton_synchronizers: ["first_seen"], canton_participants: ["moved_in_at"], tx_lifecycle: ["updated_at"], contracts: [], bytecodes: [],
};
async function snapshot(pool: Pool, tables: string[] = Object.keys(TABLES)): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const r = await pool.query(`select (to_jsonb(x) - $1::text[])::text as j from ${t} x order by j`, [TABLES[t]]);
    out[t] = r.rows.map((x) => x.j as string);
  }
  return out;
}

function genesisFile(accounts: Record<string, { code?: string; balance?: string }>): string {
  const file = scratch("genesis.json");
  writeFileSync(file, JSON.stringify({ config: {}, alloc: accounts }));
  return file;
}

describe.skipIf(!TEST_URL)("reindex, export, rebuild and the genesis contracts, on the pinned PostgreSQL", () => {
  checkRequired();

  it("works a range out again from the stored records and reth: repairs damage, and a second run changes nothing", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      const good = await snapshot(pool);
      expect(good.transactions).toHaveLength(27);
      expect(good.gateway_legs).toHaveLength(2);

      // Damage the facts of blocks 2 and 4, and the block row too; the lifecycle row is the producer's and the reindex must leave it alone.
      await pool.query("delete from logs where block_number in (2, 4)");
      await pool.query("delete from gateway_legs where block_number = 2");
      await pool.query("delete from tx_hashes where block_number = 4");
      await pool.query("update transactions set status = 9, value = 1 where block_number in (2, 3)");
      await pool.query("update blocks set gas_used = 1, tx_count = 99, legs_count = 7 where number = 2");
      await pool.query("update tx_lifecycle set state_reason = 'kept' where final_block = 3");
      const kept = await snapshot(pool, ["tx_lifecycle"]);

      const reads = chain.reads;
      reads.calls.block = 0;
      reads.calls.traces = 0;
      const done = await reindexRange({ pool, reads, gateway: GATEWAY }, 2, 4);
      expect(done).toEqual({ from: 2, to: 4, blocks: 3 });
      expect(reads.calls.block).toBe(3);
      expect(await snapshot(pool, ["tx_lifecycle"])).toEqual(kept);
      // The derive cursor stays where it is, and the range's stage 2 rows are written again with its facts, from reth's traces of those blocks only.
      expect((await pool.query("select position from cursors where stream = 'derive'")).rows[0].position).toBe("5");
      expect(reads.calls.traces).toBe(3);
      await indexer.deriveOnce();
      await pool.query("update tx_lifecycle set state_reason = null where final_block = 3");
      const first = await snapshot(pool);
      expect(first).toEqual(good);

      await reindexRange({ pool, reads, gateway: GATEWAY }, 2, 4);
      await indexer.deriveOnce();
      expect(await snapshot(pool)).toEqual(first);
      // The whole chain, with the head as the default end.
      expect(await reindexRange({ pool, reads, gateway: GATEWAY }, 1, null)).toEqual({ from: 1, to: 5, blocks: 5 });
      await indexer.deriveOnce();
      expect(await snapshot(pool)).toEqual(good);
    });
  }, 60_000);

  it("checks the leg hash of each block it writes (C10), and a degraded row stays degraded", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      const row = async () => (await pool.query("select status, value from health_checks where check_id = 'C10'")).rows[0];
      expect(await row()).toMatchObject({ status: "ok", value: { block: 4 } });

      // Reindexing blocks that agree with the gateway leaves C10 ok.
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, null);
      expect((await row()).status).toBe("ok");

      // Reth now holds another legs[2] than the decoded legs hash to: the reindex reports it, and still writes the block.
      const other = "0x" + "11".repeat(32);
      chain.blocks[1]!.legsHash = other;
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, 3);
      const r = await row();
      expect(r.status).toBe("degraded");
      expect(r.value).toMatchObject({ block: 2, computed: expect.stringMatching(/^0x[0-9a-f]{64}$/), onChain: other });
      expect((await pool.query("select legs_count from blocks where number = 2")).rows[0].legs_count).toBe(1);

      // A later reindex of blocks that agree does not clear it.
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 3, 5);
      expect((await row()).status).toBe("degraded");
    });
  }, 60_000);

  it("refuses a range outside the indexed blocks, a block that reth has another hash for, and another gateway", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      const o = { pool, reads: chain.reads, gateway: GATEWAY };
      await expect(reindexRange(o, 0, 3)).rejects.toThrow(/not within the indexed blocks 1 to 5/);
      await expect(reindexRange(o, 2, 9)).rejects.toThrow(/not within/);
      await expect(reindexRange(o, 4, 2)).rejects.toThrow(/not within/);
      await expect(reindexRange({ ...o, gateway: "0x" + "11".repeat(20) }, 1, 2)).rejects.toThrow(/made for the gateway/);
      const before = await snapshot(pool);
      await pool.query("update blocks set hash = decode($1, 'hex') where number = 3", ["77".repeat(32)]);
      await expect(reindexRange(o, 2, 4)).rejects.toThrow(/block 3: reth's hash is .* another chain instance/);
      await pool.query("update blocks set hash = decode($1, 'hex') where number = 3", [chain.blocks[2]!.block.hash.slice(2)]);
      chain.reads.rethHead = 3;
      await expect(reindexRange(o, 2, 4)).rejects.toThrow(/reth has no block for block 4/);
      // Block 2 and 3 were rewritten with the same rows; the failed block 4 was not touched.
      expect((await snapshot(pool, ["transactions", "logs", "blocks", "gateway_legs"]))).toEqual(Object.fromEntries(["transactions", "logs", "blocks", "gateway_legs"].map((t) => [t, before[t]])));
    });
  }, 60_000);

  it("leaves tx_traces and the derive cursor as they were when a reindex is refused, whatever the reason", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      const before = await snapshot(pool);
      expect(before.tx_traces!.length).toBeGreaterThan(0);
      const cursor = async () => (await pool.query("select position from cursors where stream = 'derive'")).rows[0].position;
      const o = { pool, reads: chain.reads, gateway: GATEWAY };
      chain.reads.rethHead = 0; // reth has no block at all
      await expect(reindexRange(o, 1, null)).rejects.toThrow(/reth has no block for block 1/);
      expect(await snapshot(pool)).toEqual(before);
      expect(await cursor()).toBe("5");
      // Another chain instance behind reth: the hash of block 1 differs.
      chain.reads.rethHead = 5;
      await pool.query("update blocks set hash = decode($1, 'hex') where number = 1", ["77".repeat(32)]);
      await expect(reindexRange(o, 1, null)).rejects.toThrow(/another chain instance/);
      await pool.query("update blocks set hash = decode($1, 'hex') where number = 1", [chain.blocks[0]!.block.hash.slice(2)]);
      // Traces that are not the block's transactions.
      const real = chain.reads.traces;
      chain.reads.traces = async (n) => (n === 2 ? (await real(3)) : real(n));
      await expect(reindexRange(o, 1, null)).rejects.toBeInstanceOf(IndexerStop);
      chain.reads.traces = async (n) => (n === 3 ? null : real(n));
      await expect(reindexRange(o, 3, 3)).rejects.toThrow(/reth has no traces for block 3/);
      chain.reads.traces = real;
      expect(await snapshot(pool)).toEqual(before);
      expect(await cursor()).toBe("5");
    });
  }, 60_000);

  it("writes a block's stage 2 rows again only for blocks in the range and at or below the derive cursor, and never moves the cursor", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      const good = await snapshot(pool);
      const reads = chain.reads;
      const o = { pool, reads, gateway: GATEWAY };
      // Damage the stage 2 rows of block 2, and put the derive cursor at block 3 (blocks 4 and 5 are not derived yet).
      await pool.query("update tx_traces set call_count = 99, revert_reason = 'x' where block_number = 2");
      await pool.query("delete from tx_traces where block_number >= 4");
      await pool.query("update cursors set position = 3 where stream = 'derive'");
      reads.calls.traces = 0;
      await reindexRange(o, 2, 5);
      expect(reads.calls.traces).toBe(2); // blocks 2 and 3 only
      expect((await pool.query("select position from cursors where stream = 'derive'")).rows[0].position).toBe("3");
      expect((await pool.query("select count(*) as n from tx_traces where block_number >= 4")).rows[0].n).toBe("0");
      await indexer.deriveOnce();
      expect(await snapshot(pool)).toEqual(good);
      // A range of one block reads one block's traces.
      reads.calls.traces = 0;
      await reindexRange(o, 1, 1);
      expect(reads.calls.traces).toBe(1);
    });
  }, 60_000);

  it("does not hold the inline indexer behind a catch-up of the chain after the range", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      chain.ledger.ledgerHead = 4;
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, 1);
      chain.reads.calls.traces = 0;
      chain.ledger.ledgerHead = 5;
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 1 });
      expect(chain.reads.calls.traces).toBe(1); // block 5's own, nothing else
      expect((await pool.query("select position from cursors where stream = 'derive'")).rows[0].position).toBe("5");
    });
  }, 60_000);

  it("does not stop the inline indexer when the derive cursor is moved in the gap between its catch-up and its transaction", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      chain.ledger.ledgerHead = 3;
      const indexer0 = await open(pool, chain);
      await indexer0.runOnce();
      await opened.pop()!.close();
      chain.ledger.ledgerHead = 5;
      // A pool whose next connection (the transaction of block 4, after its catch-up has returned) first finds the cursor moved back.
      let armed = false;
      const real = chain.reads.traces;
      let seen = false;
      chain.reads.traces = async (n) => { if (n === 4 && !seen) { seen = true; armed = true; } return real(n); };
      const proxy = new Proxy(pool, {
        get(target, prop) {
          if (prop === "connect") {
            return async () => {
              if (armed) {
                armed = false;
                // Stage 2 put back before block 1, with its rows dropped: a consistent state, as an older reindex left it.
                await target.query("delete from tx_traces");
                await target.query("update cursors set position = 0 where stream = 'derive'");
              }
              return target.connect();
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const indexer = createIndexer({ pool: proxy, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      opened.push(indexer);
      await indexer.open();
      const run = await indexer.runOnce();
      expect(run).toEqual({ state: "caught-up", indexed: 2 });
      expect((await pool.query("select position from cursors where stream = 'derive'")).rows[0].position).toBe("5");
      expect((await pool.query("select count(*) as n from health_checks where status = 'down'")).rows[0].n).toBe("0");
    });
  }, 60_000);

  it("exports one snapshot: a synchronizer made after the export began does not leave a hole in a line", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      await (await open(pool, chain)).runOnce();
      const lines: string[] = [];
      await exportRecords(pool, async (line) => {
        lines.push(line);
        if (lines.length === 2) {
          // The indexer goes on writing: a new synchronizer, and block 5 now points at it.
          await pool.query("insert into canton_synchronizers (synchronizer_id, first_seen) values ('late::sync', now())");
          await pool.query("update canton_updates set synchronizer = (select id from canton_synchronizers where synchronizer_id = 'late::sync') where update_id = (select update_id from blocks where number = 5)");
        }
      }, { pageSize: 2 });
      expect(lines).toHaveLength(6);
      const last = JSON.parse(lines[5]!);
      expect(last.number).toBe(5);
      expect(last.synchronizerId).toBe(chain.blocks[4]!.record.synchronizerId);
      expect(last.synchronizerId).not.toBe("late::sync");
    });
  }, 60_000);

  it("refuses to write a line with a hole in it", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      await (await open(pool, chain)).runOnce();
      const file = scratch("records.jsonl");
      await pool.query("alter table canton_updates drop constraint if exists canton_updates_synchronizer_fkey");
      await pool.query("update canton_updates set synchronizer = 9999 where update_id = (select update_id from blocks where number = 3)");
      await expect(exportRecordsToFile(pool, file)).rejects.toThrow(/block 3: its synchronizer/);
      expect(() => readFileSync(file)).toThrow();
    });
  }, 60_000);

  it("rebuilds from a file with a ledger that cannot be reached", async () => {
    await inDb(async () => {
      const chain = makeChain(SHAPES);
      const poolA = await newDb();
      await (await open(poolA, chain)).runOnce();
      const file = scratch("records.jsonl");
      await exportRecordsToFile(poolA, file);
      const poolB = await newDb();
      const dead = () => { throw new Error("Canton is not reachable"); };
      const ledger = { ...chain.ledger, participantId: dead, ledgerEnd: dead, recordPages: dead } as unknown as typeof chain.ledger;
      const indexer = createIndexer({ pool: poolB, reads: chain.reads, ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      opened.push(indexer);
      await indexer.open();
      expect(await indexer.rebuild(readRecords(file))).toBe(5);
      expect(await snapshot(poolB)).toEqual(await snapshot(poolA));
    });
  }, 60_000);

  it("rebuilds on a database that is ahead of the file without moving its cursor back, and still checks the hashes", async () => {
    await inDb(async () => {
      const chain = makeChain(SHAPES);
      const pool = await newDb();
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      const file = scratch("records.jsonl");
      await exportRecordsToFile(pool, file);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      const short = scratch("short.jsonl");
      writeFileSync(short, lines.slice(0, 4).join("\n") + "\n"); // header and blocks 1 to 3
      const cursor = async () => (await pool.query("select position, detail from cursors where stream = 'reader_updates'")).rows[0];
      const at = await cursor();
      const before = await snapshot(pool);
      expect(await indexer.rebuild(readRecords(short))).toBe(0);
      expect(await cursor()).toEqual(at);
      expect(await snapshot(pool)).toEqual(before);
      // A record with another hash for a block the database holds is the other chain instance's, and stops.
      const wrong = scratch("wrong.jsonl");
      const bad = { ...JSON.parse(lines[2]!), blockHash: "0x" + "77".repeat(32) };
      writeFileSync(wrong, [lines[0], lines[1], JSON.stringify(bad)].join("\n") + "\n");
      await expect(indexer.rebuild(readRecords(wrong))).rejects.toBeInstanceOf(IndexerStop);
    });
  }, 60_000);

  it("pauses the live indexer while a reindex holds the database, and goes on after it", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      chain.ledger.ledgerHead = 2;
      const indexer = await open(pool, chain);
      await indexer.runOnce();
      chain.ledger.ledgerHead = 5;
      const holder = await pool.connect();
      try {
        await holder.query("select pg_advisory_lock($1)", [REINDEX_KEY]);
        expect(await indexer.runOnce()).toEqual({ state: "paused", indexed: 0 });
        expect((await pool.query("select count(*) as n from blocks")).rows[0].n).toBe("2");
        // A second reindex cannot take the lock either, and says so when its wait is over.
        await expect(reindexRange({ pool, reads: chain.reads, gateway: GATEWAY, lockWaitMs: 100 }, 1, 2)).rejects.toThrow(/still holds the reindex lock/);
      } finally {
        await holder.query("select pg_advisory_unlock($1)", [REINDEX_KEY]);
        holder.release();
      }
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 3 });
      expect((await pool.query("select count(*) as n from blocks")).rows[0].n).toBe("5");
    });
  }, 60_000);

  it("exports the stored records and builds a fresh database from the file, with the same rows", async () => {
    await inDb(async () => {
      const chain = makeChain(SHAPES);
      const poolA = await newDb();
      await (await open(poolA, chain)).runOnce();
      const file = scratch("records.jsonl");
      expect(await exportRecordsToFile(poolA, file)).toBe(5);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(6);
      expect(JSON.parse(lines[0]!)).toEqual({ format: "ostia-explorer-records", version: 1, chainId: CHAIN_ID, genesisHash: chain.genesisHash });
      expect(JSON.parse(lines[3]!)).toMatchObject({ number: 3, blockHash: chain.blocks[2]!.record.blockHash, signatories: chain.blocks[2]!.record.signatories, participant: { firstOffset: 0 } });
      await expect(exportRecordsToFile(poolA, file)).rejects.toThrow(); // never over a file that is there

      const poolB = await newDb();
      const rebuilt = await open(poolB, chain);
      expect(await rebuilt.rebuild(readRecords(file))).toBe(5);
      expect(await snapshot(poolB)).toEqual(await snapshot(poolA));
      for (const stream of ["reader_updates", "derive"]) {
        const at = async (p: Pool) => (await p.query("select position, detail from cursors where stream = $1", [stream])).rows[0];
        expect(await at(poolB)).toEqual(await at(poolA));
      }
      expect((await poolB.query("select key, value from meta order by key")).rows).toEqual((await poolA.query("select key, value from meta order by key")).rows);
      // Again on the database that has them: nothing is written twice.
      expect(await rebuilt.rebuild(readRecords(file))).toBe(0);
      expect(await snapshot(poolB)).toEqual(await snapshot(poolA));
    });
  }, 60_000);

  it("builds from an export that is for another chain or another set of pins as a stop, and refuses a file that is not an export", async () => {
    await inDb(async () => {
      const chain = makeChain(SHAPES);
      const poolA = await newDb();
      await (await open(poolA, chain)).runOnce();
      const file = scratch("records.jsonl");
      await exportRecordsToFile(poolA, file);
      const lines = readFileSync(file, "utf8").trim().split("\n");

      // A record that does not follow the chain: block 3 is taken out, so block 4 meets the check on order.
      const gap = scratch("gap.jsonl");
      writeFileSync(gap, [...lines.slice(0, 3), ...lines.slice(4)].join("\n") + "\n");
      const poolB = await newDb();
      const b = await open(poolB, chain);
      await expect(b.rebuild(readRecords(gap))).rejects.toBeInstanceOf(IndexerStop);
      expect((await poolB.query("select status from health_checks where check_id = 'C2'")).rows[0].status).toBe("down");
      expect((await poolB.query("select count(*) as n from blocks")).rows[0].n).toBe("2");

      const other = scratch("other.jsonl");
      writeFileSync(other, [JSON.stringify({ ...JSON.parse(lines[0]!), chainId: 1 }), ...lines.slice(1)].join("\n") + "\n");
      await expect(open(await newDb(), chain).then((i) => i.rebuild(readRecords(other)))).rejects.toThrow(/for chain 1/);

      const junk = scratch("junk.jsonl");
      writeFileSync(junk, '{"hello":1}\n');
      await expect(open(await newDb(), chain).then((i) => i.rebuild(readRecords(junk)))).rejects.toThrow(/not an export of block records/);
      const torn = scratch("torn.jsonl");
      writeFileSync(torn, lines.slice(0, 2).join("\n") + '\n{"number": 2\n');
      await expect(open(await newDb(), chain).then((i) => i.rebuild(readRecords(torn)))).rejects.toThrow(/line 3: /);
      const empty = scratch("empty.jsonl");
      writeFileSync(empty, "");
      await expect((async () => { for await (const _ of readRecords(empty)) { /* none */ } })()).rejects.toThrow(/empty/);
    });
  }, 60_000);

  it("keeps a failed export from leaving a file that looks finished", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const file = scratch("records.jsonl");
      await expect(exportRecordsToFile(pool, file)).rejects.toThrow(/nothing to export/);
      expect(() => readFileSync(file)).toThrow();
      expect(() => readFileSync(`${file}.partial`)).toThrow();
    });
  }, 30_000);

  it("seeds the genesis contracts at first start, the gateway among them, with origin genesis and no creator", async () => {
    await inDb(async () => {
      const pool = await newDb();
      const chain = makeChain(SHAPES);
      const SYSTEM = "0x" + "00".repeat(19) + "01";
      chain.reads.codes[GATEWAY] = GATEWAY_CODE;
      chain.reads.codes[SYSTEM] = "0x3373fffe";
      // The keys are written the way genesis files write them: without 0x, in any case. An account with no code is not a contract.
      const file = genesisFile({ [GATEWAY.slice(2).toUpperCase()]: { code: GATEWAY_CODE, balance: "0x0" }, [SYSTEM]: { code: "0x3373FFFE" }, ["0x" + "bb".repeat(20)]: { balance: "0x5" } });
      await open(pool, chain, file);
      const rows = (await pool.query("select '0x' || encode(address, 'hex') as address, origin, creator, creation_block, creation_tx_index, runtime_code_hash, creation_code_hash, verified_source, interaction_count from contracts order by address")).rows;
      expect(rows.map((r) => r.address)).toEqual([SYSTEM, GATEWAY]);
      const gateway = rows[1];
      expect(gateway).toMatchObject({ origin: "genesis", creator: null, creation_block: null, creation_tx_index: null, creation_code_hash: null, verified_source: null, interaction_count: "0" });
      expect("0x" + (gateway.runtime_code_hash as Buffer).toString("hex")).toBe(keccak256(GATEWAY_CODE as `0x${string}`));
      const code = (await pool.query("select code, size from bytecodes where code_hash = $1", [gateway.runtime_code_hash])).rows[0];
      expect(`0x${(code.code as Buffer).toString("hex")}`).toBe(GATEWAY_CODE);
      expect(code.size).toBe(7);
      expect((await pool.query("select value from meta where key = 'genesis_seeded'")).rows[0].value).toBe("2");

      // Once: a later start reads nothing from reth and writes nothing.
      await opened.pop()!.close();
      chain.reads.calls.code = 0;
      await open(pool, chain, file);
      expect(chain.reads.calls.code ?? 0).toBe(0);
      expect((await pool.query("select count(*) as n from contracts")).rows[0].n).toBe("2");
    });
  }, 30_000);

  it("stops at first start when the genesis file is not what reth holds, or has no gateway", async () => {
    await inDb(async () => {
      const chain = makeChain(SHAPES);
      chain.reads.codes[GATEWAY] = "0x6080";
      const wrong = genesisFile({ [GATEWAY]: { code: GATEWAY_CODE } });
      const pool = await newDb();
      await expect(open(pool, chain, wrong)).rejects.toThrow(/not the code reth holds at block 0/);
      expect((await pool.query("select status, detail from health_checks where check_id = 'genesis'")).rows[0]).toMatchObject({ status: "down" });
      expect((await pool.query("select count(*) as n from contracts")).rows[0].n).toBe("0");
      expect((await pool.query("select count(*) as n from meta where key = 'genesis_seeded'")).rows[0].n).toBe("0");

      const noGateway = genesisFile({ ["0x" + "00".repeat(19) + "01"]: { code: "0x3373fffe" } });
      const pool2 = await newDb();
      await expect(open(pool2, chain, noGateway)).rejects.toThrow(/no code at the gateway's address/);
      const pool3 = await newDb();
      const broken = scratch("broken.json");
      writeFileSync(broken, "{");
      await expect(open(pool3, chain, broken)).rejects.toThrow(/cannot be read/);
    });
  }, 30_000);
});
