import { describe, expect, it } from "vitest";
import { AmountError, maxText, parseAmount, showBalance, showUnits, tenDecimals } from "./amounts.ts";

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

describe("showing amounts", () => {
  it("shows the exact decimal, without trailing zeros", () => {
    expect(showUnits(20n * 10n ** 18n, 18)).toBe("20");
    expect(showUnits(15n * 10n ** 17n, 18)).toBe("1.5");
    expect(showUnits(1n, 18)).toBe("0.000000000000000001");
    expect(showUnits(1500000n, 6)).toBe("1.5");
    expect(showUnits(0n, 10)).toBe("0");
  });
  it("offers as the most only what the bridge moves: cut down to 10 decimals, never rounded up", () => {
    expect(maxText(123456789012345678n, 18)).toBe("0.123456789");
    expect(maxText(5n * 10n ** 10n, 10)).toBe("5");
    expect(maxText(10n ** 7n, 18)).toBe("");
    expect(maxText(0n, 6)).toBe("");
    expect(parseAmount(maxText(123456789012345678n, 18), 18).base).toBe(123456789000000000n);
  });
});

describe("showBalance", () => {
  it("shows at most 6 decimals, cut down, with the whole part and no trailing zeros", () => {
    expect(showBalance(1234567890123456789n, 18)).toBe("1.234567");
    expect(showBalance(1999999999999999999n, 18)).toBe("1.999999");
    expect(showBalance(20n * 10n ** 18n, 18)).toBe("20");
    expect(showBalance(15n * 10n ** 17n, 18)).toBe("1.5");
    expect(showBalance(123456789n * 10n ** 18n + 5n, 18)).toBe("123456789");
    expect(showBalance(0n, 18)).toBe("0");
  });
  it("shows a balance too small for 6 decimals as less than the least it shows, and leaves short tokens as they are", () => {
    expect(showBalance(999999999999n, 18)).toBe("<0.000001");
    expect(showBalance(1234567n, 6)).toBe("1.234567");
    expect(showBalance(15n * 10n ** 9n, 10)).toBe("1.5");
    expect(showBalance(12345678901n, 10)).toBe("1.234567");
  });
  it("leaves Max exact", () => {
    expect(maxText(1234567890123456789n, 18)).toBe("1.2345678901");
  });
});
