import { describe, expect, it } from "vitest";
import { finalSpread, summarize, usualProof } from "./stats.ts";
import { blockItem, inFlight, status } from "./test-utils.tsx";

describe("the home page's numbers from the status and the in-flight route", () => {
  it("takes the height and the block being proven from the status, and what is not final from the in-flight route", () => {
    const s = summarize(status(), inFlight());
    expect(s).toEqual({ height: 3, proving: 4, notFinal: { inBlocks: 3, waiting: 1 } });
  });

  it("has no height with no final block", () => {
    const s = summarize(status({ final: null, proving: null }), inFlight({ attempts: [], poolWaiting: null }));
    expect(s).toEqual({ height: null, proving: null, notFinal: { inBlocks: 0, waiting: null } });
  });

  it("does not know what is not final when the in-flight route has not answered, and does not know the pool when it has no sample", () => {
    expect(summarize(status(), null).notFinal).toBeNull();
    expect(summarize(status(), inFlight({ poolWaiting: null })).notFinal).toEqual({ inBlocks: 3, waiting: null });
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

describe("the time to final of the newest blocks", () => {
  it("is the middle and the 95th percentile of the blocks the producer's log has a time for, and never negative", () => {
    const blocks = [blockItem(5, { finalSeconds: 9 }), blockItem(4, { finalSeconds: 8.2 }), blockItem(3, { finalSeconds: 8.5 }), blockItem(2, { finalSeconds: null })];
    expect(finalSpread(blocks)).toEqual({ medianMs: 8500, p95Ms: 9000, blocks: 3 });
    expect(finalSpread([blockItem(5, { finalSeconds: -0.5 })])!.medianMs).toBe(0);
  });

  it("is nothing when no block has a time", () => {
    expect(finalSpread([blockItem(4, { finalSeconds: null })])).toBeNull();
    expect(finalSpread([])).toBeNull();
  });
});
