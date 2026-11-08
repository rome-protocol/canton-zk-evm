import { readFileSync } from "node:fs";
import { decodePreparedTransaction, hashPreparedTransaction } from "@canton-network/core-tx-visualizer";
import { PreparedTransaction, type Value } from "@canton-network/core-ledger-proto";
import { describe, expect, it } from "vitest";
import type { DisclosedContract, Prepared } from "./accounts.ts";
import { acceptTransfer, allocate, archiveDepositRequest, chainFromEnv, depositRequest, implementationOf, redeemRequest, transfer, twinAcceptance, withdrawalAcceptance, type Chain, type Intent, type Transfer } from "./commands.ts";
import { base64, fromBase64, keyFromSignature } from "./key.ts";
import { checkIntent, signPrepared, UnexpectedTransaction } from "./sign.ts";

// Prepared transactions of the pinned Canton, made by apps/accounts/tests/integration.py, which prints them: the account's WithdrawalAcceptance, DepositRequest, RedeemRequest and TwinAcceptance
// creates, an AllocationFactory_Allocate of the test token (with its disclosed rules) and an exercise of Archive on the acceptance, each with the hash the service gave. `command` is what was asked for.
interface Fixture extends Prepared { name: string; command: Record<string, any>; disclosedContracts?: DisclosedContract[] }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as Fixture[];
const fixture = (name: string) => fixtures.find((f) => f.name === name)!;
const key = await keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1b");
/** The page's clock for a fixture: the moment it was prepared (the fixtures are from the day they were made). */
const preparedAt = (p: Prepared) => Number(decodePreparedTransaction(p.preparedTransaction).metadata!.preparationTime / 1000n);
const decode = (p: Prepared) => decodePreparedTransaction(p.preparedTransaction, { readUnknownField: "throw" });
const sign = (intent: Intent, p: Prepared) => signPrepared(key, intent, p, preparedAt(p));

const acceptance = fixture("create-acceptance");
const PARTY = acceptance.party;
const args = acceptance.command.CreateCommand.createArguments as Record<string, string>;
const chain: Chain = { operator: args.operator!, confirmer: args.confirmer!, gateway: args.gateway!, builder: args.builder!, chainId: Number(args.chainId) };
const archived = fixture("exercise-archive");
const archive = (): Intent => ({ party: PARTY, kind: "exercise", template: { packageName: "canton-zk-evm", module: "Zk.Chain", entity: "WithdrawalAcceptance" }, choice: "Archive", contractId: archiveContract(), args: {} });
const archiveContract = () => (decode(archived).transaction!.nodes[0]!.versionedNode as unknown as { v1: { nodeType: { exercise: { contractId: string } } } }).v1.nodeType.exercise.contractId;
const depositFixture = fixture("create-deposit-request");
const ALLOCATION = depositFixture.command.CreateCommand.createArguments.allocation as string;
const deposit = async () => depositRequest(PARTY, chain, ALLOCATION, "ab".repeat(20), "integration");
const verifies = async (hash: string, signature: Uint8Array) =>
  crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", key.publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]), signature as BufferSource, fromBase64(hash) as BufferSource);
const refused = (p: Promise<unknown>, why: RegExp | typeof UnexpectedTransaction) => expect(p).rejects.toThrow(why);

// The allocation, rebuilt by the page's own builder from the arguments the integration test asked for.
const allocation = fixture("exercise-allocate");
const call = allocation.command.ExerciseCommand.choiceArgument;
const allocationOf = () => allocate(PARTY, chain, {
  admin: call.expectedAdmin, instrumentId: call.allocation.transferLeg.instrumentId.id, amount: call.allocation.transferLeg.amount, label: call.allocation.settlement.settlementRef.id,
  inputHoldings: call.inputHoldingCids, requestedAt: call.requestedAt, allocateBefore: call.allocation.settlement.allocateBefore, settleBefore: call.allocation.settlement.settleBefore,
  implementation: "splice-test-token-v1",   // the test token's package: the one the real transaction names
}, { contractId: allocation.command.ExerciseCommand.contractId, context: call.extraArgs.context, disclosedContracts: allocation.disclosedContracts! });
const HOLDING = (call.inputHoldingCids as string[])[0]!;
// The fixture's ERC-20 address is a placeholder (the repository's pre-push check flags `token` assigned a literal); the integration test used 0xabab...ab.
const redeemFixture = structuredClone(fixture("create-redeem-request"));
redeemFixture.command.CreateCommand.createArguments.token = "ab".repeat(20);
const redeemOf = () => redeemRequest(PARTY, chain, "0x" + "AB".repeat(20), [HOLDING], "1.5", "0x" + "CD".repeat(20), "redeem-1");

