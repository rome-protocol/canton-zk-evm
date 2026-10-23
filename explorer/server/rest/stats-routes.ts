/**
 * `GET /api/stats/summary` and `GET /api/stats/series` (design 6.1 and 8). Every number is made from stored facts: the minute, hour and day rows of the rollups,
 * and, for what is live, the tables themselves. A number that has nothing behind it is null (a latency with no sample, a rate with no transaction); a count with
 * nothing behind it is 0. Times are ISO 8601 UTC; durations are seconds, read from histograms whose buckets are 5% apart, so a percentile is never below the
 * truth and at most 5% above it (`capped` says that a value fell outside the buckets).
 *
 * A window is the last N whole buckets of the rows it reads, the open one included: 1 h and 6 h read minute rows, 24 h and 7 d hour rows, 30 d day rows.
 * Buckets are UTC and are cut from the epoch, so the session's time zone does not matter.
 */
import type { Answer } from "../api.ts";
import { DAY, HOUR, MINUTE } from "../indexer/stats.ts";
import { addHists, histLength, quantile, total } from "../indexer/stats-hist.ts";
import { cached } from "./cache.ts";
import { REST_FIELDS as F, pick } from "./fields.ts";
import { BadRequest } from "./paging.ts";
import { router } from "./router.ts";
import { STUCK_SECONDS, type Column, type Span, type StatsRest, type StatsRow } from "./stats-rest.ts";

const ok = (body: unknown): Answer => ({ status: 200, body });
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export const WINDOWS = {
  "1h": { ms: HOUR, rows: "minute" }, "6h": { ms: 6 * HOUR, rows: "minute" }, "24h": { ms: DAY, rows: "hour" }, "7d": { ms: 7 * DAY, rows: "hour" }, "30d": { ms: 30 * DAY, rows: "day" },
} as const satisfies Record<string, { ms: number; rows: Span }>;
export type WindowName = keyof typeof WINDOWS;
export const DEFAULT_WINDOW: WindowName = "24h";

/** The steps of a series, and the table whose rows make one. */
export const STEPS = { "1m": { ms: MINUTE, rows: "minute" }, "10m": { ms: 10 * MINUTE, rows: "minute" }, "1h": { ms: HOUR, rows: "hour" }, "1d": { ms: DAY, rows: "day" } } as const satisfies Record<string, { ms: number; rows: Span }>;
export type StepName = keyof typeof STEPS;
/** The steps each window can be drawn in (the first is its default): never a step finer than the rows a window is read from, and at most 360 points. */
export const WINDOW_STEPS: Record<WindowName, readonly StepName[]> = { "1h": ["1m", "10m"], "6h": ["10m", "1m", "1h"], "24h": ["1h", "10m"], "7d": ["1h", "1d"], "30d": ["1d"] };

// ---- the numbers of a set of rows ----

const sum = (rows: readonly StatsRow[], c: Column): number => rows.reduce((a, r) => a + ((r[c] as number | null) ?? 0), 0);
const max = (rows: readonly StatsRow[], c: Column): number => rows.reduce((a, r) => Math.max(a, (r[c] as number | null) ?? 0), 0);
const hists = (rows: readonly StatsRow[], c: Column) => rows.map((r) => r[c] as number[] | null | undefined);
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** The middle and the 95th percentile of a time histogram, in seconds; null with no sample. */
export function spread(h: readonly number[]): { median: number; p95: number; samples: number; capped: boolean } | null {
  const a = quantile("time", h, 0.5), b = quantile("time", h, 0.95);
  return a && b ? { median: a.value, p95: b.value, samples: total(h), capped: a.capped || b.capped } : null;
}
const timeHist = (rows: readonly StatsRow[], c: Column): number[] => addHists("time", hists(rows, c));
const spreadOf = (rows: readonly StatsRow[], c: Column) => { const s = spread(timeHist(rows, c)); return s && pick(s, F.statsSpread); };

