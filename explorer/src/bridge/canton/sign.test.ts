import { readFileSync } from "node:fs";
import { decodePreparedTransaction } from "@canton-network/core-tx-visualizer";
import type { PreparedTransaction, Value } from "@canton-network/core-ledger-proto";
import { describe, expect, it } from "vitest";
import type { Prepared } from "./accounts.ts";
import { allocate, chainFromEnv, depositRequest, redeemRequest, twinAcceptance, withdrawalAcceptance, type Chain, type Intent } from "./commands.ts";
import { base64, fromBase64, keyFromSignature } from "./key.ts";
import { checkIntent, signPrepared, UnexpectedTransaction } from "./sign.ts";

// Three prepared transactions of the pinned Canton (made by apps/accounts/tests/integration.py, which prints them): the account's WithdrawalAcceptance and DepositRequest creates
// and an exercise of Archive on its acceptance, each with the hash the service gave. `command` is what was asked for.
interface Fixture extends Prepared { name: string; command: { CreateCommand?: { createArguments: Record<string, string> } } }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as Fixture[];
const fixture = (name: string) => fixtures.find((f) => f.name === name)!;
const key = await keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1b");

const acceptance = fixture("create-acceptance");
const PARTY = acceptance.party;
const args = acceptance.command.CreateCommand!.createArguments;
const chain: Chain = { operator: args.operator!, confirmer: args.confirmer!, gateway: args.gateway!, builder: args.builder!, chainId: Number(args.chainId) };
const archived = fixture("exercise-archive");
const archive = (): Intent => ({ party: PARTY, kind: "exercise", template: { packageName: "canton-zk-evm", module: "Zk.Chain", entity: "WithdrawalAcceptance" }, choice: "Archive", contractId: archiveContract(), args: {} });
const archiveContract = () => (decodePreparedTransaction(archived.preparedTransaction).transaction!.nodes[0]!.versionedNode as unknown as { v1: { nodeType: { exercise: { contractId: string } } } }).v1.nodeType.exercise.contractId;
const deposit = async () => depositRequest(PARTY, chain, fixture("create-deposit-request").command.CreateCommand!.createArguments.allocation!, "ab".repeat(20), "integration");
const verifies = async (hash: string, signature: Uint8Array) =>
  crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", key.publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]), signature as BufferSource, fromBase64(hash) as BufferSource);
const refused = (p: Promise<unknown>, why: RegExp | typeof UnexpectedTransaction) => expect(p).rejects.toThrow(why);

