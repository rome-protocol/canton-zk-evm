import { describe, expect, it, vi } from "vitest";
import { AccountsError } from "../canton/accounts.ts";
import { Refused } from "../moves/moves.ts";
import { CHAIN, COIN, fakeWallet, id, WALLET_PARTY } from "./fake-wallet.ts";
import { ledgerError, PublicRegistry, WalletClient, WalletLedger } from "./ledger.ts";
import { linkWallet } from "./link.ts";

const setup = async (o = {}) => {
  const w = fakeWallet(o);
  const link = await linkWallet(w.provider, { name: "W" });
  return { w, link, ledger: new WalletLedger(link, CHAIN) };
};
const TWIN = { admin: CHAIN.gateway, id: "erc20:" + "aa".repeat(20) };

describe("what the page reads of a connected wallet's account", () => {
  describe("holdings", () => {
    it("are the party's own holdings of every instrument, as the account service gives them (a holding that is only seen is left out)", async () => {
      const { w, ledger } = await setup();
      const a = w.holding("5.0000000000", COIN), b = w.holding("2.5", TWIN, { locked: true });
      w.holding("9", COIN, { owner: id("bob", 9) });
      expect(await ledger.holdings(null, WALLET_PARTY)).toEqual([
        { contractId: a.contractId, instrumentId: COIN, amount: "5.0000000000", locked: false },
        { contractId: b.contractId, instrumentId: TWIN, amount: "2.5", locked: true },
      ]);
    });
    it("asks the ledger for the party's active contracts through the holding interface, and only the party", async () => {
      const { w, ledger } = await setup();
      await ledger.holdings(null, WALLET_PARTY);
      const call = w.requests.find((r) => r.method === "ledgerApi")!.params;
      expect(call).toMatchObject({ requestMethod: "post", resource: "/v2/state/active-contracts-page" });
      expect(Object.keys(call.body.eventFormat.filtersByParty)).toEqual([WALLET_PARTY]);
      expect(call.body.eventFormat.filtersByParty[WALLET_PARTY].cumulative[0].identifierFilter.InterfaceFilter.value).toEqual({ interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding", includeInterfaceView: true, includeCreatedEventBlob: false });
    });
    it("follow the ledger's pages of one snapshot", async () => {
      const { w, ledger } = await setup({ pageSize: 2 });
      for (let i = 0; i < 5; i++) w.holding(String(i + 1), COIN);
      expect((await ledger.holdings(null, WALLET_PARTY)).map((h) => h.amount)).toEqual(["1", "2", "3", "4", "5"]);
      const pages = w.requests.filter((r) => r.method === "ledgerApi").map((r) => r.params.body);
      expect(pages).toHaveLength(3);
      expect(pages[1]).toMatchObject({ activeAtOffset: 42, pageToken: "2" });
    });
    it("are not read for any other party", async () => {
      const { ledger } = await setup();
      await expect(ledger.holdings(null, id("bob", 9))).rejects.toThrow(Refused);
    });
  });

  describe("allocations", () => {
    it("are the party's own (the party is the sender of the leg), with their holdings", async () => {
      const { w, ledger } = await setup();
      const spec = { settlement: { settlementRef: { id: "label-1" } }, transferLegId: "leg-1", transferLeg: { sender: WALLET_PARTY, receiver: CHAIN.gateway, amount: "1", instrumentId: COIN } };
      const mine = w.add({ templateId: "p:M:AmuletAllocation", packageName: "splice-amulet", view: { interface: "Splice.Api.Token.AllocationV1:Allocation", value: { allocation: spec, holdingCids: ["h1"] } } });
      w.add({ templateId: "p:M:AmuletAllocation", packageName: "splice-amulet", view: { interface: "Splice.Api.Token.AllocationV1:Allocation", value: { allocation: { ...spec, transferLeg: { ...spec.transferLeg, sender: id("bob", 9) } }, holdingCids: [] } } });
      expect(await ledger.allocations(null, WALLET_PARTY)).toEqual([{ contractId: mine.contractId, allocation: spec, holdingCids: ["h1"] }]);
    });
  });

  describe("open requests and the two acceptances", () => {
    const own = { operator: CHAIN.operator, confirmer: CHAIN.confirmer, gateway: CHAIN.gateway, builder: CHAIN.builder, chainId: "770101" };
    it("are read in one look, each by its owner, and put where the account service puts them", async () => {
      const { w, ledger } = await setup();
      const dep = w.add({ templateId: "p:Zk.Chain:DepositRequest", packageName: "canton-zk-evm", createArgument: { ...own, depositor: WALLET_PARTY, depositId: "d1" } });
      const red = w.add({ templateId: "p:Zk.Chain:RedeemRequest", packageName: "canton-zk-evm", createArgument: { ...own, holder: WALLET_PARTY, ref: "r1" } });
      const twin = w.add({ templateId: "p:Twin.Twin:TwinAcceptance", packageName: "ostia-twin", createArgument: { party: WALLET_PARTY, admin: CHAIN.gateway } });
      const wd = w.add({ templateId: "p:Zk.Chain:WithdrawalAcceptance", packageName: "canton-zk-evm", createArgument: { ...own, party: WALLET_PARTY } });
      const open = await ledger.openRequests(null, WALLET_PARTY);
      expect(open.depositRequests).toEqual([{ contractId: dep.contractId, arguments: { ...own, depositor: WALLET_PARTY, depositId: "d1" } }]);
      expect(open.redeemRequests.map((r) => r.contractId)).toEqual([red.contractId]);
      expect(open.twinAcceptance?.contractId).toBe(twin.contractId);
      expect(open.withdrawalAcceptance?.contractId).toBe(wd.contractId);
      expect(w.requests.filter((r) => r.method === "ledgerApi")).toHaveLength(1);
    });
    it("have nothing, as null, when the party has made none", async () => {
      const { ledger } = await setup();
      expect(await ledger.openRequests(null, WALLET_PARTY)).toEqual({ depositRequests: [], redeemRequests: [], twinAcceptance: null, withdrawalAcceptance: null });
    });
    it("leave out what names another chain's parties, or another gateway's twins, or is another party's", async () => {
      const { w, ledger } = await setup();
      w.add({ templateId: "p:Zk.Chain:WithdrawalAcceptance", packageName: "canton-zk-evm", createArgument: { ...own, operator: id("operator", 77), party: WALLET_PARTY } });
      w.add({ templateId: "p:Zk.Chain:RedeemRequest", packageName: "canton-zk-evm", createArgument: { ...own, chainId: "1", holder: WALLET_PARTY, ref: "x" } });
      w.add({ templateId: "p:Twin.Twin:TwinAcceptance", packageName: "ostia-twin", createArgument: { party: WALLET_PARTY, admin: id("gateway", 99) } });
      w.add({ templateId: "p:Zk.Chain:DepositRequest", packageName: "canton-zk-evm", createArgument: { ...own, depositor: id("bob", 9), depositId: "d" } });
      expect(await ledger.openRequests(null, WALLET_PARTY)).toEqual({ depositRequests: [], redeemRequests: [], twinAcceptance: null, withdrawalAcceptance: null });
    });
  });

  describe("when the wallet cannot answer", () => {
    const failing = (code: number) => {
      const link = { party: WALLET_PARTY, ledgerApi: async () => { throw Object.assign(new Error("x"), { code }); } };
      return new WalletLedger(link, CHAIN);
    };
    it("a rate (-32005) is a rate the wait looks again after, and an outage (-32002) an unavailable one", async () => {
      expect(await failing(-32005).holdings(null, WALLET_PARTY).catch((e) => e)).toMatchObject({ name: "AccountsError", kind: "rate-limited" });
      expect(await failing(-32002).holdings(null, WALLET_PARTY).catch((e) => e)).toMatchObject({ name: "AccountsError", kind: "unavailable" });
    });
    it("a wallet that does not let the page read is told in words", async () => {
      await expect(failing(4200).holdings(null, WALLET_PARTY)).rejects.toThrow("does not let this page read your account");
    });
    it("a wallet that is not connected is told in words", async () => {
      await expect(failing(4900).holdings(null, WALLET_PARTY)).rejects.toBeInstanceOf(AccountsError);
      expect(ledgerError(Object.assign(new Error("x"), { code: 4100 }))).toBeInstanceOf(Refused);
    });
  });
});

describe("the public registry route", () => {
  const answering = (status: number, body: unknown, headers: Record<string, string> = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
  const admin = id("DSO", 5);

  it("asks the allocation factory with the registry's request body, no party and no signature, and gives the answer as it is", async () => {
    const fetcher = answering(200, { factoryId: "f1", choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [] } });
    const answer = await new PublicRegistry("", fetcher as never).allocationFactory(admin, { expectedAdmin: admin });
    expect(answer.factoryId).toBe("f1");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/accounts/v1/public-registry/${admin}/allocation-factory`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ choiceArguments: { expectedAdmin: admin }, excludeDebugFields: true });
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });
  it("asks for the context to take an allocation back, and for a twin's transfer factory, on the signed relay's paths", async () => {
    const fetcher = answering(200, { choiceContextData: { values: {} } });
    const r = new PublicRegistry("https://x.example", fetcher as never);
    const cid = "00" + "ab".repeat(20);
    await r.allocationWithdrawContext(admin, cid);
    await r.transferFactory(admin, { a: 1 });
    expect(fetcher.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([`https://x.example/accounts/v1/public-registry/${admin}/allocation/${cid}/withdraw-context`, `https://x.example/accounts/v1/public-registry/${admin}/transfer-factory`]);
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ meta: {}, excludeDebugFields: true });
  });
  it("builds no path from a party or a contract id that is not the shape the relay accepts, and sends nothing", async () => {
    const fetcher = answering(200, {});
    const r = new PublicRegistry("", fetcher as never);
    const cid = "00" + "ab".repeat(20);
    for (const bad of ["../x", "a/b::1220" + "ab".repeat(32), "x::1220" + "ab".repeat(32) + "/..", "DSO::1220" + "ab".repeat(32) + "?q", ""]) {
      await expect(r.allocationFactory(bad, {})).rejects.toMatchObject({ kind: "bad-request" });
    }
    for (const bad of ["../../x", "00ab", cid + "/..", "zz" + cid, ""]) await expect(r.allocationWithdrawContext(admin, bad)).rejects.toMatchObject({ kind: "bad-request" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("says what each refusal is: 404 an unknown registry (which waiting does not clear), 400 a request that is too long, 429 a used-up rate with its wait, 5xx an outage", async () => {
    const ask = (status: number, headers = {}) => new PublicRegistry("", answering(status, { error: "x" }, headers) as never).allocationFactory(admin, {}).catch((e) => e);
    expect(await ask(404)).toMatchObject({ kind: "not-found", status: 404 });
    expect(await ask(400)).toMatchObject({ kind: "bad-request" });
    expect(await ask(429, { "Retry-After": "30" })).toMatchObject({ kind: "rate-limited", retryAfter: 30 });
    expect(await ask(503)).toMatchObject({ kind: "unavailable" });
    expect((await ask(404)).message).not.toMatch(/registry|account service/i);
  });
  it("is a network error when the site cannot be reached", async () => {
    expect(await new PublicRegistry("", (async () => { throw new TypeError("offline"); }) as never).allocationFactory(admin, {}).catch((e) => e)).toMatchObject({ kind: "network" });
  });
});

describe("the reads of the move library for a wallet", () => {
  it("answer with the signature of the account service's, ignoring the key", async () => {
    const { w, ledger } = await setup();
    const registry = { allocationFactory: vi.fn(async () => ({ factoryId: "f" })), allocationWithdrawContext: vi.fn(async () => ({})), transferFactory: vi.fn(async () => ({})) };
    const client = new WalletClient(ledger, registry as never);
    w.holding("1", COIN);
    expect(await client.holdings({}, WALLET_PARTY)).toHaveLength(1);
    await client.allocationFactory({}, "admin", WALLET_PARTY, { a: 1 });
    await client.allocationWithdrawContext({}, "admin", "00cd", WALLET_PARTY);
    await client.transferFactory({}, "admin", WALLET_PARTY, { b: 2 });
    expect(registry.allocationFactory).toHaveBeenCalledWith("admin", { a: 1 });
    expect(registry.allocationWithdrawContext).toHaveBeenCalledWith("admin", "00cd");
    expect(registry.transferFactory).toHaveBeenCalledWith("admin", { b: 2 });
  });
});
