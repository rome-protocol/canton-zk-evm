import { describe, expect, it } from "vitest";
import { B1_MS, B2_MS, B2_RUNNER_MS } from "./budgets.ts";

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
