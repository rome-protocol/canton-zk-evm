import { describe, expect, it } from "vitest";
import { shareOf } from "./AddressParts.tsx";

describe("a holder's share of the supply", () => {
  it("cuts to two places and never rounds up", () => {
    expect(shareOf("995000", "1000000")).toBe("99.50%");
    expect(shareOf("999999", "1000000")).toBe("99.99%");
    expect(shareOf("1", "3")).toBe("33.33%");
  });
  it("says 100% only for all of it, and <0.01% for a sliver", () => {
    expect(shareOf("1000000", "1000000")).toBe("100%");
    expect(shareOf("1", "1000000000")).toBe("<0.01%");
    expect(shareOf("0", "10")).toBe("0%");
  });
  it("says nothing when the supply is not known, is zero, or is smaller than the value", () => {
    expect(shareOf("5", null)).toBeNull();
    expect(shareOf("5", "0")).toBeNull();
    expect(shareOf("11", "10")).toBeNull();
  });
});
