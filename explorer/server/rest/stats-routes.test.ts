/**
 * `/api/stats/summary` and `/api/stats/series`, on the pinned PostgreSQL, against numbers worked out by hand. The rollup rows are written straight into the
 * tables, so that every expected number is a sum of the rows below; one test runs the real rollup on facts to see that the two halves meet.
 *
 * A time is the upper edge of its histogram bucket, 0.01 * 1.05^k seconds. The buckets used here:
 *   B = 120: 3.4896 s   A = 142: 10.2125 s   C = 160: 24.5519 s
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createApi, type Answer } from "../api.ts";
import { createChainRest } from "./chain-rest.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { ensurePartitions } from "../db/partitions.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { DAY, HOUR, MINUTE, rollupStats } from "../indexer/stats.ts";
import { histLength } from "../indexer/stats-hist.ts";
import { PINS } from "../../test/synthetic-chain.ts";
import { CACHE_CONTROL } from "./cache.ts";
import { REST_FIELDS as F } from "./fields.ts";
import { createStatsRest } from "./stats-rest.ts";
import { METRICS, WINDOW_STEPS, busyWindows, slowHours } from "./stats-routes.ts";

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
const TL = histLength("time"), CL = histLength("count");
const B = 120, A = 142, C = 160;
const edge = (k: number) => 0.01 * Math.pow(1.05, k);
const keys = (o: object) => Object.keys(o).sort();
const same = (o: object, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());
const body = (a: Answer) => a.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 12:30:20 UTC. The open minute is 12:30, the open hour is 12:00 and the open day is 20 October. */
const NOW = Date.UTC(2026, 9, 20, 12, 30, 20);
const at = (ms: number) => new Date(ms);
const t = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 20, h, m, s);
const hist = (len: number, set: Record<number, number>, offset = 0) => { const h = new Array(len).fill(0); for (const [i, n] of Object.entries(set)) h[offset + Number(i)] = n; return h; };
const time = (set: Record<number, number>) => hist(TL, set);
const count = (set: Record<number, number>) => hist(CL, set);

