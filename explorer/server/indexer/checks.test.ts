import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import type { BlockRecord } from "../ledger.ts";
import { advisoryLeader, FAUCET_LOCK, TRACKER_LOCK } from "../leader.ts";
import { clearCheck, readerMoved, resetChain } from "./admin.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { legHash } from "./legs.ts";

const opened: Indexer[] = [];
async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    try {
      await migrate(pool);
      await fn(pool);
    } finally {
      for (const i of opened.splice(0)) await i.close().catch(() => undefined);
    }
  });
}

type Ledger = SyntheticChain["ledger"];
/** The Ledger API of another participant (or of a reset network): `from` is the first block it has, `shift` moves every offset. */
function ledgerView(chain: SyntheticChain, o: { participant?: string; from?: number; shift?: number } = {}): Ledger {
  const records = chain.blocks.map((b) => ({ ...b.record, offset: b.record.offset + (o.shift ?? 0) }) as BlockRecord).filter((r) => r.number >= (o.from ?? 1));
  const view = {
    ledgerHead: 0,
    ledgerEnd: async () => Math.max(0, ...records.map((r) => r.offset)),
    participantId: async () => o.participant ?? (await chain.ledger.participantId()),
    recordPages: async function* (after: number, upTo: number) { yield records.filter((r) => r.offset > after && r.offset <= upTo); },
    call: async () => { throw new Error("not used"); },
  };
  return view as unknown as Ledger;
}

async function start(pool: Pool, chain: SyntheticChain, over: Partial<Parameters<typeof createIndexer>[0]> = {}): Promise<Indexer> {
  const ix = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", ...over });
  opened.push(ix);
  await ix.open();
  return ix;
}
const row = async (pool: Pool, id: string) => (await pool.query("select status, value, threshold, detail from health_checks where check_id = $1", [id])).rows[0];
const meta = async (pool: Pool, key: string) => (await pool.query("select value from meta where key = $1", [key])).rows[0]?.value as string | undefined;
const blocks = async (pool: Pool) => Number((await pool.query("select count(*) as n from blocks")).rows[0].n);
const shapes = (n: number): BlockShape[] => Array.from({ length: n }, () => ({ txs: 2 }));
const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);
const at = (block: number, plusMs: number) => T0 + block * 3000 + plusMs;

describe("the leg hash", () => {
  it("is the formula of gateway/README.md, from 32 zero bytes, leg after leg", () => {
    const chain = makeChain([{ txs: 1, leg: 2 }]);
    const l = { kind: 2, id: "0x" + "01".repeat(32), token: "0x" + "00".repeat(18) + "d0" + "00", account: "0x" + "00".repeat(17) + "0a11ce", amount: 42n, party: "alice::1220" + "ab".repeat(32) };
    expect(legHash([l])).toBe(chain.blocks[0]!.legsHash);
    expect(legHash([])).toBe("0x" + "00".repeat(32));
    expect(legHash([l, l])).not.toBe(legHash([l]));
  });
});

describe.skipIf(!TEST_URL)("C10: the leg hash worked out again", () => {
  checkRequired();

  it("is ok for a block whose legs hash to legs[N], and its row says which block", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 2 }, { txs: 3, leg: 1 }, { txs: 1, leg: 3 }]);
      const ix = await start(pool, chain);
      await ix.runOnce();
      expect(await row(pool, "C10")).toMatchObject({ status: "ok", value: { block: 3 } });
    });
  });

  it("is degraded, naming the block, when legs[N] differs, and the block is still written", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 2, leg: 1 }, { txs: 2 }, { txs: 1, leg: 2 }]);
      chain.blocks[0]!.legsHash = "0x" + "11".repeat(32);
      const ix = await start(pool, chain);
      expect(await ix.runOnce()).toEqual({ state: "caught-up", indexed: 3 });
      const r = await row(pool, "C10");
      expect(r.status).toBe("degraded");
      expect(r.detail).toContain("block 1");
      expect(r.value).toMatchObject({ block: 1, computed: expect.stringMatching(/^0x[0-9a-f]{64}$/), onChain: "0x" + "11".repeat(32) });
      expect(await blocks(pool)).toBe(3);
      // A later block that agrees does not wipe the report of the old one.
      expect((await row(pool, "C10")).status).toBe("degraded");
    });
  });

  it("is not looked at for a block with no legs", async () => {
    await inDb(async (pool) => {
      const chain = makeChain(shapes(2));
      const ix = await start(pool, chain);
      await ix.runOnce();
      expect(chain.reads.calls.storageAt ?? 0).toBe(0);
      await ix.checkOnce();
      expect((await row(pool, "C10")).status).toBe("ok");
    });
  });
});