describe("what the page signs", () => {
  it("builds the commands of the fixtures, and signs the hash it computed itself for each", async () => {
    const built = withdrawalAcceptance(PARTY, chain);
    expect(built.command).toEqual(acceptance.command);
    expect(Object.keys(built.intent.args)).toEqual(["party", "chainId", "operator", "confirmer", "gateway", "builder"]);   // the Daml's order
    const made = await deposit();
    expect(made.command).toEqual(depositFixture.command);
    const twin = twinAcceptance(PARTY, chain);
    expect(twin.command).toEqual(fixture("create-twin-acceptance").command);
    const redeem = redeemOf();
    expect(redeem.command).toEqual(redeemFixture.command);
    const allocated = allocationOf();
    expect(allocated.command).toEqual(allocation.command);
    expect(allocated.disclosedContracts).toEqual(allocation.disclosedContracts);
    for (const [prepared, intent] of [[acceptance, built.intent], [depositFixture, made.intent], [archived, archive()], [fixture("create-twin-acceptance"), twin.intent], [redeemFixture, redeem.intent], [allocation, allocated.intent]] as const) {
      expect(await verifies(prepared.preparedTransactionHash, await sign(intent, prepared)), prepared.name).toBe(true);
    }
  });
  it("refuses a hash that is not the one it computes, a transaction that does not decode, and another hashing scheme", async () => {
    const intent = withdrawalAcceptance(PARTY, chain).intent;
    const wrong = base64(Uint8Array.from(fromBase64(acceptance.preparedTransactionHash), (b, i) => (i === 0 ? b ^ 1 : b)));
    await refused(sign(intent, { ...acceptance, preparedTransactionHash: wrong }), /hash is not the service's/);
    await refused(sign(intent, { ...acceptance, hashingSchemeVersion: "HASHING_SCHEME_VERSION_V3" }), /hashing scheme/);
    await refused(sign(intent, { ...acceptance, party: "other::1220" + "00".repeat(32) }), /another party/);
    const extra = base64(Uint8Array.from([...fromBase64(acceptance.preparedTransaction), 0x78, 0x01]));   // a field the definition does not have
    await refused(signPrepared(key, intent, { ...acceptance, preparedTransaction: extra }, preparedAt(acceptance)), /does not decode/);
    await refused(signPrepared(key, intent, { ...acceptance, preparedTransaction: "AAAA" }, preparedAt(acceptance)), UnexpectedTransaction);
  });
  it("refuses a transaction whose content is not what was asked for", async () => {
    const other = { ...chain, chainId: 1 };
    await refused(sign(withdrawalAcceptance(PARTY, other).intent, acceptance), /chainId/);
    await refused(sign(withdrawalAcceptance(PARTY, { ...chain, gateway: "evil::1220" + "00".repeat(32) }).intent, acceptance), /gateway/);
    await refused(sign({ ...withdrawalAcceptance(PARTY, chain).intent, template: { packageName: "canton-zk-evm", module: "Zk.Chain", entity: "DepositRequest" } }, acceptance), /creates/);
    await refused(sign(twinAcceptance(PARTY, chain).intent, acceptance), /creates/);
    await refused(sign((await depositRequest(PARTY, chain, "00", "ab".repeat(20), "integration")).intent, depositFixture), /allocation/);
    await refused(sign((await depositRequest(PARTY, chain, ALLOCATION, "cd".repeat(20), "integration")).intent, depositFixture), /recipient/);
    await refused(sign(withdrawalAcceptance(PARTY, chain).intent, archived), /not a create/);   // an exercise where a create was asked for
    await refused(sign({ ...archive(), choice: "Other" }, archived), /exercises Archive/);
    await refused(sign({ ...archive(), contractId: "00" }, archived), /exercises Archive/);
    await refused(sign({ ...archive(), args: { extra: "x" } }, archived), /fields/);
    await refused(sign({ ...archive(), party: "me::1220" + "00".repeat(32) }, { ...archived, party: "me::1220" + "00".repeat(32) }), /submitter/);
    await refused(sign(redeemRequest(PARTY, chain, "0x" + "AB".repeat(20), [HOLDING], "1.6", "0x" + "CD".repeat(20), "redeem-1").intent, redeemFixture), /amount/);
    await refused(sign(redeemRequest(PARTY, chain, "0x" + "AB".repeat(20), [HOLDING], "1.5", "0x" + "EE".repeat(20), "redeem-1").intent, redeemFixture), /recipient/);
    await refused(sign(twinAcceptance(PARTY, { ...chain, gateway: "evil::1220" + "00".repeat(32) }).intent, fixture("create-twin-acceptance")), /admin/);
  });
  it("accepts the archive of the account's own deposit request and nothing else in its place", () => {
    // The service refuses to prepare this until the deposit's allocation is gone or past its time, so the prepared form of it is the real archive of the acceptance with the template swapped.
    const now = preparedAt(archived);
    const request = structuredClone(decode(archived));
    const root = request.transaction!.nodes[0]!.versionedNode as unknown as { v1: { nodeType: { exercise: { templateId: { entityName: string } } } } };
    root.v1.nodeType.exercise.templateId.entityName = "DepositRequest";
    const intent = archiveDepositRequest(PARTY, archiveContract()).intent;
    expect(() => checkIntent(request, intent, now)).not.toThrow();
    expect(() => checkIntent(request, archive(), now)).toThrow(/exercises through/);   // not the acceptance's archive
    expect(() => checkIntent(request, archiveDepositRequest(PARTY, "00").intent, now)).toThrow(/exercises Archive/);
    expect(() => checkIntent(decode(archived), intent, now)).toThrow(/exercises through/);   // the acceptance's archive is not the request's
  });
  it("refuses extra root nodes and other actors", () => {
    const intent = withdrawalAcceptance(PARTY, chain).intent;
    const now = preparedAt(acceptance);
    const tx = decode(acceptance);
    expect(() => checkIntent(tx, intent, now)).not.toThrow();
    const more = structuredClone(tx);
    more.transaction!.roots.push(more.transaction!.roots[0]!);
    expect(() => checkIntent(more, intent, now)).toThrow(/2 root nodes/);
    const acting = structuredClone(tx);
    acting.metadata!.submitterInfo!.actAs.push(chain.operator);
    expect(() => checkIntent(acting, intent, now)).toThrow(/submitter/);
    const signed = structuredClone(tx);
    (signed.transaction!.nodes[0]!.versionedNode as unknown as { v1: { nodeType: { create: { signatories: string[] } } } }).v1.nodeType.create.signatories.push(chain.operator);
    expect(() => checkIntent(signed, intent, now)).toThrow(/signatory/);
  });
});

describe("the node table is one tree, and the node the page checks is the node the hash covers", () => {
  const intent = withdrawalAcceptance(PARTY, chain).intent;
  const verify = async (p: Prepared, i: Intent) => verifies(p.preparedTransactionHash, await sign(i, p));

  it("refuses a table that uses a node id twice (a harmless node in front of the real one with the same id is refused)", async () => {
    // The hasher keeps the LAST node of an id, the page used to check the FIRST. The harmless node is the acceptance create; the real one the archive exercise with the same id.
    const real = decode(archived);
    const harmless = structuredClone(decode(acceptance).transaction!.nodes.find((n) => n.nodeId === decode(acceptance).transaction!.roots[0])!);
    const rootId = real.transaction!.roots[0]!;
    harmless.nodeId = rootId;
    const forged = structuredClone(real);
    forged.transaction!.nodes = [harmless, ...real.transaction!.nodes];
    const hash = await hashPreparedTransaction(real, "base64");
    expect(await hashPreparedTransaction(forged, "base64")).toBe(hash);   // the harmless node is not in the hash: the attack is real
    const prepared = { party: PARTY, preparedTransaction: base64(PreparedTransaction.toBinary(forged)), preparedTransactionHash: hash, hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" };
    await refused(sign(intent, prepared), /there twice/);   // for the create the page asked for
    await refused(sign(archive(), prepared), /there twice/);   // and for the exercise it hashes
    expect(() => checkIntent(forged, intent, preparedAt(archived))).toThrow(/there twice/);
    expect(await verify(archived, archive())).toBe(true);   // the unforged archive is still signed
  });
  it("refuses a node that is not under the root, and a child that is missing", () => {
    const now = preparedAt(acceptance);
    const tx = decode(acceptance);
    const stray = structuredClone(tx);
    const copy = structuredClone(stray.transaction!.nodes[0]!);
    copy.nodeId = "stray";
    stray.transaction!.nodes.push(copy);
    expect(() => checkIntent(stray, intent, now)).toThrow(/not under the root/);
    const exercised = decode(allocation);
    const lost = structuredClone(exercised);
    lost.transaction!.nodes.pop();
    expect(() => checkIntent(lost, allocationOf().intent, preparedAt(allocation))).toThrow(/missing/);
    const unreachable = structuredClone(exercised);
    unreachable.transaction!.nodes.push({ ...structuredClone(unreachable.transaction!.nodes[0]!), nodeId: "stray" });
    expect(() => checkIntent(unreachable, allocationOf().intent, preparedAt(allocation))).toThrow(/not under the root/);
    expect(() => checkIntent(exercised, allocationOf().intent, preparedAt(allocation))).not.toThrow();
  });
});

describe("the time of the transaction", () => {
  const intent = withdrawalAcceptance(PARTY, chain).intent;
  it("is refused when it is more than five minutes from the page's clock, either way", async () => {
    const at = preparedAt(acceptance);
    await refused(signPrepared(key, intent, acceptance, at + 5 * 60 * 1000 + 1), /five minutes/);
    await refused(signPrepared(key, intent, acceptance, at - 5 * 60 * 1000 - 1), /five minutes/);
    expect(await verifies(acceptance.preparedTransactionHash, await signPrepared(key, intent, acceptance, at + 4 * 60 * 1000))).toBe(true);
    await refused(signPrepared(key, intent, acceptance), /five minutes/);   // today's clock: the fixture is old
  });
  it("is refused with a ledger time bound that was not asked for, and allowed for the allocation, whose deadlines are such bounds", () => {
    const now = preparedAt(acceptance);
    for (const bound of ["minLedgerEffectiveTime", "maxLedgerEffectiveTime"] as const) {
      const tx = decode(acceptance);
      tx.metadata![bound] = 1n;
      expect(() => checkIntent(tx, intent, now), bound).toThrow(/ledger time/);
    }
    const bounded = decode(allocation);
    expect(bounded.metadata!.minLedgerEffectiveTime !== undefined || bounded.metadata!.maxLedgerEffectiveTime !== undefined).toBe(true);
    expect(() => checkIntent(bounded, { ...allocationOf().intent, ledgerTimes: false }, preparedAt(allocation))).toThrow(/ledger time/);
    expect(() => checkIntent(bounded, allocationOf().intent, preparedAt(allocation))).not.toThrow();
  });
});

describe("the allocation's transaction, from the real Canton", () => {
  const made = allocationOf();
  const now = preparedAt(allocation);
  it("is the intent's, whatever the registry's choice context is, and its fields are in the token standard's order", () => {
    expect(Object.keys(made.intent.args)).toEqual(["expectedAdmin", "allocation", "requestedAt", "inputHoldingCids", "extraArgs"]);
    expect(Object.keys((made.intent.args.allocation as { transferLeg: object }).transferLeg)).toEqual(["sender", "receiver", "amount", "instrumentId", "meta"]);
    expect(() => checkIntent(decode(allocation), made.intent, now)).not.toThrow();
  });
  it("is refused with another amount, receiver, executor, holding, time or factory, or a template call", () => {
    const changed = (patch: (x: Record<string, any>) => void) => { const x = structuredClone(made.intent.args) as Record<string, any>; patch(x); return { ...made.intent, args: x }; };
    const tx = decode(allocation);
    expect(() => checkIntent(tx, changed((x) => { x.allocation.transferLeg.amount = "5.6"; }), now)).toThrow(/amount/);
    expect(() => checkIntent(tx, changed((x) => { x.allocation.transferLeg.receiver = "evil::1220"; }), now)).toThrow(/receiver/);
    expect(() => checkIntent(tx, changed((x) => { x.allocation.settlement.executor = "evil::1220"; }), now)).toThrow(/executor/);
    expect(() => checkIntent(tx, changed((x) => { x.inputHoldingCids = ["00e1"]; }), now)).toThrow(/inputHoldingCids/);
    expect(() => checkIntent(tx, changed((x) => { x.allocation.settlement.settleBefore = "2030-11-05T12:00:01Z"; }), now)).toThrow(/settleBefore/);
    expect(() => checkIntent(tx, { ...made.intent, contractId: "00ff" }, now)).toThrow(/exercises/);
    expect(() => checkIntent(tx, { ...made.intent, interface: undefined }, now)).toThrow(/through/);
  });
  it("must be implemented by the instrument's own package", () => {
    const tx = decode(allocation);
    expect(() => checkIntent(tx, { ...made.intent, implementation: "splice-amulet" }, now)).toThrow(/through/);
    expect(() => checkIntent(tx, { ...made.intent, implementation: undefined }, now)).not.toThrow();   // no pin: any implementation of the interface
    expect(implementationOf("Amulet")).toBe("splice-amulet");
    expect(implementationOf("erc20:" + "ab".repeat(20))).toBe("ostia-twin");
    expect(() => implementationOf("TKB")).toThrow("no implementation is known");
    expect(() => implementationOf("erc20:xyz")).toThrow("no implementation is known");
    expect(() => allocate(PARTY, chain, { admin: "a", instrumentId: "TKB", amount: "1.0", label: "x", inputHoldings: [], requestedAt: "", allocateBefore: "", settleBefore: "" }, { contractId: "00", context: {}, disclosedContracts: [] })).toThrow("no implementation");
  });
  it("is refused with a text map that has a key twice", () => {
    const tx = decode(allocation);
    const down = (v: Value, ...labels: string[]): Value => labels.reduce((cur, label) => {
      if (cur.sum.oneofKind !== "record") throw new Error("not a record");
      return cur.sum.record.fields.find((f) => f.label === label)!.value!;
    }, v);
    const root = tx.transaction!.nodes.find((n) => n.nodeId === tx.transaction!.roots[0])!;
    const exercise = (root.versionedNode as unknown as { v1: { nodeType: { exercise: { chosenValue: Value } } } }).v1.nodeType.exercise;
    const values = down(exercise.chosenValue, "allocation", "settlement", "meta", "values");
    const text = (s: string): Value => ({ sum: { oneofKind: "text", text: s } });
    values.sum = { oneofKind: "textMap", textMap: { entries: [{ key: "a", value: text("x") }, { key: "a", value: text("x") }] } };
    const intent = structuredClone(made.intent) as Intent & { args: { allocation: { settlement: { meta: { values: Record<string, string> } } } } };
    intent.args.allocation.settlement.meta = { values: { a: "x", b: "y" } };   // two entries, both asked for: the key `a` twice and `b` never must not pass
    expect(() => checkIntent(tx, intent, now)).toThrow(/key twice/);
    values.sum = { oneofKind: "textMap", textMap: { entries: [{ key: "a", value: text("x") }, { key: "b", value: text("y") }] } };
    expect(() => checkIntent(tx, intent, now)).not.toThrow();
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

// A TransferFactory_Transfer of the test token, made by the integration test: one account sends 3 to another.
describe("the transfer's transaction, from the real Canton", () => {
  const fx = fixture("exercise-transfer");
  const sender = fx.party;
  const call = fx.command.ExerciseCommand.choiceArgument;
  const now = preparedAt(fx);
  const t: Transfer = {
    admin: call.expectedAdmin, instrumentId: call.transfer.instrumentId.id, receiver: call.transfer.receiver, amount: call.transfer.amount, inputHoldings: call.transfer.inputHoldingCids,
    requestedAt: call.transfer.requestedAt, executeBefore: call.transfer.executeBefore, implementation: "splice-test-token-v1",   // the test token's package: the one the real transaction names
  };
  const factory = { contractId: fx.command.ExerciseCommand.contractId, context: call.extraArgs.context, disclosedContracts: fx.disclosedContracts! };
  const made = () => transfer(sender, t, factory);
  /** The intent with one change made to what the person asked for. */
  const changed = (patch: (x: Record<string, any>) => void) => { const x = structuredClone(made().intent.args) as Record<string, any>; patch(x); return { ...made().intent, args: x }; };

  it("is built by the page as the real transaction was asked for, in the token standard's field order, and is signed with the page's own hash", async () => {
    expect(made().command).toEqual(fx.command);
    expect(made().disclosedContracts).toEqual(fx.disclosedContracts);
    expect(Object.keys(made().intent.args)).toEqual(["expectedAdmin", "transfer", "extraArgs"]);
    expect(Object.keys((made().intent.args.transfer as object))).toEqual(["sender", "receiver", "amount", "instrumentId", "requestedAt", "executeBefore", "inputHoldingCids", "meta"]);
    expect(() => checkIntent(decode(fx), made().intent, now)).not.toThrow();
    expect(await verifies(fx.preparedTransactionHash, await sign(made().intent, fx))).toBe(true);
  });
  it("is refused with another receiver, amount, instrument, sender, holdings, times or admin", () => {
    const tx = decode(fx);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.receiver = "evil::1220" + "00".repeat(32); }), now)).toThrow(/receiver/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.amount = "3.1"; }), now)).toThrow(/amount/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.amount = "30"; }), now)).toThrow(/amount/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.instrumentId.id = "TKC"; }), now)).toThrow(/instrumentId/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.instrumentId.admin = "evil::1220" + "00".repeat(32); }), now)).toThrow(/instrumentId/);
    expect(() => checkIntent(tx, changed((x) => { x.expectedAdmin = "evil::1220" + "00".repeat(32); }), now)).toThrow(/expectedAdmin/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.sender = "evil::1220" + "00".repeat(32); }), now)).toThrow(/sender/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.inputHoldingCids = ["00e1"]; }), now)).toThrow(/inputHoldingCids/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.inputHoldingCids = [...x.transfer.inputHoldingCids, "00e1"]; }), now)).toThrow(/list of 1/);   // an extra holding
    expect(() => checkIntent(tx, changed((x) => { x.transfer.inputHoldingCids = []; }), now)).toThrow(/list of 1/);   // a holding fewer
    expect(() => checkIntent(tx, changed((x) => { x.transfer.requestedAt = "2030-11-05T12:00:00Z"; }), now)).toThrow(/requestedAt/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.executeBefore = "2030-11-05T12:00:00Z"; }), now)).toThrow(/executeBefore/);
    expect(() => checkIntent(tx, changed((x) => { x.transfer.meta = { values: { note: "x" } }; }), now)).toThrow(/map of 0 entries/);   // a note the person did not write
    expect(() => checkIntent(tx, changed((x) => { x.transfer.extra = "x"; }), now)).toThrow(/fields/);
  });
  it("is refused with another factory, choice, interface, package, actor or a template call; the registry's context is the one thing it does not pin", () => {
    const tx = decode(fx);
    expect(() => checkIntent(tx, { ...made().intent, contractId: "00ff" }, now)).toThrow(/exercises/);
    expect(() => checkIntent(tx, { ...made().intent, choice: "TransferFactory_PublicFetch" }, now)).toThrow(/exercises/);
    expect(() => checkIntent(tx, { ...made().intent, interface: undefined }, now)).toThrow(/through/);
    expect(() => checkIntent(tx, { ...made().intent, implementation: "splice-amulet" }, now)).toThrow(/through/);   // another package implements the factory than the instrument's own
    expect(() => checkIntent(tx, { ...made().intent, party: "evil::1220" + "00".repeat(32) }, now)).toThrow(/submitter/);
    expect(() => checkIntent(tx, changed((x) => { x.extraArgs.meta = { values: { a: "b" } }; }), now)).toThrow(/map of 0 entries/);
    expect(() => checkIntent(tx, changed((x) => { x.extraArgs.context = { values: { anything: { tag: "AV_Bool", value: true } } }; }), now)).not.toThrow();
    expect(tx.metadata!.minLedgerEffectiveTime !== undefined || tx.metadata!.maxLedgerEffectiveTime !== undefined).toBe(true);   // the standard's deadlines are the transaction's time bounds, as for the allocation
    expect(() => checkIntent(tx, { ...made().intent, ledgerTimes: false }, now)).toThrow(/ledger time/);
  });
  it("is refused with an extra node, a second root, another actor, and another time", () => {
    const tx = decode(fx);
    const more = structuredClone(tx);
    more.transaction!.roots.push(more.transaction!.roots[0]!);
    expect(() => checkIntent(more, made().intent, now)).toThrow(/2 root nodes/);
    const stray = structuredClone(tx);
    stray.transaction!.nodes.push({ ...structuredClone(stray.transaction!.nodes[0]!), nodeId: "stray" });
    expect(() => checkIntent(stray, made().intent, now)).toThrow(/not under the root/);
    const acting = structuredClone(tx);
    acting.metadata!.submitterInfo!.actAs.push("other::1220" + "00".repeat(32));
    expect(() => checkIntent(acting, made().intent, now)).toThrow(/submitter/);
    expect(() => checkIntent(tx, made().intent, now + 5 * 60 * 1000 + 1)).toThrow(/five minutes/);
  });
  it("is refused when the service's hash is not the one the page computes, and when it is for another account", async () => {
    const wrong = base64(Uint8Array.from(fromBase64(fx.preparedTransactionHash), (b, i) => (i === 0 ? b ^ 1 : b)));
    await refused(sign(made().intent, { ...fx, preparedTransactionHash: wrong }), /hash is not the service's/);
    await refused(sign(made().intent, { ...fx, party: "other::1220" + "00".repeat(32) }), /another party/);
  });
});

