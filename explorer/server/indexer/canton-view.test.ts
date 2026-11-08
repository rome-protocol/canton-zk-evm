import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createChainRest } from "../rest/chain-rest.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { refreshCantonView } from "./canton-view.ts";
import { RUN1, Run, appendLines, makeFolder, putFile, removeFolders } from "./journal-fixtures.ts";

afterAll(removeFolders);
const opened: Indexer[] = [];
const one = async (pool: Pool, sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];

/** Three blocks: 1 committed on the first attempt, 2 refused once and then committed, 3 with nothing in the journal. Block 2 has one withdrawal leg. */
async function setup(pool: Pool): Promise<{ chain: SyntheticChain; ix: Indexer; dir: string; run: Run; now: number }> {
  const chain = makeChain([{ txs: 2 }, { txs: 2, leg: 2 }, { txs: 2 }]);
  const dir = makeFolder();
  const run = new Run(RUN1);
  const t2 = Date.parse(chain.blocks[1]!.record.recordTime);
  run.start(t2 - 60_000);
  run.committed(1, 1, chain);
  // a first try of block 2 that Canton refused, then the one that committed
  run.add(t2 - 20_000, "cut", { attempt: 2, number: 2, strategy: "on_demand", cut_reason: "pool", pool_waiting: 2, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
  run.add(t2 - 19_900, "built", { attempt: 2, block_hash: chain.blocks[1]!.block.hash, parent_hash: chain.blocks[1]!.block.parentHash, tx_hashes: chain.blocks[1]!.block.transactions.map((x) => x.hash), gas_used: 1, legs: 0, rebuilds: 0, left_out: [] });
  run.add(t2 - 19_000, "submitted", { attempt: 2, command_id: "ostia-770101-2-x-2", argument_bytes: 10 });
  run.add(t2 - 18_000, "answered", { attempt: 2, outcome: "refused", reason: "rejected by Canton", update_id: null, completion_offset: null });
  run.committed(3, 2, chain);
  putFile(dir, "2026-10-21.jsonl", run.lines);
  const ix = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", journalDir: dir, producerStatusFile: null });
  opened.push(ix);
  await ix.open();
  chain.ledger.ledgerHead = 3;
  chain.reads.rethHead = 3;
  await ix.runOnce();
  await ix.loadJournal();
  return { chain, ix, dir, run, now: Date.parse(chain.blocks[2]!.record.recordTime) + 1000 };
}

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

describe.skipIf(!TEST_URL)("the Linked to Canton view", () => {
  checkRequired();

  it("works out the attempts, the settlement time and the legs of each block", async () => {
    await inDb(async (pool) => {
      const { chain, now } = await setup(pool);
      await refreshCantonView(pool, { now: () => now });
      const row = (n: number) => one(pool, "select * from canton_updates where update_id = $1", [chain.blocks[n - 1]!.record.updateId]);
      const first = await row(1), second = await row(2), third = await row(3);
      expect(first).toMatchObject({ commit_attempts: 1, settle_from: "proof_start" });
      expect(first.settle_seconds).toBeCloseTo(6.8, 3);
      expect(second).toMatchObject({ commit_attempts: 2, settle_from: "proof_start", legs_done: true, legs_total: 1, legs_withdrawal: 1, legs_deposit: 0, legs_payment: 0 });
      // block 3 has no journal behind it: no attempts, and the time runs from the block's own timestamp, in whole seconds
      expect(third).toMatchObject({ commit_attempts: null, settle_from: "block_time", legs_done: true, legs_total: 0 });
      const ts = Number((await one(pool, "select extract(epoch from timestamp) as t from blocks where number = 3")).t);
      expect(third.settle_seconds).toBeCloseTo(Date.parse(chain.blocks[2]!.record.recordTime) / 1000 - ts, 3);
    });
  });

  it("rolls the hours up, and a second pass changes nothing", async () => {
    await inDb(async (pool) => {
      const { now } = await setup(pool);
      await refreshCantonView(pool, { now: () => now });
      const rest = createChainRest(pool, () => now);
      const stats = await rest.cantonStats("24h");
      expect(stats).toMatchObject({ blocks: 3, retriedBlocks: 1, attempts: { submitted: 3, committed: 2, refused: 1, other: 0 }, legs: { withdrawal: 1, total: 1 } });
      expect(stats.successRate).toBeCloseTo(2 / 3, 3);
      // two blocks have a proof start behind their time: both took 6.8 s
      expect(stats.settlement).toMatchObject({ blocks: 2, averageSeconds: 6.8, basis: "proofStart" });
      expect(stats.settlement.p95Seconds).toBeGreaterThanOrEqual(6.8);
      expect(stats.settlement.p95Seconds).toBeLessThanOrEqual(6.8 * 1.05 + 0.001);
      await refreshCantonView(pool, { now: () => now });
      expect(await rest.cantonStats("24h")).toEqual(stats);
      expect(await rest.cantonStats("7d")).toMatchObject({ blocks: 3, settlement: { window: "7d", blocks: 2 } });
    });
  });

  it("gives nothing for a window with no block, and no rate with no attempt", async () => {
    await inDb(async (pool) => {
      const rest = createChainRest(pool);
      expect(await rest.cantonStats("24h")).toMatchObject({ blocks: 0, successRate: null, asOf: null, dataSince: null, settlement: { blocks: 0, averageSeconds: null, p95Seconds: null }, attempts: { submitted: 0, since: null } });
    });
  });

  it("counts an attempt the journal loads late in its own hour", async () => {
    await inDb(async (pool) => {
      const { chain, dir, run, now } = await setup(pool);
      await refreshCantonView(pool, { now: () => now });
      const t1 = Date.parse(chain.blocks[0]!.record.recordTime);
      // an attempt of an earlier day, loaded after the rest: it is not for any block of the chain
      const early = t1 - 3 * 86_400_000;
      run.lines.length = 0;
      run.add(early, "cut", { attempt: 9, number: 1, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
      run.add(early + 10, "built", { attempt: 9, block_hash: "0x" + "ab".repeat(32), parent_hash: "0x" + "cd".repeat(32), tx_hashes: [], gas_used: 0, legs: 0, rebuilds: 0, left_out: [] });
      run.add(early + 20, "submitted", { attempt: 9, command_id: "ostia-770101-1-y-9", argument_bytes: 10 });
      run.add(early + 900, "answered", { attempt: 9, outcome: "refused", reason: "rejected", update_id: null, completion_offset: null });
      appendLines(dir, "2026-10-21.jsonl", run.lines);
      const { ix } = { ix: opened[0]! };
      await ix.loadJournal();
      await refreshCantonView(pool, { now: () => now });
      const hour = await one(pool, "select attempts, attempts_refused from canton_view_hour where hour = date_trunc('hour', $1::timestamptz)", [new Date(early)]);
      expect(hour).toMatchObject({ attempts: 1, attempts_refused: 1 });
    });
  });

  it("lists by filter and order, pages by key, and exports the filtered list", async () => {
    await inDb(async (pool) => {
      const { chain, now } = await setup(pool);
      await refreshCantonView(pool, { now: () => now });
      const rest = createChainRest(pool, () => now);
      const ids = (rows: { updateId: string }[]) => rows.map((r) => r.updateId);
      const id = (n: number) => chain.blocks[n - 1]!.record.updateId;
      expect(ids(await rest.updates(null, 10))).toEqual([id(3), id(2), id(1)]);
      expect(ids(await rest.updates(null, 10, "all", true))).toEqual([id(1), id(2), id(3)]);
      expect(ids(await rest.updates(null, 10, "first"))).toEqual([id(1)]);
      expect(ids(await rest.updates(null, 10, "retried"))).toEqual([id(2)]);
      expect(ids(await rest.updates(null, 10, "legs"))).toEqual([id(2)]);
      // keys page both ways
      const page = await rest.updates(null, 1);
      expect(page).toHaveLength(2);
      const after = await rest.updates([page[0]!.micros, page[0]!.updateId], 5);
      expect(ids(after)).toEqual([id(2), id(1)]);
      const up = await rest.updates([page[0]!.micros, page[0]!.updateId], 5, "all", true);
      expect(up).toEqual([]);
      const [two] = await rest.updates(null, 1, "retried");
      expect(two).toMatchObject({ status: "retried", attempts: 2, settleFrom: "proofStart", submittedTemplate: "Zk.Chain:ZkChain", submittedChoice: "Advance", legs: { total: 1, withdrawal: 1, deposit: 0, payment: 0, lock: 0, release: 0 } });
      const [three] = await rest.updates(null, 1);
      expect(three).toMatchObject({ status: null, attempts: null, settleFrom: "blockTime", submittedTemplate: null, legs: { total: 0 } });
    });
  });

  it("leaves a block's legs unknown until its legs are indexed, and lock and release apart from payments", async () => {
    await inDb(async (pool) => {
      const { chain, now } = await setup(pool);
      // a registered gateway whose legs are indexed only to block 1: blocks above it are not counted yet
      await pool.query("insert into canton_registry (address, kind, code_hash, admin, legs_cursor, ledger_offset) values ($1, 'gateway', $2, 'admin', 1, 1)", [Buffer.alloc(20, 7), Buffer.alloc(32, 1)]);
      await refreshCantonView(pool, { now: () => now });
      const rest = createChainRest(pool, () => now);
      const rows = await rest.updates(null, 10);
      expect(rows.map((r) => r.legs === null)).toEqual([true, true, false]);
      // the gateway catches up and block 2's payment turns out to be a lock
      await pool.query("update canton_registry set legs_cursor = 3");
      await pool.query("insert into gateway_legs (block_number, leg_index, tx_index, log_index, kind, leg_id, token, account, amount) values (3, 0, 0, 0, 3, $1, $2, $3, 5), (3, 1, 0, 1, 3, $1, $2, $3, 6)", [Buffer.alloc(32, 9), Buffer.alloc(20, 1), Buffer.alloc(20, 2)]);
      await pool.query("insert into twin_legs (block_number, leg_index, is_release) values (3, 0, false), (3, 1, true)");
      await refreshCantonView(pool, { now: () => now });
      const three = (await rest.updates(null, 10)).find((r) => r.updateId === chain.blocks[2]!.record.updateId)!;
      expect(three.legs).toEqual({ total: 2, deposit: 0, withdrawal: 0, payment: 0, lock: 1, release: 1 });
      expect((await rest.cantonStats()).legs).toMatchObject({ lock: 1, release: 1, withdrawal: 1 });
    });
  });

  it("shows the attempts, the timeline and the proof check of an update", async () => {
    await inDb(async (pool) => {
      const { chain, now } = await setup(pool);
      await refreshCantonView(pool, { now: () => now });
      const rest = createChainRest(pool, () => now);
      const d = (await rest.update(chain.blocks[1]!.record.updateId))!;
      expect(d.view.attempts.map((a) => [a.number, a.outcome, a.reason, a.committed])).toEqual([[1, "refused", "rejected by Canton", false], [2, "committed", null, true]]);
      expect(d.view.timeline.map((s) => [s.step, s.source])).toEqual([["built", "producer"], ["proofStarted", "producer"], ["proofDone", "producer"], ["submitted", "producer"], ["committed", "canton"]]);
      const times = d.view.timeline.map((s) => Date.parse(s.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(d.view.timeline.at(-1)!.at).toBe(d.recordTime);
      expect(d.view.proofCheck).toMatchObject({ evidence: "committed update", confirmers: 1 });
      // a block the journal does not hold has the block's timestamp for its first step and no attempts
      const e = (await rest.update(chain.blocks[2]!.record.updateId))!;
      expect(e.view.attempts).toEqual([]);
      expect(e.view.timeline.map((s) => [s.step, s.source])).toEqual([["built", "block"], ["committed", "canton"]]);
    });
  });
});