describe.skipIf(!TEST_URL)("C4 heads and C5 index lag", () => {
  checkRequired();

  it("C4 is ok when reth's finalized is the newest record, or one behind, and degraded once it is more behind for over 2 s", async () => {
    await inDb(async (pool) => {
      let now = at(5, 0);
      const chain = makeChain(shapes(5));
      const ix = await start(pool, chain, { now: () => now });
      await ix.runOnce();
      await ix.checkOnce();
      expect(await row(pool, "C4")).toMatchObject({ status: "ok", value: { finalized: 5, newest: 5 }, threshold: { behindBlocks: 1, forMs: 2000 } });
      chain.reads.rethFinalized = 4;
      now += 10_000;
      await ix.checkOnce();
      expect((await row(pool, "C4")).status).toBe("ok");
      chain.reads.rethFinalized = 3;
      await ix.checkOnce();
      expect((await row(pool, "C4")).status).toBe("ok"); // seen for the first time
      now += 1500;
      await ix.checkOnce();
      expect((await row(pool, "C4")).status).toBe("ok");
      now += 1000;
      await ix.checkOnce();
      expect(await row(pool, "C4")).toMatchObject({ status: "degraded", value: { finalized: 3, newest: 5 } });
      chain.reads.rethFinalized = 5;
      await ix.checkOnce();
      expect((await row(pool, "C4")).status).toBe("ok");
    });
  });

  it("C5 is ok when caught up, degraded past 5 s and down past 30 s behind the newest record, with the lag in blocks and seconds", async () => {
    await inDb(async (pool) => {
      let now = at(1, 100);
      const chain = makeChain(shapes(3));
      chain.reads.rethHead = 1;
      const ix = await start(pool, chain, { now: () => now });
      expect(await ix.runOnce()).toEqual({ state: "reth-behind", indexed: 1 });
      await ix.checkOnce();
      // Block 2's record became readable at at(2, 0); block 3 is behind it, so the lag is two blocks.
      now = at(2, 4000);
      await ix.checkOnce();
      expect(await row(pool, "C5")).toMatchObject({ status: "ok", value: { lagBlocks: 2, lagSeconds: 4 }, threshold: { degradedSeconds: 5, downSeconds: 30 } });
      now = at(2, 6000);
      await ix.checkOnce();
      expect(await row(pool, "C5")).toMatchObject({ status: "degraded", value: { lagBlocks: 2, lagSeconds: 6 } });
      now = at(2, 31_000);
      await ix.checkOnce();
      expect((await row(pool, "C5")).status).toBe("down");
      chain.reads.rethHead = 3;
      await ix.runOnce();
      await ix.checkOnce();
      expect(await row(pool, "C5")).toMatchObject({ status: "ok", value: { lagBlocks: 0, lagSeconds: 0 } });
    });
  });

  it("writes a row for every check the indexer runs, with the severity it is ok at, and the derive lag is degraded past 60 s", async () => {
    await inDb(async (pool) => {
      const chain = makeChain(shapes(3));
      const ix = await start(pool, chain, { derive: "behind" });
      await ix.runOnce();
      await ix.checkOnce();
      for (const id of ["C1", "C2", "C3", "C4", "C5", "C7", "C10", "derive_lag"]) expect((await row(pool, id))?.status, id).toBe("ok");
      expect((await row(pool, "derive_lag")).threshold).toMatchObject({ degradedSeconds: 60 });
      await pool.query("update blocks set indexed_at = now() - interval '90 seconds' where number = 1");
      await ix.checkOnce();
      expect(await row(pool, "derive_lag")).toMatchObject({ status: "degraded", value: { blocks: 3, seconds: expect.any(Number) } });
      await ix.deriveOnce();
      await ix.checkOnce();
      expect((await row(pool, "derive_lag")).status).toBe("ok");
    });
  });
});

