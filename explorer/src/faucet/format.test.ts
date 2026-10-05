import { describe, expect, it } from "vitest";
import { formatCoin, formatPeriod, formatWait, shortHash } from "./format.ts";

describe("formatCoin", () => {
  it("shows whole coins with thousands separators", () => {
    expect(formatCoin("1000000000000000000", 18)).toBe("1");
    expect(formatCoin("999997000000000000000000", 18)).toBe("999,997");
  });
  it("keeps up to four decimals, cut down and without trailing zeros", () => {
    expect(formatCoin("999996999999999999999999", 18)).toBe("999,996.9999");
    expect(formatCoin("500000000000000000", 18)).toBe("0.5");
    expect(formatCoin("12300000000000000", 18)).toBe("0.0123");
  });
  it("shows a tiny amount as less than the smallest figure, never as zero", () => {
    expect(formatCoin("1", 18)).toBe("less than 0.0001");
    expect(formatCoin("0", 18)).toBe("0");
  });
  it("works for another number of decimals", () => {
    expect(formatCoin("1500000", 6)).toBe("1.5");
  });
});

describe("formatWait", () => {
  it("says seconds under a minute", () => {
    expect(formatWait(1)).toBe("1 s");
    expect(formatWait(2)).toBe("2 s");
    expect(formatWait(59)).toBe("59 s");
  });
  it("says minutes under an hour, rounding up", () => {
    expect(formatWait(60)).toBe("1 min");
    expect(formatWait(61)).toBe("2 min");
    expect(formatWait(3599)).toBe("1 h");
  });
  it("says hours and minutes from an hour, rounding the minutes up", () => {
    expect(formatWait(3600)).toBe("1 h");
    expect(formatWait(3601)).toBe("1 h 1 min");
    expect(formatWait(23 * 3600 + 41 * 60)).toBe("23 h 41 min");
    expect(formatWait(86400)).toBe("24 h");
    expect(formatWait(86400 - 1)).toBe("24 h");
  });
});

describe("formatPeriod", () => {
  it("names a day, whole hours, and anything else in seconds", () => {
    expect(formatPeriod(86400)).toBe("24 hours");
    expect(formatPeriod(3600)).toBe("1 hour");
    expect(formatPeriod(90)).toBe("90 seconds");
  });
});

describe("shortHash", () => {
  it("keeps six characters and four", () => {
    expect(shortHash("0x59c5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa48f7")).toBe("0x59c5…48f7");
  });
  it("leaves a short value alone", () => {
    expect(shortHash("0x1234")).toBe("0x1234");
  });
});
