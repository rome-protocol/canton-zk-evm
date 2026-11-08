import { describe, expect, it, vi } from "vitest";
import { AccountsError, type AllocationView, type Holding, type OpenRequest } from "./canton/accounts.ts";
import type { Built } from "./canton/commands.ts";
import type { CantonKey } from "./canton/key.ts";
import { cantonAdapter, cover } from "./adapter.ts";
import { Refused, Waited } from "./moves/moves.ts";
import { depositIdOf } from "./moves/state.ts";

const id = (tag: string, n: number) => `${tag}::1220${n.toString(16).padStart(2, "0").repeat(32)}`;
const PARTY = id("bridge", 0xab), chain = { operator: id("operator", 1), confirmer: id("confirmer", 2), gateway: id("gateway", 3), builder: id("builder", 4), chainId: 770101 };
const TOKEN = "0x" + "aa".repeat(20), TO = "0x" + "bb".repeat(20), NOW = Date.parse("2026-11-05T12:00:00Z");
const TWIN = { admin: chain.gateway, id: "erc20:" + "aa".repeat(20) }, COIN = { admin: id("dso", 5), id: "Amulet" };
const DISCLOSED = { templateId: "t", contractId: "d1", createdEventBlob: "blob", synchronizerId: "sync" };
const key: CantonKey = { publicKey: new Uint8Array(32) };
const held = (contractId: string, amount: string, instrumentId = TWIN, locked = false): Holding => ({ contractId, instrumentId, amount, locked });

/** A fake account service that remembers what the adapter made, and an adapter over it: each command that is submitted shows in the next read, as on the ledger. */
function setup(holdings: Holding[] = [], over: { allocationFactory?: () => Promise<unknown> } = {}) {
  const ledger = { holdings, allocations: [] as AllocationView[], redeemRequests: [] as OpenRequest[], depositRequests: [] as OpenRequest[] };
  const submitted: Built[] = [];
  const client = {
    holdings: vi.fn(async () => ledger.holdings),
    allocations: vi.fn(async () => ledger.allocations),
    openRequests: vi.fn(async () => ({ redeemRequests: ledger.redeemRequests, depositRequests: ledger.depositRequests, twinAcceptance: null, withdrawalAcceptance: null })),
    allocationWithdrawContext: vi.fn(async () => ({ choiceContextData: { values: { withdraw: 1 } }, disclosedContracts: [DISCLOSED] })),
    allocationFactory: vi.fn(over.allocationFactory ?? (async () => ({ factoryId: "factory-1", choiceContext: { choiceContextData: { values: { rules: 1 } }, disclosedContracts: [DISCLOSED] } }))),
  };
  const sleeps: number[] = [];
  const adapter = cantonAdapter({
    client: client as never, key, party: PARTY, chain, now: () => NOW, pollMs: 7, maxPolls: 3,
    sleep: async (ms) => { sleeps.push(ms); },
    submit: async (b) => {
      submitted.push(b);
      const c = b.command;
      if ("CreateCommand" in c) {
        const a = c.CreateCommand.createArguments as Record<string, unknown>;
        if (c.CreateCommand.templateId.endsWith("RedeemRequest")) ledger.redeemRequests.push({ contractId: "r" + submitted.length, arguments: a });
        else ledger.depositRequests.push({ contractId: "d" + submitted.length, arguments: a });
      } else if (c.ExerciseCommand.choice === "Allocation_Withdraw") {
        ledger.allocations = ledger.allocations.filter((a) => a.contractId !== c.ExerciseCommand.contractId);
      } else if (c.ExerciseCommand.choice === "Archive") {
        ledger.depositRequests = ledger.depositRequests.filter((r) => r.contractId !== c.ExerciseCommand.contractId);
      } else {
        const spec = (c.ExerciseCommand.choiceArgument as { allocation: AllocationView["allocation"] }).allocation;
        ledger.allocations.push({ contractId: "alloc-" + spec.settlement.settlementRef.id, allocation: spec, holdingCids: [] });
      }
      return "update";
    },
  });
  return { adapter, client, ledger, submitted, sleeps };
}
const create = (b: Built) => (b.command as { CreateCommand: { createArguments: Record<string, unknown> } }).CreateCommand.createArguments;

