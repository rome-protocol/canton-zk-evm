// What the page signs to open an account, checked first. The account service names the party and the topology's multi-hash; the page signs neither as given. It decodes
// the topology transactions the service got from the participant, holds them to this key's onboarding alone (the party's namespace from this key, this key the only signing key,
// hosting on the configured participant), computes the party and the multi-hash itself, and signs its own multi-hash if the service's is the same. The decode and the hashes
// are Digital Asset's (@canton-network/core-tx-visualizer); the formulas are pinned by a topology of the real Canton in fixtures.json.
import { computeMultiHashForTopology, computeSha256CantonHash, decodeTopologyTransaction } from "@canton-network/core-tx-visualizer";
import type { SigningPublicKey, TopologyTransaction } from "@canton-network/core-ledger-proto";
import { bytesFromHex, fromBase64, hex, sameBytes } from "./key.ts";

const PURPOSE = { topologyTransaction: 11, publicKeyFingerprint: 12, multiTopologyTransaction: 55 };   // Canton's hash purposes
const ADD_REPLACE = 1, SUBMISSION = 1, CONFIRMATION = 2, EC_CURVE25519 = 1;   // the proto enums' numbers
const SPKI_ED25519 = bytesFromHex("302a300506032b6570032100");   // the DER prefix of an Ed25519 public key (SubjectPublicKeyInfo); the 32 raw bytes follow

/** The topology is not this key's onboarding (or could not be checked): nothing is signed. */
export class UnexpectedOnboarding extends Error {
  constructor(why: string) { super(`The account's topology is not what was asked for: ${why}`); this.name = "UnexpectedOnboarding"; }
}
const refuse = (why: string): never => { throw new UnexpectedOnboarding(why); };

/** Canton's fingerprint of an Ed25519 key: its hash (purpose 12) over the key in DER X.509 form, in Canton's hash format (1220 and 64 hex digits). */
export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  return hex(await computeSha256CantonHash(PURPOSE.publicKeyFingerprint, new Uint8Array([...SPKI_ED25519, ...publicKey])));
}
/** The account's party id: the service's hint (`bridge`), then the key's fingerprint. */
export const partyOf = async (publicKey: Uint8Array): Promise<string> => `bridge::${await fingerprintOf(publicKey)}`;

export interface TopologyAnswer { party: string; multiHash: string; topologyTransactions: string[] }

const uid = (s: string) => s.replace(/^PAR::/, "");   // a participant's id as the Ledger API says it, and as a topology transaction does

/** Gives the multi-hash (34 bytes) of the onboarding of `publicKey` on `participant`, after checking that the service's topology is exactly that. */
export async function verifyOnboarding(answer: TopologyAnswer, publicKey: Uint8Array, participant: string): Promise<Uint8Array> {
  const fingerprint = await fingerprintOf(publicKey);
  const party = `bridge::${fingerprint}`;
  if (answer.party !== party) refuse(`the party is ${answer.party}, not ${party}`);
  const txs = answer.topologyTransactions;
  if (!Array.isArray(txs) || txs.length < 2 || txs.length > 3 || txs.some((t) => typeof t !== "string")) return refuse("it is not two or three transactions");
  const mine = (k: SigningPublicKey | undefined): boolean => {
    if (!k || k.keySpec !== EC_CURVE25519) return false;
    const raw = k.publicKey.length === 44 && sameBytes(k.publicKey.slice(0, 12), SPKI_ED25519) ? k.publicKey.slice(12) : k.publicKey;
    return sameBytes(raw, publicKey);
  };
  const only = (keys: SigningPublicKey[] | undefined, threshold: number | undefined, what: string) => {
    if (threshold !== 1 || keys?.length !== 1 || !mine(keys[0])) refuse(`${what} is not this key alone`);
  };
  const seen = { delegation: 0, hosting: 0, keys: 0 };
  for (const t of txs) {
    let tx: TopologyTransaction;
    try { tx = decodeTopologyTransaction(t, { readUnknownField: "throw" }); }
    catch (e) { return refuse(`a transaction does not decode (${e instanceof Error ? e.message : "?"})`); }
    if (tx.operation !== ADD_REPLACE || tx.serial !== 1) refuse("a transaction is not a first addition");
    const m = tx.mapping?.mapping;
    if (m?.oneofKind === "namespaceDelegation") {
      const d = m.namespaceDelegation;
      if (d.namespace !== fingerprint || !mine(d.targetKey)) refuse("the namespace is not this key's");
      if (!d.isRootDelegation && d.restriction.oneofKind !== "canSignAllMappings") refuse("the namespace's key is restricted");
      seen.delegation++;
    } else if (m?.oneofKind === "partyToKeyMapping") {
      if (m.partyToKeyMapping.party !== party) refuse("a key mapping is for another party");
      only(m.partyToKeyMapping.signingKeys, m.partyToKeyMapping.threshold, "the key mapping");
      seen.keys++;
    } else if (m?.oneofKind === "partyToParticipant") {
      const p = m.partyToParticipant;
      const [host] = p.participants;
      if (p.party !== party || p.threshold !== 1 || p.participants.length !== 1 || !host || uid(host.participantUid) !== uid(participant)) refuse(`the party is not hosted on ${participant} alone`);
      if (host!.permission !== CONFIRMATION && host!.permission !== SUBMISSION) refuse("the hosting participant cannot confirm for the party");
      if (p.partySigningKeys) { only(p.partySigningKeys.keys, p.partySigningKeys.threshold, "the party's signing keys"); seen.keys++; }
      seen.hosting++;
    } else return refuse(`a transaction is a ${m?.oneofKind ?? "mapping that is not known"}`);
  }
  if (seen.delegation !== 1 || seen.hosting !== 1 || seen.keys < 1) refuse("it is not one namespace, one hosting and a key mapping");
  const hashes = await Promise.all(txs.map((t) => computeSha256CantonHash(PURPOSE.topologyTransaction, fromBase64(t))));
  const multiHash = await computeSha256CantonHash(PURPOSE.multiTopologyTransaction, await computeMultiHashForTopology(hashes));
  let given: Uint8Array;
  try { given = fromBase64(answer.multiHash); } catch { return refuse("the multi-hash is not base64"); }
  if (!sameBytes(multiHash, given)) refuse("the multi-hash is not the hash of those transactions");
  return multiHash;
}
