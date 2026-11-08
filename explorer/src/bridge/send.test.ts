import { describe, expect, it, vi } from "vitest";
import { AmountError } from "./amounts.ts";
import { AccountsError, type Holding, type OpenState, type TransferView } from "./canton/accounts.ts";
import { TRANSFER_PAST_MS, TRANSFER_WINDOW_MS, type Built } from "./canton/commands.ts";
import type { CantonKey } from "./canton/key.ts";
import { createSender, offersOf } from "./send.ts";
import { checkAmount, checkReceiver, confirmLine, shortAddress, tidyAmount } from "./sendwords.ts";
import type { Pair } from "./tokens.ts";

const id = (tag: string, n: number) => `${tag}::1220${n.toString(16).padStart(2, "0").repeat(32)}`;
const PARTY = id("bridge", 0xab), OTHER = id("bridge", 0xcd), DSO = id("DSO", 5), GATEWAY = id("gateway", 3);
const NOW = Date.parse("2026-11-09T12:00:00Z");
const key: CantonKey = { publicKey: new Uint8Array(32) };
const COIN: Pair = { key: "wrapped:cc", kind: "wrapped", native: false, wrapped: null, erc20: "0x" + "c1".repeat(20) as `0x${string}`, ostia: { symbol: "wCC", decimals: 10 }, canton: { symbol: "Canton Coin", admin: DSO, id: "Amulet", decimals: 10 } };
const TWIN: Pair = { key: "twin:a", kind: "twin", native: false, wrapped: null, erc20: "0x" + "aa".repeat(20) as `0x${string}`, ostia: { symbol: "TKA", decimals: 6 }, canton: { symbol: "TKA", admin: GATEWAY, id: "erc20:" + "aa".repeat(20), decimals: 10 } };
const OTHER_TOKEN: Pair = { ...COIN, key: "wrapped:x", canton: { symbol: "TKB", admin: DSO, id: "TKB", decimals: 10 } };   // a token whose package this page does not know
const held = (contractId: string, amount: string, pair: Pair = COIN, locked = false): Holding => ({ contractId, instrumentId: { admin: pair.canton.admin, id: pair.canton.id }, amount, locked });
const DISCLOSED = { templateId: "t", contractId: "d1", createdEventBlob: "blob", synchronizerId: "sync" };
const open = (redeems: unknown[] = []): OpenState => ({ depositRequests: [], redeemRequests: redeems as OpenState["redeemRequests"], twinAcceptance: null, withdrawalAcceptance: null });

describe("the send form's words and checks", () => {
  it("takes a Canton address and refuses anything else, and the account's own", () => {
    expect(checkReceiver(`  ${OTHER} `, PARTY)).toBe(OTHER);
    expect(() => checkReceiver("", PARTY)).toThrow(/Type the address/);
    for (const bad of ["bridge", "bridge::1220ab", OTHER.toUpperCase(), OTHER + "0", "::1220" + "ab".repeat(32), OTHER.replace("::1220", "::1221"), `a b::1220${"ab".repeat(32)}`, "0x" + "ab".repeat(20)]) expect(() => checkReceiver(bad, PARTY), bad).toThrow(AmountError);
    expect(() => checkReceiver(PARTY, PARTY)).toThrow(/your own address/);
    expect(() => checkReceiver(`${PARTY}`, PARTY)).toThrow(/someone else/);
  });
  it("says an address and the line to confirm in the short form the panel uses", () => {
    expect(shortAddress(OTHER)).toBe("bridge::1220…cdcd");
    expect(shortAddress(DSO)).toBe("DSO::1220…0505");
    expect(confirmLine("5", "Canton Coin", OTHER)).toBe("Send 5 Canton Coin to bridge::1220…cdcd on Canton");
    expect(tidyAmount(".50", 10)).toBe("0.5");
    expect(tidyAmount("5.", 10)).toBe("5");
    expect(tidyAmount("007.250000", 10)).toBe("7.25");
  });
  it("holds the amount to the move card's rules and to what the account holds", () => {
    expect(checkAmount("1.5", COIN, 20n * 10n ** 10n)).toBe(15_000_000_000n);
    expect(() => checkAmount("", COIN, null)).toThrow(/Type an amount/);
    expect(() => checkAmount("0", COIN, null)).toThrow(/more than zero/);
    expect(() => checkAmount("1.1234567", TWIN, null)).toThrow(/at most 6 decimals/);   // a twin of 6 decimals moves in steps of 6
    expect(() => checkAmount("21", COIN, 20n * 10n ** 10n)).toThrow(/do not hold that much/);
    expect(checkAmount("20", COIN, 20n * 10n ** 10n)).toBe(20n * 10n ** 10n);
    expect(checkAmount("1.000001", TWIN, null)).toBe(10_000_010_000n);
  });
});