/** The ten-minute windows of design 2.7 and 8: a prover busy for more than this share of one counts as loaded. */
export const BUSY_WINDOW_MS = 10 * MINUTE, BUSY_LOADED = 0.6;

/**
 * The prover's busy time over the ten-minute windows of [from, to) that have ended by `t`: the largest ratio, and how many windows are above 0.6, from minute rows
 * (test runs apart), counted from `since` (the first day with a record) when that is inside the range. A day that was busy for two hours has about a dozen such windows, though its mean is 0.083.
 */
export function busyWindows(minutes: readonly StatsRow[], from: number, t: number, since: number | null = null) {
  // A window before the first day with a record (`since`) is left out of the count and of the days: nothing was recorded then, and "0 of 144 over" would say the prover
  // was idle. With no `since` (no day recorded yet) the range is counted whole.
  const W = BUSY_WINDOW_MS, last = Math.floor(t / W) * W, first = Math.max(Math.ceil(from / W) * W, since === null ? -Infinity : Math.ceil(since / W) * W);
  const counted = Math.max(0, Math.round((last - first) / W)), by = new Map<number, number>();
  for (const r of minutes) {
    const k = Math.floor(r.bucket / W) * W;
    if (k >= first && k < last) by.set(k, (by.get(k) ?? 0) + ((r.proof_busy_ms as number | null) ?? 0));
  }
  let top = 0, over = 0;
  for (const ms of by.values()) { top = Math.max(top, ms / W); if (ms / W > BUSY_LOADED) over++; }
  // The same windows for each UTC day (a window never crosses midnight: 600 s divides a day), the days with none above 0.6 included.
  const days = new Map<number, { counted: number; over: number }>();
  for (let k = first; k < last; k += W) {
    const d = Math.floor(k / DAY) * DAY, e = days.get(d) ?? { counted: 0, over: 0 };
    e.counted++; if ((by.get(k) ?? 0) / W > BUSY_LOADED) e.over++;
    days.set(d, e);
  }
  return { counted, maxRatio: counted > 0 ? top : null, over: counted > 0 ? over : null, byDay: [...days].map(([day, e]) => ({ day, over: e.over, counted: e.counted })) };
}

/** The p95 time to final above which the rule of design 2.7 calls an hour slow. */
export const SLOW_FINAL_SECONDS = 20;

/**
 * The p95 time to final hour by hour, over the hours of [from, to) that have ended by `t`: how many there are, how many have a time (an hour with no final transaction has none),
 * how many are above 20 s, and the worst one. The rule reads "above 20 s for more than an hour", which a p95 over a whole window can hide.
 */
export function slowHours(hours: readonly StatsRow[], from: number, t: number) {
  const first = Math.ceil(from / HOUR) * HOUR, last = Math.floor(t / HOUR) * HOUR;
  const counted = Math.max(0, Math.round((last - first) / HOUR));
  let measured = 0, above = 0, worst: { p95: number; at: number } | null = null;
  for (const r of hours) {
    if (r.bucket < first || r.bucket >= last) continue;
    const q = quantile("time", (r.time_to_final_hist as number[] | null) ?? [], 0.95);
    if (!q) continue;
    measured++;
    if (q.value > SLOW_FINAL_SECONDS) above++;
    if (!worst || q.value > worst.p95) worst = { p95: q.value, at: r.bucket };
  }
  return { counted, measured, above: measured > 0 ? above : null, worst };
}

/** The five size classes of a block, as `proof_size_hist` holds them one after the other (design section 8). */
export const SIZE_LABELS = ["0", "1-10", "11-100", "101-1000", "over 1000"] as const;

