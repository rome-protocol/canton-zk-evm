import { afterEach, describe, expect, it } from "vitest";
import { createLedger, CUSTODY_ENDPOINTS, FUNDED_CLAIM_TEMPLATE, GATEWAY_TOKEN_TEMPLATE, LedgerError, VENUE_TRADE_TEMPLATE, venueIn, type VenueUpdate } from "./ledger.ts";
import { checkpoint, createdEvent, FAKE_GATEWAY, FAKE_SELLER, FAKE_VENUE, fundedClaimEvent, gatewayTokenEvent, startFakeLedger, transaction, venueTradeEvent, type FakeLedger } from "../test/fake-ledger.ts";

const TKB = "0x" + "d1".repeat(20);
const PAY = "a1".repeat(32), CLAIM = "b2".repeat(32);
const BUYER = "0x" + "e5".repeat(20), PAYEE = "0x" + "f6".repeat(20);
const trade = { payId: PAY, claimId: CLAIM, token: "0x" + "d2".repeat(20), payee: PAYEE, recipient: BUYER, amount: 2_500_000n, gatewayToken: "00tok1" };
const claim = { claimId: CLAIM, recipient: BUYER, amount: "12.5", gatewayToken: "00tok1" };

let fake: FakeLedger | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });
const walk = async (l: ReturnType<typeof createLedger>, after: number, upTo: number) => {
  const out: { updates: VenueUpdate[]; offset: number }[] = [];
  for await (const p of l.venuePages(after, upTo)) out.push(p);
  return out;
};

describe("the Canton side of the swaps, read as the gateway", () => {
  it("asks for the three templates only, as the gateway party, on the updates call, and keeps the gateway client to its two calls", async () => {
    fake = await startFakeLedger([transaction(15, "u1", [gatewayTokenEvent(15, "00tok1", TKB)])]);
    const l = createLedger(fake.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS);
    await walk(l, 0, 20);
    const sent = fake.requests.filter((r) => r.path === "/v2/updates");
    expect(sent[0]!.query.get("limit")).toBe("100");
    const filter = (templateId: string) => ({ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } } });
    expect(sent[0]!.body).toEqual({
      beginExclusive: 0, endInclusive: 20,
      updateFormat: { includeTransactions: {
        eventFormat: { filtersByParty: { [FAKE_GATEWAY]: { cumulative: [filter(GATEWAY_TOKEN_TEMPLATE), filter(VENUE_TRADE_TEMPLATE), filter(FUNDED_CLAIM_TEMPLATE)] } }, verbose: false },
        transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
      } },
    });
    expect(VENUE_TRADE_TEMPLATE).toBe("#canton-zk-evm:Zk.Chain:VenueTrade");
    expect(FUNDED_CLAIM_TEMPLATE).toBe("#canton-zk-evm:Zk.Chain:FundedClaim");
  });

  it("reads the registered token, the trade and the claim, and keeps no party: neither the venue's nor the seller's", async () => {
    fake = await startFakeLedger([
      transaction(15, "u-tok", [gatewayTokenEvent(15, "00tok1", TKB, "registry::1220" + "b2".repeat(32), "TKB")]),
      transaction(16, "u-offer", [venueTradeEvent(16, "00trade", trade)]),
      transaction(20, "u-block", [fundedClaimEvent(20, "00claim", claim), createdEvent(20)]),
    ]);
    const pages = await walk(createLedger(fake.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), 0, 20);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.offset).toBe(20);
    expect(pages[0]!.updates).toEqual([
      { updateId: "u-tok", offset: 15, tokens: [{ contractId: "00tok1", evmToken: TKB, instrumentAdmin: "registry::1220" + "b2".repeat(32), instrumentId: "TKB" }], trades: [], claims: [] },
      { updateId: "u-offer", offset: 16, tokens: [], claims: [], trades: [trade] },
      { updateId: "u-block", offset: 20, tokens: [], trades: [], claims: [{ claimId: CLAIM, recipient: BUYER, amount: 125_000_000_000n, gatewayToken: "00tok1" }] },
    ]);
    const text = JSON.stringify(pages, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain(FAKE_VENUE);
    expect(text).not.toContain(FAKE_SELLER);
    expect(text).not.toContain("alice");
  });

  it("walks a page at a time and goes on from where the last page ended, and a checkpoint or another template is no fact", async () => {
    fake = await startFakeLedger([
      transaction(10, "u1", [gatewayTokenEvent(10, "00tok1", TKB)]), checkpoint(11),
      transaction(12, "u2", [createdEvent(12)]),
      transaction(13, "u3", [venueTradeEvent(13, "00trade", trade)]),
    ]);
    const l = createLedger(fake.url, 2000, FAKE_GATEWAY, 2, null, CUSTODY_ENDPOINTS);
    const pages = await walk(l, 0, 13);
    expect(pages.map((p) => [p.offset, p.updates.map((u) => u.updateId)])).toEqual([[11, ["u1"]], [13, ["u3"]]]);
    // Nothing above the bound is asked for, and a walk that is already there asks for nothing.
    expect(await walk(l, 13, 13)).toEqual([]);
    expect(fake.requests.map((r) => (r.body as { beginExclusive: number }).beginExclusive)).toEqual([0, 11]);
  });

  it.each([
    ["a payment id that is not 64 hex digits", venueTradeEvent(5, "00t", trade, { payId: "a1".repeat(31) })],
    ["an amount that is not 64 hex digits", venueTradeEvent(5, "00t", trade, { amount: "12" })],
    ["a recipient that is not an address", venueTradeEvent(5, "00t", trade, { recipient: "not-an-address" })],
    ["a trade that names no registered token", venueTradeEvent(5, "00t", trade, { gatewayToken: "" })],
    ["a claim amount that is not a decimal of at most 10 places", fundedClaimEvent(5, "00c", claim, { amount: "1.00000000001" })],
    ["a claim with a negative amount", fundedClaimEvent(5, "00c", claim, { amount: "-1" })],
    ["a registered token that is not an address", gatewayTokenEvent(5, "00k", "0x12")],
  ])("fails the read, with a LedgerError, on %s", async (_, event) => {
    expect(() => venueIn(transaction(5, "u", [event]))).toThrow(LedgerError);
    expect(() => venueIn(transaction(5, "u", [event]))).toThrow(/venue trades cannot be read|custody cannot be read/);
  });

  it("fails as a LedgerError when Canton does not answer", async () => {
    fake = await startFakeLedger([], { httpStatus: 500 });
    await expect(walk(createLedger(fake.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), 0, 5)).rejects.toBeInstanceOf(LedgerError);
  });
});