function sender(o: { holdings?: Holding[]; open?: OpenState; kind?: string; closed?: boolean } = {}) {
  const submitted: Built[] = [];
  const client = {
    holdings: vi.fn(async () => o.holdings ?? [held("h1", "10.0"), held("h2", "4.0")]),
    openRequests: vi.fn(async () => o.open ?? open()),
    transferFactory: vi.fn(async (_k: CantonKey, _admin: string, _party: string, _args: object) => ({ factoryId: "factory1", transferKind: o.kind ?? "offer", choiceContext: { choiceContextData: { values: { x: 1 } }, disclosedContracts: [DISCLOSED] } })),
    transfers: vi.fn(async () => ({ transfers: [] as TransferView[], more: false })),
    acceptContext: vi.fn(async () => ({ choiceContextData: { values: {} }, disclosedContracts: [] })),
  };
  const account = { key, party: PARTY, client, closed: o.closed ?? false, submit: vi.fn(async (b: Built) => { submitted.push(b); return "update1"; }) };
  return { client, account, submitted, sender: createSender(account as never, () => NOW) };
}

describe("sending on Canton", () => {
  it("asks the registry's transfer factory for exactly the transfer it will sign, then signs it: the person's receiver, amount, instrument and the account's own unlocked holdings", async () => {
    const t = sender();
    const result = await t.sender.send(COIN, "12.5", ` ${OTHER}`);
    expect(result).toEqual({ updateId: "update1", waiting: true });
    const [admin, , args] = [t.client.transferFactory.mock.calls[0]![1], 0, t.client.transferFactory.mock.calls[0]![3] as any];
    expect(admin).toBe(DSO);
    expect(args.expectedAdmin).toBe(DSO);
    expect(args.transfer).toEqual({
      sender: PARTY, receiver: OTHER, amount: "12.5000000000", instrumentId: { admin: DSO, id: "Amulet" },
      requestedAt: new Date(NOW - TRANSFER_PAST_MS).toISOString(), executeBefore: new Date(NOW + TRANSFER_WINDOW_MS).toISOString(), inputHoldingCids: ["h1", "h2"], meta: { values: {} },
    });
    expect(Object.keys(args.transfer)).toEqual(["sender", "receiver", "amount", "instrumentId", "requestedAt", "executeBefore", "inputHoldingCids", "meta"]);   // the standard's field order
    const [built] = t.submitted;
    expect(built!.command).toMatchObject({ ExerciseCommand: { contractId: "factory1", choice: "TransferFactory_Transfer", choiceArgument: { transfer: args.transfer, extraArgs: { context: { values: { x: 1 } } } } } });
    expect(built!.intent).toMatchObject({ party: PARTY, kind: "exercise", choice: "TransferFactory_Transfer", contractId: "factory1", implementation: "splice-amulet", ignore: ["extraArgs.context"] });
    expect(built!.disclosedContracts).toEqual([DISCLOSED]);
  });
  it("says it is done when the registry completes it at once, and waiting when the receiver has to accept", async () => {
    expect((await sender({ kind: "direct" }).sender.send(COIN, "1", OTHER)).waiting).toBe(false);
    expect((await sender({ kind: "offer" }).sender.send(COIN, "1", OTHER)).waiting).toBe(true);
  });
  it("sends a twin through the twin's own admin, with its implementing package", async () => {
    const t = sender({ holdings: [held("t1", "3.0", TWIN)] });
    await t.sender.send(TWIN, "1.5", OTHER);
    expect(t.client.transferFactory.mock.calls[0]![1]).toBe(GATEWAY);
    expect(t.submitted[0]!.intent).toMatchObject({ implementation: "ostia-twin" });
  });
  it("picks the fewest holdings, leaves out locked ones, other tokens' and those an open redeem names", async () => {
    const t = sender({ holdings: [held("h1", "10.0"), held("lock", "50.0", COIN, true), held("tw", "50.0", TWIN), held("h2", "4.0"), held("h3", "3.0")], open: open([{ contractId: "r1", arguments: { holdings: ["h1"] } }]) });
    await t.sender.send(COIN, "6", OTHER);
    expect((t.client.transferFactory.mock.calls[0]![3] as any).transfer.inputHoldingCids).toEqual(["h2", "h3"]);
  });
  it("refuses, and signs nothing, when the holdings do not cover it, or only an open redeem's would", async () => {
    const few = sender({ holdings: [held("h1", "1.0")] });
    await expect(few.sender.send(COIN, "2", OTHER)).rejects.toThrow(/do not hold enough/);
    const named = sender({ holdings: [held("h1", "10.0")], open: open([{ contractId: "r1", arguments: { holdings: ["h1"] } }]) });
    await expect(named.sender.send(COIN, "2", OTHER)).rejects.toThrow(/redeem that is still open/);
    for (const t of [few, named]) { expect(t.submitted).toEqual([]); expect(t.client.transferFactory).not.toHaveBeenCalled(); }
  });
  it("refuses a bad receiver, the account's own address, a bad amount and a token it cannot sign for, before it asks anyone", async () => {
    const t = sender();
    await expect(t.sender.send(COIN, "1", PARTY)).rejects.toThrow(AmountError);
    await expect(t.sender.send(COIN, "1", "nobody")).rejects.toThrow(AmountError);
    await expect(t.sender.send(COIN, "0.00000000001", OTHER)).rejects.toThrow(AmountError);
    expect(t.sender.can(COIN)).toBe(true);
    expect(t.sender.can(TWIN)).toBe(true);
    expect(t.sender.can(OTHER_TOKEN)).toBe(false);
    expect(t.client.holdings).not.toHaveBeenCalled();
    expect(t.submitted).toEqual([]);
  });
  it("does nothing for an account that was let go, and passes the service's refusal on", async () => {
    const gone = sender({ closed: true });
    await expect(gone.sender.send(COIN, "1", OTHER)).rejects.toMatchObject({ code: "account_closed" });
    await expect(gone.sender.incoming([COIN])).rejects.toMatchObject({ code: "account_closed" });
    expect(gone.client.holdings).not.toHaveBeenCalled();
    const refused = sender();
    refused.client.transferFactory.mockRejectedValueOnce(new AccountsError("not-found", 404, "no registry"));
    await expect(refused.sender.send(COIN, "1", OTHER)).rejects.toBeInstanceOf(AccountsError);
    expect(refused.submitted).toEqual([]);
  });
});