describe("what the page signs", () => {
  it("builds the commands of the fixtures, and signs the hash it computed itself for each", async () => {
    const built = withdrawalAcceptance(PARTY, chain);
    expect(built.command).toEqual(acceptance.command);
    expect(Object.keys(built.intent.args)).toEqual(["party", "chainId", "operator", "confirmer", "gateway", "builder"]);   // the Daml's order
    const made = await deposit();
    expect(made.command).toEqual(fixture("create-deposit-request").command);
    for (const [prepared, intent] of [[acceptance, built.intent], [fixture("create-deposit-request"), made.intent], [archived, archive()]] as const) {
      expect(await verifies(prepared.preparedTransactionHash, await signPrepared(key, intent, prepared))).toBe(true);
    }
  });
  it("refuses a hash that is not the one it computes, a transaction that does not decode, and another hashing scheme", async () => {
    const intent = withdrawalAcceptance(PARTY, chain).intent;
    const wrong = base64(Uint8Array.from(fromBase64(acceptance.preparedTransactionHash), (b, i) => (i === 0 ? b ^ 1 : b)));
    await refused(signPrepared(key, intent, { ...acceptance, preparedTransactionHash: wrong }), /hash is not the service's/);
    await refused(signPrepared(key, intent, { ...acceptance, hashingSchemeVersion: "HASHING_SCHEME_VERSION_V3" }), /hashing scheme/);
    await refused(signPrepared(key, intent, { ...acceptance, party: "other::1220" + "00".repeat(32) }), /another party/);
    const extra = base64(Uint8Array.from([...fromBase64(acceptance.preparedTransaction), 0x78, 0x01]));   // a field the definition does not have
    await refused(signPrepared(key, intent, { ...acceptance, preparedTransaction: extra }), /does not decode/);
    await refused(signPrepared(key, intent, { ...acceptance, preparedTransaction: "AAAA" }), UnexpectedTransaction);
  });
  it("refuses a transaction whose content is not what was asked for", async () => {
    const other = { ...chain, chainId: 1 };
    await refused(signPrepared(key, withdrawalAcceptance(PARTY, other).intent, acceptance), /chainId/);
    await refused(signPrepared(key, withdrawalAcceptance(PARTY, { ...chain, gateway: "evil::1220" + "00".repeat(32) }).intent, acceptance), /gateway/);
    await refused(signPrepared(key, { ...withdrawalAcceptance(PARTY, chain).intent, template: { packageName: "canton-zk-evm", module: "Zk.Chain", entity: "DepositRequest" } }, acceptance), /creates/);
    await refused(signPrepared(key, twinAcceptance(PARTY, chain).intent, acceptance), /creates/);
    await refused(signPrepared(key, (await depositRequest(PARTY, chain, "00", "ab".repeat(20), "integration")).intent, fixture("create-deposit-request")), /allocation/);
    await refused(signPrepared(key, (await depositRequest(PARTY, chain, fixture("create-deposit-request").command.CreateCommand!.createArguments.allocation!, "cd".repeat(20), "integration")).intent, fixture("create-deposit-request")), /recipient/);
    await refused(signPrepared(key, withdrawalAcceptance(PARTY, chain).intent, archived), /not a create/);   // an exercise where a create was asked for
    await refused(signPrepared(key, { ...archive(), choice: "Other" }, archived), /exercises Archive/);
    await refused(signPrepared(key, { ...archive(), contractId: "00" }, archived), /exercises Archive/);
    await refused(signPrepared(key, { ...archive(), args: { extra: "x" } }, archived), /fields/);
    await refused(signPrepared(key, { ...archive(), party: "me::1220" + "00".repeat(32) }, { ...archived, party: "me::1220" + "00".repeat(32) }), /submitter/);
  });
  it("refuses extra root nodes and other actors", () => {
    const intent = withdrawalAcceptance(PARTY, chain).intent;
    const tx = decodePreparedTransaction(acceptance.preparedTransaction, { readUnknownField: "throw" });
    expect(() => checkIntent(tx, intent)).not.toThrow();
    const more = structuredClone(tx);
    more.transaction!.roots.push(more.transaction!.roots[0]!);
    expect(() => checkIntent(more, intent)).toThrow(/2 root nodes/);
    const acting = structuredClone(tx);
    acting.metadata!.submitterInfo!.actAs.push(chain.operator);
    expect(() => checkIntent(acting, intent)).toThrow(/submitter/);
    const signed = structuredClone(tx);
    (signed.transaction!.nodes[0]!.versionedNode as unknown as { v1: { nodeType: { create: { signatories: string[] } } } }).v1.nodeType.create.signatories.push(chain.operator);
    expect(() => checkIntent(signed, intent)).toThrow(/signatory/);
  });
});

// The allocation and the redeem request have no transaction of the real Canton here (the integration test has no token to allocate): the decoded transaction is made by hand
// in the shape the fixtures show, and the check is the same.
const KINDS: Record<string, "party" | "contractId" | "timestamp" | "numeric" | "text"> = {
  expectedAdmin: "party", executor: "party", sender: "party", receiver: "party", admin: "party", inputHoldingCids: "contractId",
  requestedAt: "timestamp", allocateBefore: "timestamp", settleBefore: "timestamp", amount: "numeric", id: "text", transferLegId: "text",
};
const micros = (iso: string) => String(BigInt(Date.parse(iso)) * 1000n);
function value(x: unknown, name = ""): Value {
  if (x === null) return { sum: { oneofKind: "optional", optional: {} } };
  if (Array.isArray(x)) return { sum: { oneofKind: "list", list: { elements: x.map((e) => value(e, name)) } } };
  if (typeof x === "object") {
    if (name === "values") return { sum: { oneofKind: "textMap", textMap: { entries: Object.entries(x).map(([key, v]) => ({ key, value: value(v, key) })) } } };
    return { sum: { oneofKind: "record", record: { fields: Object.entries(x).map(([label, v]) => ({ label, value: value(v, label) })) } } };
  }
  const kind = KINDS[name]!;
  const s = String(x);
  return { sum: kind === "timestamp" ? { oneofKind: kind, timestamp: micros(s) } : kind === "numeric" ? { oneofKind: kind, numeric: s + "0000000000".slice(0, 10) } : ({ oneofKind: kind, [kind]: s } as Value["sum"]) };
}
const exercise = (party: string, e: object): PreparedTransaction => ({
  metadata: { submitterInfo: { actAs: [party] } },
  transaction: { roots: ["0"], nodes: [{ nodeId: "0", versionedNode: { oneofKind: "v1", v1: { nodeType: { oneofKind: "exercise", exercise: e } } } }] },
}) as unknown as PreparedTransaction;

describe("the allocation's transaction", () => {
  const factory = { contractId: "00ab", context: { values: { "amulet-rules": { tag: "AV_ContractId", value: "00cd" } } }, disclosedContracts: [] };
  const a = { admin: "dso::1220" + "11".repeat(32), instrumentId: "Amulet", amount: "5.5", label: "dep1", inputHoldings: ["00e1", "00e2"], requestedAt: "2026-11-05T10:00:00.123456Z", allocateBefore: "2026-11-05T11:00:00Z", settleBefore: "2026-11-05T12:00:00Z" };
  const made = allocate(PARTY, chain, a, factory);
  const real = (): PreparedTransaction => exercise(PARTY, {
    choiceId: "AllocationFactory_Allocate", contractId: "00ab", actingParties: [PARTY], interfaceId: { moduleName: "Splice.Api.Token.AllocationInstructionV1", entityName: "AllocationFactory" },
    templateId: { moduleName: "Splice.Amulet", entityName: "ExternalPartyAmuletRules" }, packageName: "splice-amulet",
    chosenValue: value({ ...made.intent.args, extraArgs: { context: { values: {} }, meta: { values: {} } } }),   // the context is the registry's: any value
  });
  it("is the intent's, whatever the registry's choice context is, and its fields are in the token standard's order", () => {
    expect(Object.keys(made.intent.args)).toEqual(["expectedAdmin", "allocation", "requestedAt", "inputHoldingCids", "extraArgs"]);
    expect(Object.keys((made.intent.args.allocation as { transferLeg: object }).transferLeg)).toEqual(["sender", "receiver", "amount", "instrumentId", "meta"]);
    expect(() => checkIntent(real(), made.intent)).not.toThrow();
  });
  it("is refused with another amount, receiver, executor, holding, time or factory, or a template call", () => {
    const changed = (patch: (x: Record<string, any>) => void) => { const x = structuredClone(made.intent.args) as Record<string, any>; patch(x); return { ...made.intent, args: x }; };
    expect(() => checkIntent(real(), changed((x) => { x.allocation.transferLeg.amount = "5.6"; }))).toThrow(/amount/);
    expect(() => checkIntent(real(), changed((x) => { x.allocation.transferLeg.receiver = "evil::1220"; }))).toThrow(/receiver/);
    expect(() => checkIntent(real(), changed((x) => { x.allocation.settlement.executor = "evil::1220"; }))).toThrow(/executor/);
    expect(() => checkIntent(real(), changed((x) => { x.inputHoldingCids = ["00e1"]; }))).toThrow(/inputHoldingCids/);
    expect(() => checkIntent(real(), changed((x) => { x.allocation.settlement.settleBefore = "2026-11-05T12:00:01Z"; }))).toThrow(/settleBefore/);
    expect(() => checkIntent(real(), { ...made.intent, contractId: "00ff" })).toThrow(/exercises/);
    expect(() => checkIntent(real(), { ...made.intent, interface: undefined })).toThrow(/through/);
  });
});

describe("the other commands", () => {
  it("carry the chain's parties from configuration, and the twin's admin is the gateway", async () => {
    expect(twinAcceptance(PARTY, chain).command).toEqual({ CreateCommand: { templateId: "#ostia-twin:Twin.Twin:TwinAcceptance", createArguments: { party: PARTY, admin: chain.gateway } } });
    const r = redeemRequest(PARTY, chain, "0x" + "AB".repeat(20), ["00aa"], "1.5", "0x" + "CD".repeat(20), "ref-1");
    expect(Object.keys(r.intent.args)).toEqual(["holder", "operator", "confirmer", "gateway", "builder", "chainId", "token", "holdings", "amount", "recipient", "ref"]);
    expect(r.intent.args).toMatchObject({ holder: PARTY, token: "ab".repeat(20), recipient: "cd".repeat(20), chainId: String(chain.chainId) });
    expect((await deposit()).intent.args.depositor).toBe(PARTY);
  });
  it("read the chain's parties from the page's configuration, and name the one that is missing", () => {
    const env = { VITE_CHAIN_OPERATOR: "o", VITE_CHAIN_CONFIRMER: "c", VITE_CHAIN_GATEWAY: "g", VITE_CHAIN_BUILDER: "b", VITE_CHAIN_ID: "770101" };
    expect(chainFromEnv(env)).toEqual({ operator: "o", confirmer: "c", gateway: "g", builder: "b", chainId: 770101 });
    expect(() => chainFromEnv({ ...env, VITE_CHAIN_GATEWAY: undefined })).toThrow("VITE_CHAIN_GATEWAY");
  });
});
