import { describe, expect, it } from "vitest";
import { cantonUnits, holdingsOf } from "./balances.ts";

const held = (admin: string, id: string, amount: string, locked = false) => ({ contractId: "00", instrumentId: { admin, id }, amount, locked });

describe("what the Canton account holds", () => {
  it("reads a Canton amount in its smallest unit", () => {
    expect(cantonUnits("1.5")).toBe(15_000_000_000n);
    expect(cantonUnits("20.0000000000")).toBe(200_000_000_000n);
    expect(cantonUnits("0.0000000001")).toBe(1n);
    expect(cantonUnits("7")).toBe(70_000_000_000n);
  });
  it("adds up the unlocked holdings of one instrument and nothing else", () => {
    const list = [held("a", "X", "1.5"), held("a", "X", "2.5"), held("a", "X", "9", true), held("a", "Y", "4"), held("b", "X", "8")];
    expect(holdingsOf(list, { admin: "a", id: "X" })).toBe(40_000_000_000n);
    expect(holdingsOf(list, { admin: "c", id: "X" })).toBe(0n);
  });
});
