// What a move out costs and whether the book takes it, worked out before the wallet is asked, from the setup alone (the book's own rules: `claimAndBridge` in the router). A move that would be refused is
// never offered for signing. The fee shown is the fee finally taken, so the `maxFee` the page writes in the label is that same number.
import { zeroAddress } from "viem";
import { AmountError } from "../amounts.ts";
import { parseBase } from "../other/amount.ts";
import type { RouteAsset } from "./setup.ts";
import { DEST, minimumWords, overCapWords } from "./words.ts";

export interface Quote { fee: bigint; send: bigint }
/** What a move of `amount` pays and sends: the fee is the book's fee for the asset and the destination, and what is sent is cut down to a multiple of the destination's unit, the cut going to the fee. Null when nothing is left. */
export function quote(a: RouteAsset, unit: bigint, amount: bigint): Quote | null {
  const fee0 = a.feeOut + a.claimFee;
  if (amount <= fee0) return null;
  const send = ((amount - fee0) / unit) * unit;
  return send === 0n ? null : { fee: amount - send, send };
}

export type Checked = { state: "empty" } | { state: "bad"; why: string } | { state: "ok"; amount: bigint; quote: Quote };

/** The amount typed, against the asset's rules in the order the design gives them: it reads, it is at least the minimum with something left after the fee, and what is sent fits the room under the cap. */
export function checkAmount(a: RouteAsset, unit: bigint, text: string): Checked {
  if (text.trim() === "") return { state: "empty" };
  let amount: bigint;
  try { amount = parseBase(text, a.decimals); } catch (e) { return { state: "bad", why: e instanceof AmountError ? e.message : "Type an amount such as 12 or 12.5." }; }
  const least = [a.minAmount, a.feeOut + a.claimFee + unit].reduce((x, y) => (x > y ? x : y));
  const q = amount >= a.minAmount ? quote(a, unit, amount) : null;
  if (!q) return { state: "bad", why: minimumWords(a, least) };
  if (q.send > a.lockRoom) return { state: "bad", why: overCapWords(a) };
  return { state: "ok", amount, quote: q };
}

/** The address on Ethereum Sepolia: 0x and 40 hex digits, never the zero address. */
export function checkAddress(text: string): string | null {
  const t = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return `Type an address on ${DEST}: 0x and 40 letters and digits.`;
  return t.toLowerCase() === zeroAddress ? "The zero address cannot take a move. Use an address of your own." : null;
}
