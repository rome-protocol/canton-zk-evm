/** The methods that most transactions call, by the first 4 bytes of their input. */
const KNOWN: Record<string, string> = {
  "0xa9059cbb": "Transfer", "0x23b872dd": "Transfer from", "0x095ea7b3": "Approve", "0x40c10f19": "Mint", "0x42966c68": "Burn",
};

/**
 * What a transaction did, in a word. With no input it is a creation (no recipient), a transfer of coin (a value) or a plain call. With input it is the
 * token method that the first 4 bytes name, and any other method shows those bytes, because nothing here knows its name.
 */
export function methodOf(t: { methodId: string | null; to: string | null; created: string | null; value: string }): string {
  if (t.to === null || t.created !== null) return "Create";
  if (t.methodId === null) return BigInt(t.value) > 0n ? "Transfer" : "Call";
  return KNOWN[t.methodId] ?? t.methodId;
}
