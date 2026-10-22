import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { createJournal } from "./journal.ts";
import { createLifecycleChecks } from "./lifecycle.ts";
import { RUN1, Run, iso, makeFolder, putFile, removeFolders } from "./journal-fixtures.ts";

afterAll(removeFolders);
checkRequired();

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
async function start(pool: Pool, chain: SyntheticChain, over: Partial<Parameters<typeof createIndexer>[0]> = {}): Promise<Indexer> {
  const ix = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", ...over });
  opened.push(ix);
  await ix.open();
  return ix;
}
const hb = (h: string) => Buffer.from(h.slice(2), "hex");
const one = async (pool: Pool, sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];
const health = async (pool: Pool, id: string) => one(pool, "select status, value, detail from health_checks where check_id = $1", [id]);
const life = (pool: Pool, hash: string) => one(pool, "select * from tx_lifecycle where tx_hash = $1", [hb(hash)]);
const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);
const NOW = T0 + 3_600_000;
const addr = (b: string) => hb(b);

/** Two blocks, both committed and final, with the journal that says so, indexed and loaded. */
async function world(pool: Pool, o: { answerMs?: number; runStart?: number; second?: boolean } = {}) {
  const chain = makeChain([{ txs: 2 }, { txs: 1 }]);
  const dir = makeFolder();
  const r = new Run(RUN1);
  r.start(o.runStart ?? T0 - 60_000);
  r.committed(1, 1, chain, { answerMs: o.answerMs });
  if (o.second !== false) r.committed(2, 2, chain, { answerMs: o.answerMs });
  putFile(dir, "2026-10-21.jsonl", r.lines);
  const ix = await start(pool, chain, { journalDir: dir, producerStatusFile: null });
  await ix.runOnce();
  await ix.loadJournal();
  return { chain, dir, ix, run: r };
}
function statusFile(over: Record<string, unknown> = {}, at = NOW): string {
  const f = join(makeFolder(), "status.json");
  writeFileSync(f, JSON.stringify({ state: "running", updatedAt: iso(at), consecutiveFailures: 0, blocksUnknown: 0, journalError: null, lastError: null, ...over }));
  return f;
}
const checks = (pool: Pool, file: string | null, now: () => number = () => NOW) => createLifecycleChecks({ pool, statusFile: file, now });

describe.skipIf(!TEST_URL)("the state of a transaction, by the precedence of design section 4.6", () => {
  it("final beats a dropped written earlier, and a word of the journal that comes after", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 2 }]);
      const [a, b] = chain.blocks[0]!.block.transactions;
      // the API's tracker dropped both before the block was indexed
      for (const t of [a!, b!]) {
        await pool.query("insert into tx_lifecycle (tx_hash, sender, nonce, state, state_reason, accepted_at, accepted_via, updated_at) values ($1, $2, $3, 'dropped', 'gave up', $4, 'rpc', $4)",
          [hb(t.hash), addr(t.from), t.nonce, iso(NOW)]);
      }
      const ix = await start(pool, chain);
      await ix.runOnce();
      expect(await life(pool, a!.hash)).toMatchObject({ state: "final", state_reason: null, final_block: "1", accepted_via: "rpc" });
      // the journal says `lost` for one of them after it is final: the word does not undo final
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(NOW);
      r.add(NOW + 5000, "lost", { transactions: [{ transaction: a!.hash, error: "nonce too low" }] });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      await createJournal({ pool, folder: dir }).load();
      expect(await life(pool, a!.hash)).toMatchObject({ state: "final", state_reason: null });
    });
  });

  it("the newer event wins when none is final, and an older one does not undo it", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const h = "0x" + "ab".repeat(32);
      await pool.query("insert into tx_lifecycle (tx_hash, state, state_reason, updated_at) values ($1, 'dropped', 'gave up', $2)", [hb(h), iso(T0 + 10_000)]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0);
      r.add(T0 + 5000, "lost", { transactions: [{ transaction: h, error: "older than the drop" }] }); // older: the drop stays
      r.add(T0 + 1000, "cut", { attempt: 1, number: 1, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
      r.add(T0 + 20_000, "built", { attempt: 1, block_hash: chain.blocks[0]!.block.hash, parent_hash: chain.blocks[0]!.block.parentHash, tx_hashes: [h], gas_used: 1, legs: 0, rebuilds: 0, left_out: [] });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      await createJournal({ pool, folder: dir }).load();
      // attempt 1 held it later than the drop: proving, with the later time
      expect(await life(pool, h)).toMatchObject({ state: "proving", attempts: 1 });
    });
  });

  it("marks a transaction replaced only when one with the same sender and nonce is final", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 2 }]);
      const [a, b] = chain.blocks[0]!.block.transactions;
      const rows = [
        ["0x" + "01".repeat(32), a!.from, a!.nonce, "pending"], // same sender and nonce as a: replaced
        ["0x" + "02".repeat(32), a!.from, a!.nonce, "dropped"], // the same, though the tracker had dropped it: replaced
        ["0x" + "03".repeat(32), a!.from, a!.nonce + 1000, "pending"], // the same sender, another nonce: stays
        ["0x" + "04".repeat(32), b!.from, a!.nonce, "pending"], // another sender, the same nonce: stays
        ["0x" + "05".repeat(32), null, null, "pending"], // no sender known: stays
      ] as const;
      for (const [h, s, n, st] of rows) {
        await pool.query("insert into tx_lifecycle (tx_hash, sender, nonce, state, updated_at) values ($1, $2, $3, $4, $5)", [hb(h), s ? addr(s) : null, n, st, iso(NOW)]);
      }
      // b's own sender and nonce are not a's, unless the chain gave both the same sender: make sure 04 is not a match
      expect(b!.from === a!.from && b!.nonce === a!.nonce).toBe(false);
      const ix = await start(pool, chain);
      await ix.runOnce();
      const states = (await pool.query("select encode(tx_hash, 'hex') as h, state, state_reason from tx_lifecycle where tx_hash = any($1::bytea[]) order by h", [rows.map((r) => hb(r[0]))])).rows;
      expect(states.map((r) => [r.h.slice(0, 2), r.state])).toEqual([["01", "replaced"], ["02", "replaced"], ["03", "pending"], ["04", "pending"], ["05", "pending"]]);
      expect(states[0]!.state_reason).toMatch(/same sender took nonce/);
      // a replaced transaction is not brought back by a later word of the journal
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(NOW);
      r.add(NOW + 1000, "lost", { transactions: [{ transaction: rows[0][0], error: "nonce too low" }] });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      await createJournal({ pool, folder: dir }).load();
      expect(await life(pool, rows[0][0])).toMatchObject({ state: "replaced" });
    });
  });
});

