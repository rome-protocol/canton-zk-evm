import { methodNames } from "./abi-call.ts";
import { abiOrStandard, type AbiEntry } from "./abi.ts";

const standard = methodNames(abiOrStandard(null));

/**
 * What a transaction did, in a word. With no input it is a creation (no recipient), a transfer of coin (a value) or a plain call. With input it
 * is the function the first 4 bytes name in the contract's verified ABI, or in the standard ABI when there is none (lowercase, as the source
 * writes it: "transfer", "safeMint"), and any other method shows those bytes, because nothing here knows its name. "Transfer" is only a plain
 * send of coin, so that it is never taken for a token's `transfer`.
 */
export function methodOf(t: { methodId: string | null; to: string | null; created: string | null; value: string }, verified?: AbiEntry[] | null): string {
  if (t.to === null || t.created !== null) return "Create contract";
  if (t.methodId === null) return BigInt(t.value) > 0n ? "Transfer" : "Call";
  const id = t.methodId.toLowerCase();
  const names = verified && verified.length > 0 ? methodNames(verified) : standard;
  return names.get(id) ?? t.methodId;
}
