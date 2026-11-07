import { describe, expect, it, vi } from "vitest";
import { AccountsError } from "./canton/accounts.ts";
import type { Built } from "./canton/commands.ts";
import { getTestCoin, optIn } from "./account.ts";

const id = (tag: string, n: number) => `${tag}::1220${n.toString(16).padStart(2, "0").repeat(32)}`;
const PARTY = id("bridge", 0xab), chain = { operator: id("operator", 1), confirmer: id("confirmer", 2), gateway: id("gateway", 3), builder: id("builder", 4), chainId: 770101 };
const DISCLOSED = { templateId: "t", contractId: "d1", createdEventBlob: "blob", synchronizerId: "sync" };
const templates = (submitted: Built[]) => submitted.map((b) => ("CreateCommand" in b.command ? b.command.CreateCommand.templateId : b.command.ExerciseCommand.choice));

describe("opting in", () => {
  it("makes the two standing acceptances, twins first", async () => {
    const submitted: Built[] = [];
    await optIn({ party: PARTY, chain, submit: async (b) => { submitted.push(b); return "u"; } });
    expect(templates(submitted)).toEqual(["#ostia-twin:Twin.Twin:TwinAcceptance", "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"]);
    expect((submitted[1]!.command as any).CreateCommand.createArguments).toMatchObject({ party: PARTY, gateway: chain.gateway, chainId: "770101" });
  });
  it("takes the service's refusal of a second open acceptance (409) as having it, for each, and goes on", async () => {
    const submitted: Built[] = [];
    await optIn({ party: PARTY, chain, submit: async (b) => { submitted.push(b); throw new AccountsError("conflict", 409, "the account has the open contracts it may"); } });
    expect(submitted).toHaveLength(2);
    const once: Built[] = [];
    await optIn({ party: PARTY, chain, submit: async (b) => { once.push(b); if (once.length === 1) throw new AccountsError("conflict", 409, "has it"); return "u"; } });
    expect(once).toHaveLength(2);
  });
  it("stops on any other refusal", async () => {
    const submit = vi.fn(async () => { throw new AccountsError("forbidden", 403, "not on the list"); });
    await expect(optIn({ party: PARTY, chain, submit })).rejects.toMatchObject({ kind: "forbidden" });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("test Canton Coin", () => {
  const key = { publicKey: new Uint8Array(32) };
  const account = (faucet: () => Promise<unknown>) => {
    const submitted: Built[] = [];
    const client = { faucet: vi.fn(faucet), acceptContext: vi.fn(async () => ({ choiceContext: { choiceContextData: { values: { round: 1 } }, disclosedContracts: [DISCLOSED] } })) };
    return { client, submitted, a: { key, party: PARTY, client: client as never, submit: async (b: Built) => { submitted.push(b); return "u"; } } };
  };
  it("accepts the offer the faucet makes, with the registry's context and contracts", async () => {
    const { a, client, submitted } = account(async () => ({ transferInstructionCid: "00ab" }));
    await expect(getTestCoin(a, "DSO::1220cc")).resolves.toBe("done");
    expect(client.acceptContext).toHaveBeenCalledWith(key, "DSO::1220cc", "00ab", PARTY);
    expect(submitted[0]!.command).toMatchObject({ ExerciseCommand: { contractId: "00ab", choice: "TransferInstruction_Accept", choiceArgument: { extraArgs: { context: { values: { round: 1 } } } } } });
    expect(submitted[0]!.disclosedContracts).toEqual([DISCLOSED]);
    expect(submitted[0]!.intent).toMatchObject({ party: PARTY, kind: "exercise", implementation: "splice-amulet", ignore: ["extraArgs.context"] });
  });
  it("has nothing to accept when the faucet has already completed it", async () => {
    const { a, submitted } = account(async () => ({ completed: true }));
    await expect(getTestCoin(a, "DSO::1220cc")).resolves.toBe("done");
    expect(submitted).toHaveLength(0);
  });
  it("says the faucet is off on a 404, and passes on any other refusal", async () => {
    await expect(getTestCoin(account(async () => { throw new AccountsError("not-found", 404, "no faucet") }).a, "DSO::1220cc")).resolves.toBe("off");
    await expect(getTestCoin(account(async () => { throw new AccountsError("rate-limited", 429, "later") }).a, "DSO::1220cc")).rejects.toMatchObject({ kind: "rate-limited" });
    await expect(getTestCoin(account(async () => ({})).a, "DSO::1220cc")).rejects.toThrow(/did not offer/);
  });
});
