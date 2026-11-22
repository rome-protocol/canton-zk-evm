import { AmountError, normaliseAmount } from "../amounts.ts";

const TEXT = /^(\d{1,30})(?:\.(\d{1,30}))?$/;

/** An amount typed as a decimal ("0.002") in a token of `decimals`: its base units. Integer arithmetic only; a finer amount than the token has is refused, never rounded. */
export function parseBase(text: string, decimals: number): bigint {
  const m = TEXT.exec(normaliseAmount(text));
  if (!m) throw new AmountError("Type an amount such as 0.5 or 12.");
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) throw new AmountError(`This token has ${decimals} decimals: use at most ${decimals}.`);
  const base = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (base === 0n) throw new AmountError("The amount must be more than zero.");
  return base;
}