describe.skipIf(!TEST_URL)("the chain instance guard", () => {
  checkRequired();

  async function indexedA(pool: Pool) {
    const a = makeChain(shapes(3));
    const ix = await start(pool, a);
    await ix.runOnce();
    await ix.close();
    return a;
  }
  const untouched = async (pool: Pool) => {
    expect(await blocks(pool)).toBe(3);
    expect(Number((await pool.query("select position from cursors where stream = 'reader_updates'")).rows[0].position)).toBe(30);
  };

  it("keeps the update id of block 1's record as chain_instance, once", async () => {
    await inDb(async (pool) => {
      const a = await indexedA(pool);
      expect(await meta(pool, "chain_instance")).toBe(a.blocks[0]!.record.updateId);
      const ix = await start(pool, a);
      await pool.query("update cursors set position = 0, detail = null where stream = 'reader_updates'");
      await ix.runOnce();
      expect(await meta(pool, "chain_instance")).toBe(a.blocks[0]!.record.updateId);
    });
  });

  it("(a) stops with down when reth's hash at the indexed head is not the indexed one, and wipes nothing", async () => {
    await inDb(async (pool) => {
      await indexedA(pool);
      const b = makeChain(shapes(3), PINS, 1); // the same genesis, chain id and pins, other blocks
      const ix = await start(pool, b, { ledger: ledgerView(b, { shift: 100 }) });
      const r = await ix.runOnce();
      expect(r.state).toBe("stopped");
      expect(await row(pool, "chain_instance")).toMatchObject({ status: "down", detail: expect.stringContaining("another chain instance") });
      expect((await row(pool, "chain_instance")).detail).toContain("block 3");
      await untouched(pool);
      expect(await ix.runOnce()).toMatchObject({ state: "stopped", indexed: 0 }); // it stays stopped
    });
  });

  it("(a) stops when reth has no block at the indexed head", async () => {
    await inDb(async (pool) => {
      const a = await indexedA(pool);
      a.reads.rethHead = 2;
      const ix = await start(pool, a);
      expect((await ix.runOnce()).state).toBe("stopped");
      expect((await row(pool, "chain_instance")).detail).toContain("reth has no block 3");
      await untouched(pool);
    });
  });

  it("(b) stops when the reader's ledger end is below the cursor's offset", async () => {
    await inDb(async (pool) => {
      const a = await indexedA(pool);
      const b = makeChain(shapes(1), PINS, 1);
      const ix = await start(pool, a, { ledger: ledgerView(b) }); // reth is still the old chain, the new ledger has one record at offset 10
      expect((await ix.runOnce()).state).toBe("stopped");
      expect(await row(pool, "chain_instance")).toMatchObject({ status: "down", detail: expect.stringContaining("ledger end") });
      await untouched(pool);
    });
  });

  it("(c) stops when the first record after the cursor is an earlier block that is not the one indexed", async () => {
    await inDb(async (pool) => {
      const a = await indexedA(pool);
      const b = makeChain(shapes(6), PINS, 1);
      const ix = await start(pool, a, { ledger: ledgerView(b, { shift: 100 }) }); // reth old; the new chain's first record sits just past the cursor
      const r = await ix.runOnce();
      expect(r.state).toBe("stopped");
      expect(await row(pool, "chain_instance")).toMatchObject({ status: "down", detail: expect.stringContaining("another chain instance") });
      await untouched(pool);
    });
  });

  it("(c) stops, naming the gap, when the first record after the cursor is not head + 1", async () => {
    await inDb(async (pool) => {
      const a = makeChain(shapes(6));
      const first = await start(pool, a, { ledger: ledgerView(a) });
      a.reads.rethHead = 3;
      await first.runOnce();
      await first.close();
      a.reads.rethHead = 6;
      const ix = await start(pool, a, { ledger: ledgerView(a, { from: 5 }) });
      expect((await ix.runOnce()).state).toBe("stopped");
      const r = await row(pool, "chain_instance");
      expect(r.status).toBe("down");
      expect(r.detail).toContain("block 4");
      expect(r.detail).toContain("block 5");
      expect(await blocks(pool)).toBe(3);
    });
  });

  it("does not stop on a replay of the same chain, or on a chain that has only moved on", async () => {
    await inDb(async (pool) => {
      const a = makeChain(shapes(5));
      a.reads.rethHead = 3;
      a.ledger.ledgerHead = 3;
      const ix = await start(pool, a);
      await ix.runOnce();
      a.reads.rethHead = 5;
      a.ledger.ledgerHead = 5;
      expect(await ix.runOnce()).toEqual({ state: "caught-up", indexed: 2 });
      await pool.query("update cursors set position = 0, detail = null where stream = 'reader_updates'");
      expect(await ix.runOnce()).toEqual({ state: "caught-up", indexed: 5 });
      expect((await row(pool, "chain_instance"))?.status ?? "ok").toBe("ok");
    });
  });
});

