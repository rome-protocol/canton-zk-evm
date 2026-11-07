import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Enums_ParticipantPermission, TopologyTransaction as V30 } from "../../../canton-proto/gen/com/digitalasset/canton/protocol/v30/topology.ts";
import { PartyToParticipant_HostingParticipant_HostingState, TopologyTransaction as V31 } from "../../../canton-proto/gen/com/digitalasset/canton/protocol/v31/topology.ts";
import { UntypedVersionedMessage } from "../../../canton-proto/gen/com/digitalasset/canton/version/v1/untyped_versioned_message.ts";
import { AccountsClient, AccountsError } from "./accounts.ts";
import { base64, fromBase64, hex, keyFromSignature, signOnboarding, type CantonKey } from "./key.ts";
import { fingerprintOf, partyOf, topologyMultiHash, UnexpectedOnboarding, verifyOnboarding } from "./topology.ts";

// Two real topology answers of the pinned Canton 3.7.1, printed by apps/accounts/tests/integration.py: one on protocol version 36 (messages of version 30, in a wrapper of version 30) and one on
// protocol version 37 (messages of version 31, in a wrapper of version 31). Each is one PartyToParticipant, with the party's key in it.
interface Real { name: string; party: string; publicKey: string; participant: string; protocolVersion: number; multiHash: string; topologyTransactions: string[] }
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as Record<string, any>[];
const reals = ["topology-pv36", "topology-pv37"].map((name) => fixtures.find((f) => f.name === name) as Real);
const archived = fixtures.find((f) => f.name === "exercise-archive")!;
const NOW = 1_800_000_000_000;
const OTHER_PARTICIPANT = "operator::1220" + "ee".repeat(32);

const version = (fx: Real) => (fx.protocolVersion === 37 ? 31 : 30);
const T = (fx: Real) => (version(fx) === 31 ? V31 : V30);
/** The real transaction, decoded, changed by `mutate` (the message and its PartyToParticipant), and wrapped again (in the wrapper version asked for, the message's own by default). */
function remake(fx: Real, mutate: (tx: any, hosting: any) => void = () => {}, wrapperVersion = version(fx), extra: number[] = []): string {
  const wrapper = UntypedVersionedMessage.fromBinary(fromBase64(fx.topologyTransactions[0]!));
  if (wrapper.wrapper.oneofKind !== "data") throw new Error("no data");
  const tx: any = T(fx).fromBinary(wrapper.wrapper.data);
  mutate(tx, tx.mapping.mapping.partyToParticipant);
  return base64(UntypedVersionedMessage.toBinary({ wrapper: { oneofKind: "data", data: new Uint8Array([...T(fx).toBinary(tx), ...extra]) }, version: wrapperVersion }));
}
const answer = async (fx: Real, txs: string[]) => ({ party: fx.party, topologyTransactions: txs, multiHash: base64(await topologyMultiHash(txs)) });
const verify = async (fx: Real, txs: string[], over: Record<string, unknown> = {}, participant = fx.participant, publicKey = fx.publicKey) =>
  verifyOnboarding({ ...(await answer(fx, txs)), ...over }, fromBase64(publicKey), participant);
const other = (n = 44) => new Uint8Array(n).fill(7);

