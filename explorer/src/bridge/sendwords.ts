// The words and the checks of the account panel's "Send on Canton" form: addresses, the confirm line and the amount. Nothing here signs or reads the network, so the page loads it at once;
// the part that signs is send.ts, which the page loads when the account is open.
import { AmountError, parseAmount, showUnits } from "./amounts.ts";
import type { Pair } from "./tokens.ts";

/** What a Canton address looks like: a name, `::`, then `1220` and 64 lowercase hex digits (a key's fingerprint). */
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}::1220[0-9a-f]{64}$/;

/** The receiver the person typed, as the address to send to. Words for the person when it is not one, or is the account's own. */
export function checkReceiver(text: string, own: string): string {
  const address = text.trim();
  if (address === "") throw new AmountError("Type the address of the receiver on Canton.");
  if (!ADDRESS.test(address)) throw new AmountError("This is not a Canton address. It looks like name::1220 followed by 64 letters and digits.");
  if (address === own) throw new AmountError("This is your own address. Type the address of someone else.");
  return address;
}

/** An address for a sentence: its name and the start of its key's fingerprint, and the last four characters (rome::1220…ab12). */
export const shortAddress = (address: string): string => {
  const at = address.indexOf("::1220");
  const lead = at < 0 ? 12 : at + 6;
  return address.length <= lead + 5 ? address : `${address.slice(0, lead)}…${address.slice(-4)}`;
};

/** The line the person confirms before anything is signed. */
export const confirmLine = (amount: string, symbol: string, receiver: string): string => `Send ${amount} ${symbol} to ${shortAddress(receiver)} on Canton`;

/** The amount as the person typed it, tidied for a sentence ("5", "1.5"): no leading point, no trailing zeros, nothing rounded. */
export const tidyAmount = (text: string, decimals: number): string => showUnits(parseAmount(text, decimals).twin, 10);

/** The send form's amount, held to the card's own rules and to what the account holds on Canton (`held`, null while not known). Words for the person when it is not good. */
export function checkAmount(text: string, pair: Pair, held: bigint | null): bigint {
  const { twin } = parseAmount(text, pair.ostia.decimals);
  if (held !== null && twin > held) throw new AmountError("You do not hold that much on Canton.");
  return twin;
}