describe.skipIf(!TEST_URL)("explorer reset", () => {
  checkRequired();

  it("wipes the explorer's own tables for a new chain, keeps the migrations and the partition width, and the new chain then indexes", async () => {
    await inDb(async (pool) => {
      const a = makeChain(shapes(3));
      const ix = await start(pool, a);
      await ix.runOnce();
      await ix.close();
      const width = await meta(pool, "partition_width");
      const migrations = Number((await pool.query("select count(*) as n from schema_migrations")).rows[0].n);
      const done = await resetChain(pool);
      expect(done.tables).toBeGreaterThan(10);
      for (const t of ["blocks", "block_records", "transactions", "logs", "canton_updates", "canton_participants", "cursors", "health_checks", "tx_lifecycle"]) {
        expect(Number((await pool.query(`select count(*) as n from ${t}`)).rows[0].n), t).toBe(0);
      }
      expect((await pool.query("select key from meta order by key")).rows.map((x) => x.key)).toEqual(["partition_width"]);
      expect(await meta(pool, "partition_width")).toBe(width);
      expect(Number((await pool.query("select count(*) as n from schema_migrations")).rows[0].n)).toBe(migrations);
      const b = makeChain(shapes(2), PINS, 1);
      const next = await start(pool, b);
      expect(await next.runOnce()).toEqual({ state: "caught-up", indexed: 2 });
      expect(await meta(pool, "chain_instance")).toBe(b.blocks[0]!.record.updateId);
    });
  });

  it("refuses while an indexer holds the database", async () => {
    await inDb(async (pool) => {
      await start(pool, makeChain(shapes(1)));
      await expect(resetChain(pool)).rejects.toThrow(/indexer/);
      expect(await meta(pool, "chain_id")).toBe(String(CHAIN_ID));
    });
  });
});

