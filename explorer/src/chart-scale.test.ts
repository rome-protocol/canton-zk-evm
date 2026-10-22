import { describe, expect, it } from "vitest";
import { axisTicks, niceCeil, scaleOf, timeTicks } from "./chart-scale.ts";

describe("niceCeil", () => {
  it("rounds up to 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten", () => {
    expect([0.07, 1, 1.2, 17, 20.8, 88.6, 0.3].map(niceCeil)).toEqual([0.08, 1, 1.5, 20, 25, 100, 0.3]);
  });
});

describe("scaleOf", () => {
  it("fits the axis to the values when none stands far above the rest", () => {
    const s = scaleOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s).toEqual({ top: 10, off: [] });
  });
  it("stops the axis at twice the ordinary values and lists the ones above it, so that ordinary hours can be read", () => {
    const v = [...Array.from({ length: 30 }, (_, i) => 8 + (i % 3)), 88.6];
    const s = scaleOf(v);
    expect(s.top).toBe(20);
    expect(s.off).toEqual([30]);
  });
  it("gives an axis to a series with no value and to one of zeros", () => {
    expect(scaleOf([])).toEqual({ top: 1, off: [] });
    expect(scaleOf([null, 0, 0])).toEqual({ top: 1, off: [] });
  });
  it("leaves out the places with no fact", () => {
    expect(scaleOf([null, 3, null]).top).toBe(3);
  });
});

describe("axisTicks", () => {
  it("is five ticks from 0 to the top", () => { expect(axisTicks(20)).toEqual([0, 5, 10, 15, 20]); });
});

describe("timeTicks", () => {
  const day = 86_400_000;
  it("marks every UTC midnight over a week, with the day's name", () => {
    const t = timeTicks(Date.parse("2026-10-14T00:00:00Z"), Date.parse("2026-10-21T00:00:00Z"));
    expect(t).toHaveLength(7);
    expect(t[0]).toEqual({ at: Date.parse("2026-10-14T00:00:00Z"), label: "Wed 14 Oct" });
  });
  it("marks every four hours over a day, every hour over six, every ten minutes over one", () => {
    expect(timeTicks(0, day).map((x) => x.label)).toEqual(["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"]);
    expect(timeTicks(0, 6 * 3_600_000)).toHaveLength(6);
    expect(timeTicks(0, 3_600_000).map((x) => x.label)).toEqual(["00:00", "00:10", "00:20", "00:30", "00:40", "00:50"]);
  });
  it("marks every five days over a month", () => {
    expect(timeTicks(0, 30 * day).map((x) => x.label).slice(0, 2)).toEqual(["1 Jan", "6 Jan"]);
  });
});
