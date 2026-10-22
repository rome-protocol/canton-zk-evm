import { describe, expect, it } from "vitest";
import { summarize, usualProof } from "./stats.ts";
import { blockItem, inFlight, status } from "./test-utils.tsx";

describe("the home page's numbers", () => {
  it("takes the height from the status, the time to final from the producer's cut to Canton's record, and the proof time from the producer's log", () => {
    // The block's own time to Canton's record is 7.4 s for each of these, which is not what is counted.
    const blocks = [blockItem(5, { txCount: 2, finalSeconds: 9, proofSeconds: 7.5, commitSeconds: 0.9 }), blockItem(4, { txCount: 1, finalSeconds: 8.2, proofSeconds: 7.1, commitSeconds: 0.7 }), blockItem(3, { txCount: 0, finalSeconds: 8.5, proofSeconds: 7, commitSeconds: 0.8 })];
    const s = summarize(status(), blocks, inFlight());
    expect(s.height).toBe(3);
    expect(s.proving).toBe(4);
    expect(s.timeToFinal).toEqual({ medianMs: 8500, p95Ms: 9000, blocks: 3 });
    expect(s.proofTime).toEqual({ medianMs: 7100, p95Ms: 7500, blocks: 3 });
    expect(s.commitTime).toEqual({ medianMs: 800, p95Ms: 900, blocks: 3 });
    expect(s.transactions).toEqual({ count: 3, blocks: 3 });
    expect(s.notFinal).toEqual({ inBlocks: 3, waiting: 1 });
  });

  it("leaves out a block that the producer's log has no times for, and has no time when none has", () => {
    const blocks = [blockItem(5, { finalSeconds: 9, proofSeconds: 7.5 }), blockItem(4, { finalSeconds: null, proofSeconds: null, commitSeconds: null })];
    const s = summarize(status(), blocks, inFlight());
    expect(s.timeToFinal).toEqual({ medianMs: 9000, p95Ms: 9000, blocks: 1 });
    expect(s.proofTime).toEqual({ medianMs: 7500, p95Ms: 7500, blocks: 1 });
    expect(s.transactions.blocks).toBe(2);
    const none = summarize(status(), [blockItem(4, { finalSeconds: null, proofSeconds: null, commitSeconds: null })], inFlight());
    expect(none.timeToFinal).toBeNull();
    expect(none.proofTime).toBeNull();
    expect(none.commitTime).toBeNull();
  });

  it("has no times with no blocks, and no height with no final block", () => {
    const s = summarize(status({ final: null, proving: null }), [], inFlight({ attempts: [], poolWaiting: null }));
    expect(s).toEqual({ height: null, proving: null, timeToFinal: null, commitTime: null, proofTime: null, transactions: { count: 0, blocks: 0 }, notFinal: { inBlocks: 0, waiting: null } });
  });

  it("does not know what is not final when the in-flight route has not answered, and does not know the pool when it has no sample", () => {
    expect(summarize(status(), [], null).notFinal).toBeNull();
    expect(summarize(status(), [], inFlight({ poolWaiting: null })).notFinal).toEqual({ inBlocks: 3, waiting: null });
  });

  it("never reads a negative time when two clocks differ", () => {
    expect(summarize(status(), [blockItem(5, { finalSeconds: -0.5 })], inFlight()).timeToFinal!.medianMs).toBe(0);
  });
});

describe("the proof time a block usually takes", () => {
  it("is the 10th to the 90th percentile of the served proof times, so one slow proof does not stretch it", () => {
    const blocks = [7.0, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.7, 88].map((s, i) => blockItem(i + 1, { proofSeconds: s }));
    expect(usualProof(blocks)).toEqual({ lowMs: 7000, highMs: 7700 });
  });

  it("is not claimed from fewer than three blocks with a proof time", () => {
    expect(usualProof([blockItem(1, { proofSeconds: 7 }), blockItem(2, { proofSeconds: 7.4 }), blockItem(3, { proofSeconds: null })])).toBeNull();
  });
});
