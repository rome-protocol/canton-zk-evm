import { describe, expect, it } from "vitest";
import { B1_MS, B2_MS, B2_RUNNER_MS, LOAD_B1_MS, LOAD_B1_RUNNER_MS, LOAD_B2_MS, LOAD_B2_RUNNER_MS } from "./budgets.ts";

describe("W1 budgets", () => {
  it("keeps the runner tolerance at 1.25 x B2 (rounded to 250 ms, the step the budgets are set in), so the two cannot drift apart silently", () => {
    expect(B2_RUNNER_MS).toBe(Math.round((1.25 * B2_MS) / 250) * 250);
  });
  it("holds B1 and B2 at the reference-machine budgets and the runner tolerance above B2", () => {
    expect(B1_MS).toBe(2750);
    expect(B2_MS).toBe(12_750);
    expect(B2_RUNNER_MS).toBeGreaterThan(B2_MS);
  });
});

describe("the ordinary load shapes' budgets (tokens-load.test.ts)", () => {
  it("keeps the budgets at the design's 1.0 s and 3.0 s: the reference machine's, never loosened for the runner", () => {
    expect(LOAD_B1_MS).toBe(1000);
    expect(LOAD_B2_MS).toBe(3000);
  });
  it("keeps the runner tolerances at 1.25 x the budget, rounded to 250 ms, as W1's is, and above the budget (1,013 ms was seen against 1,000)", () => {
    expect(LOAD_B1_RUNNER_MS).toBe(Math.round((1.25 * LOAD_B1_MS) / 250) * 250);
    expect(LOAD_B2_RUNNER_MS).toBe(Math.round((1.25 * LOAD_B2_MS) / 250) * 250);
    expect(LOAD_B1_RUNNER_MS).toBeGreaterThan(1013);
    expect(LOAD_B2_RUNNER_MS).toBeGreaterThan(LOAD_B2_MS);
  });
});
