// What the page signs to open an account, checked first. The account service names the party and the topology's multi-hash; the page signs neither as given. It decodes the topology
// transaction the service got from the participant, holds it to this key's onboarding and nothing else (the party's namespace this key's fingerprint, this key the party's only signing
// key with threshold 1, hosting on the configured participant alone, with the permission an account has), computes the party and the multi-hash itself, and signs its own
// multi-hash if the service's is the same. The decode is protobuf-ts's, generated from the .proto files of the pinned Canton (explorer/canton-proto: protocol versions 30 and 31). A
// topology transaction comes in a versioned wrapper (UntypedVersionedMessage, whose version is the protocol version's message version); any other version is refused, and so is any field
// that the definitions do not have.
import { computeMultiHashForTopology, computeSha256CantonHash } from "@canton-network/core-tx-visualizer";
import { CryptoKeyFormat, SigningKeySpec, type SigningKeysWithThreshold } from "../../../canton-proto/gen/com/digitalasset/canton/crypto/v30/crypto.ts";
import { Enums_ParticipantPermission, Enums_TopologyChangeOp, TopologyTransaction as TopologyTransactionV30 } from "../../../canton-proto/gen/com/digitalasset/canton/protocol/v30/topology.ts";
import { PartyToParticipant_HostingParticipant_HostingState, TopologyTransaction as TopologyTransactionV31 } from "../../../canton-proto/gen/com/digitalasset/canton/protocol/v31/topology.ts";
import { UntypedVersionedMessage } from "../../../canton-proto/gen/com/digitalasset/canton/version/v1/untyped_versioned_message.ts";
import { bytesFromHex, fromBase64, hex, sameBytes } from "./key.ts";

const PURPOSE = { topologyTransaction: 11, publicKeyFingerprint: 12, multiTopologyTransaction: 55 };   // Canton's hash purposes
const SPKI_ED25519 = bytesFromHex("302a300506032b6570032100");   // the DER prefix of an Ed25519 public key (SubjectPublicKeyInfo); the 32 raw bytes follow
const STRICT = { readUnknownField: "throw" } as const;   // a field the definitions do not have is an error

/** The topology is not this key's onboarding on the configured participant (or could not be checked): nothing is signed. */
export class UnexpectedOnboarding extends Error {
  constructor(why: string) { super(`The account's topology is not what was asked for: ${why}`); this.name = "UnexpectedOnboarding"; }
}
const refuse = (why: string): never => { throw new UnexpectedOnboarding(why); };

/** Canton's fingerprint of an Ed25519 key: its hash (purpose 12) over the 32 raw bytes of the key, in Canton's hash format (1220 and 64 hex digits). Pinned by a real vector in fixtures.json. */
export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  return hex(await computeSha256CantonHash(PURPOSE.publicKeyFingerprint, publicKey));
}
/** The account's party id: the service's hint (`bridge`), then the key's fingerprint, which is the party's namespace. */
export const partyOf = async (publicKey: Uint8Array): Promise<string> => `bridge::${await fingerprintOf(publicKey)}`;

/** The multi-hash (34 bytes) of base64 topology transactions: each hashed (purpose 11), the hashes sorted and joined, that hashed (purpose 55). Pinned by real vectors in fixtures.json. */
export async function topologyMultiHash(transactions: string[]): Promise<Uint8Array> {
  const hashes = await Promise.all(transactions.map((t) => computeSha256CantonHash(PURPOSE.topologyTransaction, fromBase64(t))));
  return computeSha256CantonHash(PURPOSE.multiTopologyTransaction, await computeMultiHashForTopology(hashes));
}

export interface TopologyAnswer { party: string; multiHash: string; topologyTransactions: string[] }

/** The one PartyToParticipant of an onboarding, as both message versions say it: `active` is "hosts the party" (version 31's state, the absence of version 30's onboarding flag). */
interface Hosting { party: string; threshold: number; hosts: { uid: string; permission: Enums_ParticipantPermission; active: boolean }[]; keys: SigningKeysWithThreshold | undefined }

