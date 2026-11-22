import { describe, expect, it } from "vitest";
import { ALLOCATION_INTERFACE, createCanton, DEPOSIT_REQUEST_TEMPLATE, requestsFrom } from "./canton.ts";

const PKG = "abc123";
const request = (over: Record<string, unknown> = {}, cid = "00req1") => ({ contractEntry: { JsActiveContract: { createdEvent: {
  contractId: cid, templateId: `${PKG}:Zk.Chain:DepositRequest`,
  createArgument: { operator: "op", confirmer: "cf", gateway: "gw", builder: "b", chainId: "770101", depositor: "alice::1220", depositId: "d2".repeat(32), recipient: "a1".repeat(20), allocation: "00alloc1", label: "r1:0:0x" + "e3".repeat(20) + ":2000000000:17", ...over },
} } } });
const allocation = (cid: string, amount: string, settleBefore: string) => ({ contractEntry: { JsActiveContract: { createdEvent: {
  contractId: cid, templateId: `${PKG}:Some.Amulet:AmuletAllocation`,
  interfaceViews: [{ interfaceId: `${PKG}:Splice.Api.Token.AllocationV1:Allocation`, viewStatus: { code: 0 }, viewValue: { allocation: { settlement: { requestedAt: "2026-11-22T21:40:00Z", settleBefore }, transferLeg: { amount } } } }],
} } } });

describe("the open requests of a route", () => {
  it("reads a route's request with its amount and its real end from the allocation", () => {
    expect(requestsFrom([request()], [allocation("00alloc1", "5.0000000000", "2026-11-22T23:40:00Z")])).toEqual([
      { depositId: "d2".repeat(32), party: "alice::1220", label: "r1:0:0x" + "e3".repeat(20) + ":2000000000:17", amount: 50_000_000_000n, requestedAt: "2026-11-22T21:40:00Z", settleBefore: "2026-11-22T23:40:00Z" },
    ]);
  });
  it("keeps a request whose allocation is not in the view, with no amount and no end", () => {
    expect(requestsFrom([request()], [])).toMatchObject([{ amount: null, requestedAt: null, settleBefore: null }]);
    expect(requestsFrom([request()], [allocation("00other", "5", "2026-11-22T23:40:00Z")])).toMatchObject([{ amount: null, requestedAt: null, settleBefore: null }]);
  });
  it("leaves out a request with no label, or a label that is not a route's", () => {
    expect(requestsFrom([request({ label: null }), request({ label: "hello" }), request({ label: undefined })], [])).toEqual([]);
  });
  it("fails on a request that is not shaped as the template is", () => {
    expect(() => requestsFrom([request({ depositId: 5 })], [])).toThrow("not valid");
    expect(() => requestsFrom([request({ depositor: "" })], [])).toThrow("not valid");
  });
  it("ignores an allocation with an amount or an end it cannot read", () => {
    expect(requestsFrom([request()], [allocation("00alloc1", "-1", "2026-11-22T23:40:00Z"), allocation("00alloc1", "1e3", "x")])).toMatchObject([{ amount: null }]);
  });
});

describe("reading them as the gateway", () => {
  const ledger = (answers: (body: any) => unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const calls: { path: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { calls, reader: { ledgerEnd: async () => 42 }, gateway: { party: "gw::1220", call: async (_m: "GET" | "POST", path: string, body?: unknown) => { calls.push({ path, body }); return answers(body); } } };
  };
  it("asks for the two lists at the reader's ledger end, as the gateway party, and gives the requests", async () => {
    const l = ledger((b) => (JSON.stringify(b).includes("DepositRequest") ? [request()] : [allocation("00alloc1", "5", "2026-11-22T23:40:00Z")]));
    const found = await createCanton({ reader: l.reader, gateway: l.gateway as never }).requests();
    expect(found).toHaveLength(1);
    expect(l.calls).toHaveLength(2);
    for (const c of l.calls) {
      expect(c.path).toBe("/v2/state/active-contracts?limit=500");
      expect(c.body.activeAtOffset).toBe(42);
      expect(Object.keys(c.body.eventFormat.filtersByParty)).toEqual(["gw::1220"]);
    }
    expect(JSON.stringify(l.calls[0]!.body)).toContain(DEPOSIT_REQUEST_TEMPLATE);
    expect(JSON.stringify(l.calls[1]!.body)).toContain(ALLOCATION_INTERFACE);
  });
  it("refuses a list as long as the limit, which may have been cut, and an answer that is not a list", async () => {
    const full = ledger(() => Array.from({ length: 3 }, () => request()));
    await expect(createCanton({ reader: full.reader, gateway: full.gateway as never, limit: 3 }).requests()).rejects.toThrow("may be cut short");
    const notList = ledger(() => ({}));
    await expect(createCanton({ reader: notList.reader, gateway: notList.gateway as never }).requests()).rejects.toThrow("not valid");
  });
});
