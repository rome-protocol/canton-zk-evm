import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { RethError } from "../reth.ts";
import { createIndexer, type DeriveShape, type Indexer, type Timing } from "./indexer.ts";
import { reindexRange } from "./reindex.ts";

// Every indexer a test opens is closed when the test ends, pass or fail: an open one holds the advisory lock, and the database cannot be dropped
// until it is released, so a failed assertion would otherwise end as a timeout with its message lost.
const opened: Indexer[] = [];
async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    try {
      await fn(pool);
    } finally {
      for (const i of opened.splice(0)) await i.close().catch(() => undefined);
    }
  });
}

async function setup(pool: Pool, shapes: BlockShape[], derive: DeriveShape = "inline", over: Partial<Parameters<typeof createIndexer>[0]> = {}) {
  await migrate(pool);
  const chain = makeChain(shapes);
  const timings: Timing[] = [];
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive, onTiming: (t) => timings.push(t), ...over });
  opened.push(indexer);
  await indexer.open();
  return { chain, indexer, timings };
}

async function count(pool: Pool, table: string): Promise<number> {
  return Number((await pool.query(`select count(*) as n from ${table}`)).rows[0].n);
}
const TABLES = ["blocks", "block_records", "proofs", "transactions", "tx_hashes", "tx_lifecycle", "logs", "gateway_legs", "canton_updates", "tx_traces"];
async function counts(pool: Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await count(pool, t);
  return out;
}
const cursor = async (pool: Pool, stream: string): Promise<number | null> => {
  const r = await pool.query("select position from cursors where stream = $1", [stream]);
  return r.rowCount ? Number(r.rows[0].position) : null;
};
const health = async (pool: Pool, id: string) => (await pool.query("select status, detail, value from health_checks where check_id = $1", [id])).rows[0];
const logsOf = (c: SyntheticChain, i: number) => c.blocks[i]!.receipts.reduce((x, y) => x + y.logs.length, 0);

