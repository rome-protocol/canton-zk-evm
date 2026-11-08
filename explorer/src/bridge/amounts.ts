/** Canton, the twins and the wrapped tokens count in 10 decimals. */
export const CANTON_DECIMALS = 10;

/** A Canton amount (10 decimals, as `twin` below) as the exact text Canton takes: always ten decimals, e.g. "1.5000000000". */
export const tenDecimals = (twin: bigint): string => `${twin / 10n ** 10n}.${(twin % 10n ** 10n).toString().padStart(10, "0")}`;

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

/** A base-unit amount as the exact decimal text, with no trailing zeros: 20000000000000000000n of 18 decimals is "20", 1500000n of 6 is "1.5". Nothing is rounded. */
export function showUnits(base: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (base % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? (base / unit).toString() : `${base / unit}.${fraction}`;
}

/** The most decimals a balance is shown with. */
export const BALANCE_DECIMALS = 6;

/**
 * A balance for the screen: at most 6 decimals, cut down (never up, so never more than is there), the whole part never cut, no trailing zeros. A balance too small for 6 decimals reads "<0.000001".
 * Max does not use this: it fills in the exact amount (maxText).
 */
export function showBalance(base: bigint, decimals: number): string {
  if (decimals <= BALANCE_DECIMALS) return showUnits(base, decimals);
  const cut = base - (base % 10n ** BigInt(decimals - BALANCE_DECIMALS));
  return cut === 0n && base > 0n ? `<0.${"0".repeat(BALANCE_DECIMALS - 1)}1` : showUnits(cut, decimals);
}

/** The most of `base` the bridge moves, as text to type into the amount: cut down (never up) to the finest step it moves (10 decimals). Empty when there is none. */
export function maxText(base: bigint, decimals: number): string {
  const step = decimals > CANTON_DECIMALS ? 10n ** BigInt(decimals - CANTON_DECIMALS) : 1n;
  const cut = base - (base % step);
  return cut <= 0n ? "" : showUnits(cut, decimals);
}
