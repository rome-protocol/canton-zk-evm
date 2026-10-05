import { describe, expect, it } from "vitest";
import { bytesOf, count, gwei, party, seconds, units, utcDate, utcMs } from "./format.ts";

describe("numbers", () => {
  it("groups thousands", () => {
    expect(count(51698)).toBe("51,698");
    expect(count(30000000)).toBe("30,000,000");
    expect(count(0)).toBe("0");
    expect(count("1234567890123456789012")).toBe("1,234,567,890,123,456,789,012");
  });

  it("shows a coin amount in whole coins, without the zeros it does not need", () => {
    expect(units("0", 18)).toBe("0");
    expect(units("10000000000000000000", 18)).toBe("10");
    expect(units("9997910000000000000", 18)).toBe("9.99791");
    expect(units("1000000", 6)).toBe("1");
    expect(units("1500000000000000000", 18)).toBe("1.5");
    expect(units("1234567000000000000000000", 18)).toBe("1,234,567");
  });

  it("keeps three significant digits of a small amount, and cuts rather than rounds", () => {
    expect(units("86336000000000", 18)).toBe("0.0000863");
    expect(units("1", 18)).toBe("0.000000000000000001");
    expect(units("999999999999999999", 18)).toBe("0.999");
  });

  it("writes a fee rate in gwei, or in wei when it is tiny", () => {
    expect(gwei("670000000")).toBe("0.67 gwei");
    expect(gwei("1000000000")).toBe("1 gwei");
    expect(gwei("1670000000")).toBe("1.67 gwei");
    expect(gwei("7")).toBe("7 wei");
    expect(gwei("0")).toBe("0 wei");
  });

  it("measures the size of hex data in bytes", () => {
    expect(bytesOf("ab".repeat(1344))).toBe("1,344 B");
    expect(bytesOf("")).toBe("0 B");
  });
});

describe("times", () => {
  it("shows Canton's record time to the millisecond, in UTC", () => {
    expect(utcMs("2026-10-04T01:37:15.412Z")).toBe("01:37:15.412 UTC");
    expect(utcMs("2026-10-04T01:37:15Z")).toBe("01:37:15.000 UTC");
  });

  it("shows a date in UTC", () => {
    expect(utcDate(Date.parse("2026-10-04T01:37:08Z"))).toBe("2026-10-04");
  });

  it("says how long after the block was made, to a tenth of a second", () => {
    expect(seconds(Date.parse("2026-10-04T01:37:08Z") / 1000, "2026-10-04T01:37:15.412Z")).toBe("7.4 s");
    expect(seconds(Date.parse("2026-10-04T01:37:08Z") / 1000, "2026-10-04T01:37:08.000Z")).toBe("0.0 s");
    expect(seconds(Date.parse("2026-10-04T01:37:08Z") / 1000, "2026-10-04T01:35:08.000Z")).toBe("0.0 s");
    expect(seconds(Date.parse("2026-10-04T01:35:16Z") / 1000, "2026-10-04T01:37:20.600Z")).toBe("2 min 5 s");
  });
});

describe("party ids", () => {
  it("keeps the name and the ends of the identifier", () => {
    expect(party("operator::1220" + "ab".repeat(30) + "3619")).toBe("operator::1220…3619");
    expect(party("odd")).toBe("odd");
  });
});