describe.skipIf(!TEST_URL)("the indexer's write path, on the pinned PostgreSQL", () => {
  checkRequired();

  it("writes each final block whole, with its cursor, and the checks' rows say ok", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 0 }, { txs: 10, leg: 2 }, { txs: 7 }]);
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 3 });
      const logs = logsOf(chain, 0) + logsOf(chain, 1) + logsOf(chain, 2);
      expect(await counts(pool)).toMatchObject({ blocks: 3, block_records: 3, proofs: 3, transactions: 17, tx_hashes: 17, tx_lifecycle: 17, logs, gateway_legs: 1, canton_updates: 3 });
      expect(await cursor(pool, "reader_updates")).toBe(30);
      expect(await cursor(pool, "derive")).toBe(3);
      for (const id of ["C1", "C2", "C3", "C7"]) expect((await health(pool, id)).status).toBe("ok");
      const b = (await pool.query("select tx_count, log_count, legs_count, encode(legs_hash, 'hex') as lh from blocks where number = 2")).rows[0];
      expect(b).toMatchObject({ tx_count: 10, legs_count: 1, lh: (chain.blocks[1]!.legsHash as string).slice(2), log_count: logsOf(chain, 1) });
      await indexer.close();
    });
  });

  it("changes nothing when a block is read again, and moves the cursor past it", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, [{ txs: 12, leg: 1 }, { txs: 5 }]);
      await indexer.runOnce();
      const before = await counts(pool);
      await pool.query("update cursors set position = 0, detail = null where stream = 'reader_updates'");
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 2 });
      expect(await counts(pool)).toEqual(before);
      expect(await cursor(pool, "reader_updates")).toBe(20);
      expect(await cursor(pool, "derive")).toBe(2);
      await indexer.close();
    });
  });

  it("leaves nothing of a block that was cut off in the middle, and the cursor where it was", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, [{ txs: 3 }, { txs: 20 }]);
      // The connection dies at the logs of block 2, after its transactions went in.
      let killed = false;
      // `pool.query` calls `connect` with a callback; only the promise form, which the indexer's transactions use, is wrapped.
      const realConnect = pool.connect.bind(pool) as (cb?: unknown) => Promise<PoolClient>;
      (pool as unknown as { connect: (cb?: unknown) => Promise<PoolClient> | void }).connect = (cb?: unknown) => {
        if (cb) return realConnect(cb) as unknown as void;
        return realConnect().then((c) => wrap(c));
      };
      const wrap = (c: PoolClient): PoolClient => {
        const q = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = (...a: unknown[]) => {
          const sql = typeof a[0] === "string" ? a[0] : "";
          if (!killed && sql.includes("insert into logs") && (a[1] as unknown[])[0] === 2) { killed = true; return Promise.reject(new Error("connection terminated")); }
          return q(...a);
        };
        return c;
      };
      await expect(indexer.runOnce()).rejects.toThrow("connection terminated");
      expect(killed).toBe(true);
      expect(await counts(pool)).toMatchObject({ blocks: 1, transactions: 3, tx_hashes: 3, canton_updates: 1 });
      expect(await cursor(pool, "reader_updates")).toBe(10);
      // Started again, it writes block 2 and counts it once.
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 1 });
      expect(await counts(pool)).toMatchObject({ blocks: 2, transactions: 23, tx_hashes: 23, tx_lifecycle: 23, canton_updates: 2 });
      await indexer.close();
    });
  });

  it("waits when reth is behind, and goes on when reth has the block", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 2 }, { txs: 2 }, { txs: 2 }]);
      chain.reads.rethHead = 1;
      expect(await indexer.runOnce()).toEqual({ state: "reth-behind", indexed: 1 });
      expect((await counts(pool)).blocks).toBe(1);
      expect(await cursor(pool, "reader_updates")).toBe(10);
      chain.reads.rethHead = 3;
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 2 });
      expect((await counts(pool)).blocks).toBe(3);
      await indexer.close();
    });
  });

  it("stops at a gap (C2), writes the check as down, and stays stopped", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }, { txs: 1 }]);
      const all = chain.ledger.recordPages;
      chain.ledger.recordPages = async function* (a: number, u: number) {
        for await (const page of all(a, u)) yield page.filter((r) => r.number !== 2);
      };
      const r = await indexer.runOnce();
      expect(r.state).toBe("stopped");
      if (r.state !== "stopped") return;
      expect(r.stop.check).toBe("C2");
      expect(r.stop.block).toBe(3);
      expect(r.indexed).toBe(1);
      expect((await counts(pool)).blocks).toBe(1);
      expect(await cursor(pool, "reader_updates")).toBe(10);
      const h = await health(pool, "C2");
      expect(h.status).toBe("down");
      expect(h.detail).toContain("gap");
      chain.ledger.recordPages = all;
      expect((await indexer.runOnce()).state).toBe("stopped");
      expect((await counts(pool)).blocks).toBe(1);
      await indexer.close();
    });
  });

  async function stopsOn(tamper: (c: SyntheticChain) => void, check: string) {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 3 }, { txs: 3 }]);
      tamper(chain);
      const r = await indexer.runOnce();
      expect(r.state).toBe("stopped");
      if (r.state !== "stopped") return;
      expect(r.stop.check).toBe(check);
      expect(r.stop.block).toBe(2);
      expect(await counts(pool)).toMatchObject({ blocks: 1, transactions: 3, logs: logsOf(chain, 0) });
      expect(await cursor(pool, "reader_updates")).toBe(10);
      expect((await health(pool, check)).status).toBe("down");
      await indexer.close();
    });
  }

  it("stops at C1 when reth's hash is not the record's", () => stopsOn((c) => { c.blocks[1]!.block.hash = "0x" + "de".repeat(32); }, "C1"));
  it("stops at C1 when the record's hash is not the Keccak of its header", () => stopsOn((c) => { c.blocks[1]!.record.headerHex += "00"; }, "C1"));
  it("stops at C2 when the record's parent is not the last indexed hash", () => stopsOn((c) => { c.blocks[1]!.record.parentHash = "0x" + "ab".repeat(32); }, "C2"));
  it("stops at C3 when the record's transactions are not reth's", () => stopsOn((c) => { const t = c.blocks[1]!.block.transactions; [t[0], t[1]] = [t[1]!, t[0]!]; }, "C3"));
  it("stops at C3 when reth's receipts are not those of its transactions", () => stopsOn((c) => { c.blocks[1]!.receipts.pop(); }, "C3"));
  it("stops at C7 when the proof's program key is not the pin", () => stopsOn((c) => {
    const r = c.blocks[1]!.record;
    r.proofHex = r.proofHex.slice(0, 1536) + "ff".repeat(32) + r.proofHex.slice(1600);
  }, "C7"));

  // A chain that switches program at block 2: blocks before it are checked under the first key, blocks from it under the second.
  const KEY2 = { fromBlock: 2, programVK: "0x" + "c3".repeat(32), rootC: "0x" + "d4".repeat(32), zisk: "1.3.1" as const };
  const RANGED = { ...PINS, programVK: KEY2.programVK, rootC: KEY2.rootC, keys: [...PINS.keys, KEY2] };
  const proveUnder = (c: SyntheticChain, i: number, k: { programVK: string; rootC: string }) => {
    const r = c.blocks[i]!.record;
    r.proofHex = r.proofHex.slice(0, 1536) + k.programVK.slice(2) + k.rootC.slice(2) + r.proofHex.slice(1664);
  };

  it("checks each block under the key for its height", () => inDb(async (pool) => {
    const { chain, indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }], "inline", { pins: RANGED });
    proveUnder(chain, 1, KEY2); // block 1 keeps the first key, block 2 is proven under the second
    expect((await indexer.runOnce()).state).not.toBe("stopped");
    expect((await counts(pool)).blocks).toBe(2);
    expect((await pool.query("select number, matches_pins from proofs order by number")).rows).toEqual([{ number: "1", matches_pins: true }, { number: "2", matches_pins: true }]);
    await indexer.close();
  }));

  it("stops at C7 for a block proven under the first key at a height of the second", () => inDb(async (pool) => {
    const { chain, indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }], "inline", { pins: RANGED });
    const r = await indexer.runOnce(); // block 2 still carries the first key
    expect(chain.blocks[1]!.record.proofHex.slice(1536, 1600)).toBe(PINS.programVK.slice(2));
    expect(r.state).toBe("stopped");
    if (r.state === "stopped") expect([r.stop.check, r.stop.block]).toEqual(["C7", 2]);
    expect((await counts(pool)).blocks).toBe(1);
    await indexer.close();
  }));

  it("stops at C7 for a block proven under the second key before the switch", () => inDb(async (pool) => {
    const { chain, indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }], "inline", { pins: RANGED });
    proveUnder(chain, 0, KEY2);
    proveUnder(chain, 1, KEY2);
    const r = await indexer.runOnce();
    expect(r.state).toBe("stopped");
    if (r.state === "stopped") expect([r.stop.check, r.stop.block]).toEqual(["C7", 1]);
    await indexer.close();
  }));

  it("does not make an existing database another chain's when a key is added to the pins", () => inDb(async (pool) => {
    const { indexer } = await setup(pool, [{ txs: 1 }]);
    await indexer.close();
    const again = createIndexer({ pool, reads: makeChain([{ txs: 1 }]).reads, ledger: makeChain([{ txs: 1 }]).ledger, pins: RANGED, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    opened.push(again);
    await again.open();
    await again.close();
  }));

  it("refuses a database made for other pins", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }]);
      await indexer.close();
      const other = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: { ...PINS, keys: [{ ...PINS.keys[0]!, programVK: "0x" + "01".repeat(32) }] }, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      await expect(other.open()).rejects.toThrow("program_vk");
      await other.close();
    });
  });

  it("refuses a second indexer for one database", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }]);
      const second = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      await expect(second.open()).rejects.toThrow("another indexer");
      await indexer.close();
      await second.open();
      await second.close();
    });
  });

  it("in the inline shape, writes both stages in one transaction: a block never shows without its traces", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 10 }, { txs: 10 }]);
      // The traces of block 2 are not those of its transactions: stage 2 stops, so stage 1's rows of block 2 go too.
      chain.blocks[1]!.traces.pop();
      const r = await indexer.runOnce();
      expect(r.state).toBe("stopped");
      if (r.state === "stopped") expect(r.stop.check).toBe("derive");
      expect((await counts(pool)).blocks).toBe(1);
      expect(await cursor(pool, "derive")).toBe(1);
      expect(await cursor(pool, "reader_updates")).toBe(10);
      await indexer.close();
    });
  });

  it("in the behind shape, stage 1 does not wait for stage 2, which catches up on its own cursor", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 10 }, { txs: 10 }], "behind");
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 2 });
      expect(chain.reads.calls.traces ?? 0).toBe(0);
      expect(await cursor(pool, "derive")).toBe(0);
      expect((await counts(pool)).tx_traces).toBe(0);
      expect(await indexer.deriveOnce()).toEqual({ state: "caught-up", indexed: 2 });
      expect(await cursor(pool, "derive")).toBe(2);
      const before = await counts(pool);
      expect(await indexer.deriveOnce()).toEqual({ state: "caught-up", indexed: 0 });
      expect(await counts(pool)).toEqual(before);
      await indexer.close();
    });
  });

  it("keeps the revert data of a failed transaction, with the reason decoded, and the call count of the others", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 10 }]);
      await indexer.runOnce();
      const rows = (await pool.query("select tx_index, call_count, encode(revert_data, 'hex') as data, revert_reason from tx_traces where block_number = 1 order by tx_index")).rows;
      // The kinds cycle every five: 3 is a call with inner calls, 4 fails.
      expect(rows.map((r) => r.tx_index)).toEqual([3, 4, 8, 9]);
      expect(rows[0]).toMatchObject({ call_count: 3, data: null, revert_reason: null });
      expect(rows[1]).toMatchObject({ call_count: 0, revert_reason: "not allowed" });
      expect(rows[1].data).toBe(chain.blocks[0]!.traces[4]!.output.slice(2));
      await indexer.close();
    });
  });

  it("decodes the gateway's Leg logs into gateway_legs", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, [{ txs: 3, leg: 2 }]);
      await indexer.runOnce();
      const r = (await pool.query("select kind, tx_index, log_index, amount::text as amount, party from gateway_legs")).rows;
      expect(r).toEqual([{ kind: 2, tx_index: 0, log_index: 0, amount: "42", party: "alice::1220" + "ab".repeat(32) }]);
      await indexer.close();
    });
  });

  it("keeps the blocks of the pages it read when a later page fails, and the next look goes on from there", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }, { txs: 1 }, { txs: 1 }, { txs: 1 }]);
      chain.ledger.pageSize = 2;
      chain.ledger.failAfterPages = 2;
      await expect(indexer.runOnce()).rejects.toThrow("Canton timed out");
      expect((await counts(pool)).blocks).toBe(4);
      expect(await cursor(pool, "reader_updates")).toBe(40);
      chain.ledger.failAfterPages = null;
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 1 });
      expect((await counts(pool)).blocks).toBe(5);
      await indexer.close();
    });
  });

  it("reads a page only after the records of the page before are written", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }, { txs: 1 }]);
      chain.ledger.pageSize = 1;
      const pages = chain.ledger.recordPages;
      const written: number[] = [];
      chain.ledger.recordPages = async function* (a: number, u: number) {
        for await (const page of pages(a, u)) {
          written.push(await count(pool, "blocks"));
          yield page;
        }
      };
      await indexer.runOnce();
      expect(written).toEqual([0, 1, 2]);
      await indexer.close();
    });
  });

  it("stops between records when told to stop, without waiting for the backlog", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }, { txs: 1 }, { txs: 1 }], "inline", { pollMs: 20 });
      chain.ledger.pageSize = 1;
      const halt = indexer.start();
      const stop = halt();
      await stop;
      expect((await counts(pool)).blocks).toBeLessThan(4);
      await indexer.close();
    });
  });

  it("records an undecodable Leg as C10 degraded, naming the block, and goes on without that block's legs", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 2, leg: 1 }, { txs: 2 }]);
      chain.blocks[0]!.receipts[0]!.logs[0]!.data = "0x1234";
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 2 });
      expect((await counts(pool)).blocks).toBe(2);
      expect((await counts(pool)).gateway_legs).toBe(0);
      // The row still says what the chain says: the gateway wrote one Leg, and legs[1] is read.
      const row = (await pool.query("select legs_count, legs_hash is not null as has_hash from blocks where number = 1")).rows[0];
      expect(row).toEqual({ legs_count: 1, has_hash: true });
      const h = await health(pool, "C10");
      expect(h.status).toBe("degraded");
      expect(h.detail).toContain("block 1");
      expect(h.value).toMatchObject({ block: 1 });
      await indexer.close();
    });
  });

  it("clears a stopped row once the indexer passes what it stopped at", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, [{ txs: 1 }, { txs: 1 }]);
      for (const id of ["record", "derive", "participant", "C1"]) {
        await pool.query("insert into health_checks (check_id, status, value, changed_at, checked_at, detail) values ($1, 'down', null, now(), now(), 'stopped')", [id]);
      }
      await indexer.runOnce();
      for (const id of ["record", "derive", "participant", "C1"]) expect((await health(pool, id)).status).toBe("ok");
      await indexer.close();
    });
  });

  it("clears the pins row when the indexer is started again with the pins the database was made for", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }]);
      await indexer.close();
      const other = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: { ...PINS, keys: [{ ...PINS.keys[0]!, programVK: "0x" + "01".repeat(32) }] }, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      await expect(other.open()).rejects.toThrow("program_vk");
      await other.close();
      expect((await health(pool, "pins")).status).toBe("down");
      const again = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      await again.open();
      expect((await health(pool, "pins")).status).toBe("ok");
      await again.close();
    });
  });

  it("writes reth_reads as degraded, with the method and the message, after repeated read errors, and ok when they stop", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }], "inline", { pollMs: 20, readErrorsBeforeDegraded: 2 });
      const traces = chain.reads.traces;
      chain.reads.traces = async () => { throw new RethError('trace_replayBlockTransactions: reth answered "Method not found"', true); };
      const halt = indexer.start();
      const until = async (status: string) => {
        for (let i = 0; i < 100; i++) {
          const h = await health(pool, "reth_reads");
          if (h?.status === status) return h;
          await new Promise((ok) => setTimeout(ok, 30));
        }
        throw new Error(`reth_reads never became ${status}`);
      };
      const h = await until("degraded");
      expect(h.detail).toContain("trace_replayBlockTransactions");
      expect(h.detail).toContain("Method not found");
      chain.reads.traces = traces;
      await until("ok");
      await halt();
      expect((await counts(pool)).blocks).toBe(1);
      await indexer.close();
    });
  });

  it("in the behind shape, reports a stage 2 read that keeps failing as a steady degraded row, not one that flaps with stage 1's good looks", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, [{ txs: 1 }], "behind", { pollMs: 10, readErrorsBeforeDegraded: 2 });
      const traces = chain.reads.traces;
      chain.reads.traces = async () => { throw new RethError("trace_replayBlockTransactions: the replay timed out", true); };
      const halt = indexer.start();
      const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
      for (let i = 0; i < 100 && (await health(pool, "reth_reads"))?.status !== "degraded"; i++) await wait(20);
      expect((await health(pool, "reth_reads")).status).toBe("degraded");
      // Many looks of stage 1 go by with the trace read still failing; the row stays degraded the whole time.
      for (let i = 0; i < 15; i++) {
        await wait(15);
        expect((await health(pool, "reth_reads")).status).toBe("degraded");
      }
      chain.reads.traces = traces;
      for (let i = 0; i < 100 && (await health(pool, "reth_reads")).status !== "ok"; i++) await wait(20);
      expect((await health(pool, "reth_reads")).status).toBe("ok");
      await halt();
      await indexer.close();
    });
  });
});