interface Metric {
  unit: string;
  columns: readonly Column[];
  /** The steps it can be drawn in, when not every step of the window. */
  steps?: readonly StepName[];
  /** What a step with no row holds: a count is 0, a time or a rate has nothing to say. */
  none: number | null;
  value: (rows: readonly StatsRow[], stepMs: number) => number | null;
}
const quant = (c: Column, q: number): Metric => ({ unit: "seconds", columns: [c], none: null, value: (rows) => quantile("time", timeHist(rows, c), q)?.value ?? null });
const count = (c: Column): Metric => ({ unit: "count", columns: [c], none: 0, value: (rows) => sum(rows, c) });
const extra = (c: Column): Metric => ({ unit: "count", columns: [c], steps: ["1d"], none: 0, value: (rows) => { const v = rows[0]?.[c]; return v === null || v === undefined ? null : (v as number); } });

/** Every metric of the series route. */
export const METRICS: Record<string, Metric> = {
  txs: count("txs"),
  tps: { unit: "per second", columns: ["txs"], none: 0, value: (rows, step) => sum(rows, "txs") / (step / 1000) },
  busiest_minute_tps: { unit: "per second", columns: ["max_minute_txs"], none: 0, value: (rows) => max(rows, "max_minute_txs") / 60 },
  blocks: count("blocks"),
  empty_blocks: count("empty_blocks"),
  txs_per_block: { unit: "transactions", columns: ["txs", "blocks"], none: null, value: (rows) => ratio(sum(rows, "txs"), sum(rows, "blocks")) },
  success_rate: { unit: "ratio", columns: ["txs", "txs_failed"], none: null, value: (rows) => ratio(sum(rows, "txs") - sum(rows, "txs_failed"), sum(rows, "txs")) },
  accepted: count("accepted"),
  lost: count("lost"), dropped: count("dropped"), replaced: count("replaced"),
  fullness: { unit: "ratio", columns: ["gas_used", "gas_limit_sum"], none: null, value: (rows) => ratio(sum(rows, "gas_used"), sum(rows, "gas_limit_sum")) },
  block_time_busy_p50: quant("busy_gap_hist", 0.5), block_time_busy_p95: quant("busy_gap_hist", 0.95),
  time_to_final_p50: quant("time_to_final_hist", 0.5), time_to_final_p95: quant("time_to_final_hist", 0.95),
  proof_time_p50: quant("proof_hist", 0.5), proof_time_p95: quant("proof_hist", 0.95),
  commit_time_p50: quant("commit_hist", 0.5), commit_time_p95: quant("commit_hist", 0.95),
  served_p50: quant("served_hist", 0.5), served_p95: quant("served_hist", 0.95),
  busy_ratio: { unit: "ratio", columns: ["proof_busy_ms"], steps: ["10m", "1h", "1d"], none: 0, value: (rows, step) => sum(rows, "proof_busy_ms") / step },
  active_addresses: extra("active_addresses"), new_addresses: extra("new_addresses"), new_contracts: extra("new_contracts"), verified_contracts: extra("verified_contracts"),
};

const words = (a: readonly string[]) => a.join(", ");

export interface StatsRouteDeps { stats: StatsRest; now?: () => number }