/** Decodes one base64 topology transaction: the wrapper, then the message of the wrapper's version, a first addition of a PartyToParticipant and nothing else. */
function decode(transaction: string): Hosting {
  let wrapper: UntypedVersionedMessage;
  try { wrapper = UntypedVersionedMessage.fromBinary(fromBase64(transaction), STRICT); }
  catch (e) { return refuse(`a transaction does not decode (${e instanceof Error ? e.message : "?"})`); }
  if (wrapper.wrapper.oneofKind !== "data") return refuse("a transaction has no content");
  const { data } = wrapper.wrapper;
  try {
    if (wrapper.version === 30) {
      const tx = TopologyTransactionV30.fromBinary(data, STRICT);
      const m = tx.mapping?.mapping;
      if (tx.operation !== Enums_TopologyChangeOp.ADD_REPLACE || tx.serial !== 1) return refuse("a transaction is not a first addition");
      if (m?.oneofKind !== "partyToParticipant") return refuse(`a transaction is a ${m?.oneofKind ?? "mapping that is not known"}, not a PartyToParticipant`);
      const p = m.partyToParticipant;
      return { party: p.party, threshold: p.threshold, keys: p.partySigningKeys, hosts: p.participants.map((h) => ({ uid: h.participantUid, permission: h.permission, active: h.onboarding === undefined })) };
    }
    if (wrapper.version === 31) {
      const tx = TopologyTransactionV31.fromBinary(data, STRICT);
      const m = tx.mapping?.mapping;
      if (tx.operation !== Enums_TopologyChangeOp.ADD_REPLACE || tx.serial !== 1) return refuse("a transaction is not a first addition");
      if (m?.oneofKind !== "partyToParticipant") return refuse(`a transaction is a ${m?.oneofKind ?? "mapping that is not known"}, not a PartyToParticipant`);
      const p = m.partyToParticipant;
      return { party: p.party, threshold: p.threshold, keys: p.partySigningKeys, hosts: p.participants.map((h) => ({ uid: h.participantUid, permission: h.permission, active: h.state === PartyToParticipant_HostingParticipant_HostingState.ACTIVE })) };
    }
  } catch (e) {
    if (e instanceof UnexpectedOnboarding) throw e;
    return refuse(`a transaction does not decode (${e instanceof Error ? e.message : "?"})`);
  }
  return refuse(`the transaction's version is ${wrapper.version}, not 30 or 31`);
}

const uid = (s: string) => s.replace(/^PAR::/, "");   // a participant's id as the Ledger API says it, and as a topology transaction does

/** Gives the multi-hash (34 bytes) of the onboarding of `publicKey` on `participant`, after checking that the service's topology is exactly that: one transaction, the party of this key
 * (its namespace is the key's fingerprint), this key its only signing key with threshold 1, and the configured participant its only host, with the permission to confirm, hosting it. */
export async function verifyOnboarding(answer: TopologyAnswer, publicKey: Uint8Array, participant: string): Promise<Uint8Array> {
  const party = await partyOf(publicKey);
  if (answer.party !== party) refuse(`the party is ${answer.party}, not ${party}`);
  const txs = answer.topologyTransactions;
  if (!Array.isArray(txs) || txs.length !== 1 || typeof txs[0] !== "string") return refuse("it is not one transaction");
  const h = decode(txs[0]);
  if (h.party !== party) refuse(`the transaction is for ${h.party}, not ${party}`);
  if (h.threshold !== 1) refuse("the party's confirmation threshold is not 1");
  const [host] = h.hosts;
  if (h.hosts.length !== 1 || !host || uid(host.uid) !== uid(participant)) refuse(`the party is not hosted on ${participant} alone`);
  if (host!.permission !== Enums_ParticipantPermission.CONFIRMATION || !host!.active) refuse("the participant does not host the party with the permission to confirm");
  const [key] = h.keys?.keys ?? [];
  const raw = key && key.publicKey.length === 44 && sameBytes(key.publicKey.slice(0, 12), SPKI_ED25519) ? key.publicKey.slice(12) : key?.publicKey;
  if (!h.keys || h.keys.threshold !== 1 || h.keys.keys.length !== 1 || !key || key.keySpec !== SigningKeySpec.EC_CURVE25519
    || (key.format !== CryptoKeyFormat.DER_X509_SUBJECT_PUBLIC_KEY_INFO && key.format !== CryptoKeyFormat.RAW) || !raw || !sameBytes(raw, publicKey)) refuse("the party's signing keys are not this key alone, with threshold 1");
  const multiHash = await topologyMultiHash(txs);
  let given: Uint8Array;
  try { given = fromBase64(answer.multiHash); } catch { return refuse("the multi-hash is not base64"); }
  if (!sameBytes(multiHash, given)) refuse("the multi-hash is not the hash of the transaction");
  return multiHash;
}
