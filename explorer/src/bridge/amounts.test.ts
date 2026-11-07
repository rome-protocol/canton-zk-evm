import { describe, expect, it } from "vitest";
import { AmountError, parseAmount, tenDecimals } from "./amounts.ts";

describe("tenDecimals", () => {
  it("writes a Canton amount with exactly ten decimals", () => {
    expect(tenDecimals(15n * 10n ** 9n)).toBe("1.5000000000");
    expect(tenDecimals(1n)).toBe("0.0000000001");
    expect(tenDecimals(2n * 10n ** 10n)).toBe("2.0000000000");
    expect(tenDecimals(parseAmount("1.5", 18).twin)).toBe("1.5000000000");
  });
});

describe("parseAmount", () => {
  it("gives base units and the same amount in Canton's 10 decimals", () => {
    expect(parseAmount("1.5", 18)).toEqual({ base: 15n * 10n ** 17n, twin: 15n * 10n ** 9n });
    expect(parseAmount("2", 10)).toEqual({ base: 2n * 10n ** 10n, twin: 2n * 10n ** 10n });
    expect(parseAmount("1.5", 6)).toEqual({ base: 1_500_000n, twin: 15n * 10n ** 9n });
  });
  it("moves an 18-decimal token in steps of 10^8", () => {
    expect(parseAmount("0.0000000001", 18)).toEqual({ base: 10n ** 8n, twin: 1n });
    expect(parseAmount("0.00000000010", 18).base).toBe(10n ** 8n);
  });
  it("refuses a finer amount, never rounds it", () => {
    expect(() => parseAmount("0.00000000001", 18)).toThrow(AmountError);
    expect(() => parseAmount("1.00000000001", 10)).toThrow(AmountError);
    expect(() => parseAmount("0.0000001", 6)).toThrow("at most 6 decimals");
  });
  it("refuses zero and text that is not an amount", () => {
    for (const text of ["0", "0.0", "", "abc", "-1", "1e3", "1.", ".5"]) expect(() => parseAmount(text, 18)).toThrow(AmountError);
  });
});
