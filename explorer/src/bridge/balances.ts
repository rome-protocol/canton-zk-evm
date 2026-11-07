import type { Holding } from "./canton/accounts.ts";

const TEN = 10n ** 10n;
/** A Canton amount ("1.5") in Canton's smallest unit (10 decimals). */
export function cantonUnits(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole || "0") * TEN + BigInt(fraction.padEnd(10, "0").slice(0, 10) || "0");
}

/** What the unlocked holdings of one instrument add up to, in Canton's smallest unit. */
export function holdingsOf(held: Holding[], instrument: { admin: string; id: string }): bigint {
  return held.filter((h) => !h.locked && h.instrumentId.admin === instrument.admin && h.instrumentId.id === instrument.id).reduce((sum, h) => sum + cantonUnits(h.amount), 0n);
}