const view = (contractId: string, over: Partial<TransferView["transfer"]> = {}): TransferView => ({
  contractId, transfer: { sender: OTHER, receiver: PARTY, amount: "5.0000000000", instrumentId: { admin: DSO, id: "Amulet" }, requestedAt: "2026-11-09T11:00:00Z", executeBefore: "2026-11-10T11:00:00Z", ...over },
});

describe("incoming transfers", () => {
  it("lists the offers to the account for tokens the page lists, and leaves out the rest", () => {
    const views = [
      view("a"), view("own", { sender: PARTY, receiver: OTHER }), view("to-other", { receiver: id("bridge", 0x99) }), view("lapsed", { executeBefore: "2026-11-09T11:59:59Z" }),
      view("unlisted", { instrumentId: { admin: DSO, id: "Unlisted" } }), view("odd", { amount: "1.00000000001" }), view("twin", { instrumentId: { admin: GATEWAY, id: TWIN.canton.id }, amount: "0.5" }),
      view("unknown-package", { instrumentId: { admin: DSO, id: "TKB" } }),
    ];
    const offers = offersOf(views, PARTY, [COIN, TWIN, OTHER_TOKEN], NOW);
    expect(offers.map((o) => [o.id, o.amount, o.pair.canton.symbol, o.from])).toEqual([["a", "5", "Canton Coin", OTHER], ["twin", "0.5", "TKA", OTHER]]);
    expect(offers[0]!.until).toBe(Date.parse("2026-11-10T11:00:00Z"));
  });
  it("accepts an offer with the registry's accept context of its token, as the account", async () => {
    const t = sender();
    t.client.transfers.mockResolvedValueOnce({ transfers: [view("offer1")], more: false });
    const [offer] = await t.sender.incoming([COIN]);
    await t.sender.accept(offer!);
    expect(t.client.acceptContext).toHaveBeenCalledWith(key, DSO, "offer1", PARTY);
    expect(t.submitted[0]!.command).toMatchObject({ ExerciseCommand: { contractId: "offer1", choice: "TransferInstruction_Accept" } });
    expect(t.submitted[0]!.intent).toMatchObject({ party: PARTY, contractId: "offer1", implementation: "splice-amulet" });
  });
});