describe.each(reals)("the real topology of protocol version $protocolVersion", (fx) => {
  const key = fromBase64(fx.publicKey);
  it("has the party, the multi-hash and the message version that the page computes and reads", async () => {
    expect(fx.participant).toMatch(/^operator::1220[0-9a-f]{64}$/);
    expect(await partyOf(key)).toBe(fx.party);   // bridge:: and the fingerprint: 1220 and the SHA-256 (purpose 12) of the 32 raw bytes
    expect(await fingerprintOf(key)).toBe(fx.party.slice("bridge::".length));
    expect(hex(await topologyMultiHash(fx.topologyTransactions))).toBe(hex(fromBase64(fx.multiHash)));   // the participant's multi-hash of its transactions
    expect(fromBase64(fx.multiHash).length).toBe(34);
    expect(fx.topologyTransactions.length).toBe(1);
    expect(UntypedVersionedMessage.fromBinary(fromBase64(fx.topologyTransactions[0]!)).version).toBe(version(fx));
  });
  it("is this key's onboarding on this participant, and the page signs the multi-hash it computed", async () => {
    expect(hex(await verify(fx, fx.topologyTransactions))).toBe(hex(fromBase64(fx.multiHash)));
    expect(hex(await verify(fx, [remake(fx)]))).toBe(hex(await topologyMultiHash([remake(fx)])));   // decoded and encoded again: still accepted
    await expect(verify(fx, fx.topologyTransactions, {}, "PAR::" + fx.participant)).resolves.toBeDefined();   // the Ledger API says a participant's id with PAR::
  });

  const refused: [string, (tx: any, p: any) => void, RegExp][] = [
    ["an extra signing key", (_t, p) => p.partySigningKeys.keys.push({ ...p.partySigningKeys.keys[0], publicKey: other() }), /this key alone/],
    ["another signing key", (_t, p) => { p.partySigningKeys.keys[0].publicKey = other(); }, /this key alone/],
    ["a signing threshold of 2", (_t, p) => { p.partySigningKeys.threshold = 2; }, /this key alone/],
    ["no signing keys", (_t, p) => { p.partySigningKeys = undefined; }, /this key alone/],
    ["another namespace", (_t, p) => { p.party = "bridge::1220" + "ee".repeat(32); }, /is for/],
    ["another participant", (_t, p) => { p.participants[0].participantUid = OTHER_PARTICIPANT; }, /not hosted/],
    ["an extra participant", (_t, p) => p.participants.push({ ...p.participants[0], participantUid: OTHER_PARTICIPANT }), /not hosted/],
    ["the same participant twice", (_t, p) => p.participants.push({ ...p.participants[0] }), /not hosted/],
    ["no participant", (_t, p) => { p.participants = []; }, /not hosted/],
    ["a submission permission", (_t, p) => { p.participants[0].permission = Enums_ParticipantPermission.SUBMISSION; }, /permission to confirm/],
    ["an observation permission", (_t, p) => { p.participants[0].permission = Enums_ParticipantPermission.OBSERVATION; }, /permission to confirm/],
    ["a confirmation threshold of 2", (_t, p) => { p.threshold = 2; }, /threshold is not 1/],
    ["a participant that does not host it yet", (_t, p) => {
      if (version(fx) === 31) p.participants[0].state = PartyToParticipant_HostingParticipant_HostingState.NOMINATED;
      else p.participants[0].onboarding = {};
    }, /permission to confirm/],
    ["a removal", (t) => { t.operation = 2; }, /first addition/],
    ["a later serial", (t) => { t.serial = 2; }, /first addition/],
    ["another mapping", (t) => { t.mapping.mapping = { oneofKind: "namespaceDelegation", namespaceDelegation: { namespace: "x", isRootDelegation: true, restriction: { oneofKind: undefined } } }; }, /not a PartyToParticipant/],
  ];
  it.each(refused)("refuses %s", async (_name, mutate, why) => {
    await expect(verify(fx, [remake(fx, mutate)])).rejects.toThrow(why);   // the multi-hash is the changed transaction's own: only its content is refused
    await expect(verify(fx, [remake(fx, mutate)])).rejects.toThrow(UnexpectedOnboarding);
  });

  it("refuses a second mapping, and no transaction", async () => {
    const second = remake(fx, (t) => { t.mapping.mapping = { oneofKind: "namespaceDelegation", namespaceDelegation: { namespace: "x", isRootDelegation: true, restriction: { oneofKind: undefined } } }; });
    await expect(verify(fx, [fx.topologyTransactions[0]!, second])).rejects.toThrow(/not one transaction/);
    await expect(verify(fx, [fx.topologyTransactions[0]!, fx.topologyTransactions[0]!])).rejects.toThrow(/not one transaction/);
    await expect(verify(fx, [])).rejects.toThrow(/not one transaction/);
  });
  it("refuses a field the definitions do not have, in the message and in the wrapper", async () => {
    await expect(verify(fx, [remake(fx, undefined, version(fx), [0x78, 0x01])])).rejects.toThrow(/does not decode/);
    const wrapped = Uint8Array.from([...fromBase64(fx.topologyTransactions[0]!), 0x78, 0x01]);
    await expect(verify(fx, [base64(wrapped)])).rejects.toThrow(/does not decode/);
    await expect(verify(fx, [base64(new Uint8Array([0, 0, 0]))])).rejects.toThrow(UnexpectedOnboarding);
    await expect(verifyOnboarding({ party: fx.party, topologyTransactions: ["not base64!"], multiHash: fx.multiHash }, key, fx.participant)).rejects.toThrow(UnexpectedOnboarding);
  });
  it("refuses a wrapper version other than 30 or 31, and a message in the other version's wrapper", async () => {
    for (const v of [0, 29, 32, 36, 37]) await expect(verify(fx, [remake(fx, undefined, v)]), String(v)).rejects.toThrow(/not 30 or 31/);
    await expect(verify(fx, [remake(fx, undefined, version(fx) === 31 ? 30 : 31)])).rejects.toThrow(/does not decode/);
  });
  it("refuses a multi-hash that is not the hash of the transaction: a prepared transaction's hash, another multi-hash, or none", async () => {
    await expect(verify(fx, fx.topologyTransactions, { multiHash: archived.preparedTransactionHash })).rejects.toThrow(/not the hash/);   // 32 bytes: the hash that executes a transaction
    await expect(verify(fx, fx.topologyTransactions, { multiHash: base64(new Uint8Array([0x12, 0x20, ...other(32)])) })).rejects.toThrow(/not the hash/);
    await expect(verify(fx, fx.topologyTransactions, { multiHash: "not base64!" })).rejects.toThrow(/not base64/);
    await expect(verify(fx, fx.topologyTransactions, { multiHash: "" })).rejects.toThrow(/not the hash/);
  });
  it("refuses another party than the key's, another key, and another participant", async () => {
    await expect(verify(fx, fx.topologyTransactions, { party: "bridge::1220" + "ee".repeat(32) })).rejects.toThrow(/the party is/);
    await expect(verify(fx, fx.topologyTransactions, {}, fx.participant, base64(other(32)))).rejects.toThrow(/the party is/);
    await expect(verify(fx, fx.topologyTransactions, {}, OTHER_PARTICIPANT)).rejects.toThrow(/not hosted/);
  });
});

