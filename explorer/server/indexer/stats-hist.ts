/**
 * The histograms of the stats rollups (design section 8). Edges are fixed, so histograms add up across minutes, hours and days, and a percentile is read
 * from the sum. A value falls in bucket `b` = the number of edges that are at or below it, the same rule as SQL's `width_bucket(value, edges)`, so the
 * database and this code count alike: bucket 0 is below the first edge, bucket `edges.length` is at or above the last.
 *
 * Times are in seconds and log-spaced, 5% apart (a percentile is at most 5% above the truth, and the page says so). Counts (transactions per block) are exact up
 * to 32, then 5% apart.
 */
export const STEP = 1.05;
const TIME_FIRST = 0.01, TIME_BUCKETS = 280;

/** 0.01 s up to about 8,200 s, 5% apart. */
export const TIME_EDGES: readonly number[] = Array.from({ length: TIME_BUCKETS }, (_, i) => TIME_FIRST * Math.pow(STEP, i));

function countEdges(): number[] {
  const e = Array.from({ length: 32 }, (_, i) => i + 1);
  while ((e[e.length - 1] as number) < 100_000) { const p = e[e.length - 1] as number; e.push(Math.max(p + 1, Math.ceil(p * STEP))); }
  return e;
}
/** 1, 2 ... 32, then 5% apart up to 100,000. */
export const COUNT_EDGES: readonly number[] = countEdges();

export type Kind = "time" | "count";
const EDGES: Record<Kind, readonly number[]> = { time: TIME_EDGES, count: COUNT_EDGES };

/** The length of a histogram of this kind: one bucket more than edges. */
export const histLength = (kind: Kind): number => EDGES[kind].length + 1;
export const emptyHist = (kind: Kind): number[] => new Array(histLength(kind)).fill(0);

/** The bucket a value falls in: the number of edges at or below it. */
export function bucketOf(kind: Kind, v: number): number {
  const e = EDGES[kind];
  let lo = 0, hi = e.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((e[mid] as number) <= v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The sum of histograms of one kind, bucket by bucket (an empty or missing one counts as zeros). */
export function addHists(kind: Kind, hists: readonly (readonly number[] | null | undefined)[]): number[] {
  const out = emptyHist(kind);
  for (const h of hists) if (h) for (let i = 0; i < h.length && i < out.length; i++) out[i] = (out[i] as number) + (h[i] as number);
  return out;
}

export const total = (h: readonly number[]): number => h.reduce((a, b) => a + b, 0);

/**
 * The value at quantile `q` (nearest rank: the smallest value with at least ceil(q * n) values at or below it), or null for an empty histogram. A time is the
 * upper edge of its bucket, so it is never below the truth and at most 5% above it (a value under the first edge is reported as the first edge, and one over the
 * last as the last: `capped`). A count is the lower edge of its bucket: exact up to 32, 0 for an empty block.
 */
export function quantile(kind: Kind, h: readonly number[], q: number): { value: number; capped: boolean } | null {
  const n = total(h);
  if (n === 0) return null;
  const e = EDGES[kind];
  const rank = Math.max(1, Math.ceil(q * n));
  let seen = 0;
  for (let b = 0; b < h.length; b++) {
    seen += h[b] as number;
    if (seen < rank) continue;
    if (kind === "time") return { value: b < e.length ? (e[b] as number) : (e[e.length - 1] as number), capped: b >= e.length };
    return { value: b === 0 ? 0 : (e[b - 1] as number), capped: b >= e.length };
  }
  return null;
}
