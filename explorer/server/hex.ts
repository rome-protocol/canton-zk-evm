/**
 * Whether a string is whole bytes of hex. Not a regular expression with a group in a loop (`^(?:[0-9a-f]{2})*$`): V8 runs out of stack on that
 * one past about 4 MB of input (a RangeError, which would read as a crash, not as bad data), and reth's answers can be 32 MB. A class loop and
 * a check of the length have no such limit.
 */
const LOWER = /^[0-9a-f]*$/, ANY = /^[0-9a-fA-F]*$/;

export interface HexOptions {
  /** "0x" (default): the prefix is required; "optional"; "none": it is not allowed. */
  prefix?: "0x" | "optional" | "none";
  /** Accept A to F too (default: lower case only). */
  upper?: boolean;
  /** Accept no bytes at all (default: true). */
  empty?: boolean;
}

export function isHexBytes(s: string, { prefix = "0x", upper = false, empty = true }: HexOptions = {}): boolean {
  const has = s.startsWith("0x");
  if (prefix === "0x" && !has) return false;
  const body = has && prefix !== "none" ? s.slice(2) : s;
  return body.length % 2 === 0 && (empty || body.length > 0) && (upper ? ANY : LOWER).test(body);
}