describe.each(reals)("opening an account on protocol version $protocolVersion", (fx) => {
  /** This test's own key, in the real transaction in place of the real key: so the page can sign it. */
  const run = async (publicKey: Uint8Array) => {
    const party = await partyOf(publicKey);
    const tx = remake(fx, (_t, p) => {
      const der = p.partySigningKeys.keys[0].publicKey as Uint8Array;
      p.party = party;
      p.partySigningKeys.keys[0].publicKey = new Uint8Array([...der.slice(0, 12), ...publicKey]);
    });
    return { party, tx, multiHash: base64(await topologyMultiHash([tx])) };
  };
  const key = keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1b");
  const client = (f: ReturnType<typeof vi.fn>) => new AccountsClient("", f as unknown as typeof fetch, () => NOW);
  const answered = (body: unknown) => new Response(JSON.stringify(body));
  const verifies = async (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) =>
    crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]), signature as BufferSource, message as BufferSource);

  it("asks the wallet again, then signs the multi-hash it computed, and sends it with the service's blob", async () => {
    const k = await key;
    const { party, tx, multiHash } = await run(k.publicKey);
    const order: string[] = [];
    const f = vi.fn(async (url: string) => {
      order.push(url.slice(url.lastIndexOf("/") + 1));
      return url.endsWith("/topology") ? answered({ party, exists: false, multiHash, topologyTransactions: [tx], blob: "blob" }) : answered({ party, created: true });
    });
    const confirm = vi.fn(async () => { order.push("confirm"); });
    expect(await client(f).open(k, fx.participant, confirm)).toBe(party);
    expect(order).toEqual(["topology", "confirm", "allocate"]);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.every(([, i]) => !("X-Account-Signature" in (i.headers as object)))).toBe(true);
    const sent = JSON.parse(calls[1]![1].body as string);
    expect(sent.blob).toBe("blob");
    expect(await verifies(k.publicKey, fromBase64(multiHash), fromBase64(sent.signature))).toBe(true);
  });
  it("signOnboarding checks the answer itself: it signs the multi-hash of this key's onboarding, and nothing else", async () => {
    const k = await key;
    const { party, tx, multiHash } = await run(k.publicKey);
    const answerOf = (over: Record<string, unknown> = {}) => ({ party, topologyTransactions: [tx], multiHash, ...over });
    expect(await verifies(k.publicKey, fromBase64(multiHash), await signOnboarding(k, answerOf(), fx.participant))).toBe(true);
    await expect(signOnboarding(k, answerOf({ multiHash: archived.preparedTransactionHash }), fx.participant)).rejects.toThrow(UnexpectedOnboarding);   // a transaction's hash is not an onboarding
    await expect(signOnboarding(k, answerOf({ multiHash: base64(new Uint8Array([0x12, 0x20, ...other(32)])) }), fx.participant)).rejects.toThrow(/not the hash/);
    await expect(signOnboarding(k, answerOf(), OTHER_PARTICIPANT)).rejects.toThrow(/not hosted/);
    await expect(signOnboarding(k, answerOf({ party: "bridge::1220" + "ee".repeat(32) }), fx.participant)).rejects.toThrow(/the party is/);
    await expect(signOnboarding({ publicKey: k.publicKey } as CantonKey, answerOf(), fx.participant)).rejects.toThrow("not a key made by this library");   // a look-alike has no signer
  });
  it("signs nothing for a multi-hash the service names that is not the hash of the transaction (a prepared transaction's hash in place of the topology's multi-hash is refused)", async () => {
    const k = await key;
    const { party, tx } = await run(k.publicKey);
    const sentTo: string[] = [];
    const confirm = vi.fn(async () => {});
    for (const multiHash of [archived.preparedTransactionHash, base64(new Uint8Array([0x12, 0x20, ...other(32)]))]) {
      const f = vi.fn(async (url: string) => { sentTo.push(url); return url.endsWith("/topology") ? answered({ party, exists: false, multiHash, topologyTransactions: [tx], blob: "blob" }) : answered({ party, created: true }); });
      await expect(client(f).open(k, fx.participant, confirm)).rejects.toThrow(/not the hash/);
    }
    expect(sentTo.filter((u) => u.endsWith("/allocate"))).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("signs nothing for another key's onboarding, another participant's, or a transaction that hosts the party twice", async () => {
    const k = await key;
    const mine = await run(k.publicKey);
    const others = await run(other(32));   // the transaction of another key and party, which the service gives for this key
    const hosted = remake(fx, (_t, p) => {
      const der = p.partySigningKeys.keys[0].publicKey as Uint8Array;
      p.party = mine.party;
      p.partySigningKeys.keys[0].publicKey = new Uint8Array([...der.slice(0, 12), ...k.publicKey]);
      p.participants.push({ ...p.participants[0], participantUid: OTHER_PARTICIPANT });
    });
    let allocated = 0;
    const serve = (multiHash: string, txs: string[]) => vi.fn(async (url: string) => {
      if (url.endsWith("/allocate")) allocated++;
      return url.endsWith("/topology") ? answered({ party: mine.party, exists: false, multiHash, topologyTransactions: txs, blob: "blob" }) : answered({ party: mine.party, created: true });
    });
    await expect(client(serve(others.multiHash, [others.tx])).open(k, fx.participant)).rejects.toThrow(/the transaction is for/);
    await expect(client(serve(mine.multiHash, [mine.tx])).open(k, OTHER_PARTICIPANT)).rejects.toThrow(/not hosted/);
    await expect(client(serve(base64(await topologyMultiHash([hosted])), [hosted])).open(k, fx.participant)).rejects.toThrow(/not hosted/);
    expect(allocated).toBe(0);
  });
  it("stops at the wallet that does not sign the same way twice, and at a service that makes another party", async () => {
    const k = await key;
    const { party, tx, multiHash } = await run(k.publicKey);
    let allocated = 0;
    const serve = (made: string) => vi.fn(async (url: string) => {
      if (url.endsWith("/allocate")) { allocated++; return answered({ party: made, created: true }); }
      return answered({ party, exists: false, multiHash, topologyTransactions: [tx], blob: "blob" });
    });
    await expect(client(serve(party)).open(k, fx.participant, async () => { throw new Error("this wallet does not sign the same way twice"); })).rejects.toThrow("same way twice");
    expect(allocated).toBe(0);
    await expect(client(serve("bridge::1220" + "ee".repeat(32))).open(k, fx.participant)).rejects.toThrow(AccountsError);
  });
});
