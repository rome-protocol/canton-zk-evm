/** The stats rollups, on the pinned PostgreSQL, against numbers worked out by hand. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { ensurePartitions } from "../db/partitions.ts";
import { migrate } from "../db/migrate.ts";
import { DAY, HOUR, MINUTE, rebuildStats, rollupStats } from "./stats.ts";
import { histLength } from "./stats-hist.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createIndexer } from "./indexer.ts";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0); // 12:00:00 UTC on a day with nothing else in it
const at = (sec: number) => new Date(T0 + Math.round(sec * 1000));
const TL = histLength("time"); // 281
const hex = (n: number) => `\\x${n.toString(16).padStart(2, "0").repeat(4)}`;

async function ins(pool: Pool, table: string, o: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = Object.keys(o);
  const { rows } = await pool.query(`insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, keys.map((k) => o[k]));
  return rows[0];
}
const run = async (pool: Pool, test: boolean) => (await ins(pool, "producer_runs", { run_id: randomUUID(), started_at: at(-3600), strategy: "t", settings: JSON.stringify(test ? { test: true } : {}), source_commit: "x" })).run_id as string;
let seq = 0;
const attempt = async (pool: Pool, runId: string, number: number, o: Record<string, unknown>) =>
  Number((await ins(pool, "block_attempts", { run_id: runId, attempt_seq: ++seq, number, strategy: "t", cut_reason: "timer", ...o })).attempt_id);
async function block(pool: Pool, number: number, rt: number, o: { txs?: number; gas?: number; attempt?: number | null; servedMs?: number; update?: string; arg?: number; traffic?: number } = {}) {
  await ins(pool, "canton_updates", { update_id: o.update ?? `u${number}`, participant: 1, reader_offset: number, record_time: at(rt), synchronizer: 1, reader_template: 1, signatories: "{}",
    argument_bytes: o.arg ?? null, traffic_bytes: o.traffic ?? null });
  await ins(pool, "blocks", {
    number, hash: hex(number), parent_hash: hex(number - 1), timestamp: at(rt), fee_recipient: hex(0), gas_limit: 1000, gas_used: o.gas ?? 0, base_fee_per_gas: 0, burnt_fees: 0,
    priority_fees: 0, tx_count: o.txs ?? 0, log_count: 0, size_bytes: 0, state_root: hex(0), transactions_root: hex(0), receipts_root: hex(0), extra_data: hex(0),
    legs_count: 0, update_id: o.update ?? `u${number}`, record_time: at(rt), attempt_id: o.attempt ?? null, indexed_at: at(rt + (o.servedMs ?? 1000) / 1000),
  });
}
async function tx(pool: Pool, block_: number, index: number, from: number, status: number) {
  await ins(pool, "transactions", {
    block_number: block_, tx_index: index, hash: hex(block_ * 10 + index), type: 2, from_address: hex(from), nonce: 0, value: 0, gas_limit: 21000, effective_gas_price: 0,
    gas_used: 21000, cumulative_gas_used: 21000, status, input: "\\x", log_count: 0,
  });
}
const life = (pool: Pool, n: number, o: Record<string, unknown>) => ins(pool, "tx_lifecycle", { tx_hash: hex(200 + n), state: "final", updated_at: at(0), ...o });
const dump = async (pool: Pool) => {
  const out: Record<string, unknown> = {};
  for (const t of ["stats_minute", "stats_hour", "stats_day"]) out[t] = (await pool.query(`select * from ${t} order by bucket`)).rows;
  return JSON.stringify(out);
};
const minuteRow = async (pool: Pool, sec: number) => (await pool.query("select * from stats_minute where bucket = $1", [at(sec)])).rows[0];
const nz = (h: number[]) => Object.fromEntries(h.map((v, i) => [i, v]).filter(([, v]) => v !== 0));

async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    await migrate(pool);
    await ensurePartitions(pool, { head: 0 });
    // The one participant, synchronizer and template (each gets id 1) that every update points at.
    await pool.query("insert into canton_participants (participant_id, moved_in_at) values ('p', now())");
    await pool.query("insert into canton_synchronizers (synchronizer_id, first_seen) values ('s', now())");
    await pool.query("insert into canton_templates (package_id, module, entity) values ('k', 'm', 'e')");
    await fn(pool);
  });
}

checkRequired();
describe.skipIf(!TEST_URL)("the stats rollups", () => {
  it("a database with no facts has no rows and no cursor, and a run says nothing was done", () => inDb(async (pool) => {
    const r = await rollupStats(pool, { now: () => T0 });
    expect(r.minutes).toBe(0);
    for (const t of ["stats_minute", "stats_hour", "stats_day", "cursors"]) expect((await pool.query(`select count(*)::int as n from ${t} where ${t === "cursors" ? "stream = 'stats_rollup'" : "true"}`)).rows[0].n).toBe(0);
  }));

  it("every stat, minute by minute, for a small worked set; hours and days add the minutes; a second run changes nothing", () => inDb(async (pool) => {
    const R1 = await run(pool, false), R2 = await run(pool, true);
    // Attempts. a1 made block 1 (busy: cut 500 ms after the prover was free); a6 and a7 made blocks 2 and 4 (busy); a5 is the test run's.
    const a1 = await attempt(pool, R1, 1, { cut_at: at(50), idle_before_cut_ms: 500, tx_count: 3, proof_started_at: at(50), proof_ended_at: at(70), proof_outcome: "ok",
      submitted_at: at(72), answered_at: at(74), outcome: "committed" });
    const a6 = await attempt(pool, R1, 2, { cut_at: at(60.5), idle_before_cut_ms: 100, argument_bytes: 50, outcome: "committed" });
    const a7 = await attempt(pool, R1, 4, { cut_at: at(68), idle_before_cut_ms: 200, outcome: "committed" });
    await attempt(pool, R1, 5, { cut_at: at(80), outcome: "refused" });
    await attempt(pool, R1, 6, { cut_at: at(90), proof_started_at: at(90), proof_ended_at: at(100), proof_outcome: "failed" });
    await attempt(pool, R1, 7, { cut_at: at(95), outcome: "not_taken" });
    const a5 = await attempt(pool, R2, 3, { cut_at: at(96), proof_started_at: at(96), proof_ended_at: at(106), proof_outcome: "ok", tx_count: 5 });
    // Blocks: 1 at 59.999 s, 2 at 62 s (gap 2.001 s), the test block 3 at 90 s, and 4 at 70 s (out of order: its predecessor is later, so the gap is negative).
    await block(pool, 1, 59.999, { txs: 3, gas: 300, attempt: a1, servedMs: 500, arg: 100, traffic: 40 });
    await block(pool, 2, 62, { txs: 0, gas: 0, attempt: a6 });
    await block(pool, 3, 90, { txs: 5, gas: 500, attempt: a5 });
    await block(pool, 4, 70, { txs: 2, gas: 100, attempt: a7 });
    await tx(pool, 1, 0, 0xa1, 1); await tx(pool, 1, 1, 0xa1, 1); await tx(pool, 1, 2, 0xb2, 0); await tx(pool, 4, 0, 0xb2, 1); await tx(pool, 4, 1, 0xc3, 1);
    // Lifecycles. A: 70 s to final in block 1. B: final with no acceptance. C: final in the test run's block. D: lost. E: final before acceptance (skew).
    await life(pool, 1, { accepted_at: at(10), final_at: at(80), final_block: 1 });
    await life(pool, 2, { final_at: at(100) });
    await life(pool, 3, { accepted_at: at(65), final_at: at(110), final_block: 3 });
    await life(pool, 4, { state: "lost", updated_at: at(30) });
    await life(pool, 5, { accepted_at: at(86), final_at: at(85) });
    // The day's extras: addresses a1, b2, c3 sent; two addresses first seen in blocks 1-4; one contract created in block 2; one verification that day.
    await ins(pool, "addresses", { address: hex(0xa1), first_seen_block: 1, last_active_block: 1 });
    await ins(pool, "addresses", { address: hex(0xc3), first_seen_block: 4, last_active_block: 4 });
    await ins(pool, "addresses", { address: hex(0xd4), first_seen_block: 99, last_active_block: 99 });
    await ins(pool, "bytecodes", { code_hash: hex(1), code: "\\x00", size: 1 });
    await ins(pool, "contracts", { address: hex(0xe5), origin: "create", runtime_code_hash: hex(1), creation_block: 2 });
    await ins(pool, "verified_sources", { address: hex(0xe5), runtime_code_hash: hex(1), language: "solidity", compiler_version: "0.8.0", code_format: "single", contract_path: "a.sol", contract_name: "A",
      settings: "{}", sources: "{}", abi: "[]", match_type: "full", verified_at: at(120) });

    const now = () => T0 + 3 * MINUTE + 10_000;
    const first = await rollupStats(pool, { now });
    expect(first).toEqual({ from: T0, to: T0 + 4 * MINUTE, minutes: 4 });

    const m0 = await minuteRow(pool, 0);
    expect(m0).toMatchObject({ blocks: 1, empty_blocks: 0, busy_blocks: 1, txs: 3, txs_failed: 1, gas_used: "300", gas_limit_sum: "1000", argument_bytes: "100", traffic_bytes: "40",
      traffic_updates: 1, max_txs_in_block: 3, accepted: 1, lost: 1, attempts: 1, attempts_refused: 0, attempts_failed: 0, attempts_not_taken: 0, proof_busy_ms: "10000",
      ttf_without_acceptance: 0, clock_skew: 0, test_blocks: 0, test_txs: 0 });
    expect(nz(m0.txs_per_block_hist)).toEqual({ 3: 1 }); // 3 transactions: three edges (1, 2, 3) are at or below it
    expect(nz(m0.served_hist)).toEqual({ 81: 1 }); // 0.5 s: edges 0.01 * 1.05^0..80 (the last is 0.4956 s) are below it
    expect(nz(m0.busy_gap_hist)).toEqual({}); // block 1 has no predecessor

    const m1 = await minuteRow(pool, 60);
    expect(m1).toMatchObject({ blocks: 2, empty_blocks: 1, busy_blocks: 2, txs: 2, txs_failed: 0, gas_used: "100", gas_limit_sum: "2000", argument_bytes: "50", traffic_bytes: "0", traffic_updates: 0,
      max_txs_in_block: 2, accepted: 2, lost: 0, attempts: 5, attempts_refused: 1, attempts_failed: 1, attempts_not_taken: 1, proof_busy_ms: "20000",
      ttf_without_acceptance: 1, clock_skew: 2, test_blocks: 1, test_txs: 5, test_attempts: 1, test_proof_busy_ms: "10000" });
    expect(nz(m1.txs_per_block_hist)).toEqual({ 0: 1, 2: 1 });
    expect(nz(m1.busy_gap_hist)).toEqual({ 109: 1 }); // block 2 is 2.001 s after block 1: 109 edges are at or below it; block 4's gap is -8 s and counts as skew
    expect(nz(m1.served_hist)).toEqual({ 95: 2 }); // 1.0 s: 95 edges (the last is 0.9834 s)
    expect(nz(m1.time_to_final_hist)).toEqual({ 182: 1 }); // A: 70 s, 182 edges (the last is 68.6 s); B has none, C is the test run's, E is skew (2 skew in all: E and block 4's gap)
    expect(nz(m1.proof_hist)).toEqual({ 156: 1 }); // 20 s
    expect(nz(m1.proof_size_hist)).toEqual({ [TL + 156]: 1 }); // 3 transactions: the second size class
    expect(nz(m1.commit_hist)).toEqual({ 109: 1 }); // 2 s
    expect(await minuteRow(pool, 120)).toBeUndefined(); // no facts in the third minute

    const h = (await pool.query("select * from stats_hour")).rows;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ bucket: at(0), blocks: 3, txs: 5, txs_failed: 1, gas_used: "400", attempts: 6, max_txs_in_block: 3, proof_busy_ms: "30000", test_blocks: 1, accepted: 3, lost: 1 });
    expect(nz(h[0].txs_per_block_hist)).toEqual({ 0: 1, 2: 1, 3: 1 });
    const d = (await pool.query("select * from stats_day")).rows;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ bucket: new Date(Math.floor(T0 / DAY) * DAY), blocks: 3, txs: 5, active_addresses: 3, new_addresses: 2, new_contracts: 1, verified_contracts: 1 });

    const before = await dump(pool);
    await rollupStats(pool, { now });
    await rollupStats(pool, { now });
    expect(await dump(pool)).toBe(before); // a run twice changes nothing
    // Chunks of one minute, from nothing, give the very same rows.
    await rebuildStats(pool, { now, chunkMs: MINUTE });
    expect(await dump(pool)).toBe(before);
  }));

  it("a block at 59.999 s and one at 00.000 s fall in different minutes, and the same at the hour and the day edge", () => inDb(async (pool) => {
    const edges = [59.999, 60, 3599.999, 3600, 43199.999, 43200]; // 12:00:59.999, 12:01:00, 12:59:59.999, 13:00:00, 23:59:59.999, 00:00:00 next day
    for (const [i, s] of edges.entries()) await block(pool, i + 1, s);
    await rollupStats(pool, { now: () => T0 + 43200_000 + 30_000 });
    const key = (t: string) => async () => (await pool.query(`select extract(epoch from bucket)::float8 * 1000 as b, blocks from ${t} order by bucket`)).rows.map((r) => [r.b - T0, r.blocks]);
    expect(await key("stats_minute")()).toEqual([[0, 1], [60_000, 1], [3_540_000, 1], [3_600_000, 1], [43_140_000, 1], [43_200_000, 1]]);
    expect(await key("stats_hour")()).toEqual([[0, 3], [3_600_000, 1], [39_600_000, 1], [43_200_000, 1]]);
    const days = (await pool.query("select extract(epoch from bucket)::float8 * 1000 as b, blocks from stats_day order by bucket")).rows.map((r) => [r.b - Math.floor(T0 / DAY) * DAY, r.blocks]);
    expect(days).toEqual([[0, 5], [DAY, 1]]);
  }));

  it("a late fact inside the lookback is repaired by the next run, and one outside it only by a rebuild", () => inDb(async (pool) => {
    await block(pool, 1, 10);
    await rollupStats(pool, { now: () => T0 + 5 * MINUTE });
    await life(pool, 1, { accepted_at: at(2 * 60 + 30) }); // two minutes ago: inside the 15 minutes
    await life(pool, 2, { accepted_at: new Date(T0 - 3 * HOUR) });
    await rollupStats(pool, { now: () => T0 + 6 * MINUTE });
    expect((await minuteRow(pool, 120))?.accepted).toBe(1);
    expect((await pool.query("select count(*)::int as n from stats_minute where bucket = $1", [new Date(T0 - 3 * HOUR)])).rows[0].n).toBe(0);
    await rebuildStats(pool, { now: () => T0 + 6 * MINUTE });
    expect((await pool.query("select accepted from stats_minute where bucket = $1", [new Date(T0 - 3 * HOUR)])).rows[0].accepted).toBe(1);
  }));

  it("a clock that goes back does not lose or double anything", () => inDb(async (pool) => {
    await block(pool, 1, 10);
    await rollupStats(pool, { now: () => T0 + 5 * MINUTE });
    const before = await dump(pool);
    await rollupStats(pool, { now: () => T0 + 2 * MINUTE });
    expect(await dump(pool)).toBe(before);
  }));

  it("runs by itself while the indexer runs, and once on demand", () => withDatabase(async (pool) => {
    await migrate(pool);
    const chain = makeChain([{ txs: 2 }, { txs: 3 }]);
    let clock = 0;
    const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", pollMs: 20, checkMs: 50, rollupMs: 50, now: () => clock });
    try {
      await indexer.open();
      await indexer.runOnce();
      clock = Number((await pool.query("select extract(epoch from max(record_time))::float8 * 1000 as t from blocks")).rows[0].t) + 90_000;
      const halt = indexer.start();
      try {
        for (let i = 0; i < 100 && !(await pool.query("select 1 from stats_minute")).rowCount; i++) await new Promise((ok) => setTimeout(ok, 50));
        expect(Number((await pool.query("select sum(txs)::int as n from stats_minute")).rows[0].n)).toBe(5);
      } finally {
        await halt();
      }
      expect((await indexer.rollupStatsOnce()).minutes).toBeGreaterThan(0);
    } finally {
      await indexer.close().catch(() => undefined);
    }
  }));
});
