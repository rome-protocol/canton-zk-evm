import { describe, expect, it } from "vitest";
import { summarize } from "./stats.ts";
import { blockItem, inFlight, status } from "./test-utils.tsx";

describe("the home page's numbers", () => {
  it("takes the height from the status, and the times and counts from the blocks given", () => {
    const blocks = [blockItem(5, { txCount: 2, recordTime: new Date(blockItem(5).timestamp * 1000 + 9000).toISOString() }), blockItem(4, { txCount: 1 }), blockItem(3, { txCount: 0 })];
    const s = summarize(status(), blocks, inFlight());
    expect(s.height).toBe(3);
    expect(s.proving).toBe(4);
    expect(s.timeToFinal).toEqual({ medianMs: 7400, p95Ms: 9000, blocks: 3 });
    expect(s.transactions).toEqual({ count: 3, blocks: 3 });
    expect(s.notFinal).toEqual({ inBlocks: 3, waiting: 1 });
  });

  it("has no times with no blocks, and no height with no final block", () => {
    const s = summarize(status({ final: null, proving: null }), [], inFlight({ attempts: [], poolWaiting: null }));
    expect(s).toEqual({ height: null, proving: null, timeToFinal: null, transactions: { count: 0, blocks: 0 }, notFinal: { inBlocks: 0, waiting: 0 } });
  });

  it("never reads a negative time when two clocks differ", () => {
    const b = blockItem(5, { recordTime: new Date(blockItem(5).timestamp * 1000 - 500).toISOString() });
    expect(summarize(status(), [b], inFlight()).timeToFinal!.medianMs).toBe(0);
  });
});
