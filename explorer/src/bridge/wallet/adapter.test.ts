import { describe, expect, it, vi } from "vitest";
import { Refused, Waited } from "../moves/moves.ts";
import { depositIdOf } from "../moves/state.ts";
import { CHAIN, COIN, fakeWallet, WALLET_PARTY } from "./fake-wallet.ts";
import { NO_KEY, optedIn, optIn, walletAccount, walletAdapter } from "./adapter.ts";
import { linkWallet, WALLET_WORDS } from "./link.ts";

const TWIN = { admin: CHAIN.gateway, id: "erc20:" + "aa".repeat(20) };
const TOKEN = "0x" + "aa".repeat(20), TO = "0x" + "bb".repeat(20);
const DISCLOSED = { templateId: "t", contractId: "d1", createdEventBlob: "blob", synchronizerId: "sync" };

/** The public registry route, as the account service answers it. */
function registry() {
  const seen: { path: string; body: any }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    seen.push({ path: url.replace("/accounts/v1/public-registry/", ""), body });
    if (url.endsWith("/allocation-factory")) return new Response(JSON.stringify({ factoryId: "factory-1", choiceContext: { choiceContextData: { values: { rules: 1 } }, disclosedContracts: [DISCLOSED] } }), { status: 200 });
    if (url.endsWith("/withdraw-context")) return new Response(JSON.stringify({ choiceContextData: { values: { withdraw: 1 } }, disclosedContracts: [DISCLOSED] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  return { fetcher: fetcher as unknown as typeof fetch, seen };
}
async function setup(o = {}, make = (w: ReturnType<typeof fakeWallet>) => linkWallet(w.provider, { name: "W" })) {
  const w = fakeWallet(o);
  const link = await make(w);
  const reg = registry();
  const account = walletAccount(link, CHAIN, "", reg.fetcher);
  const adapter = walletAdapter(account, async () => {});
  return { w, link, reg, account, adapter };
}
const created = (w: ReturnType<typeof fakeWallet>, entity: string) => w.commands().filter((c) => c.CreateCommand?.templateId.endsWith(entity));

describe("the wallet's account", () => {
  it("has no key of the page's: the party is the wallet's and every command goes to the wallet", async () => {
    const { account, w } = await setup();
    expect(account.party).toBe(WALLET_PARTY);
    expect(account.key).toBe(NO_KEY);
    await account.submit((await import("../canton/commands.ts")).twinAcceptance(WALLET_PARTY, CHAIN));
    expect(w.commands()).toHaveLength(1);
  });
});

describe("the standing acceptances", () => {
  it("are made once, each approved in the wallet, in the order of the account service's opt-in, and read back", async () => {
    const { w, account } = await setup();
    expect(await optedIn(account)).toBe(false);
    await optIn(account, async () => {});
    expect(w.commands().map((c) => c.CreateCommand.templateId)).toEqual(["#ostia-twin:Twin.Twin:TwinAcceptance", "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"]);
    expect(w.commands()[0].CreateCommand.createArguments).toEqual({ party: WALLET_PARTY, admin: CHAIN.gateway });
    expect(w.commands()[1].CreateCommand.createArguments).toMatchObject({ party: WALLET_PARTY, operator: CHAIN.operator, gateway: CHAIN.gateway, chainId: "770101" });
    expect(await optedIn(account)).toBe(true);
  });
  it("ask only for what is missing, and nothing when both are there", async () => {
    const { w, account } = await setup();
    await optIn(account, async () => {});
    w.commands().length = 0;
    await optIn(account, async () => {});
    expect(w.commands()).toEqual([]);
    const half = await setup();
    half.w.add({ templateId: "p:Twin.Twin:TwinAcceptance", packageName: "ostia-twin", createArgument: { party: WALLET_PARTY, admin: CHAIN.gateway } });
    await optIn(half.account, async () => {});
    expect(half.w.commands().map((c) => c.CreateCommand.templateId)).toEqual(["#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"]);
  });
  it("stop when the person declines in the wallet, and leave the first one made", async () => {
    const { w, account } = await setup({ refuse: (c: any) => (c.CreateCommand.templateId.endsWith("WithdrawalAcceptance") ? 4001 : undefined) });
    await expect(optIn(account, async () => {})).rejects.toThrow(WALLET_WORDS.declined);
    expect(await optedIn(account)).toBe(false);
    expect(w.commands()).toHaveLength(1);
  });
  it("are not taken as made until the ledger shows both", async () => {
    const { account } = await setup({ silent: () => true });
    await expect(optIn(account, async () => {}, 2)).rejects.toMatchObject({ code: "acceptances_missing" });
  });
});

describe("a redeem", () => {
  it("is one create the wallet approves, burning twin holdings of the gateway's instrument, and it is not made again once it is there", async () => {
    const { w, adapter } = await setup();
    const big = w.holding("4", TWIN), mid = w.holding("3", TWIN);
    w.holding("99", COIN);
    await adapter.signRedeem({ asset: TOKEN as never, amount: "5.0000000000", recipient: TO as never, ref: "ref-1" });
    const [request] = created(w, "RedeemRequest");
    expect(request.CreateCommand.createArguments).toMatchObject({ holder: WALLET_PARTY, token: "aa".repeat(20), holdings: [big.contractId, mid.contractId], amount: "5.0000000000", recipient: "bb".repeat(20), ref: "ref-1" });
    expect(await adapter.appeared({ redeem: "ref-1" })).toBe(true);
    await adapter.signRedeem({ asset: TOKEN as never, amount: "5.0000000000", recipient: TO as never, ref: "ref-1" });
    expect(created(w, "RedeemRequest")).toHaveLength(1);
    await adapter.waitRedeem("ref-1");
  });
  it("is not made again by a page that was reloaded: a new adapter on the same wallet looks at the ledger first", async () => {
    const { w, account } = await setup();
    w.holding("5", TWIN);
    const first = walletAdapter(account, async () => {});
    await first.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "ref-1" });
    const second = walletAdapter(walletAccount(await linkWallet(w.provider, { name: "W" }), CHAIN, "", registry().fetcher), async () => {});
    await second.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "ref-1" });
    expect(created(w, "RedeemRequest")).toHaveLength(1);
  });
  it("refuses, in words, when the wallet's account does not hold enough, and asks the wallet nothing", async () => {
    const { w, adapter } = await setup();
    w.holding("1", TWIN);
    await expect(adapter.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "r" })).rejects.toThrow(Refused);
    expect(w.commands()).toEqual([]);
  });
  it("is taken back by archiving the request, when there is one", async () => {
    const { w, adapter } = await setup();
    w.holding("5", TWIN);
    await adapter.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "ref-1" });
    await adapter.cancelRedeem("ref-1");
    expect(w.commands().at(-1).ExerciseCommand).toMatchObject({ choice: "Archive" });
    expect(await adapter.appeared({ redeem: "ref-1" })).toBe(false);
    await adapter.cancelRedeem("ref-1");
    expect(w.commands().filter((c) => c.ExerciseCommand)).toHaveLength(1);
  });
  it("waits for the ledger to show it and gives up with `Waited`, not an error, when it does not", async () => {
    const { adapter } = await setup();
    await expect(adapter.waitRedeem("never")).rejects.toBeInstanceOf(Waited);
  });
  it("looks again after the wallet's rate is used up, instead of failing the wait", async () => {
    const { w, link } = await setup();
    w.holding("5", TWIN);
    let limited = 2;
    const limit = { ...link, party: link.party, ledgerApi: async (r: never) => { if (limited-- > 0) throw Object.assign(new Error("x"), { code: -32005 }); return link.ledgerApi(r); }, submit: link.submit };
    const adapter = walletAdapter(walletAccount(limit as never, CHAIN, "", registry().fetcher), async () => {});
    await adapter.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "r" }).catch(() => {});
    limited = 2;
    await adapter.waitRedeem("r");
  });
});

