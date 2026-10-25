import type { StatsMetric, StatsSeries, StatsSummary, StatsWindow } from "../api.ts";

/** Answers of the stats routes over seven days (14 to 20 Oct 2026), with the numbers of the approved screen. The test holds their fields to the server's lists. */
const sp = (median: number, p95: number, samples: number) => ({ median, p95, samples, capped: false });
const sizes = ["0", "1-10", "11-100", "101-1000", "over 1000"];

export function summary(over: Partial<StatsSummary> = {}): StatsSummary {
  return {
    window: "7d", rows: "hour", from: "2026-10-14T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z", asOf: "2026-10-20T16:30:00.000Z", dataSince: "2026-10-01T00:00:00.000Z",
    tps: { now: 0, peak: 20.8, peakAt: "2026-10-15T14:07:00.000Z" },
    blockTime: sp(9.4, 31, 900), timeToFinal: sp(8.4, 80.6, 5899), commitTime: sp(0.58, 0.63, 901), served: sp(0.2, 0.4, 901),
    proofTime: {
      ...sp(7.1, 7.9, 901),
      bySize: sizes.map((size, k) => [
        { size, median: 13.98, p95: 13.98, samples: 1, capped: false }, { size, median: 7.08, p95: 7.66, samples: 813, capped: false }, { size, median: 7.31, p95: 8.4, samples: 87, capped: false },
        { size, median: null, p95: null, samples: 0, capped: false }, { size, median: null, p95: null, samples: 0, capped: false },
      ][k]!),
    },
    txsPerBlock: { mean: 6.5, median: 3, max: 100, nonEmptyMean: 6.6, nonEmptyMedian: 3 },
    blocks: { count: 901, empty: 1, busy: 640, firstTry: 901 / 910, bySize: sizes.map((size, k) => ({ size, count: [1, 813, 87, 0, 0][k]! })) },
    txs: { count: 5899, failed: 16, reverted: 16, successRate: 1, accepted: 5903, acceptedFinal: 5899, lost: 0, droppedByChain: 0, delayedByRedo: 9, allTime: null },
    attempts: { total: 910, committed: 901, unknown: 1, decided: 910, refused: 6, failed: 2, notTaken: 0, refusedShare: 6 / 910, failedShare: 2 / 910, notTakenShare: 0 },
    fullness: 0.004,
    canton: { argumentBytesPerBlock: 4100, argumentBytesPerTx: 630, trafficBytesPerBlock: null, trafficReported: 0 },
    prover: { maxBusyRatio10m: 0.035, windowsOver: 0, windowsCounted: 1008, windowSeconds: 600, loadedAbove: 0.6, meanBusyRatio: 0.012, busyMs: 7_300_000 },
    quality: { withoutAcceptanceTime: 0, clockSkew: 0 },
    rule: { slowAboveSeconds: 20, hoursCounted: 168, hoursMeasured: 168, hoursAbove: 0, worstHourP95: 9.5, worstHourAt: "2026-10-18T14:00:00.000Z", windowsOverByDay: [{ day: "2026-10-17", windowsOver: 0, windowsCounted: 144 }, { day: "2026-10-18", windowsOver: 0, windowsCounted: 144 }] },
    test: { blocks: 0, txs: 0, attempts: 0, proverBusyMs: 0 },
    today: { date: "2026-10-20", activeAddresses: 14, newAddresses: 3, newContracts: 1, verifiedContracts: 0, countedAt: "2026-10-20T16:00:00.000Z" },
    waiting: { open: 4, pool: { waiting: 1, at: "2026-10-20T16:29:50.000Z", ageSeconds: 10 } },
    acceptedNotFinal: { normal: 4, slow: 0, stuck: 0, beingProven: 3, waiting: 1, noAcceptanceTime: 0, slowAfterSeconds: 161.2, stuckAfterSeconds: 120, listed: [] },
    lost: { window: 0, total: 0, listed: [] }, dropped: { window: 0, total: 0, listed: [] }, replaced: { window: 0, total: 0 },
    cutting: { strategy: "on_demand", since: "2026-10-12T09:00:00.000Z" },
    faucet: { requests: 1388, sent: 1311, final: 1311, failed: 0, timeToFinal: sp(45.8, 120, 1311), turnedAway: null, turnedAwaySince: null },
    ...over,
  };
}

const STEP_MS = { "1m": 60_000, "10m": 600_000, "1h": 3_600_000, "1d": 86_400_000 } as const;
const DEFAULT_STEP: Record<StatsWindow, StatsSeries["step"]> = { "1h": "1m", "6h": "10m", "24h": "1h", "7d": "1h", "30d": "1d" };
const SPAN: Record<StatsWindow, number> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };

/** One metric over a window as the series route gives it: a point for every step, the values from `value(i, n)` (null where there is no fact). */
export function series(metric: StatsMetric, value: (i: number, n: number) => number | null, over: Partial<StatsSeries> = {}): StatsSeries {
  const window = over.window ?? "7d", step = over.step ?? DEFAULT_STEP[window], ms = STEP_MS[step];
  const to = Date.parse("2026-10-21T00:00:00Z"), n = SPAN[window] / ms;
  const unit = { tps: "per second", blocks: "count", txs: "count", busy_ratio: "ratio" }[metric as string] ?? "seconds";
  return {
    metric, unit, window, step, from: new Date(to - n * ms).toISOString(), to: new Date(to).toISOString(), asOf: "2026-10-20T16:30:00.000Z",
    points: Array.from({ length: n }, (_, i) => ({ at: new Date(to - (n - i) * ms).toISOString(), value: value(i, n) })), ...over,
  };
}
/** Ordinary values around `base`, with a gap every 31st step and one value far above the rest at step `spike`. */
export const wave = (base: number, spike?: { at: number; value: number }) => (i: number) => (spike && i === spike.at ? spike.value : i % 31 === 7 ? null : base + ((i * 7) % 5) * base * 0.05);
