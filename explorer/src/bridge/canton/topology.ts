// What the page can check of an account's onboarding. The party id and the multi-hash are computed here and never taken from the account service. What the topology
// transactions SAY (this key the namespace, this key the only signing key, hosting on the configured participant) is not checked: see `OnboardingNotChecked`.
import { computeMultiHashForTopology, computeSha256CantonHash } from "@canton-network/core-tx-visualizer";
import { fromBase64, hex } from "./key.ts";

const PURPOSE = { topologyTransaction: 11, publicKeyFingerprint: 12, multiTopologyTransaction: 55 };   // Canton's hash purposes

/** Canton's fingerprint of an Ed25519 key: its hash (purpose 12) over the 32 raw bytes of the key, in Canton's hash format (1220 and 64 hex digits). Pinned by a real vector in fixtures.json. */
export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  return hex(await computeSha256CantonHash(PURPOSE.publicKeyFingerprint, publicKey));
}
/** The account's party id: the service's hint (`bridge`), then the key's fingerprint. */
export const partyOf = async (publicKey: Uint8Array): Promise<string> => `bridge::${await fingerprintOf(publicKey)}`;

/** The multi-hash (34 bytes) of base64 topology transactions: each hashed (purpose 11), the hashes sorted and joined, that hashed (purpose 55). Pinned by a real vector in fixtures.json. */
export async function topologyMultiHash(transactions: string[]): Promise<Uint8Array> {
  const hashes = await Promise.all(transactions.map((t) => computeSha256CantonHash(PURPOSE.topologyTransaction, fromBase64(t))));
  return computeSha256CantonHash(PURPOSE.multiTopologyTransaction, await computeMultiHashForTopology(hashes));
}

/** A new account is not made: the page cannot yet read what the participant's topology transactions say, so it cannot hold them to this key's onboarding, and it signs nothing it has not read.
 * The participant's transactions are Canton 3.7's (a versioned wrapper around a protocol-37 message), and the decoder of the pinned @canton-network packages is protocol 30's: its
 * PartyToParticipant keeps the party's signing keys in field 6 where the participant writes field 4, and it reads the hosting participant's field 3 as a message where the participant
 * writes a number. Until a decoder of the participant's own protocol version is pinned, an account that exists is found, and one that does not is refused. */
export class OnboardingNotChecked extends Error {
  constructor(why: string) { super(`A new Canton account is not made: ${why}`); this.name = "OnboardingNotChecked"; }
}