describe("a deposit of Canton Coin", () => {
  const input = { instrument: COIN, amount: "2.0000000000", label: "label-1" };
  const at = (w: ReturnType<typeof fakeWallet>) => w.commands().filter((c) => c.ExerciseCommand?.choice === "AllocationFactory_Allocate");

  it("asks the public registry for the factory, has the wallet allocate to the gateway with the registry's context and disclosed contracts, and is not made again once it is there", async () => {
    const { w, reg, adapter } = await setup();
    const h = w.holding("5.0000000000", COIN);
    await adapter.allocateDeposit(input);
    expect(reg.seen).toHaveLength(1);
    expect(reg.seen[0]!.path).toBe(`${COIN.admin}/allocation-factory`);
    expect(reg.seen[0]!.body).toMatchObject({ excludeDebugFields: true, choiceArguments: { expectedAdmin: COIN.admin } });
    expect(reg.seen[0]!.body).not.toHaveProperty("party");
    const [cmd] = at(w);
    expect(cmd.ExerciseCommand).toMatchObject({ contractId: "factory-1", choice: "AllocationFactory_Allocate" });
    expect(cmd.ExerciseCommand.choiceArgument).toMatchObject({ inputHoldingCids: [h.contractId], allocation: { transferLeg: { sender: WALLET_PARTY, receiver: CHAIN.gateway, amount: "2.0000000000" }, settlement: { executor: CHAIN.operator, settlementRef: { id: "label-1" } } }, extraArgs: { context: { values: { rules: 1 } } } });
    expect(w.requests.find((r) => r.method === "prepareExecute")!.params.disclosedContracts).toEqual([DISCLOSED]);
    expect(await adapter.appeared({ allocation: "label-1" })).toBe(true);
    await adapter.allocateDeposit(input);
    expect(at(w)).toHaveLength(1);
    expect(reg.seen).toHaveLength(1);
  });
  it("asks the wallet for the request that names the allocation's own contract id, once, and waits for it", async () => {
    const { w, adapter } = await setup();
    w.holding("5.0000000000", COIN);
    await adapter.allocateDeposit(input);
    const depositId = depositIdOf(WALLET_PARTY, "label-1");
    await adapter.signDeposit({ ...input, depositId, recipient: TO as never });
    const [request] = created(w, "DepositRequest");
    const allocation = w.contracts.find((c) => c.packageName === "splice-amulet" && c.view?.interface.endsWith("Allocation"))!;
    expect(request.CreateCommand.createArguments).toMatchObject({ depositor: WALLET_PARTY, allocation: allocation.contractId, label: "label-1", recipient: "bb".repeat(20), operator: CHAIN.operator });
    expect(await adapter.appeared({ deposit: depositId })).toBe(true);
    await adapter.signDeposit({ ...input, depositId, recipient: TO as never });
    expect(created(w, "DepositRequest")).toHaveLength(1);
    await adapter.waitDeposit(depositId);
  });
  it("refuses a deposit id that is not the one its label makes, and asks the wallet nothing", async () => {
    const { w, adapter } = await setup();
    await expect(adapter.signDeposit({ ...input, depositId: ("0x" + "00".repeat(32)) as never, recipient: TO as never })).rejects.toThrow(Refused);
    expect(w.commands()).toEqual([]);
  });
  it("takes the tokens back: the registry's context for the withdrawal, the wallet withdraws the allocation, and the request is archived", async () => {
    const { w, reg, adapter } = await setup();
    w.holding("5.0000000000", COIN);
    await adapter.allocateDeposit(input);
    const depositId = depositIdOf(WALLET_PARTY, "label-1");
    await adapter.signDeposit({ ...input, depositId, recipient: TO as never });
    const allocation = w.contracts.find((c) => c.view?.interface.endsWith("Allocation"))!.contractId;
    await adapter.recoverDeposit({ label: "label-1", depositId });
    expect(reg.seen.at(-1)!.path).toBe(`${COIN.admin}/allocation/${allocation}/withdraw-context`);
    const choices = w.commands().filter((c) => c.ExerciseCommand).map((c) => c.ExerciseCommand.choice);
    expect(choices).toEqual(["AllocationFactory_Allocate", "Allocation_Withdraw", "Archive"]);
    expect(await adapter.appeared({ allocation: "label-1" })).toBe(false);
    expect(await adapter.appeared({ deposit: depositId })).toBe(false);
    await adapter.recoverDeposit({ label: "label-1", depositId });
    expect(w.commands().filter((c) => c.ExerciseCommand)).toHaveLength(3);
  });
  it("still archives the request, and says the withdrawal could not be made, when the registry does not know the allocation", async () => {
    const { w, adapter, account } = await setup();
    w.holding("5.0000000000", COIN);
    await adapter.allocateDeposit(input);
    const depositId = depositIdOf(WALLET_PARTY, "label-1");
    await adapter.signDeposit({ ...input, depositId, recipient: TO as never });
    const broken = walletAdapter({ ...account, client: Object.assign(Object.create(account.client), { allocationWithdrawContext: async () => { throw Object.assign(new Error("gone"), { status: 404 }); } }) }, async () => {});
    await expect(broken.recoverDeposit({ label: "label-1", depositId })).rejects.toMatchObject({ status: 404 });
    expect(await broken.appeared({ deposit: depositId })).toBe(false);
  });
  it("reads the settle-before time of the allocation it made", async () => {
    const { w, adapter } = await setup();
    w.holding("5.0000000000", COIN);
    expect(await adapter.depositDeadline("label-1")).toBeNull();
    await adapter.allocateDeposit(input);
    expect(await adapter.depositDeadline("label-1")).toBeGreaterThan(Date.now());
  });
});
