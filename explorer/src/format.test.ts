import { describe, expect, it } from "vitest";
import { baseFee, bytesOf, compactUnits, count, dateTime, feeOf, gwei, nb, party, peakCount, rate, seconds, shortUpdate, units, utcDate, utcMs } from "./format.ts";

describe("a rate of transactions per second", () => {
  it("keeps one place from 1 up and two significant figures under 1, so a busiest minute of 1 or 2 transactions is not 0", () => {
    expect([1 / 60, 2 / 60, 0.5, 0.25, 1, 10.2, 20.84, 1248 / 60].map(rate)).toEqual(["0.017", "0.033", "0.5", "0.25", "1", "10.2", "20.8", "20.8"]);
    expect(rate(0)).toBe("0");
  });
  it("says the busiest minute as a count", () => {
    expect([peakCount(1 / 60), peakCount(2 / 60), peakCount(59 / 60)]).toEqual(["1 tx", "2 tx", "59 tx"]);
  });
});

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

describe("baseFee", () => {
  it("is gwei to three digits, so that a fee of a few hundredths of a gwei is not rounded away", () => {
    expect(baseFee("67300000")).toBe("0.0673 gwei");
    expect(baseFee("1000000000")).toBe("1 gwei");
    expect(baseFee("1234567890")).toBe("1.23 gwei");
    expect(baseFee("123456789012")).toBe("123 gwei");
    expect(baseFee("7")).toBe("7 wei");
    expect(baseFee("0")).toBe("0 gwei");
  });
});

describe("a Canton update id", () => {
  it("is its first eight characters and its last four, as on the screens", () => {
    expect(shortUpdate("12204594" + "ab".repeat(26) + "b509")).toBe("12204594…b509");
    expect(shortUpdate("12204594" + "ab".repeat(26) + "b509", 10, 6)).toBe("12204594ab…abb509");
    expect(shortUpdate("12204594" + "ab".repeat(26) + "b509", 12, 8)).toBe("12204594abab…ababb509");
  });
});

describe("feeOf", () => {
  it("shows a fee to ten decimals, with the zeros at the end cut, as the screens do", () => {
    expect(feeOf("3536400000000", 18)).toBe("0.0000035364");
    expect(feeOf("35440000000000", 18)).toBe("0.00003544");
    expect(feeOf("246418600000000", 18)).toBe("0.0002464186");
  });
  it("cuts a longer fee and never rounds it up", () => {
    expect(feeOf("6222516131082", 18)).toBe("0.0000062225");
    expect(feeOf("1999999999999999999", 18)).toBe("1.9999999999");
  });
  it("shows a whole fee without a fraction, none as 0, and a fee below the tenth place as such", () => {
    expect(feeOf("2000000000000000000", 18)).toBe("2");
    expect(feeOf("0", 18)).toBe("0");
    expect(feeOf("99999999", 18)).toBe("<0.0000000001");
  });
  it("groups the thousands of the whole part, and works with a coin of fewer decimals", () => {
    expect(feeOf("1234567890000000000000", 18)).toBe("1,234.56789");
    expect(feeOf("12345", 6)).toBe("0.012345");
  });
});

describe("dateTime", () => {
  it("writes a date and time as 'DD Mon YYYY, HH:MM:SS UTC'", () => {
    expect(dateTime(Date.UTC(2026, 9, 20, 17, 44, 57, 999))).toBe("20 Oct 2026, 17:44:57 UTC");
    expect(dateTime(Date.UTC(2026, 0, 5, 3, 4, 5))).toBe("05 Jan 2026, 03:04:05 UTC");
  });
  it("reads an ISO time too", () => {
    expect(dateTime("2026-10-23T11:11:26.120Z")).toBe("23 Oct 2026, 11:11:26 UTC");
  });
});

describe("compactUnits", () => {
  it("shows at most six decimals, rounded, with a thousands separator, and says '<0.000001' for anything smaller that is not zero", () => {
    expect(compactUnits("1", 18)).toBe("<0.000001");
    expect(compactUnits("999999999999", 18)).toBe("<0.000001");
    expect(compactUnits("1000000000000", 18)).toBe("0.000001");
    expect(compactUnits("500000000000000000", 18)).toBe("0.5");
    expect(compactUnits("1234567891234567000000000", 18)).toBe("1,234,567.891235");
    expect(compactUnits("0", 18)).toBe("0");
    expect(compactUnits("1999999999999999999", 18)).toBe("2");
    expect(compactUnits("1500000", 6)).toBe("1.5");
    expect(compactUnits("1", 6)).toBe("0.000001");
  });
});

describe("the short forms the cards use", () => {
  it("says a big count in short and a rate without decimals from 10", async () => {
    const { compactCount, rateShort } = await import("./format.ts");
    expect(compactCount(6_961_234)).toBe("6.96 M");
    expect(compactCount(12_400)).toBe("12.4 k");
    expect(compactCount(9_245)).toBe("9,245");
    expect(rateShort(181.4)).toBe("181");
    expect(rateShort(9.46)).toBe("9.5");
    expect(rateShort(0.017)).toBe("0.017");
  });
});

describe("a label's number and unit", () => {
  it("stay together on a narrow screen", () => {
    expect(nb("24 h, RPC and faucet")).toBe("24\u00a0h, RPC and faucet");
    expect(nb("Time to final")).toBe("Time to final");
  });
});