describe.skipIf(!TEST_URL)("the checks that need the producer", () => {
  it("C8 and C9 are ok when every committed attempt has its update and every block its attempt, and the clocks agree", async () => {
    await inDb(async (pool) => {
      await world(pool);
      await checks(pool, statusFile()).run(true, true);
      expect(await health(pool, "C8")).toMatchObject({ status: "ok", detail: null, value: { committedWithoutUpdate: 0, blocksWithoutAttempt: 0 } });
      expect(await health(pool, "C9")).toMatchObject({ status: "ok", value: { checked: 2 } });
      expect(await health(pool, "producer_alive")).toMatchObject({ status: "ok" });
      expect(await health(pool, "producer_state")).toMatchObject({ status: "ok" });
      expect(await health(pool, "prover")).toMatchObject({ status: "ok", value: { number: 2, outcome: "ok" } });
    });
  });

  it("C8 is degraded for a block the producer says committed that the index does not have, and for an indexed block with no attempt", async () => {
    await inDb(async (pool) => {
      const { dir, run } = await world(pool, { second: false });
      // the journal says block 2 committed with an update that never reaches the index
      const chain2 = makeChain([{ txs: 2 }, { txs: 1 }]);
      run.committed(2, 2, chain2);
      putFile(dir, "2026-10-21.jsonl", run.lines.map((l) => l.replace(chain2.blocks[1]!.record.updateId, "1220" + "cd".repeat(32))));
      await createJournal({ pool, folder: dir }).load();
      await checks(pool, statusFile()).run(true, true);
      const c8 = await health(pool, "C8");
      expect(c8.status).toBe("degraded");
      expect(c8.detail).toMatch(/1 blocks the producer says committed have no update in the index after 10 s \(the first is block 2\)/);
      // another producer: a block the journal never saw
      await inDb(async (pool2) => {
        const w = await world(pool2, { second: false });
        const ix2 = w.ix;
        w.chain.ledger.ledgerHead = 2;
        await ix2.runOnce();
        expect(Number((await one(pool2, "select count(*) as n from blocks")).n)).toBe(2);
        await checks(pool2, statusFile()).run(true, true);
        const c = await health(pool2, "C8");
        expect(c.status).toBe("degraded");
        expect(c.detail).toMatch(/1 indexed blocks have no committed attempt in the journal \(the first is block 2\): another producer, or a lost journal/);
      });
    });
  });

  it("C9 is degraded when the producer's answer is before Canton's record time by more than 100 ms, and not for less", async () => {
    await inDb(async (pool) => {
      await world(pool, { answerMs: -50 });
      await checks(pool, statusFile()).run(true, true);
      expect(await health(pool, "C9")).toMatchObject({ status: "ok", value: { worstMs: -50 } });
    });
    await inDb(async (pool) => {
      await world(pool, { answerMs: -500 });
      await checks(pool, statusFile()).run(true, true);
      const c9 = await health(pool, "C9");
      expect(c9.status).toBe("degraded");
      expect(c9.detail).toMatch(/500 ms before Canton's record time/);
    });
  });

  it("a quiet chain is ok: no new block for an hour, the journal old, the producer's status file fresh", async () => {
    await inDb(async (pool) => {
      await world(pool);
      const now = NOW + 24 * 3_600_000; // a day later
      await checks(pool, statusFile({ state: "running" }, now), () => now).run(true, true);
      for (const id of ["C8", "C9", "producer_alive", "producer_state", "prover"]) expect((await health(pool, id)).status, id).toBe("ok");
    });
  });

  it("says a producer that has stopped writing its status, one that fails, one that is unsure of a block, and one that cannot write its journal", async () => {
    await inDb(async (pool) => {
      await world(pool);
      let now = NOW;
      const c = checks(pool, statusFile({}, NOW - 60_000), () => now);
      await c.run(true, true);
      expect(await health(pool, "producer_alive")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/last written 60 s ago/) });

      const failing = checks(pool, statusFile({ consecutiveFailures: 3, lastError: { error: "the prover is down" } }), () => now);
      await failing.run(true, true);
      expect(await health(pool, "producer_state")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/3 blocks in a row have failed: the prover is down/) });

      // `blocksUnknown` counts since the loop started and never goes down: it is no news by itself. `waitingToBeResolved` is the block not settled.
      const waiting = { number: 3, hash: "0x" + "ab".repeat(32) };
      const settled = checks(pool, statusFile({ blocksUnknown: 1, waitingToBeResolved: null }), () => now);
      await settled.run(true, true);
      now += 61_000;
      await settled.run(true, true);
      expect(await health(pool, "producer_state")).toMatchObject({ status: "ok", value: { blocksUnknown: 1, waitingToBeResolved: null } });

      const f = join(makeFolder(), "s.json");
      const write = (w: unknown) => writeFileSync(f, JSON.stringify({ state: "running", updatedAt: iso(now), consecutiveFailures: 0, blocksUnknown: 1, waitingToBeResolved: w }));
      const unsure = checks(pool, f, () => now);
      write(waiting);
      await unsure.run(true, true);
      expect((await health(pool, "producer_state")).status).toBe("ok"); // not yet a minute
      now += 61_000;
      write(waiting);
      await unsure.run(true, true);
      expect(await health(pool, "producer_state")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/outcome of block 3 has not been known for 61 s/) });
      // once the block is settled the timer is reset: a new wait starts from zero
      write(null);
      await unsure.run(true, true);
      expect((await health(pool, "producer_state")).status).toBe("ok");
      now += 30_000;
      write(waiting);
      await unsure.run(true, true);
      now += 30_000;
      write(waiting);
      await unsure.run(true, true);
      expect((await health(pool, "producer_state")).status).toBe("ok");

      await checks(pool, statusFile({ journalError: { time: iso(NOW), error: "disk full" } }), () => now).run(true, true);
      expect(await health(pool, "producer_state")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/cannot write its journal: disk full/) });
      await checks(pool, statusFile({ state: "stopped" }), () => now).run(true, true);
      expect(await health(pool, "producer_state")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/the producer is stopped/) });
    });
  });

  it("says there is no status file, an unreadable one and one that is not an object", async () => {
    await inDb(async (pool) => {
      await checks(pool, null).run(false, true);
      expect(await health(pool, "producer_alive")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/no producer status file is set/) });
      await checks(pool, join(makeFolder(), "missing.json")).run(false, true);
      expect(await health(pool, "producer_state")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/cannot be read/) });
      const f = join(makeFolder(), "s.json");
      writeFileSync(f, "[1]");
      await checks(pool, f).run(false, true);
      expect(await health(pool, "producer_alive")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/not a JSON object/) });
      expect(await health(pool, "C8")).toMatchObject({ status: "degraded" });
    });
  });

  it("the prover is degraded when the last proof failed", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0);
      r.add(T0 + 1000, "cut", { attempt: 1, number: 1, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
      r.add(T0 + 1100, "built", { attempt: 1, block_hash: chain.blocks[0]!.block.hash, parent_hash: chain.blocks[0]!.block.parentHash, tx_hashes: [], gas_used: 1, legs: 0, rebuilds: 0, left_out: [] });
      r.add(T0 + 1200, "proof_started", { attempt: 1, prover: "prover-a" });
      r.add(T0 + 2000, "proof_ended", { attempt: 1, prover: "prover-a", outcome: "failed", seconds: 0.8 });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      await createJournal({ pool, folder: dir }).load();
      await checks(pool, statusFile()).run(true, true);
      expect(await health(pool, "prover")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/block 1\) ended failed/) });
    });
  });
});
