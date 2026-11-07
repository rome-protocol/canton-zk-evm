/** Canton, the twins and the wrapped tokens count in 10 decimals. */
export const CANTON_DECIMALS = 10;

/** An amount the bridge will not take, in words for the person. */
export class AmountError extends Error {}

const TEXT = /^(\d{1,30})(?:\.(\d{1,30}))?$/;

/**
 * An amount typed as a decimal ("12", "12.5") in a token of `decimals`: its base units on Ostia, and the same amount in Canton's 10 decimals.
 * Integer arithmetic only. A token with more than 10 decimals moves in steps of 10^(decimals-10) (10^8 for 18 decimals): a finer amount is refused, never rounded.
 */
export function parseAmount(text: string, decimals: number): { base: bigint; twin: bigint } {
  const m = TEXT.exec(text.trim());
  if (!m) throw new AmountError("Type an amount such as 12 or 12.5.");
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  const finest = Math.min(decimals, CANTON_DECIMALS);
  if (fraction.length > finest) throw new AmountError(`This amount is finer than the bridge moves: use at most ${finest} decimals.`);
  const base = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (base === 0n) throw new AmountError("The amount must be more than zero.");
  const twin = decimals >= CANTON_DECIMALS ? base / 10n ** BigInt(decimals - CANTON_DECIMALS) : base * 10n ** BigInt(CANTON_DECIMALS - decimals);
  return { base, twin };
}