// A TransferInstruction_Accept of the test token, made by the integration test: the receiver accepts the transfer above.
describe("the accept's transaction, from the real Canton", () => {
  const fx = fixture("exercise-accept");
  const receiver = fx.party;
  const now = preparedAt(fx);
  const made = () => acceptTransfer(receiver, fx.command.ExerciseCommand.contractId, { context: fx.command.ExerciseCommand.choiceArgument.extraArgs.context, disclosedContracts: fx.disclosedContracts! }, "splice-test-token-v1");
  it("is built by the page as the real transaction was asked for, and is signed with the page's own hash", async () => {
    expect(made().command).toEqual(fx.command);
    expect(() => checkIntent(decode(fx), made().intent, now)).not.toThrow();
    expect(await verifies(fx.preparedTransactionHash, await sign(made().intent, fx))).toBe(true);
  });
  it("is refused for another offer, choice, package, actor or argument", () => {
    const tx = decode(fx);
    expect(() => checkIntent(tx, { ...made().intent, contractId: "00ff" }, now)).toThrow(/exercises/);
    expect(() => checkIntent(tx, { ...made().intent, choice: "TransferInstruction_Reject" }, now)).toThrow(/exercises/);
    expect(() => checkIntent(tx, { ...made().intent, implementation: "splice-amulet" }, now)).toThrow(/through/);
    expect(() => checkIntent(tx, { ...made().intent, party: "evil::1220" + "00".repeat(32) }, now)).toThrow(/submitter/);
    expect(() => checkIntent(tx, { ...made().intent, args: { extraArgs: { context: {}, meta: { values: { a: "b" } } } } }, now)).toThrow(/map of 0 entries/);
    expect(() => checkIntent(tx, { ...made().intent, args: { extraArgs: { context: {}, meta: { values: {} } }, extra: 1 } }, now)).toThrow(/fields/);
  });
});