export function statsRoutes({ stats, now = Date.now }: StatsRouteDeps) {
  const windowOf = (raw: string | null): WindowName => {
    if (raw === null) return DEFAULT_WINDOW;
    if (!Object.hasOwn(WINDOWS, raw)) throw new BadRequest(`window is one of ${words(Object.keys(WINDOWS))}.`);
    return raw as WindowName;
  };

  async function summary(q: URLSearchParams): Promise<Answer> {
    const name = windowOf(q.get("window"));
    const t = now(), w = WINDOWS[name], span = { minute: MINUTE, hour: HOUR, day: DAY }[w.rows];
    const to = Math.floor(t / span) * span + span, from = to - w.ms;
    const hourFrom = Math.ceil(from / HOUR) * HOUR, hourTo = Math.floor(t / HOUR) * HOUR;
    const [state, rows, peak, lastMinute, pool, today, lost, busyMinutes, cutting, faucet, allTime, endedHours] = await Promise.all([
      stats.state(),
      stats.rows(w.rows, from, to, [
        "blocks", "empty_blocks", "busy_blocks", "txs", "txs_failed", "gas_used", "argument_bytes", "accepted", "lost", "attempts_refused", "attempts_failed", "attempts",
        "attempts_not_taken", "dropped", "replaced", "size_blocks_0", "size_blocks_1", "size_blocks_2", "size_blocks_3", "size_blocks_4", "ttf_without_acceptance", "clock_skew", "max_txs_in_block", "gas_limit_sum", "traffic_bytes", "traffic_updates", "proof_busy_ms", "test_blocks",
        "test_txs", "test_attempts", "test_proof_busy_ms", "busy_gap_hist", "time_to_final_hist", "proof_hist", "commit_hist", "served_hist", "txs_per_block_hist", "proof_size_hist",
      ]),
      stats.peak(from, to), stats.lastMinuteTxs(t), stats.pool(),
      stats.rows("day", Math.floor(t / DAY) * DAY, Math.floor(t / DAY) * DAY + DAY, ["active_addresses", "new_addresses", "new_contracts", "verified_contracts"]),
      stats.lost(),
      stats.rows("minute", from, Math.floor(t / MINUTE) * MINUTE + MINUTE, ["proof_busy_ms"]),
      stats.cutting(), stats.faucet(from, to), stats.txTotal(),
      // The hours that have ended: the window's own rows when it is read from hours, else the hour rows of the same stretch.
      w.rows === "hour" ? Promise.resolve(null) : hourTo > hourFrom ? stats.rows("hour", hourFrom, hourTo, ["time_to_final_hist"]) : Promise.resolve([]),
    ]);

    const blocks = sum(rows, "blocks"), txs = sum(rows, "txs"), empty = sum(rows, "empty_blocks"), attempts = sum(rows, "attempts");
    const perBlock = addHists("count", hists(rows, "txs_per_block_hist"));
    const nonEmpty = [...perBlock]; nonEmpty[0] = 0;
    const median = (h: number[]) => quantile("count", h, 0.5)?.value ?? null;
    const timeToFinal = spread(timeHist(rows, "time_to_final_hist"));
    const L = histLength("time"), sizes = rows.map((r) => r.proof_size_hist as number[] | null);
    const bySize = SIZE_LABELS.map((size, k) => {
      const h = addHists("time", sizes.map((s) => (s && s.length ? s.slice(k * L, (k + 1) * L) : null)));
      return pick({ size, ...(spread(h) ?? { median: null, p95: null, samples: 0, capped: false }) }, F.statsSize);
    });
    const proof = spread(timeHist(rows, "proof_hist"));
    const traffic = sum(rows, "traffic_updates");
    const open = await stats.open(t, timeToFinal ? 2 * timeToFinal.p95 : null);
    const stuck = open.stuck > 0 ? await stats.stuck(t) : [];
    const day = today[0];
    const busy = busyWindows(busyMinutes, from, t, state.since), hourly = slowHours(endedHours ?? rows, from, t);
    const body = {
      window: name, rows: w.rows, from: iso(from), to: iso(to), asOf: iso(state.asOf), dataSince: iso(state.since),
      tps: pick({ now: lastMinute / 60, peak: peak ? peak.txs / 60 : null, peakAt: iso(peak?.at ?? null) }, F.statsTps),
      blockTime: spreadOf(rows, "busy_gap_hist"),
      timeToFinal: spreadOf(rows, "time_to_final_hist"),
      proofTime: proof && pick({ ...proof, bySize }, F.statsProof),
      commitTime: spreadOf(rows, "commit_hist"),
      served: spreadOf(rows, "served_hist"),
      txsPerBlock: pick({
        mean: ratio(txs, blocks), median: blocks ? median(perBlock) : null, max: blocks ? max(rows, "max_txs_in_block") : null,
        nonEmptyMean: ratio(txs, blocks - empty), nonEmptyMedian: blocks - empty > 0 ? median(nonEmpty) : null,
      }, F.statsTxsPerBlock),
      blocks: pick({
        count: blocks, empty, busy: sum(rows, "busy_blocks"),
        bySize: SIZE_LABELS.map((size, k) => pick({ size, count: sum(rows, `size_blocks_${k}` as Column) }, F.statsBlockSize)),
      }, F.statsBlocks),
      txs: pick({ count: txs, failed: sum(rows, "txs_failed"), successRate: ratio(txs - sum(rows, "txs_failed"), txs), accepted: sum(rows, "accepted"),
        allTime: allTime && pick({ total: allTime.total, asOfBlock: allTime.asOfBlock, asOf: iso(allTime.asOf) }, F.statsAllTime) }, F.statsTxs),
      attempts: pick({
        total: attempts, refused: sum(rows, "attempts_refused"), failed: sum(rows, "attempts_failed"), notTaken: sum(rows, "attempts_not_taken"),
        refusedShare: ratio(sum(rows, "attempts_refused"), attempts), failedShare: ratio(sum(rows, "attempts_failed"), attempts), notTakenShare: ratio(sum(rows, "attempts_not_taken"), attempts),
      }, F.statsAttempts),
      fullness: ratio(sum(rows, "gas_used"), sum(rows, "gas_limit_sum")),
      canton: pick({
        argumentBytesPerBlock: ratio(sum(rows, "argument_bytes"), blocks), argumentBytesPerTx: ratio(sum(rows, "argument_bytes"), txs),
        trafficBytesPerBlock: ratio(sum(rows, "traffic_bytes"), traffic), trafficReported: traffic,
      }, F.statsCanton),
      prover: pick({
        maxBusyRatio10m: busy.maxRatio, windowsOver: busy.over, windowsCounted: busy.counted, windowSeconds: BUSY_WINDOW_MS / 1000, loadedAbove: BUSY_LOADED,
        // The mean over the part of the window that has happened; the 10-minute figures above are what the switching rule reads.
        meanBusyRatio: sum(rows, "proof_busy_ms") / Math.max(1, Math.min(w.ms, t - from)), busyMs: sum(rows, "proof_busy_ms"),
      }, F.statsProver),
      rule: pick({
        slowAboveSeconds: SLOW_FINAL_SECONDS, hoursCounted: hourly.counted, hoursMeasured: hourly.measured, hoursAbove: hourly.above,
        worstHourP95: hourly.worst?.p95 ?? null, worstHourAt: iso(hourly.worst?.at ?? null),
        windowsOverByDay: busy.byDay.map((d) => pick({ day: iso(d.day)!.slice(0, 10), windowsOver: d.over, windowsCounted: d.counted }, F.statsRuleDay)),
      }, F.statsRule),
      quality: pick({ withoutAcceptanceTime: sum(rows, "ttf_without_acceptance"), clockSkew: sum(rows, "clock_skew") }, F.statsQuality),
      test: pick({ blocks: sum(rows, "test_blocks"), txs: sum(rows, "test_txs"), attempts: sum(rows, "test_attempts"), proverBusyMs: sum(rows, "test_proof_busy_ms") }, F.statsTest),
      today: day ? pick({
        date: iso(day.bucket)!.slice(0, 10), activeAddresses: day.active_addresses, newAddresses: day.new_addresses, newContracts: day.new_contracts, verifiedContracts: day.verified_contracts,
        countedAt: iso(state.extrasAt),
      }, F.statsToday) : null,
      waiting: pick({
        open: open.open,
        pool: pool && pick({ waiting: pool.waiting, at: iso(pool.at), ageSeconds: Math.max(0, Math.floor((t - pool.at) / 1000)) }, F.statsPool),
      }, F.statsWaiting),
      acceptedNotFinal: pick({
        normal: open.normal, slow: open.slow, stuck: open.stuck, beingProven: open.beingProven, waiting: open.waiting, noAcceptanceTime: open.noAcceptanceTime,
        slowAfterSeconds: timeToFinal ? 2 * timeToFinal.p95 : null, stuckAfterSeconds: STUCK_SECONDS, listed: stuck.map((s) => pick(s, F.statsStuckItem)),
      }, F.statsOpen),
      lost: pick({ window: sum(rows, "lost"), total: lost.lost.total, listed: lost.lost.items.map((i) => pick(i, F.statsLostItem)) }, F.statsLost),
      dropped: pick({ window: sum(rows, "dropped"), total: lost.dropped.total, listed: lost.dropped.items.map((i) => pick(i, F.statsLostItem)) }, F.statsLost),
      replaced: pick({ window: sum(rows, "replaced"), total: lost.replaced }, F.statsReplaced),
      cutting: cutting && pick({ strategy: cutting.strategy, since: iso(cutting.since) }, F.statsCutting),
      // The refusals are counted from `turnedAwaySince` on. A window that starts before that has no count (a part of it would read as all of it).
      faucet: pick({
        requests: faucet.requests, sent: faucet.sent, final: faucet.final, failed: faucet.failed, timeToFinal: (() => { const x = spread(faucet.hist); return x && pick(x, F.statsSpread); })(),
        turnedAway: faucet.turnedAway.since !== null && from >= faucet.turnedAway.since
          ? pick({ total: Object.values(faucet.turnedAway.byReason).reduce((a, b) => a + b, 0), byReason: pick(faucet.turnedAway.byReason, F.statsTurnedAwayReasons) }, F.statsTurnedAway)
          : null,
        turnedAwaySince: iso(faucet.turnedAway.since),
      }, F.statsFaucet),
    };
    return cached(ok(pick(body, F.statsSummary)), "list");
  }

  async function series(q: URLSearchParams): Promise<Answer> {
    const name = windowOf(q.get("window"));
    const metricName = q.get("metric");
    if (metricName === null || !Object.hasOwn(METRICS, metricName)) throw new BadRequest(`metric is one of ${words(Object.keys(METRICS))}.`);
    const metric = METRICS[metricName]!;
    const allowed = WINDOW_STEPS[name].filter((st) => !metric.steps || metric.steps.includes(st));
    const raw = q.get("step");
    if (allowed.length === 0) {
      const windows = Object.keys(WINDOWS).filter((w) => WINDOW_STEPS[w as WindowName].some((st) => !metric.steps || metric.steps.includes(st)));
      throw new BadRequest(`${metricName} cannot be drawn over ${name}: use a window of ${words(windows)}.`);
    }
    if (raw !== null && !allowed.includes(raw as StepName)) throw new BadRequest(`step for ${metricName} over ${name} is one of ${words(allowed)}.`);
    const step = (raw ?? allowed[0]) as StepName, s = STEPS[step];
    const t = now(), to = Math.floor(t / s.ms) * s.ms + s.ms, n = WINDOWS[name].ms / s.ms, from = to - n * s.ms;
    const [state, rows] = await Promise.all([stats.state(), stats.rows(s.rows, from, to, metric.columns)]);
    const by = new Map<number, StatsRow[]>();
    for (const r of rows) {
      const k = Math.floor(r.bucket / s.ms) * s.ms;
      const list = by.get(k);
      if (list) list.push(r); else by.set(k, [r]);
    }
    const points = Array.from({ length: n }, (_, i) => {
      const at = from + i * s.ms, got = by.get(at);
      return pick({ at: iso(at), value: got ? metric.value(got, s.ms) : metric.none }, F.statsPoint);
    });
    return cached(ok(pick({ metric: metricName, unit: metric.unit, window: name, step, from: iso(from), to: iso(to), asOf: iso(state.asOf), points }, F.statsSeries)), "list");
  }

  return router([
    ["/api/stats/summary", (_, q) => summary(q)],
    ["/api/stats/series", (_, q) => series(q)],
  ]);
}