describe("the Canton adapter", () => {
  it("gives the account's own id, with no request", () => {
    const { adapter, client } = setup();
    expect(adapter.party()).toBe(PARTY);
    expect(client.holdings).not.toHaveBeenCalled();
  });

  describe("choosing holdings", () => {
    it("takes the fewest unlocked holdings of the instrument, the largest first, and no other", () => {
      const all = [held("small", "1.0000000000"), held("big", "4.5"), held("locked", "100", TWIN, true), held("other", "100", COIN), held("mid", "3")];
      expect(cover(all, TWIN, "5.0000000000")).toEqual(["big", "mid"]);
      expect(cover(all, TWIN, "4.5")).toEqual(["big"]);
    });
    it("refuses when what is unlocked does not cover the amount", () => {
      expect(() => cover([held("a", "1"), held("l", "9", TWIN, true)], TWIN, "2")).toThrow(Refused);
    });
  });

  describe("a redeem", () => {
    it("burns twin holdings of the gateway's instrument for the token, with the ref and the recipient the move gave", async () => {
      const { adapter, submitted } = setup([held("big", "4"), held("mid", "3"), held("coin", "99", COIN)]);
      await adapter.signRedeem({ asset: TOKEN as never, amount: "5.0000000000", recipient: TO as never, ref: "ref-1" });
      expect(submitted).toHaveLength(1);
      expect(create(submitted[0]!)).toMatchObject({ holder: PARTY, token: "aa".repeat(20), holdings: ["big", "mid"], amount: "5.0000000000", recipient: "bb".repeat(20), ref: "ref-1", gateway: chain.gateway });
    });
    it("signs nothing again for a ref that is already open, even when the holdings were used up by the first one", async () => {
      const { adapter, ledger, submitted } = setup([held("big", "5")]);
      const a = { asset: TOKEN as never, amount: "5.0000000000", recipient: TO as never, ref: "ref-1" };
      await adapter.signRedeem(a);
      ledger.holdings = [];   // the first one locked them
      await adapter.signRedeem(a);
      expect(submitted).toHaveLength(1);
    });
    it("signs for a new ref although another is open", async () => {
      const { adapter, submitted } = setup([held("big", "5"), held("two", "5")]);
      await adapter.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "ref-1" });
      await adapter.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "ref-2" });
      expect(submitted).toHaveLength(2);
    });
    it("refuses, signing nothing, when the account does not hold enough", async () => {
      const { adapter, submitted } = setup([held("small", "1")]);
      await expect(adapter.signRedeem({ asset: TOKEN as never, amount: "5", recipient: TO as never, ref: "ref-1" })).rejects.toBeInstanceOf(Refused);
      expect(submitted).toHaveLength(0);
    });
    it("waits for the request to be open, and gives up with Waited after its polls", async () => {
      const { adapter, ledger, sleeps } = setup();
      const waiting = adapter.waitRedeem("ref-1");
      await Promise.resolve();
      ledger.redeemRequests.push({ contractId: "r", arguments: { ref: "ref-1" } });
      await expect(waiting).resolves.toBeUndefined();
      const none = setup();
      await expect(none.adapter.waitRedeem("ref-1")).rejects.toBeInstanceOf(Waited);
      expect(none.sleeps).toEqual([7, 7, 7]);
      expect(sleeps.length).toBeLessThanOrEqual(1);
    });
    it("looks again after a refusal that passes, and stops on any other error", async () => {
      const { adapter, client } = setup();
      client.openRequests.mockRejectedValueOnce(new AccountsError("rate-limited", 429, "slow down")).mockResolvedValue({ redeemRequests: [{ contractId: "r", arguments: { ref: "ref-1" } }], depositRequests: [], twinAcceptance: null, withdrawalAcceptance: null });
      await expect(adapter.waitRedeem("ref-1")).resolves.toBeUndefined();
      client.openRequests.mockRejectedValue(new AccountsError("forbidden", 403, "no"));
      await expect(adapter.waitRedeem("ref-1")).rejects.toMatchObject({ kind: "forbidden" });
    });
  });

  describe("a deposit", () => {
    const deposit = { instrument: COIN, amount: "5.0000000000", label: "label-1" };
    it("asks the registry for the allocation factory, then allocates for the gateway under the label with the registry's context and contracts", async () => {
      const { adapter, client, submitted } = setup([held("cc1", "3", COIN), held("cc2", "4", COIN), held("twin", "9", TWIN)]);
      await adapter.allocateDeposit(deposit);
      expect(client.allocationFactory).toHaveBeenCalledTimes(1);
      const [, admin, party, args] = client.allocationFactory.mock.calls[0] as unknown as [CantonKey, string, string, any];
      expect([admin, party]).toEqual([COIN.admin, PARTY]);
      expect(args).toMatchObject({ expectedAdmin: COIN.admin, inputHoldingCids: ["cc2", "cc1"], extraArgs: { context: { values: {} } }, allocation: { settlement: { settlementRef: { id: "label-1" } }, transferLeg: { sender: PARTY, receiver: chain.gateway, amount: "5.0000000000" } } });
      const sent = submitted[0]!;
      expect(sent.command).toMatchObject({ ExerciseCommand: { contractId: "factory-1", choice: "AllocationFactory_Allocate", choiceArgument: { extraArgs: { context: { values: { rules: 1 } } }, inputHoldingCids: ["cc2", "cc1"] } } });
      expect(sent.disclosedContracts).toEqual([DISCLOSED]);
      expect(sent.intent.args).toMatchObject({ requestedAt: new Date(NOW - 60_000).toISOString(), allocation: { settlement: { allocateBefore: new Date(NOW + 3_600_000).toISOString(), settleBefore: new Date(NOW + 7_200_000).toISOString() } } });
    });
    it("allocates nothing again for a label that already has an allocation, and asks the registry nothing", async () => {
      const { adapter, client, submitted } = setup([held("cc", "9", COIN)]);
      await adapter.allocateDeposit(deposit);
      await adapter.allocateDeposit(deposit);
      expect(submitted).toHaveLength(1);
      expect(client.allocationFactory).toHaveBeenCalledTimes(1);
    });
    it("refuses, asking and signing nothing, when the account does not hold enough", async () => {
      const { adapter, client, submitted } = setup([held("cc", "1", COIN)]);
      await expect(adapter.allocateDeposit(deposit)).rejects.toBeInstanceOf(Refused);
      expect(client.allocationFactory).not.toHaveBeenCalled();
      expect(submitted).toHaveLength(0);
    });
    it("signs the deposit request naming the committed allocation, for the recipient", async () => {
      const { adapter, submitted } = setup([held("cc", "9", COIN)]);
      await adapter.allocateDeposit(deposit);
      await adapter.signDeposit({ ...deposit, depositId: depositIdOf(PARTY, "label-1"), recipient: TO as never });
      expect(create(submitted[1]!)).toMatchObject({ depositor: PARTY, allocation: "alloc-label-1", label: "label-1", recipient: "bb".repeat(20), depositId: depositIdOf(PARTY, "label-1").slice(2) });
    });
    it("signs nothing again when the deposit is already open, whatever the case or the 0x of its id", async () => {
      const { adapter, ledger, submitted } = setup([held("cc", "9", COIN)]);
      const depositId = depositIdOf(PARTY, "label-1");
      await adapter.allocateDeposit(deposit);
      await adapter.signDeposit({ ...deposit, depositId, recipient: TO as never });
      ledger.allocations = [];   // the deposit request has taken it
      await adapter.signDeposit({ ...deposit, depositId, recipient: TO as never });
      await adapter.signDeposit({ ...deposit, depositId: depositId.toUpperCase().replace("0X", "0x") as never, recipient: TO as never });
      expect(submitted).toHaveLength(2);
    });
    it("waits for the allocation's read to show, and gives up with Waited when it never does", async () => {
      const { adapter, client, submitted } = setup([held("cc", "9", COIN)]);
      await adapter.allocateDeposit(deposit);
      const real = client.allocations.getMockImplementation()!;
      client.allocations.mockResolvedValueOnce([]).mockImplementation(real);
      await adapter.signDeposit({ ...deposit, depositId: depositIdOf(PARTY, "label-1"), recipient: TO as never });
      expect(submitted).toHaveLength(2);
      const lost = setup();
      await expect(lost.adapter.signDeposit({ ...deposit, depositId: depositIdOf(PARTY, "label-1"), recipient: TO as never })).rejects.toBeInstanceOf(Waited);
      expect(lost.submitted).toHaveLength(0);
    });
    it("refuses a deposit id that is not the one its label makes", async () => {
      const { adapter, submitted } = setup([held("cc", "9", COIN)]);
      await adapter.allocateDeposit(deposit);
      await expect(adapter.signDeposit({ ...deposit, depositId: depositIdOf(PARTY, "another"), recipient: TO as never })).rejects.toBeInstanceOf(Refused);
      expect(submitted).toHaveLength(1);
    });
    it("waits for the deposit request to be open, and gives up with Waited", async () => {
      const { adapter, ledger } = setup();
      const depositId = depositIdOf(PARTY, "label-1");
      ledger.depositRequests.push({ contractId: "d", arguments: { depositId: depositId.slice(2) } });
      await expect(adapter.waitDeposit(depositId)).resolves.toBeUndefined();
      await expect(adapter.waitDeposit(depositIdOf(PARTY, "other"))).rejects.toBeInstanceOf(Waited);
    });
  });
  describe("taking a deposit back", () => {
    const deposit = { instrument: COIN, amount: "5.0000000000", label: "label-1" };
    const depositId = depositIdOf(PARTY, "label-1");
    const made = async (extra: Parameters<typeof setup>[0] = []) => {
      const t = setup(extra);
      t.ledger.holdings.push(held("cc", "9", COIN));
      await t.adapter.allocateDeposit(deposit);
      await t.adapter.signDeposit({ ...deposit, depositId, recipient: TO as never });
      return t;
    };

    it("gives the allocation's settle-before time, and null when there is no allocation", async () => {
      const { adapter, ledger, submitted } = await made();
      expect(await adapter.depositDeadline("label-1")).toBe(NOW + 7_200_000);
      expect(await adapter.depositDeadline("another")).toBeNull();
      ledger.allocations = [];
      expect(await adapter.depositDeadline("label-1")).toBeNull();
      expect(submitted).toHaveLength(2);
    });
    it("withdraws the allocation with the registry's context, then archives the request: the two commands, in that order", async () => {
      const { adapter, client, ledger, submitted } = await made();
      await adapter.recoverDeposit({ label: "label-1", depositId });
      expect(submitted).toHaveLength(4);
      const [withdraw, archive] = [submitted[2]!, submitted[3]!];
      expect(withdraw.intent).toMatchObject({ kind: "exercise", choice: "Allocation_Withdraw", contractId: "alloc-label-1", implementation: "splice-amulet" });
      expect(withdraw.command).toMatchObject({ ExerciseCommand: { choice: "Allocation_Withdraw", choiceArgument: { extraArgs: { context: { values: { withdraw: 1 } }, meta: { values: {} } } } } });
      expect(withdraw.disclosedContracts).toEqual([DISCLOSED]);
      expect(client.allocationWithdrawContext).toHaveBeenCalledWith(key, COIN.admin, "alloc-label-1", PARTY);
      expect(archive.intent).toMatchObject({ kind: "exercise", choice: "Archive", contractId: "d2", args: {} });
      expect(ledger.allocations).toEqual([]);
      expect(ledger.depositRequests).toEqual([]);
    });
    it("is idempotent: a repeat does only what is left, and a repeat of all of it does nothing", async () => {
      const t = await made();
      t.ledger.allocations = [];   // the allocation was withdrawn, then the page reloaded before the request was archived
      await t.adapter.recoverDeposit({ label: "label-1", depositId });
      expect(t.submitted).toHaveLength(3);
      expect(t.submitted[2]!.intent.choice).toBe("Archive");
      await t.adapter.recoverDeposit({ label: "label-1", depositId });
      expect(t.submitted).toHaveLength(3);
      expect(t.client.allocationWithdrawContext).not.toHaveBeenCalled();
    });
    it("a deposit whose request was never made has only its allocation withdrawn", async () => {
      const t = setup([held("cc", "9", COIN)]);
      await t.adapter.allocateDeposit(deposit);
      await t.adapter.recoverDeposit({ label: "label-1", depositId });
      expect(t.submitted.map((b) => b.intent.choice)).toEqual(["AllocationFactory_Allocate", "Allocation_Withdraw"]);
    });
    it("does not archive another deposit's request", async () => {
      const t = await made();
      t.ledger.depositRequests.push({ contractId: "other", arguments: { depositId: depositIdOf(PARTY, "label-2").slice(2) } });
      await t.adapter.recoverDeposit({ label: "label-1", depositId });
      expect(t.ledger.depositRequests.map((r) => r.contractId)).toEqual(["other"]);
    });
  });
});