const ZERO = {
  blocks: 0, empty_blocks: 0, busy_blocks: 0, txs: 0, txs_failed: 0, gas_used: 0, argument_bytes: 0, accepted: 0, lost: 0, attempts_refused: 0, attempts_failed: 0, attempts: 0,
  attempts_not_taken: 0, ttf_without_acceptance: 0, clock_skew: 0, max_txs_in_block: 0, max_minute_txs: 0, gas_limit_sum: 0, traffic_bytes: 0, traffic_updates: 0, proof_busy_ms: 0, test_blocks: 0,
  test_txs: 0, test_attempts: 0, test_proof_busy_ms: 0,
  busy_gap_hist: [], time_to_final_hist: [], proof_hist: [], commit_hist: [], served_hist: [], txs_per_block_hist: [], proof_size_hist: [],
};
async function seed(pool: Pool, table: string, bucket: number, o: Record<string, unknown>) {
  const row = { ...ZERO, bucket: at(bucket), ...o } as Record<string, unknown>;
  const cols = Object.keys(row);
  await pool.query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => row[c]));
}
const hex = (n: number) => `\\x${n.toString(16).padStart(2, "0").repeat(4)}`;
async function ins(pool: Pool, table: string, o: Record<string, unknown>) {
  const ks = Object.keys(o);
  return (await pool.query(`insert into ${table} (${ks.join(", ")}) values (${ks.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, ks.map((k) => o[k]))).rows[0];
}
const run = async (pool: Pool, test: boolean) => (await ins(pool, "producer_runs", { run_id: randomUUID(), started_at: at(NOW - 3600_000), strategy: "t", settings: JSON.stringify(test ? { test: true } : {}), source_commit: "x" })).run_id as string;
let seq = 0, bn = 0;
/** A block (and its Canton update) at a record time, optionally from the attempt of a run. */
async function block(pool: Pool, rt: number, txs: number, attemptId: number | null = null) {
  const n = ++bn;
  await ins(pool, "canton_updates", { update_id: `u${n}`, participant: 1, reader_offset: n, record_time: at(rt), synchronizer: 1, reader_template: 1, signatories: "{}" });
  await ins(pool, "blocks", {
    number: n, hash: hex(n), parent_hash: hex(n - 1), timestamp: at(rt), fee_recipient: hex(0), gas_limit: 1000, gas_used: 0, base_fee_per_gas: 0, burnt_fees: 0, priority_fees: 0,
    tx_count: txs, log_count: 0, size_bytes: 0, state_root: hex(0), transactions_root: hex(0), receipts_root: hex(0), extra_data: hex(0), legs_count: 0, update_id: `u${n}`,
    record_time: at(rt), attempt_id: attemptId, indexed_at: at(rt + 1000),
  });
}
const attempt = async (pool: Pool, runId: string, o: Record<string, unknown>) =>
  Number((await ins(pool, "block_attempts", { run_id: runId, attempt_seq: ++seq, number: seq, strategy: "t", cut_reason: "timer", ...o })).attempt_id);
/** A block as `block` makes it, with a row in `transactions` for each of its transactions: what the total must equal, counted over the rows. */
async function blockWithTxs(pool: Pool, rt: number, txs: number) {
  await block(pool, rt, txs);
  for (let i = 0; i < txs; i++) {
    await ins(pool, "transactions", {
      block_number: bn, tx_index: i, hash: `\\x${bn.toString(16).padStart(8, "0")}${i.toString(16).padStart(8, "0")}`, type: 2, from_address: hex(1), nonce: i, value: 0, gas_limit: 21000,
      effective_gas_price: 0, gas_used: 21000, cumulative_gas_used: 21000 * (i + 1), status: 1, input: hex(0), log_count: 0,
    });
  }
}
async function base(pool: Pool) {
  await migrate(pool);
  await ensurePartitions(pool, { head: 0 });
  await pool.query("insert into canton_participants (participant_id, moved_in_at) values ('p', now())");
  await pool.query("insert into canton_synchronizers (synchronizer_id, first_seen) values ('s', now())");
  await pool.query("insert into canton_templates (package_id, module, entity) values ('k', 'm', 'e')");
}
/** The chain's REST routes too, for /api/txs. */
const listApiFor = (pool: Pool, now: () => number) => {
  const api = createApi({ config, reth: {} as never, ledger: {} as never, chain: createChainDb(pool), rest: createChainRest(pool), now });
  return (target: string) => api("GET", target);
};
const apiFor = (pool: Pool, now: () => number) => {
  const api = createApi({ config, reth: {} as never, ledger: {} as never, chain: createChainDb(pool), stats: createStatsRest(pool), now });
  return (target: string, method = "GET") => api(method, target);
};

checkRequired();
describe.skipIf(!TEST_URL)("the stats routes: a database with nothing in it", () => {
  let db: TestDatabase, get: ReturnType<typeof apiFor>;
  beforeAll(async () => { db = await makeDatabase(); await base(db.pool); get = apiFor(db.pool, () => NOW); });
  afterAll(async () => { await db?.drop(); });

  it("says nothing was measured: null times and rates, zero counts, no rollup yet", async () => {
    const a = await get("/api/stats/summary?window=1h");
    expect(a.status).toBe(200);
    const s = body(a);
    same(s, F.statsSummary);
    expect(s).toMatchObject({ window: "1h", rows: "minute", from: new Date(t(11, 31)).toISOString(), to: new Date(t(12, 31)).toISOString(), asOf: null, dataSince: null });
    expect(s.tps).toEqual({ now: 0, peak: null, peakAt: null });
    for (const k of ["blockTime", "timeToFinal", "proofTime", "commitTime", "served", "fullness", "today"]) expect(s[k], k).toBeNull();
    expect(s.txsPerBlock).toEqual({ mean: null, median: null, max: null, nonEmptyMean: null, nonEmptyMedian: null });
    expect(s.txs).toEqual({ count: 0, failed: 0, reverted: 0, successRate: null, accepted: 0, acceptedFinal: 0, lost: 0, dropped: 0, delayedByRedo: 0, allTime: null });
    expect(s.blocks.firstTry).toBeNull();
    expect(s.attempts).toMatchObject({ total: 0, refusedShare: null, failedShare: null, notTakenShare: null });
    expect(s.canton).toEqual({ argumentBytesPerBlock: null, argumentBytesPerTx: null, trafficBytesPerBlock: null, trafficReported: 0 });
    expect(s.prover).toEqual({ maxBusyRatio10m: 0, windowsOver: 0, windowsCounted: 5, windowSeconds: 600, loadedAbove: 0.6, meanBusyRatio: 0, busyMs: 0 });
    expect(s.waiting).toEqual({ open: 0, pool: null });
    expect(s.acceptedNotFinal).toMatchObject({ normal: null, slow: null, stuck: 0, noAcceptanceTime: 0, slowAfterSeconds: null, stuckAfterSeconds: 120, listed: [] });
    expect(s.lost).toEqual({ window: 0, total: 0, listed: [] });
    expect(s.dropped).toEqual({ window: 0, total: 0, listed: [] });
    expect(s.replaced).toEqual({ window: 0, total: 0 });
    expect(s.blocks.bySize).toEqual([["0"], ["1-10"], ["11-100"], ["101-1000"], ["over 1000"]].map(([size]) => ({ size, count: 0 })));
    expect(s.acceptedNotFinal).toMatchObject({ beingProven: 0, waiting: 0 });
    expect(s.cutting).toBeNull(); // no producer run is known
    expect(s.faucet).toMatchObject({ requests: 0, sent: 0, final: 0, failed: 0, timeToFinal: null });
    // the migration set the start of counting to its own time, which is after this test's clock: the window was not recorded
    expect(s.faucet.turnedAway).toBeNull();
    expect(typeof s.faucet.turnedAwaySince).toBe("string");
  });

  it("draws a series of empty steps: 0 for a count, null for a time and a rate", async () => {
    const s = body(await get("/api/stats/series?metric=txs&window=1h"));
    same(s, F.statsSeries);
    expect(s).toMatchObject({ metric: "txs", unit: "count", window: "1h", step: "1m", asOf: null });
    expect(s.points).toHaveLength(60);
    expect(s.points.every((p: { value: number }) => p.value === 0)).toBe(true);
    for (const m of ["success_rate", "time_to_final_p95", "fullness", "txs_per_block"]) {
      expect(body(await get(`/api/stats/series?metric=${m}&window=6h`)).points.every((p: { value: number | null }) => p.value === null), m).toBe(true);
    }
    expect(body(await get("/api/stats/series?metric=busy_ratio&window=1h&step=10m")).points.map((p: { value: number }) => p.value)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe.skipIf(!TEST_URL)("the stats routes", () => {
  let db: TestDatabase, pool: Pool, get: ReturnType<typeof apiFor>;
  const sum = async (path: string) => body(await get(path));
  const values = (s: Record<string, any>): Array<number | null> => s.points.map((p: { value: number | null }) => p.value); // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    db = await makeDatabase(); pool = db.pool;
    await base(pool);
    get = apiFor(pool, () => NOW);
    // Minute rows. 11:30 is outside the 1 h window (11:31 to 12:30 inclusive), and has the most transactions of all.
    await seed(pool, "stats_minute", t(11, 30), { blocks: 1, txs: 1000, max_minute_txs: 1000, max_txs_in_block: 1000, busy_gap_hist: time({ [A]: 1 }), proof_busy_ms: 999999 });
    await seed(pool, "stats_minute", t(11, 31), {
      blocks: 2, empty_blocks: 1, busy_blocks: 1, size_blocks_0: 1, size_blocks_1: 1, txs: 4, max_minute_txs: 4, gas_used: 100, gas_limit_sum: 2000, argument_bytes: 400, accepted: 4, accepted_final: 4, attempts: 1, attempts_committed: 1, max_txs_in_block: 4, proof_busy_ms: 30000,
      busy_gap_hist: time({ [A]: 1 }), time_to_final_hist: time({ [B]: 4 }), proof_hist: time({ [B]: 1 }), commit_hist: time({ [B]: 1 }), served_hist: time({ [B]: 1 }),
      txs_per_block_hist: count({ 0: 1, 4: 1 }), proof_size_hist: hist(5 * TL, { [B]: 1 }, 1 * TL),
    });
    await seed(pool, "stats_minute", t(12, 28), {
      blocks: 2, empty_blocks: 1, busy_blocks: 1, size_blocks_0: 1, size_blocks_1: 1, txs: 6, max_minute_txs: 6, txs_failed: 1, gas_used: 200, gas_limit_sum: 2000, argument_bytes: 600, accepted: 6, accepted_final: 8, delayed_by_redo: 2, lost: 1, dropped: 1, replaced: 2, attempts: 3, attempts_committed: 1, attempts_refused: 1,
      attempts_failed: 1, ttf_without_acceptance: 1, clock_skew: 1, max_txs_in_block: 6, traffic_bytes: 1000, traffic_updates: 2, proof_busy_ms: 60000,
      test_blocks: 1, test_txs: 9, test_attempts: 1, test_proof_busy_ms: 5000,
      busy_gap_hist: time({ [A]: 1 }), time_to_final_hist: time({ [B]: 1, [C]: 1 }), proof_hist: time({ [A]: 1 }), served_hist: time({ [C]: 1 }),
      txs_per_block_hist: count({ 0: 1, 6: 1 }), proof_size_hist: hist(5 * TL, { [A]: 1 }, 2 * TL),
    });
    await seed(pool, "stats_minute", t(12, 29), {
      blocks: 3, busy_blocks: 3, size_blocks_1: 1, size_blocks_2: 2, txs: 30, max_minute_txs: 30, txs_failed: 3, gas_used: 600, gas_limit_sum: 3000, argument_bytes: 3000, accepted: 25, accepted_final: 18, delayed_by_redo: 3, lost: 2, replaced: 1, attempts: 4, attempts_committed: 1, attempts_unknown: 1, attempts_refused: 1,
      attempts_not_taken: 1, max_txs_in_block: 12, traffic_bytes: 2000, traffic_updates: 3, proof_busy_ms: 10000, txs_per_block_hist: count({ 6: 1, 12: 2 }),
    });
    await seed(pool, "stats_minute", t(12, 30), { blocks: 1, size_blocks_1: 1, txs: 2, max_minute_txs: 2, gas_used: 50, gas_limit_sum: 1000, attempts: 1, max_txs_in_block: 2, txs_per_block_hist: count({ 2: 1 }) });
    // Hour and day rows: 11:00 holds the 11:30 and 11:31 minutes and 12:00 the others, as the rollup would have summed them, so that a 24 h or 7 d series has data.
    await seed(pool, "stats_hour", t(11, 0), { blocks: 3, txs: 1004, max_minute_txs: 1000, proof_busy_ms: 1029999, time_to_final_hist: time({ [B]: 4 }) });
    await seed(pool, "stats_hour", t(12, 0), { blocks: 8, txs: 42, max_minute_txs: 30, txs_failed: 4, time_to_final_hist: time({ [B]: 5, [C]: 1 }), proof_busy_ms: 100000 });
    await seed(pool, "stats_day", Date.UTC(2026, 9, 19), { txs: 500, max_minute_txs: 400, active_addresses: null });
    await seed(pool, "stats_day", Date.UTC(2026, 9, 17), { txs: 70, max_minute_txs: 50, active_addresses: 5, new_addresses: 2, new_contracts: 1, verified_contracts: 0 });
    await seed(pool, "stats_day", Date.UTC(2026, 9, 20), { txs: 1046, max_minute_txs: 1000, active_addresses: 11, new_addresses: 4, new_contracts: 2, verified_contracts: 1 });
    await pool.query("insert into cursors (stream, position, detail, updated_at) values ('stats_rollup', $1, $2, $3)", [t(12, 30), JSON.stringify({ extrasAt: NOW - 60_000 }), at(NOW - 5000)]);

    // Live facts. The blocks: 6 transactions 30 s ago count; 60 s ago exactly, 5 s from now, a test run's and one more minute back do not.
    const test = await attempt(pool, await run(pool, true), { cut_at: at(NOW - 3600_000) });
    await block(pool, NOW - 30_000, 6);
    await block(pool, NOW - 60_000, 11);
    await block(pool, NOW + 5000, 13);
    await block(pool, NOW - 10_000, 100, test);
    await block(pool, NOW - 61_000, 17);
    await pool.query("insert into pool_samples (at, waiting) values ($1, 3), ($2, 7)", [at(NOW - 90_000), at(NOW - 20_000)]);
    const life = (n: number, state: string, ageSeconds: number | null, o: Record<string, unknown> = {}) =>
      ins(pool, "tx_lifecycle", { tx_hash: hex(100 + n), state, accepted_at: ageSeconds === null ? null : at(NOW - ageSeconds * 1000), updated_at: at(NOW - 1000 * n), ...o });
    // Open: ages 10 and 30 s are normal (under 2 x the 24.55 s p95 = 49.1 s), 50, 100 and exactly 120 are slow, 121 and 500 are stuck, and one has no acceptance time.
    await life(1, "pending", 10); await life(2, "proving", 30); await life(3, "pending", 50); await life(4, "proving", 100); await life(5, "pending", 120);
    await life(6, "pending", 121); await life(7, "proving", 500); await life(8, "pending", null);
    await life(9, "final", 400); await life(10, "replaced", 400);
    await life(11, "dropped", 40, { state_reason: "nonce too low", updated_at: at(NOW - 100_000) });
    await life(12, "lost", 40, { state_reason: "reth would not take it back", updated_at: at(NOW - 50_000) });
    // Runs: the test run (an hour old) and an older and a newer ordinary one. The strategy is the newest ordinary run's.
    for (const [strategy, ago] of [["timer", 7200_000], ["on_demand", 1800_000]] as const)
      await ins(pool, "producer_runs", { run_id: randomUUID(), started_at: at(NOW - ago), strategy, settings: "{}", source_commit: "x" });
    // Faucet requests (requested_at; state; final_at): in the 24 h window 12:30 - 24 h = 12:30 yesterday (day rows: the day), the 1 h window from 11:31.
    // final in 10 s (B edge 3.49 s < 10 s <= A edge 10.21 s), final in 25 s (C edge 24.55 < 25 <= next), failed, queued, one sent not final, and one 2 hours ago.
    const fq = (n: number, state: string, agoMs: number, o: Record<string, unknown> = {}) =>
      ins(pool, "faucet_requests", { ticket: randomUUID(), address: hex(50 + n), client_key: hex(60 + n), amount: "1", state, requested_at: at(NOW - agoMs), ...o });
    await fq(1, "final", 600_000, { sent_at: at(NOW - 598_000), final_at: at(NOW - 590_000) });
    await fq(2, "final", 500_000, { sent_at: at(NOW - 498_000), final_at: at(NOW - 475_000) });
    await fq(3, "failed", 400_000, { reason: "x" });
    await fq(4, "queued", 10_000);
    await fq(5, "sent", 20_000, { sent_at: at(NOW - 15_000) });
    await fq(6, "final", 7200_000, { sent_at: at(NOW - 7199_000), final_at: at(NOW - 7190_000) });
    // Refusals (counted by minute and reason). The faucet began to count at 08:00. 11:30 is outside the 1 h window, which starts at 11:31.
    await pool.query("update faucet_refusals_since set since = $1", [at(t(8, 0))]);
    const refused = (minute: number, reason: string, n: number) => ins(pool, "faucet_refusals", { minute: at(minute), reason, n });
    await refused(t(11, 30), "hour", 100); await refused(t(11, 31), "hour", 1); await refused(t(12, 10), "address", 3); await refused(t(12, 10), "ip", 2);
    await refused(t(12, 25), "captcha", 4); await refused(t(9, 0), "address", 10); await refused(t(7, 59), "ip", 1000);
  });
  afterAll(async () => { await db?.drop(); });

  it("reads the hour from minute rows: every stat of section 8, as the sum of the rows", async () => {
    const a = await get("/api/stats/summary?window=1h");
    expect(a.status).toBe(200);
    const s = body(a);
    same(s, F.statsSummary);
    expect(s).toMatchObject({ window: "1h", rows: "minute", from: new Date(t(11, 31)).toISOString(), to: new Date(t(12, 31)).toISOString() });
    expect(s.asOf).toBe(new Date(NOW - 5000).toISOString());
    expect(s.dataSince).toBe(new Date(Date.UTC(2026, 9, 17)).toISOString());
    // The 11:30 minute is outside the window: its 1,000 transactions are not the peak. The peak minute is 12:29 with 30, and the rate now is 6 over the last 60 s.
    expect(s.tps).toEqual({ now: 6 / 60, peak: 30 / 60, peakAt: new Date(t(12, 29)).toISOString() });
    // blocks 2+2+3+1 = 8, empty 1+1 = 2, busy 1+1+3 = 5, transactions 4+6+30+2 = 42, failed 1+3 = 4
    expect(s.blocks).toMatchObject({ count: 8, empty: 2, busy: 5 });
    // The rate counts only the chain's own failures: 30 accepted and final, 3 lost, 1 dropped (the 5 replaced and the 4 reverted are in no count of it).
    expect(s.txs).toMatchObject({ count: 42, failed: 4, reverted: 4, successRate: 30 / 34, accepted: 35, acceptedFinal: 30, lost: 3, dropped: 1, delayedByRedo: 5 });
    expect(s.blocks.firstTry).toBe(3 / 7);
    same(s.txs, F.statsTxs);
    // All time, whatever the window. These rows are seeded by hand and are not a rollup's output, so the number only shows the arithmetic: the day rows (500 + 70 + 1046), less the minute rows from a minute before the cursor on (12:29 with 30 and 12:30 with 2), plus the blocks from the same instant (6, 11, 17, 100 and 13).
    same(s.txs.allTime, F.statsAllTime);
    expect(s.txs.allTime).toEqual({ total: 1616 - 32 + 147, asOfBlock: expect.any(Number), asOf: new Date(NOW + 5000).toISOString() });
    expect((await pool.query("select number from blocks where record_time = $1", [at(NOW + 5000)])).rows[0].number).toBe(String(s.txs.allTime.asOfBlock));
    expect(body(await get("/api/stats/summary?window=7d")).txs.allTime).toEqual(s.txs.allTime);
    // per block: 0, 0, 2, 4, 6, 6, 12, 12 -> mean 5.25, the 4th of 8 is 4; without the empty ones 2, 4, 6, 6, 12, 12 -> mean 7, the 3rd of 6 is 6
    expect(s.txsPerBlock).toEqual({ mean: 5.25, median: 4, max: 12, nonEmptyMean: 7, nonEmptyMedian: 6 });
    // busy gaps A and A: both A. Time to final B x5 (4 + 1) and C x1: the 3rd of 6 is B, the 6th is C.
    expect(s.blockTime).toEqual({ median: edge(A), p95: edge(A), samples: 2, capped: false });
    expect(s.timeToFinal).toEqual({ median: edge(B), p95: edge(C), samples: 6, capped: false });
    expect(s.commitTime).toEqual({ median: edge(B), p95: edge(B), samples: 1, capped: false });
    expect(s.served).toEqual({ median: edge(B), p95: edge(C), samples: 2, capped: false });
    // proofs: B (1-10 transactions) and A (11-100): the 1st of 2 is B, the 2nd is A; by size the other three classes have no sample
    same(s.proofTime, F.statsProof);
    expect(s.proofTime).toMatchObject({ median: edge(B), p95: edge(A), samples: 2 });
    expect(s.proofTime.bySize.map((x: { size: string; samples: number }) => [x.size, x.samples])).toEqual([["0", 0], ["1-10", 1], ["11-100", 1], ["101-1000", 0], ["over 1000", 0]]);
    expect(s.proofTime.bySize[0]).toEqual({ size: "0", median: null, p95: null, samples: 0, capped: false });
    expect(s.proofTime.bySize[1]).toEqual({ size: "1-10", median: edge(B), p95: edge(B), samples: 1, capped: false });
    expect(s.proofTime.bySize[2]).toMatchObject({ size: "11-100", median: edge(A), p95: edge(A) });
    // attempts 1+3+4+1 = 9: refused 1+1, failed 1, not taken 1
    expect(s.attempts).toEqual({ total: 9, committed: 3, unknown: 1, decided: 7, refused: 2, failed: 1, notTaken: 1, refusedShare: 2 / 9, failedShare: 1 / 9, notTakenShare: 1 / 9 });
    expect(s.fullness).toBe(950 / 8000);
    // argument bytes 400+600+3000 = 4000 over 8 blocks and 42 transactions; traffic 3000 over the 5 updates that reported it
    expect(s.canton).toEqual({ argumentBytesPerBlock: 500, argumentBytesPerTx: 4000 / 42, trafficBytesPerBlock: 600, trafficReported: 5 });
    // busy 30 + 60 + 10 s = 100 s (the 11:30 minute's is outside), and the test run's 5 s and block are apart. The five ten-minute windows 11:40 to 12:30 hold 70 s in
    // the 12:20 one; the 30 s of 11:31 is before the first whole window. The mean is over the 59 min 20 s that have happened of the window, not the whole hour.
    expect(s.prover).toEqual({ maxBusyRatio10m: 70000 / 600000, windowsOver: 0, windowsCounted: 5, windowSeconds: 600, loadedAbove: 0.6, meanBusyRatio: 100000 / 3560000, busyMs: 100000 });
    expect(s.test).toEqual({ blocks: 1, txs: 9, attempts: 1, proverBusyMs: 5000 });
    expect(s.quality).toEqual({ withoutAcceptanceTime: 1, clockSkew: 1 });
    same(s.today, F.statsToday);
    expect(s.today).toEqual({ date: "2026-10-20", activeAddresses: 11, newAddresses: 4, newContracts: 2, verifiedContracts: 1, countedAt: new Date(NOW - 60_000).toISOString() });
  });

  it("shows what is live: waiting, open by age, stuck listed oldest first, lost newest first", async () => {
    const s = body(await get("/api/stats/summary?window=1h"));
    same(s.waiting, F.statsWaiting); same(s.waiting.pool, F.statsPool);
    expect(s.waiting).toEqual({ open: 8, pool: { waiting: 7, at: new Date(NOW - 20_000).toISOString(), ageSeconds: 20 } });
    same(s.acceptedNotFinal, F.statsOpen);
    expect(s.acceptedNotFinal).toMatchObject({ normal: 2, slow: 3, stuck: 2, noAcceptanceTime: 1, stuckAfterSeconds: 120 });
    expect(s.acceptedNotFinal.slowAfterSeconds).toBeCloseTo(2 * edge(C), 9);
    expect(s.acceptedNotFinal.listed.map((x: { ageSeconds: number }) => x.ageSeconds)).toEqual([500, 121]);
    expect(s.acceptedNotFinal.listed.map((x: { state: string }) => x.state)).toEqual(["proving", "pending"]);
    same(s.acceptedNotFinal.listed[0], F.statsStuckItem);
    expect(s.acceptedNotFinal.listed[0].txHash).toBe("0x" + (107).toString(16).padStart(2, "0").repeat(4));
    // lost: 1 + 2 in the window's rows, 2 transactions in the table, the newer first
    same(s.lost, F.statsLost);
    expect(s.lost.window).toBe(3);
    expect(s.lost.total).toBe(1);
    expect(s.lost.listed.map((x: { state: string; reason: string }) => [x.state, x.reason])).toEqual([["lost", "reth would not take it back"]]);
    same(s.lost.listed[0], F.statsLostItem);
    // dropped apart from lost: 1 in the window's rows, 1 in the table; replaced: 2 + 1 in the rows, 1 in the table (no list: a replaced transaction was not lost)
    same(s.dropped, F.statsLost); same(s.replaced, F.statsReplaced);
    expect(s.dropped).toMatchObject({ window: 1, total: 1 });
    expect(s.dropped.listed.map((x: { state: string; reason: string }) => [x.state, x.reason])).toEqual([["dropped", "nonce too low"]]);
    expect(s.replaced).toEqual({ window: 3, total: 1 });
    // open: proving 30, 100, 500 s old = 3, pending 10, 50, 120, 121 s old and the one with no time = 5
    expect(s.acceptedNotFinal).toMatchObject({ beingProven: 3, waiting: 5 });
  });

  it("counts blocks by size class from the rows, apart from the proofs", async () => {
    const s = body(await get("/api/stats/summary?window=1h"));
    // blocks: 0 txs x2 (11:31, 12:28); 1-10 txs: 4 (11:31), 6 (12:28), 6 (12:29), 2 (12:30); 11-100 txs: 12 x2 (12:29). Proofs are 2 (B and A): a different count.
    expect(s.blocks.bySize).toEqual([{ size: "0", count: 2 }, { size: "1-10", count: 4 }, { size: "11-100", count: 2 }, { size: "101-1000", count: 0 }, { size: "over 1000", count: 0 }]);
    expect(s.blocks.bySize.reduce((a: number, x: { count: number }) => a + x.count, 0)).toBe(s.blocks.count);
    expect(s.proofTime.bySize.map((x: { samples: number }) => x.samples)).toEqual([0, 1, 1, 0, 0]);
  });

  it("sums the refusals only for a window the counting covers: a longer window reads when the counting began and nothing more", async () => {
    const spy = vi.spyOn(pool, "query");
    const sums = () => spy.mock.calls.filter(([q]) => String(typeof q === "string" ? q : (q as { text: string }).text).includes("from faucet_refusals where")).length;
    await get("/api/stats/summary?window=30d");
    await get("/api/stats/summary?window=6h");
    expect(sums()).toBe(0);
    await get("/api/stats/summary?window=1h");
    expect(sums()).toBe(1);
    spy.mockRestore();
  });

  it("names the cutting strategy of the newest ordinary run, and reads the faucet's requests of the window", async () => {
    const s = body(await get("/api/stats/summary?window=1h"));
    same(s.cutting, F.statsCutting);
    expect(s.cutting).toEqual({ strategy: "on_demand", since: new Date(NOW - 1800_000).toISOString() });
    // 1 h window: requests 600, 500, 400, 10, 20 s old = 5 (the one 2 h old is outside); sent (sent_at set) 3; final 2, failed 1. The times from request to final: 10 s and 25 s.
    same(s.faucet, F.statsFaucet);
    expect(s.faucet).toMatchObject({ requests: 5, sent: 3, final: 2, failed: 1 });
    expect(s.faucet.timeToFinal).toEqual({ median: edge(A), p95: edge(C + 1), samples: 2, capped: false });
    const d = body(await get("/api/stats/summary?window=6h"));
    expect(d.faucet).toMatchObject({ requests: 6, sent: 4, final: 3, failed: 1 });
  });

  it("adds the faucet's refusals of the window by reason, and gives none for a window that starts before they were counted", async () => {
    const s = body(await get("/api/stats/summary?window=1h"));
    same(s.faucet.turnedAway, F.statsTurnedAway);
    same(s.faucet.turnedAway.byReason, F.statsTurnedAwayReasons);
    // 11:31 to 12:30: the minute 11:30 is out, so hour is 1; 12:10 address 3 and ip 2; 12:25 captcha 4.
    expect(s.faucet.turnedAway).toEqual({ total: 10, byReason: { address: 3, ip: 2, hour: 1, captcha: 4 } });
    expect(s.faucet.turnedAwaySince).toBe(new Date(t(8, 0)).toISOString());
    // 6 h: 06:31 to 12:30 starts before 08:00, so the window is not fully recorded: no count at all, not a partial one
    const six = body(await get("/api/stats/summary?window=6h"));
    expect(six.faucet.turnedAway).toBeNull();
    expect(six.faucet.turnedAwaySince).toBe(new Date(t(8, 0)).toISOString());
    expect(body(await get("/api/stats/summary?window=24h")).faucet.turnedAway).toBeNull();
    expect(body(await get("/api/stats/summary?window=30d")).faucet.turnedAway).toBeNull();
  });

  it("counts a window that starts exactly when the counting began", async () => {
    await pool.query("update faucet_refusals_since set since = $1", [at(t(6, 31))]);
    try {
      const six = body(await get("/api/stats/summary?window=6h"));
      expect(six.faucet.turnedAway).toEqual({ total: 1120, byReason: { address: 13, ip: 1002, hour: 101, captcha: 4 } });
    } finally { await pool.query("update faucet_refusals_since set since = $1", [at(t(8, 0))]); }
  });

  it("gives no turned-away count and no start when the faucet never counted (no start recorded)", async () => {
    await pool.query("delete from faucet_refusals_since");
    try {
      const s = body(await get("/api/stats/summary?window=1h"));
      expect(s.faucet.turnedAway).toBeNull();
      expect(s.faucet.turnedAwaySince).toBeNull();
    } finally { await pool.query("insert into faucet_refusals_since (since) values ($1)", [at(t(8, 0))]); }
  });

  it("splits no open transaction into normal and slow while there is no time to final to measure against", async () => {
    // 30 d reads day rows, which hold no time to final here
    const s = body(await get("/api/stats/summary?window=30d"));
    expect(s.rows).toBe("day");
    expect(s.timeToFinal).toBeNull();
    expect(s.acceptedNotFinal).toMatchObject({ normal: null, slow: null, stuck: 2, slowAfterSeconds: null });
    expect(s.txs.count).toBe(500 + 70 + 1046);
    expect(s.from).toBe(new Date(Date.UTC(2026, 9, 21) - 30 * DAY).toISOString());
    expect(s.to).toBe(new Date(Date.UTC(2026, 9, 21)).toISOString());
  });

  it("reads 24 h and 7 d from hour rows, and a window left out is 24 h", async () => {
    const d = body(await get("/api/stats/summary"));
    expect(d).toMatchObject({ window: "24h", rows: "hour", from: new Date(t(13, 0) - DAY).toISOString(), to: new Date(t(13, 0)).toISOString() });
    expect(d.txs.count).toBe(1004 + 42);
    expect(d.timeToFinal).toEqual({ median: edge(B), p95: edge(C), samples: 10, capped: false });
    // the peak is read from minutes, whatever the window: 11:30 is inside the 24 h, with 1,000 in it
    expect(d.tps.peak).toBe(1000 / 60);
    expect(body(await get("/api/stats/summary?window=7d")).rows).toBe("hour");
  });

  it("draws txs and tps from minutes: a step with no row is 0, and 10 m steps are cut from the clock", async () => {
    const m = await sum("/api/stats/series?metric=txs&window=1h");
    expect(m).toMatchObject({ metric: "txs", unit: "count", window: "1h", step: "1m", from: new Date(t(11, 31)).toISOString(), to: new Date(t(12, 31)).toISOString(), asOf: new Date(NOW - 5000).toISOString() });
    expect(m.points).toHaveLength(60);
    same(m.points[0], F.statsPoint);
    expect(m.points[0]).toEqual({ at: new Date(t(11, 31)).toISOString(), value: 4 });
    expect(m.points.at(-1)).toEqual({ at: new Date(t(12, 30)).toISOString(), value: 2 });
    const byAt = Object.fromEntries(m.points.map((p: { at: string; value: number }) => [p.at.slice(11, 16), p.value]));
    expect([byAt["12:28"], byAt["12:29"], byAt["12:00"], byAt["11:31"]]).toEqual([6, 30, 0, 4]);
    // 10 m steps: 11:40 to 12:40, so the 11:31 minute is outside; 12:28 and 12:29 make 36 in the 12:20 step
    const ten = await sum("/api/stats/series?metric=txs&window=1h&step=10m");
    expect(ten.step).toBe("10m");
    expect(ten.from).toBe(new Date(t(11, 40)).toISOString());
    expect(values(ten)).toEqual([0, 0, 0, 0, 36, 2]);
    expect(values(await sum("/api/stats/series?metric=tps&window=1h&step=10m"))).toEqual([0, 0, 0, 0, 36 / 600, 2 / 600]);
    expect(body(await get("/api/stats/series?metric=tps&window=1h")).points.find((p: { at: string }) => p.at.endsWith("12:29:00.000Z")).value).toBe(0.5);
  });

  it("draws the busiest minute of each step as a rate: the largest minute's transactions over 60 s, from minutes for a short window and from the hour and day rows for a long one", async () => {
    const one = await sum("/api/stats/series?metric=busiest_minute_tps&window=1h");
    expect(one).toMatchObject({ metric: "busiest_minute_tps", unit: "per second", step: "1m" });
    expect(one.points.find((p: { at: string }) => p.at.endsWith("12:29:00.000Z")).value).toBe(0.5);
    // 10 m steps: the 12:20 step holds the 12:28 (6) and 12:29 (30) minutes: its busiest is 30, not their sum.
    expect(values(await sum("/api/stats/series?metric=busiest_minute_tps&window=1h&step=10m"))).toEqual([0, 0, 0, 0, 30 / 60, 2 / 60]);
    const day = await sum("/api/stats/series?metric=busiest_minute_tps&window=24h&step=1h");
    expect(day.points.find((p: { at: string }) => p.at.endsWith("11:00:00.000Z")).value).toBe(1000 / 60);
    expect(day.points.find((p: { at: string }) => p.at.endsWith("12:00:00.000Z")).value).toBe(30 / 60);
    const days = await sum("/api/stats/series?metric=busiest_minute_tps&window=7d&step=1d");
    expect(days.points.find((p: { at: string }) => p.at.startsWith("2026-10-19")).value).toBe(400 / 60);
  });

  it("draws rates, shares and times: null where there is nothing to divide or to rank", async () => {
    const ok = await sum("/api/stats/series?metric=success_rate&window=1h");
    const at_ = (s: Record<string, any>, hhmm: string) => s.points.find((p: { at: string }) => p.at.slice(11, 16) === hhmm).value; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect([at_(ok, "12:28"), at_(ok, "12:29"), at_(ok, "11:31"), at_(ok, "12:00")]).toEqual([8 / 10, 18 / 20, 1, null]);
    expect(ok.unit).toBe("ratio");
    const p95 = await sum("/api/stats/series?metric=time_to_final_p95&window=1h");
    const p50 = await sum("/api/stats/series?metric=time_to_final_p50&window=1h");
    expect(p95.unit).toBe("seconds");
    expect([at_(p50, "12:28"), at_(p95, "12:28"), at_(p95, "12:29")]).toEqual([edge(B), edge(C), null]);
    expect(at_(await sum("/api/stats/series?metric=fullness&window=1h"), "12:28")).toBe(0.1);
    expect(at_(await sum("/api/stats/series?metric=txs_per_block&window=1h"), "12:29")).toBe(10);
    expect(at_(await sum("/api/stats/series?metric=blocks&window=1h"), "12:29")).toBe(3);
    expect(at_(await sum("/api/stats/series?metric=lost&window=1h"), "12:29")).toBe(2);
    expect(at_(await sum("/api/stats/series?metric=served_p95&window=1h"), "12:28")).toBe(edge(C));
    expect(at_(await sum("/api/stats/series?metric=proof_time_p50&window=1h"), "12:28")).toBe(edge(A));
  });

  it("draws the busy ratio in 10 m, 1 h or 1 d steps only: busy time over the step", async () => {
    const r = await sum("/api/stats/series?metric=busy_ratio&window=1h&step=10m");
    expect(r.unit).toBe("ratio");
    // 12:28 and 12:29 add 60 s and 10 s to the 12:20 step of 600 s
    expect(values(r)).toEqual([0, 0, 0, 0, 70000 / 600000, 0]);
    // 24 h in hours: 100 s in the 12:00 hour, and the 11:00 hour holds the 11:30 minute's 999.999 s as well
    const h = await sum("/api/stats/series?metric=busy_ratio&window=24h");
    expect(h.points).toHaveLength(24);
    expect(h.points.at(-2).value).toBe(1029999 / 3600000);
    expect(h.points.at(-1).value).toBe(100000 / 3600000);
    expect((await get("/api/stats/series?metric=busy_ratio&window=1h&step=1m")).status).toBe(400);
  });

  it("draws 24 h in hours, 7 d in hours or days and 30 d in days from the rows of that table", async () => {
    const h = await sum("/api/stats/series?metric=txs&window=24h");
    expect(h).toMatchObject({ step: "1h", from: new Date(t(13, 0) - DAY).toISOString(), to: new Date(t(13, 0)).toISOString() });
    expect(h.points).toHaveLength(24);
    expect(h.points.slice(-3).map((p: { value: number }) => p.value)).toEqual([0, 1004, 42]);
    expect(values(h).reduce((a, b) => (a as number) + (b as number), 0)).toBe(1046);
    const w = await sum("/api/stats/series?metric=txs&window=7d");
    expect(w.step).toBe("1h"); expect(w.points).toHaveLength(168);
    const d = await sum("/api/stats/series?metric=txs&window=7d&step=1d");
    expect(d.points).toHaveLength(7);
    expect(d.points.map((p: { at: string }) => p.at.slice(5, 10))).toEqual(["10-14", "10-15", "10-16", "10-17", "10-18", "10-19", "10-20"]);
    expect(values(d)).toEqual([0, 0, 0, 70, 0, 500, 1046]);
    const month = await sum("/api/stats/series?metric=txs&window=30d");
    expect(month.step).toBe("1d"); expect(month.points).toHaveLength(30);
    expect(values(month).slice(-4)).toEqual([70, 0, 500, 1046]);
  });

  it("draws the daily address and contract counts: null where the day's extras are not counted, 0 where there is no row", async () => {
    const a = await sum("/api/stats/series?metric=active_addresses&window=7d");
    expect(a.step).toBe("1d");
    expect(values(a)).toEqual([0, 0, 0, 5, 0, null, 11]);
    expect(values(await sum("/api/stats/series?metric=new_contracts&window=7d"))).toEqual([0, 0, 0, 1, 0, null, 2]);
    expect(values(await sum("/api/stats/series?metric=verified_contracts&window=7d")).slice(-1)).toEqual([1]);
    expect(values(await sum("/api/stats/series?metric=new_addresses&window=30d")).slice(-4)).toEqual([2, 0, null, 4]);
  });

  it("refuses a bad window, step or metric with a 400 and the allowed values, never cached", async () => {
    const bad = async (path: string, text: RegExp) => {
      const a = await get(path);
      expect(a.status, path).toBe(400);
      expect(body(a).error, path).toMatch(text);
      expect(a.headers?.["cache-control"], path).toBeUndefined();
    };
    await bad("/api/stats/summary?window=2h", /window is one of 1h, 6h, 24h, 7d, 30d/);
    await bad("/api/stats/summary?window=", /window is one of/);
    await bad("/api/stats/summary?window=toString", /window is one of/);
    await bad("/api/stats/series?metric=txs&window=2h", /window is one of/);
    await bad("/api/stats/series?window=1h", /metric is one of/);
    await bad("/api/stats/series?metric=nonsense", /metric is one of/);
    await bad("/api/stats/series?metric=constructor", /metric is one of/);
    await bad("/api/stats/series?metric=txs&step=5m", /step for txs over 24h is one of 1h/);
    await bad("/api/stats/series?metric=txs&window=24h&step=1m", /one of 1h/);
    await bad("/api/stats/series?metric=txs&window=1h&step=1h", /one of 1m, 10m/);
    await bad("/api/stats/series?metric=txs&window=30d&step=1h", /one of 1d/);
    await bad("/api/stats/series?metric=txs&window=7d&step=1m", /one of 1h, 1d/);
    await bad("/api/stats/series?metric=busy_ratio&window=1h&step=1m", /one of 10m/);
    await bad("/api/stats/series?metric=busy_ratio&window=30d&step=1h", /one of 1d/);
    await bad("/api/stats/series?metric=active_addresses&window=24h", /cannot be drawn over 24h: use a window of 7d, 30d/);
    await bad("/api/stats/series?metric=active_addresses&window=7d&step=1h", /one of 1d/);
    expect((await get("/api/stats/summary", "POST")).status).toBe(405);
  });

  it("holds every metric to the steps of its windows, and draws each one", async () => {
    for (const metric of Object.keys(METRICS)) {
      for (const [window, steps] of Object.entries(WINDOW_STEPS)) {
        const allowed = steps.filter((s) => !METRICS[metric]!.steps || METRICS[metric]!.steps!.includes(s));
        if (!allowed.length) { expect((await get(`/api/stats/series?metric=${metric}&window=${window}`)).status).toBe(400); continue; }
        for (const step of allowed) {
          const a = await get(`/api/stats/series?metric=${metric}&window=${window}&step=${step}`);
          expect(a.status, `${metric} ${window} ${step}`).toBe(200);
          expect(body(a).step).toBe(step);
          expect(body(a).points.length).toBeLessThanOrEqual(360);
        }
      }
    }
  });

  it("caches an answer for a second with a tag, and the tag changes with the body", async () => {
    const a = await get("/api/stats/series?metric=txs&window=1h");
    expect(a.headers?.["cache-control"]).toBe(CACHE_CONTROL.list);
    expect(a.headers?.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await get("/api/stats/series?metric=txs&window=1h")).headers?.etag).toBe(a.headers?.etag);
    expect((await get("/api/stats/series?metric=blocks&window=1h")).headers?.etag).not.toBe(a.headers?.etag);
    const s = await get("/api/stats/summary?window=1h");
    expect(s.headers?.["cache-control"]).toBe(CACHE_CONTROL.list);
    expect(s.headers?.etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("cuts its buckets from the clock: a minute, an hour and a day end exactly on their edge", async () => {
    const last = async (path: string, now: number) => (body(await apiFor(pool, () => now)(path)).points.at(-1) as { at: string }).at;
    expect(await last("/api/stats/series?metric=txs&window=1h", t(12, 30, 59) + 999)).toBe(new Date(t(12, 30)).toISOString());
    expect(await last("/api/stats/series?metric=txs&window=1h", t(12, 31))).toBe(new Date(t(12, 31)).toISOString());
    expect(await last("/api/stats/series?metric=txs&window=24h", t(12, 59, 59) + 999)).toBe(new Date(t(12, 0)).toISOString());
    expect(await last("/api/stats/series?metric=txs&window=24h", t(13, 0))).toBe(new Date(t(13, 0)).toISOString());
    expect(await last("/api/stats/series?metric=txs&window=30d", Date.UTC(2026, 9, 20, 23, 59, 59) + 999)).toBe(new Date(Date.UTC(2026, 9, 20)).toISOString());
    expect(await last("/api/stats/series?metric=txs&window=30d", Date.UTC(2026, 9, 21))).toBe(new Date(Date.UTC(2026, 9, 21)).toISOString());
    // the 12:30 row is in the window at both edges; a row of the minute that has just begun is only in the second
    await seed(pool, "stats_minute", t(12, 31), { blocks: 1, txs: 77 });
    const edgeSeries = async (now: number) => Object.fromEntries((body(await apiFor(pool, () => now)("/api/stats/series?metric=txs&window=1h")).points as { at: string; value: number }[]).map((p) => [p.at.slice(11, 16), p.value]));
    const before = await edgeSeries(t(12, 30, 59) + 999), after = await edgeSeries(t(12, 31));
    expect(before["12:30"]).toBe(2); expect(before["12:31"]).toBeUndefined();
    expect(after["12:30"]).toBe(2); expect(after["12:31"]).toBe(77);
    expect(Object.keys(after)[0]).toBe("11:32");
    // a clock that runs before the data (the newest row is in the future) leaves it out until its minute
    expect(body(await get("/api/stats/series?metric=txs&window=1h")).points.some((p: { value: number }) => p.value === 77)).toBe(false);
    await pool.query("delete from stats_minute where bucket = $1", [at(t(12, 31))]);
  });
});

describe.skipIf(!TEST_URL)("the stats routes over the real rollup", () => {
  it("meet: a block, a test run's block and an attempt are rolled up, and the summary reads them back", async () => {
    const db = await makeDatabase();
    try {
      const pool = db.pool;
      await base(pool);
      const live = await attempt(pool, await run(pool, false), { cut_at: at(t(12, 29, 5)), proof_started_at: at(t(12, 29, 6)), proof_ended_at: at(t(12, 29, 9)), proof_outcome: "ok", outcome: "committed", tx_count: 5, submitted_at: at(t(12, 29, 9)), answered_at: at(t(12, 29, 12)) });
      const test = await attempt(pool, await run(pool, true), { cut_at: at(t(12, 29, 20)), proof_started_at: at(t(12, 29, 21)), proof_ended_at: at(t(12, 29, 23)), proof_outcome: "ok", tx_count: 7 });
      await block(pool, t(12, 29, 12), 5, live);
      await block(pool, t(12, 29, 30), 7, test);
      expect((await rollupStats(pool, { now: () => NOW })).minutes).toBeGreaterThan(0);
      // a second run changes nothing
      const dump = async () => JSON.stringify((await pool.query("select * from stats_minute order by bucket")).rows);
      const once = await dump();
      await rollupStats(pool, { now: () => NOW });
      expect(await dump()).toBe(once);
      const s = body(await apiFor(pool, () => NOW)("/api/stats/summary?window=1h"));
      expect(s.asOf).toBe(new Date(NOW).toISOString());
      expect(s.txs.count).toBe(5);
      // The rollups reach 12:30:00 and hold both blocks (5 + 7, the test run's too); a block made after that is counted from the blocks, not the rollups, and is the one the total is as of.
      expect(s.txs.allTime).toMatchObject({ total: 12, asOf: new Date(t(12, 29, 30)).toISOString() });
      await block(pool, t(12, 30, 10), 3);
      const late = body(await apiFor(pool, () => NOW + 1000)("/api/stats/summary?window=1h")).txs.allTime;
      expect(late.total).toBe(15);
      expect(late.total).toBe(Number((await pool.query("select sum(tx_count) as n from blocks")).rows[0].n));
      expect(late.asOf).toBe(new Date(t(12, 30, 10)).toISOString());
      expect(late.asOfBlock).toBe(Number((await pool.query("select max(number) as n from blocks")).rows[0].n));
      await pool.query("delete from stats_day");
      expect(body(await apiFor(pool, () => NOW + 1000)("/api/stats/summary?window=1h")).txs.allTime).toBeNull();
      expect(s.blocks.count).toBe(1);
      expect(s.test).toMatchObject({ blocks: 1, txs: 7, attempts: 1, proverBusyMs: 2000 });
      expect(s.tps.peak).toBe(5 / 60);
      expect(s.prover.busyMs).toBe(3000);
      expect(s.proofTime).toMatchObject({ samples: 1 });
      // 3 s of proof lands in the bucket whose upper edge is the first one above 3 s
      expect(s.proofTime.median).toBeGreaterThanOrEqual(3);
      expect(s.proofTime.median).toBeLessThanOrEqual(3 * 1.05);
      expect(s.commitTime.samples).toBe(1);
      expect(s.served.samples).toBe(1);
    } finally { await db.drop(); }
  });

  // The all-time total against the real rollup: each case must equal `select count(*) from transactions`, on the stats summary and on /api/txs (the fixture gives every block its transaction rows).
  describe("the all-time total, exact whatever the rollup has written", () => {
    const direct = async (pool: Pool) => Number((await pool.query("select count(*) as n from transactions")).rows[0].n);
    const total = async (pool: Pool, now: number) => body(await apiFor(pool, () => now)("/api/stats/summary?window=1h")).txs.allTime;
    const listTotal = async (pool: Pool, now: number) => body(await listApiFor(pool, () => now)("/api/txs")).total;
    const withDb = async (fn: (pool: Pool) => Promise<void>) => {
      const db = await makeDatabase();
      try { await base(db.pool); await fn(db.pool); } finally { await db.drop(); }
    };

    it("a block in the open minute when the rollup runs is counted once", () => withDb(async (pool) => {
      await blockWithTxs(pool, t(12, 29, 12), 5);
      await blockWithTxs(pool, t(12, 30, 10), 3);
      await rollupStats(pool, { now: () => NOW });
      // the rollup holds both blocks, the open minute's too, and leaves its cursor at the start of that minute
      expect(Number((await pool.query("select sum(txs) as n from stats_day")).rows[0].n)).toBe(8);
      expect(Number((await pool.query("select position from cursors where stream = 'stats_rollup'")).rows[0].position)).toBe(t(12, 30));
      const a = await total(pool, NOW + 1000);
      expect(a.total).toBe(8);
      expect(a.total).toBe(await direct(pool));
      expect(await listTotal(pool, NOW + 1000)).toBe(8);
    }));

    it("a new block after a rollup, then a rollup run again, is counted once at each step", () => withDb(async (pool) => {
      await blockWithTxs(pool, t(12, 29, 12), 5);
      await rollupStats(pool, { now: () => NOW });
      expect((await total(pool, NOW + 1000)).total).toBe(5);
      await blockWithTxs(pool, t(12, 30, 10), 3);
      expect((await total(pool, NOW + 1000)).total).toBe(8);
      await rollupStats(pool, { now: () => NOW + 5000 });
      expect((await total(pool, NOW + 6000)).total).toBe(8);
      await blockWithTxs(pool, t(12, 30, 40), 4);
      await rollupStats(pool, { now: () => NOW + 25_000 });
      await rollupStats(pool, { now: () => NOW + 35_000 });
      const c = await total(pool, NOW + 36_000);
      expect(c.total).toBe(12);
      expect(c.total).toBe(await direct(pool));
      expect(c.asOf).toBe(new Date(t(12, 30, 40)).toISOString());
    }));

    it("a late block whose minute the repair run remakes is counted once, before and after the repair", () => withDb(async (pool) => {
      await blockWithTxs(pool, t(12, 20, 12), 5);
      await blockWithTxs(pool, t(12, 29, 12), 2);
      await blockWithTxs(pool, t(12, 30, 10), 3);
      await rollupStats(pool, { now: () => NOW });
      expect((await total(pool, NOW + 1000)).total).toBe(10);
      // a block caught up late, in a minute the cursor has passed: the writer leaves the minute dirty for the next run
      await blockWithTxs(pool, t(12, 25, 30), 7);
      expect(Number((await pool.query("select count(*) as n from stats_dirty")).rows[0].n)).toBeGreaterThan(0);
      // until that run the late block is in no rollup and is before the cut: not yet in the total, and nothing is counted twice
      expect((await total(pool, NOW + 1000)).total).toBe(10);
      await rollupStats(pool, { now: () => NOW + 10_000 });
      const after = await total(pool, NOW + 11_000);
      expect(after.total).toBe(17);
      expect(after.total).toBe(await direct(pool));
      await rollupStats(pool, { now: () => NOW + 20_000 });
      expect((await total(pool, NOW + 21_000)).total).toBe(17);
    }));

    it("a block indexed just after a minute boundary, with a record time in the minute before it, is counted at once", () => withDb(async (pool) => {
      await blockWithTxs(pool, t(12, 30, 10), 3);
      // the first run of the new minute moves the cursor to 12:32:00
      const run2 = t(12, 32, 2);
      await rollupStats(pool, { now: () => run2 });
      expect(Number((await pool.query("select position from cursors where stream = 'stats_rollup'")).rows[0].position)).toBe(t(12, 32));
      // then a block with a record time of 12:31:59.5 is indexed: in no rollup yet, and in the minute before the cursor
      await blockWithTxs(pool, t(12, 31, 59) + 500, 2);
      const a = await total(pool, run2 + 1000);
      expect(a.total).toBe(5);
      expect(a.total).toBe(await direct(pool));
      expect(a.asOf).toBe(new Date(t(12, 31, 59) + 500).toISOString());
      expect(await listTotal(pool, run2 + 1000)).toBe(5);
      // and the run after it holds the block, still once
      await rollupStats(pool, { now: () => run2 + 10_000 });
      expect((await total(pool, run2 + 11_000)).total).toBe(5);
      expect(await listTotal(pool, run2 + 11_000)).toBe(5);
    }));
  });
});


describe.skipIf(!TEST_URL)("the stats routes: a day with two busy hours", () => {
  let db: TestDatabase, get: ReturnType<typeof apiFor>;
  beforeAll(async () => {
    db = await makeDatabase(); await base(db.pool); get = apiFor(db.pool, () => NOW);
    // The prover is busy for every second of 10:00 to 11:59 (a minute row of 60 s each), and for 30 s of 06:15: a loaded stretch, and one that is not.
    for (let m = 0; m < 120; m++) await seed(db.pool, "stats_minute", t(10, 0) + m * MINUTE, { proof_busy_ms: 60000 });
    await seed(db.pool, "stats_minute", t(6, 15), { proof_busy_ms: 30000 });
    for (const [h, ms] of [[10, 3600000], [11, 3600000], [6, 30000]] as const) await seed(db.pool, "stats_hour", t(h, 0), { proof_busy_ms: ms });
  });
  afterAll(async () => { await db?.drop(); });

  it("gives the largest ten-minute ratio and the windows above 0.6, and the mean only as a mean", async () => {
    const s = body(await get("/api/stats/summary?window=24h"));
    // 24 h window: from 13:00 the day before (the hour's end is 13:00) to 12:30:20; whole ten-minute windows 13:00 .. 12:30 = 141; twelve are fully busy
    expect(s.prover).toEqual({ maxBusyRatio10m: 1, windowsOver: 12, windowsCounted: 141, windowSeconds: 600, loadedAbove: 0.6, meanBusyRatio: 7230000 / 84620000, busyMs: 7230000 });
    expect(s.prover.meanBusyRatio).toBeLessThan(0.09);
  });

  it("draws the ten-minute ratios across a whole day", async () => {
    const r = body(await get("/api/stats/series?metric=busy_ratio&window=24h&step=10m"));
    expect(r.points).toHaveLength(144);
    expect(r.points.filter((p: { value: number }) => p.value === 1)).toHaveLength(12);
    expect((await get("/api/stats/series?metric=busy_ratio&window=24h&step=1m")).status).toBe(400);
  });
});

describe.skipIf(!TEST_URL)("the stats routes: minutes with blocks and no transaction", () => {
  let db: TestDatabase, get: ReturnType<typeof apiFor>;
  beforeAll(async () => {
    db = await makeDatabase(); await base(db.pool); get = apiFor(db.pool, () => NOW);
    // Two minutes in the hour in which blocks were cut and none of them carried a transaction.
    await seed(db.pool, "stats_minute", t(12, 0), { blocks: 1, empty_blocks: 1 });
    await seed(db.pool, "stats_minute", t(12, 1), { blocks: 2, empty_blocks: 2 });
  });
  afterAll(async () => { await db?.drop(); });

  it("has no busiest minute, because none had a transaction: the peak is null, not 0 tx/s at a minute named busiest", async () => {
    const s = body(await get("/api/stats/summary?window=1h"));
    expect(s.blocks.count).toBe(3);
    expect(s.tps).toEqual({ now: 0, peak: null, peakAt: null });
  });
});

describe.skipIf(!TEST_URL)("the stats routes: the switching rule's two numbers by hour and by day", () => {
  let db: TestDatabase, get: ReturnType<typeof apiFor>;
  beforeAll(async () => {
    db = await makeDatabase(); await base(db.pool); get = apiFor(db.pool, () => NOW);
    // Ten-minute windows above 0.6 on 20 October (10:00 to 11:59, twelve of them), and one on 19 October (14:00 to 14:09).
    for (let m = 0; m < 120; m++) await seed(db.pool, "stats_minute", t(10, 0) + m * MINUTE, { proof_busy_ms: 60000 });
    for (let m = 0; m < 10; m++) await seed(db.pool, "stats_minute", t(14, 0) - DAY + m * MINUTE, { proof_busy_ms: 60000 });
    // The p95 time to final of three hours: 06:00 the worst (bucket 165), 10:00 above 20 s (bucket C), 11:00 below it (bucket B), 09:00 and the open hour 12:00 above it (not counted: 12:00 is open).
    await seed(db.pool, "stats_hour", t(6, 0), { time_to_final_hist: time({ 165: 10, [A]: 1 }) });
    await seed(db.pool, "stats_hour", t(10, 0), { time_to_final_hist: time({ [C]: 5 }) });
    await seed(db.pool, "stats_hour", t(11, 0), { time_to_final_hist: time({ [B]: 5 }) });
    await seed(db.pool, "stats_hour", t(12, 0), { time_to_final_hist: time({ 170: 5 }) });
  });
  afterAll(async () => { await db?.drop(); });

  it("counts the hours above 20 s and names the worst hour, from the hours that have ended", async () => {
    const s = body(await get("/api/stats/summary?window=24h"));
    same(s.rule, F.statsRule);
    // 24 h window: the hours 13:00 the day before to 11:00 have ended: 23 of them; three have a time to final
    expect(s.rule).toMatchObject({ slowAboveSeconds: 20, hoursCounted: 23, hoursMeasured: 3, hoursAbove: 2, worstHourAt: new Date(t(6, 0)).toISOString() });
    expect(s.rule.worstHourP95).toBeCloseTo(edge(165), 6);
  });

  it("reads the hours from the hour rows when the window is drawn in minutes", async () => {
    const s = body(await get("/api/stats/summary?window=6h"));
    // 6 h window: 06:31 .. 12:31 (to is the end of the open minute); the hours that have ended inside it: 07:00 to 11:00, so the 06:00 hour is outside
    expect(s.rule).toMatchObject({ hoursCounted: 5, hoursMeasured: 2, hoursAbove: 1, worstHourAt: new Date(t(10, 0)).toISOString() });
    expect(s.rule.worstHourP95).toBeCloseTo(edge(C), 6);
  });

  it("counts the ten-minute windows above 0.6 for each UTC day, the days with none included (the 14:00 window of the 19th is in the 24 h window)", async () => {
    const s = body(await get("/api/stats/summary?window=24h"));
    // the whole windows from 13:00 on the 19th to 12:30 on the 20th: 66 on the 19th (13:00 to 23:50), 75 on the 20th
    expect(s.rule.windowsOverByDay).toEqual([
      { day: "2026-10-19", windowsOver: 1, windowsCounted: 66 },
      { day: "2026-10-20", windowsOver: 12, windowsCounted: 75 },
    ]);
    for (const d of s.rule.windowsOverByDay) same(d, F.statsRuleDay);
    const wide = body(await get("/api/stats/summary?window=7d"));
    const by = Object.fromEntries(wide.rule.windowsOverByDay.map((d: { day: string; windowsOver: number }) => [d.day, d.windowsOver]));
    expect(by["2026-10-19"]).toBe(1);
    expect(by["2026-10-20"]).toBe(12);
    expect(wide.rule.windowsOverByDay.reduce((n: number, d: { windowsCounted: number }) => n + d.windowsCounted, 0)).toBe(wide.prover.windowsCounted);
  });

  it("says nothing was measured with no hour and no window behind it: null, not 0", async () => {
    const e = await makeDatabase();
    try {
      await base(e.pool);
      const s = body(await apiFor(e.pool, () => NOW)("/api/stats/summary?window=24h"));
      expect(s.rule.hoursCounted).toBeGreaterThan(0); // hours went by, none with a time to final: hoursAbove says nothing, not 0
      expect(s.rule).toMatchObject({ hoursMeasured: 0, hoursAbove: null, worstHourP95: null, worstHourAt: null });
      expect(s.rule.windowsOverByDay.every((d: { windowsOver: number }) => d.windowsOver === 0)).toBe(true);
    } finally { await e.drop(); }
  });
});

describe.skipIf(!TEST_URL)("the stats routes: days before the first record", () => {
  it("lists no day, and counts no window, before dataSince: 'idle' is for a day that was recorded", async () => {
    const e = await makeDatabase();
    try {
      await base(e.pool);
      await seed(e.pool, "stats_day", Date.UTC(2026, 9, 20), { txs: 5 }); // the first (and only) day with a record: the 20th, and it is 12:30 on it
      const s = body(await apiFor(e.pool, () => NOW)("/api/stats/summary?window=30d"));
      expect(s.dataSince).toBe(new Date(Date.UTC(2026, 9, 20)).toISOString());
      expect(s.rule.windowsOverByDay).toEqual([{ day: "2026-10-20", windowsOver: 0, windowsCounted: 75 }]); // 00:00 to 12:20; the 30 days before it are not 'idle'
      expect(s.prover.windowsCounted).toBe(75);
      expect(s.rule.hoursCounted).toBe(12); // the ended hours from 00:00 to 12:00 on the 20th; none of the 29 days before it
    } finally { await e.drop(); }
  });
});

describe("slowHours from the first day with a record", () => {
  it("counts no hour before `since`, and the whole range when `since` is not known", () => {
    const d0 = Date.UTC(2026, 9, 19), since = d0 + DAY;
    expect(slowHours([], d0 + 5 * HOUR, since + 3 * HOUR, since).counted).toBe(3);
    expect(slowHours([], d0 + 5 * HOUR, since + 3 * HOUR).counted).toBe(19 + 3);
    expect(slowHours([], d0, d0 + DAY, since).counted).toBe(0);
  });
});

describe("busyWindows by day", () => {
  it("leaves out the windows before the first day with a record: nothing was recorded then, so 'idle' would be a claim", () => {
    const d0 = Date.UTC(2026, 9, 19), since = d0 + DAY; // data from the 20th; the range starts on the 19th
    const r = busyWindows([], d0 + 5 * HOUR, since + 3 * HOUR, since);
    expect(r.byDay).toEqual([{ day: since, over: 0, counted: 18 }]);
    expect(r.counted).toBe(18);
    expect(busyWindows([], d0 + 5 * HOUR, since + 3 * HOUR).counted).toBe(18 + 114); // with no known start the range is counted whole, as before
    expect(busyWindows([], d0, d0 + DAY, since)).toMatchObject({ counted: 0, maxRatio: null, over: null, byDay: [] }); // a range wholly before the record
  });

  it("lists a day with none above 0.6 with its count of windows", () => {
    const W = 10 * MINUTE, d0 = Date.UTC(2026, 9, 19), rows = [{ bucket: d0 + DAY + 3 * HOUR, proof_busy_ms: 600000 }]; // one full ten-minute stretch, from 03:00 on the 20th (a minute row of 10 min is enough here)
    const r = busyWindows(rows, d0, d0 + 2 * DAY);
    expect(r.byDay).toEqual([{ day: d0, over: 0, counted: DAY / W }, { day: d0 + DAY, over: 1, counted: DAY / W }]);
  });
});
