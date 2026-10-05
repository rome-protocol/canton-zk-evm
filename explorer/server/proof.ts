import type { Pins } from "./config.ts";

/** A wrapped proof is four fields one after the other: the proof (768 bytes), the program key (32), the ZisK release root (32) and the public values (512). */
export const PROOF_BYTES = 1344;
const PROGRAM_AT = 768, ROOT_AT = 800, PUBLIC_AT = 832;

/** What a proof's own bytes say. Reading these is not verifying the proof: the confirmers did that when the block committed. */
export interface ProofFacts {
  programVK: string;
  rootC: string;
  /** Null when the public values do not have the one valid layout. */
  blockHash: string | null;
}

export interface FactCheck { value: string | null; ok: boolean }
export interface ProofCheck { programVK: FactCheck; rootC: FactCheck; blockHash: FactCheck }

const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

/**
 * The block hash the public values commit to, in the layout the sidecar accepts (sidecar/src/lib.rs, `committed_hash`): 64 slots of
 * 8 bytes, each a 4-byte word and 4 zero bytes; the words together are 0x20, the 32-byte hash, and zeros.
 */
function committedHash(publicValues: Uint8Array): string | null {
  const words = new Uint8Array(256);
  for (let slot = 0; slot < 64; slot++) {
    const s = publicValues.subarray(slot * 8, slot * 8 + 8);
    if (s.subarray(4).some((x) => x !== 0)) return null;
    words.set(s.subarray(0, 4), slot * 4);
  }
  return words[0] === 0x20 && words.subarray(33).every((x) => x === 0) ? hex(words.subarray(1, 33)) : null;
}

/** The facts in a proof, or null when it is not 1,344 bytes of lowercase hex (as a block record holds it). */
export function readProofFacts(proofHex: string): ProofFacts | null {
  if (proofHex.length !== PROOF_BYTES * 2 || !/^[0-9a-f]+$/.test(proofHex)) return null;
  const b = Uint8Array.from(Buffer.from(proofHex, "hex"));
  return { programVK: hex(b.subarray(PROGRAM_AT, ROOT_AT)), rootC: hex(b.subarray(ROOT_AT, PUBLIC_AT)), blockHash: committedHash(b.subarray(PUBLIC_AT)) };
}

/** Each fact next to whether it matches: the two keys against this explorer's pins, the hash against the block the record is for. */
export function checkProofFacts(facts: ProofFacts, pins: Pins, blockHash: string): ProofCheck {
  return {
    programVK: { value: facts.programVK, ok: facts.programVK === pins.programVK },
    rootC: { value: facts.rootC, ok: facts.rootC === pins.rootC },
    blockHash: { value: facts.blockHash, ok: facts.blockHash !== null && facts.blockHash === blockHash },
  };
}