// The budgets of docs/DESIGN.md, Budgets (B1, B2) against the fakes: L1. Each size is a chain of one block on a database of its own.
describe.skipIf(!TEST_URL)("L1: synthetic blocks within the ingestion budgets", () => {
  checkRequired();

  for (const txs of [0, 100, 1428, 5000]) {
    it(`indexes a block of ${txs} transactions inside B1 and B2, and writes every row`, async () => {
      await inDb(async (pool) => {
        const { chain, indexer, timings } = await setup(pool, [{ txs, leg: 1 }], "behind");
        expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 1 });
        expect(await indexer.deriveOnce()).toEqual({ state: "caught-up", indexed: 1 });
        expect(await counts(pool)).toMatchObject({ blocks: 1, transactions: txs, tx_hashes: txs, tx_lifecycle: txs, logs: logsOf(chain, 0) });
        const stage1 = timings.find((t) => t.stage === 1)!;
        const stage2 = timings.find((t) => t.stage === 2)!;
        await indexer.close();
        console.log(`L1 ${txs} txs: stage 1 ${stage1.writeMs} ms (reads ${stage1.readMs} ms), stage 2 ${stage2.writeMs} ms, ${logsOf(chain, 0)} logs`);
        // B1: stage 1 within 1.0 s up to 1,428 transactions and 3 s above. B2: both stages' writes within 2.0 s.
        expect(stage1.writeMs).toBeLessThan(txs > 1428 ? 3000 : 1000);
        expect(stage1.writeMs + stage2.writeMs).toBeLessThan(2000);
      });
    }, 60_000);
  }

  // B2: a re-index runs at 2,500 transactions a second or more. The rate is of the whole range: the reads, the checks and the rewrite of every row.
  it("L1: re-indexes at 2,500 transactions a second or more (B2)", async () => {
    await inDb(async (pool) => {
      const txs = 5000;
      const { chain, indexer } = await setup(pool, [{ txs, leg: 1 }], "behind");
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 1 });
      expect(await indexer.deriveOnce()).toEqual({ state: "caught-up", indexed: 1 });
      await indexer.close();
      const before = await counts(pool);
      const started = performance.now();
      expect(await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, null)).toEqual({ from: 1, to: 1, blocks: 1 });
      const seconds = (performance.now() - started) / 1000;
      console.log(`L1 re-index ${txs} txs: ${Math.round(seconds * 1000)} ms, ${Math.round(txs / seconds)} txs/s`);
      expect(await counts(pool)).toEqual(before);
      expect(txs / seconds).toBeGreaterThanOrEqual(2500);
    });
  }, 60_000);
});
