import { describe, expect, it } from "vitest";
import { SOFT_DEFAULTS, softRow, type SoftMeasures } from "./soft.ts";

const calm: SoftMeasures = {
  undone: { count: 0, first: null },
  confirm: { count: 40, p50Ms: 9_700, p99Ms: 13_700 },
  sent: { p99Ms: 5_600 },
  rerunFailed: { count: 0, first: null },
};

describe("the row that watches soft confirmation", () => {
  it("is ok when nothing was undone, the confirmation is quick and no transaction that ran again ended failed", () => {
    const r = softRow(calm, SOFT_DEFAULTS);
    expect(r).toMatchObject({ id: "soft_confirmation", status: "ok", detail: null });
    expect(r.value).toEqual({
      undoneBlocksLastDay: 0, firstUndoneBlock: null,
      inBlockToConfirmedMs: { p50: 9_700, p99: 13_700, transactions: 40 }, sentToInBlockP99Ms: 5_600,
      rerunFailedLastDay: 0, firstRerunFailed: null,
    });
    expect(r.threshold).toEqual({ undoneBlocksPerDay: 0, confirmP99Ms: 60_000, rerunFailedPerDay: 0 });
  });

  it("is ok on a quiet chain: no transaction in the last hour has no time to measure", () => {
    expect(softRow({ ...calm, confirm: { count: 0, p50Ms: null, p99Ms: null }, sent: { p99Ms: null } }, SOFT_DEFAULTS).status).toBe("ok");
  });

  it("is degraded when a block with transactions was undone, and names the first one", () => {
    const r = softRow({ ...calm, undone: { count: 2, first: 9_001 } }, SOFT_DEFAULTS);
    expect(r.status).toBe("degraded");
    expect(r.detail).toBe("2 blocks with transactions were undone in the last day (the first is block 9001)");
  });

  it("is degraded when the confirmation takes longer than the limit at the 99th percentile of the last hour", () => {
    const r = softRow({ ...calm, confirm: { count: 40, p50Ms: 20_000, p99Ms: 61_000 } }, SOFT_DEFAULTS);
    expect(r.status).toBe("degraded");
    expect(r.detail).toBe("a block takes 61 s to be confirmed at the 99th percentile of the last hour, over the limit of 60 s");
    expect(softRow({ ...calm, confirm: { count: 40, p50Ms: 20_000, p99Ms: 60_000 } }, SOFT_DEFAULTS).status).toBe("ok");
  });

  it("is degraded when a transaction that ran more than once ended failed, and names the first", () => {
    const hash = "0x" + "ab".repeat(32);
    const r = softRow({ ...calm, rerunFailed: { count: 1, first: hash } }, SOFT_DEFAULTS);
    expect(r.status).toBe("degraded");
    expect(r.detail).toBe(`1 transaction that ran more than once ended failed in the last day (the first is ${hash})`);
  });

  it("the limits are settings: a count up to the limit is ok, and the row says the limits it was held to", () => {
    const m = { ...calm, undone: { count: 3, first: 5 }, rerunFailed: { count: 2, first: "0x01" } };
    expect(softRow(m, { undonePerDay: 3, confirmP99Ms: 60_000, rerunFailedPerDay: 2 }).status).toBe("ok");
    const r = softRow(m, { undonePerDay: 2, confirmP99Ms: 10_000, rerunFailedPerDay: 1 });
    expect(r.status).toBe("degraded");
    expect(r.threshold).toEqual({ undoneBlocksPerDay: 2, confirmP99Ms: 10_000, rerunFailedPerDay: 1 });
    expect(r.detail!.split("; ")).toHaveLength(3);
  });

  it("never carries a path, a host or a URL", () => {
    expect(JSON.stringify(softRow({ ...calm, undone: { count: 1, first: 1 } }, SOFT_DEFAULTS))).not.toMatch(/\/|:\/\//);
  });
});
