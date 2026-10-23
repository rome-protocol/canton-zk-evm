import { methodNames } from "./abi-call.ts";
import { abiOrStandard, type AbiEntry } from "./abi.ts";

const standard = methodNames(abiOrStandard(null));
// One keccak per function of an ABI, once per ABI, not once per row of every render.
const verifiedNames = new WeakMap<AbiEntry[], Map<string, string>>();
const namesOf = (abi: AbiEntry[]) => {
  let m = verifiedNames.get(abi);
  if (!m) verifiedNames.set(abi, (m = methodNames(abi)));
  return m;
};

/**
 * What a transaction did, in a word. With no input it is a creation (no recipient), a transfer of coin (a value) or a plain call. With input it
 * is the function the first 4 bytes name in the contract's verified ABI, or else in the standard ABI (lowercase, as the source
 * writes it: "transfer", "safeMint"), and any other method shows those bytes, because nothing here knows its name. "Transfer" is only a plain
 * send of coin, so that it is never taken for a token's `transfer`.
 */
export function methodOf(t: { methodId: string | null; to: string | null; created: string | null; value: string }, verified?: AbiEntry[] | null): string {
  if (t.to === null || t.created !== null) return "Create contract";
  if (t.methodId === null) return BigInt(t.value) > 0n ? "Transfer" : "Call";
  const id = t.methodId.toLowerCase();
  return (verified && verified.length > 0 ? namesOf(verified).get(id) : undefined) ?? standard.get(id) ?? t.methodId;
}
