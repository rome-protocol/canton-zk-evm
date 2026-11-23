import { describe, expect, it } from "vitest";
import { createReceiptsRest, DEPOSITS_MAX } from "./receipts.ts";

const b = (n: number, len = 20) => Buffer.alloc(len, n);
const hexOf = (n: number, len = 20) => "0x" + b(n, len).toString("hex");

describe("the gateway's open receipts and payouts, from the rows the indexer keeps", () => {
  const rest = (rows: Record<string, unknown>[]) => {
    const asked: { sql: string; values: unknown[] }[] = [];
    return { asked, ...createReceiptsRest(async (sql, values = []) => (asked.push({ sql, values }), rows)) };
  };

  it("lists the deposits of one address, each naming its token and carrying no party", async () => {
    const r = rest([
      { deposit_id: b(1, 32), erc20: b(0xd1), amount: "125000000000", created_at: "2026-11-23T10:00:00Z", instrument_id: "TKB", symbol: "wTKB" },
      { deposit_id: b(2, 32), erc20: b(0xd2), amount: "5", created_at: new Date("2026-11-23T09:00:00Z"), instrument_id: null, symbol: null },
    ]);
    expect(await r.deposits(hexOf(0xe1))).toEqual([
      { depositId: hexOf(1, 32), token: hexOf(0xd1), symbol: "wTKB", instrumentId: "TKB", amount: "125000000000", amountDecimals: 10, createdAt: "2026-11-23T10:00:00.000Z" },
      { depositId: hexOf(2, 32), token: hexOf(0xd2), symbol: null, instrumentId: null, amount: "5", amountDecimals: 10, createdAt: "2026-11-23T09:00:00.000Z" },
    ]);
    expect(r.asked[0]!.values).toEqual([b(0xe1), DEPOSITS_MAX]);
  });

  const row = (over: Record<string, unknown>) => ({ payout_id: b(7, 32), erc20: b(0xd1), amount: "30000000000", created_at: "2026-11-23T10:00:00Z", paid_at: null, until: null, instrument_id: "TKB", symbol: "wTKB", ...over });
  const base = { id: hexOf(7, 32), token: hexOf(0xd1), symbol: "wTKB", instrumentId: "TKB", amount: "30000000000", amountDecimals: 10, createdAt: "2026-11-23T10:00:00.000Z" };

  it("says a payout is waiting, offered until a time, or paid", async () => {
    expect(await rest([row({})]).payout(hexOf(7, 32))).toEqual({ ...base, status: "waiting", until: null, paidAt: null });
    expect(await rest([row({ until: "2026-11-24T10:00:00Z" })]).payout(hexOf(7, 32))).toEqual({ ...base, status: "offered", until: "2026-11-24T10:00:00.000Z", paidAt: null });
    // Once paid, an offer that is still listed is no longer the news.
    expect(await rest([row({ paid_at: "2026-11-24T09:00:00Z", until: "2026-11-24T10:00:00Z" })]).payout(hexOf(7, 32))).toEqual({ ...base, status: "paid", until: null, paidAt: "2026-11-24T09:00:00.000Z" });
  });

  it("answers null for a payout the gateway has none of", async () => {
    expect(await rest([]).payout(hexOf(9, 32))).toBeNull();
  });
});