describe.skipIf(!TEST_URL)("explorer reader-moved", () => {
  checkRequired();

  async function indexedOnOld(pool: Pool, total = 6) {
    const a = makeChain(shapes(total));
    a.reads.rethHead = 3;
    const ix = await start(pool, a, { ledger: ledgerView(a, { participant: "PAR::old" }) });
    await ix.runOnce();
    await ix.close();
    a.reads.rethHead = total;
    return a;
  }

  it("stops at a participant it has not been told about, and goes on after the move is recorded", async () => {
    await inDb(async (pool) => {
      const a = await indexedOnOld(pool);
      const fresh = ledgerView(a, { participant: "PAR::new", from: 3, shift: -20 }); // the new participant has records from block 3 on, with offsets of its own
      const blocked = await start(pool, a, { ledger: fresh });
      expect((await blocked.runOnce()).state).toBe("stopped");
      expect((await row(pool, "participant")).status).toBe("down");
      await blocked.close();

      const moved = await readerMoved(pool, "PAR::new");
      expect(moved).toMatchObject({ from: "PAR::old", lastOffset: 30, head: 3 });
      const ps = (await pool.query("select participant_id, first_offset, last_offset, moved_out_at is not null as out from canton_participants order by id")).rows;
      expect(ps).toEqual([
        { participant_id: "PAR::old", first_offset: "0", last_offset: "30", out: true },
        { participant_id: "PAR::new", first_offset: "0", last_offset: null, out: false },
      ].map((p) => expect.objectContaining(p)));
      expect(await meta(pool, "reader_participant")).toBe("PAR::new");
      const record = JSON.parse((await meta(pool, "reader_move_1")) as string);
      expect(record).toMatchObject({ from: "PAR::old", to: "PAR::new", lastOffset: 30, head: 3 });
      expect(typeof record.at).toBe("string");
      const cursor = (await pool.query("select position, detail from cursors where stream = 'reader_updates'")).rows[0];
      expect(Number(cursor.position)).toBe(0);
      expect(cursor.detail).toEqual({ participant: "PAR::new", block: 3 });

      const ix = await start(pool, a, { ledger: fresh });
      expect(await ix.runOnce()).toEqual({ state: "caught-up", indexed: 4 }); // block 3 again (skipped), then 4 to 6
      expect(await blocks(pool)).toBe(6);
      const owners = (await pool.query("select u.reader_offset, p.participant_id, b.number from blocks b join canton_updates u on u.update_id = b.update_id join canton_participants p on p.id = u.participant order by b.number")).rows;
      expect(owners.map((o) => o.participant_id)).toEqual(["PAR::old", "PAR::old", "PAR::old", "PAR::new", "PAR::new", "PAR::new"]);
      expect((await row(pool, "participant")).status).toBe("ok");
    });
  });

  it("stops with down, naming the gap, when the new participant's first record is not the next block", async () => {
    await inDb(async (pool) => {
      const a = await indexedOnOld(pool);
      await readerMoved(pool, "PAR::new");
      const ix = await start(pool, a, { ledger: ledgerView(a, { participant: "PAR::new", from: 5, shift: -40 }) }); // block 4 happened before it hosted the reader
      const r = await ix.runOnce();
      expect(r.state).toBe("stopped");
      const h = await row(pool, "chain_instance");
      expect(h.status).toBe("down");
      expect(h.detail).toContain("block 4");
      expect(h.detail).toContain("block 5");
      expect(h.detail).toContain("PAR::new");
      expect(await blocks(pool)).toBe(3);
    });
  });

  it("refuses a participant the reader is on already, and an empty database", async () => {
    await inDb(async (pool) => {
      await expect(readerMoved(pool, "PAR::new")).rejects.toThrow(/nothing has been read/);
      await indexedOnOld(pool);
      await expect(readerMoved(pool, "PAR::old")).rejects.toThrow(/already/);
      await expect(readerMoved(pool, "")).rejects.toThrow(/participant id/);
    });
  });
});

