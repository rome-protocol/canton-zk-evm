import { describe, expect, it } from "vitest";
import { COUNT_EDGES, STEP, TIME_EDGES, addHists, bucketOf, emptyHist, histLength, quantile } from "./stats-hist.ts";

describe("the histogram edges", () => {
  it("are 5% apart for times, from 0.01 s to about 8,200 s", () => {
    expect(TIME_EDGES[0]).toBe(0.01);
    expect(TIME_EDGES[1]! / TIME_EDGES[0]!).toBeCloseTo(STEP, 12);
    expect(TIME_EDGES[TIME_EDGES.length - 1]!).toBeGreaterThan(8000);
    expect(TIME_EDGES[TIME_EDGES.length - 1]!).toBeLessThan(8400);
    expect(TIME_EDGES.every((e, i) => i === 0 || e > TIME_EDGES[i - 1]!)).toBe(true);
  });
  it("are exact for counts up to 32, then grow and never repeat", () => {
    expect(COUNT_EDGES.slice(0, 32)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(COUNT_EDGES[32]).toBe(34); // ceil(32 * 1.05) = 34 (33.6)
    expect(COUNT_EDGES.every((e, i) => i === 0 || e > COUNT_EDGES[i - 1]!)).toBe(true);
    expect(COUNT_EDGES[COUNT_EDGES.length - 1]!).toBeGreaterThanOrEqual(100_000);
  });
});

describe("which bucket a value falls in", () => {
  it("is the number of edges at or below it, like width_bucket", () => {
    expect(bucketOf("time", 0)).toBe(0);
    expect(bucketOf("time", 0.009)).toBe(0);
    expect(bucketOf("time", 0.01)).toBe(1); // an edge belongs to the bucket above it
    expect(bucketOf("time", 1e9)).toBe(TIME_EDGES.length);
    expect(bucketOf("count", 0)).toBe(0);
    expect(bucketOf("count", 1)).toBe(1);
    expect(bucketOf("count", 32)).toBe(32);
    expect(bucketOf("count", 33)).toBe(32);
    expect(bucketOf("count", 34)).toBe(33);
  });
});

describe("a percentile from a histogram", () => {
  const hist = (values: number[], kind: "time" | "count") => { const h = emptyHist(kind); for (const v of values) h[bucketOf(kind, v)]!++; return h; };
  it("is null with nothing in it", () => expect(quantile("time", emptyHist("time"), 0.5)).toBeNull());
  it("takes the nearest rank, worked by hand: of 10 times, p50 is the 5th and p95 the 10th", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const h = hist(values, "time");
    const p50 = quantile("time", h, 0.5)!, p95 = quantile("time", h, 0.95)!;
    expect(p50.value).toBeGreaterThanOrEqual(5);
    expect(p50.value).toBeLessThan(5 * STEP);
    expect(p95.value).toBeGreaterThanOrEqual(10);
    expect(p95.value).toBeLessThan(10 * STEP);
    expect(p50.capped).toBe(false);
  });
  it("is exact for small counts: blocks of 0, 0, 3, 5 and 40 transactions have median 3", () => {
    const h = hist([0, 0, 3, 5, 40], "count");
    expect(quantile("count", h, 0.5)!.value).toBe(3);
    expect(quantile("count", h, 0.2)!.value).toBe(0);
  });
  it("says capped for a value past the last edge", () => {
    const q = quantile("time", hist([1e6], "time"), 0.5)!;
    expect(q.capped).toBe(true);
    expect(q.value).toBe(TIME_EDGES[TIME_EDGES.length - 1]);
  });
});

describe("adding histograms", () => {
  it("adds bucket by bucket, and a missing one counts as zeros", () => {
    const a = emptyHist("time"), b = emptyHist("time");
    a[3] = 2; b[3] = 1; b[10] = 4;
    const sum = addHists("time", [a, b, null, undefined, []]);
    expect(sum[3]).toBe(3);
    expect(sum[10]).toBe(4);
    expect(sum).toHaveLength(histLength("time"));
  });
});