describe.skipIf(!TEST_URL)("review fixes: a walk that cannot read, the checks without reth, and the loose ends", () => {
  checkRequired();

  it("C5 goes degraded and then down while the ledger end is ahead of the cursor and the walk cannot read a record", async () => {
    await inDb(async (pool) => {
      let now = at(2, 0);
      const chain = makeChain(shapes(5));
      chain.ledger.ledgerHead = 2;
      const ix = await start(pool, chain, { now: () => now });
      await ix.runOnce();
      chain.ledger.ledgerHead = 5;
      chain.ledger.failAfterPages = 0;
      for (const plus of [0, 6000, 31_000]) {
        now = at(3, plus);
        await expect(ix.runOnce()).rejects.toThrow(/Canton timed out/);
        await ix.checkOnce();
        const c5 = await row(pool, "C5");
        expect(c5.status, `at +${plus}`).toBe(plus === 0 ? "ok" : plus === 6000 ? "degraded" : "down");
        expect(c5.value.lagSeconds).toBe(plus / 1000);
      }
      chain.ledger.failAfterPages = null;
      expect(await ix.runOnce()).toEqual({ state: "caught-up", indexed: 3 });
      await ix.checkOnce();
      expect(await row(pool, "C5")).toMatchObject({ status: "ok", value: { lagBlocks: 0, lagSeconds: 0 } });
    });
  });

  it("the checks that do not need reth are written when reth's finalized cannot be read, and C4 says why", async () => {
    await inDb(async (pool) => {
      const chain = makeChain(shapes(2));
      const ix = await start(pool, chain);
      await ix.runOnce();
      await pool.query("delete from health_checks where check_id in ('C4', 'C5', 'derive_lag')");
      chain.reads.finalized = async () => { throw new Error("reth did not answer"); };
      await ix.checkOnce();
      expect(await row(pool, "C4")).toMatchObject({ status: "degraded" });
      expect((await row(pool, "C4")).detail).toContain("reth did not answer");
      expect((await row(pool, "C5")).status).toBe("ok");
      expect((await row(pool, "derive_lag")).status).toBe("ok");
    });
  });

  it("C10's checked_at moves with every look while its status stays, and clear-check sets it ok and says who", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1, leg: 1 }, { txs: 1 }]);
      chain.blocks[0]!.legsHash = "0x" + "11".repeat(32);
      const ix = await start(pool, chain);
      await ix.runOnce();
      await pool.query("update health_checks set checked_at = now() - interval '1 hour' where check_id = 'C10'");
      await ix.checkOnce();
      const fresh = (await pool.query("select status, extract(epoch from now() - checked_at) as age from health_checks where check_id = 'C10'")).rows[0];
      expect(fresh.status).toBe("degraded");
      expect(Number(fresh.age)).toBeLessThan(30);
      await expect(clearCheck(pool, "C4", "ana")).rejects.toThrow(/C10/);
      await clearCheck(pool, "C10", "ana");
      expect(await row(pool, "C10")).toMatchObject({ status: "ok", value: { clearedBy: "ana", clearedBlock: 1 } });
    });
  });

  it("backfills chain_instance at open from block 1 for a database that was indexed before it was kept", async () => {
    await inDb(async (pool) => {
      const a = makeChain(shapes(2));
      const ix = await start(pool, a);
      await ix.runOnce();
      await ix.close();
      await pool.query("delete from meta where key = 'chain_instance'");
      expect(await meta(pool, "chain_instance")).toBeUndefined();
      await start(pool, a);
      expect(await meta(pool, "chain_instance")).toBe(a.blocks[0]!.record.updateId);
    });
  });

  it("the gap message names the latest move by its number (10 after 9), and only while the cursor is at the new participant's start", async () => {
    await inDb(async (pool) => {
      const a = makeChain(shapes(6));
      const first = await start(pool, a, { ledger: ledgerView(a) });
      a.reads.rethHead = 3;
      await first.runOnce();
      await first.close();
      a.reads.rethHead = 6;
      for (const n of [9, 10]) await pool.query("insert into meta (key, value) values ($1, $2)", [`reader_move_${n}`, JSON.stringify({ from: "PAR::x", to: `PAR::move${n}` })]);
      // The cursor is past the new participant's start: the gap is not about the move.
      const later = await start(pool, a, { ledger: ledgerView(a, { from: 5 }) });
      expect((await later.runOnce()).state).toBe("stopped");
      expect((await row(pool, "chain_instance")).detail).not.toContain("PAR::move");
      await later.close();
      await pool.query("update health_checks set status = 'ok' where check_id = 'chain_instance'");
      await pool.query("update cursors set position = 0 where stream = 'reader_updates'");
      const ix = await start(pool, a, { ledger: ledgerView(a, { from: 5, shift: -40 }) });
      expect((await ix.runOnce()).state).toBe("stopped");
      expect((await row(pool, "chain_instance")).detail).toContain("PAR::move10");
    });
  });

  it("reset refuses a database that is not the explorer's, and one whose API still holds the tracker or faucet lock", async () => {
    await withDatabase(async (pool, url) => {
      await pool.query("create table somebody_elses (x int)");
      await pool.query("insert into somebody_elses values (1)");
      await expect(resetChain(pool)).rejects.toThrow(/explorer/);
      expect(Number((await pool.query("select count(*) as n from somebody_elses")).rows[0].n)).toBe(1);
      await migrate(pool);
      const ix = await start(pool, makeChain(shapes(2)));
      await ix.runOnce();
      await ix.close();
      for (const which of [TRACKER_LOCK, FAUCET_LOCK]) {
        const api = advisoryLeader({ connectionString: url }, which);
        expect(await api.isLeader()).toBe(true);
        await expect(resetChain(pool)).rejects.toThrow(/API/);
        expect(await blocks(pool)).toBe(2);
        await api.release();
      }
      expect((await resetChain(pool)).tables).toBeGreaterThan(10);
      expect(await blocks(pool)).toBe(0);
    });
  });
});
