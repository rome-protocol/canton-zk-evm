// What the move from Canton to Ethereum Sepolia says. "Claim" for the person's own claim, never "Receive"; never "pending" and never that Rome acts after the person's own transaction; no builder words;
// "the cost on Ostia", never "gas". Numbers and times come from the setup: none is fixed here.
import { showUnits } from "../amounts.ts";
import type { RouteAsset } from "./setup.ts";

export const ROUTE_NAME = "Canton to Ethereum Sepolia";
export const DEST = "Ethereum Sepolia";
export const LEAVE_MOVE = "You can leave this page. This move stays in Activity.";
export const CLAIM_NOTE = "Your wallet switches to Ethereum Sepolia. Its fee is paid in Sepolia ETH.";
export const READY_NOTE = "Ready to claim on Ethereum Sepolia. You can claim it now with your wallet.";
export const START_NOTE = "A move from Canton starts in your Canton wallet. Moves started there show here, found by your wallet's address.";
export const TRUST = (a: Pick<RouteAsset, "name">) => `The copy of ${a.name} on Ethereum rests on the coin Rome holds on Canton and on Rome's key that signs what leaves Ostia. AggLayer's balance check does not cover it.`;

/** An amount with all its decimals, as the fee and the amount you get are shown ("0.2000000000"). */
export const exact = (base: bigint, decimals: number): string => {
  const unit = 10n ** BigInt(decimals);
  return decimals === 0 ? base.toString() : `${base / unit}.${(base % unit).toString().padStart(decimals, "0")}`;
};

/** The line about the cap, from the book's `lockCap` and `lockRoom`; null while the whole cap is free. */
export function capWords(a: RouteAsset): string | null {
  const n = (v: bigint) => showUnits(v, a.decimals);
  const head = `Up to ${n(a.lockCap)} ${a.symbol} of ${a.name} can be on AggLayer chains at once for now`;
  if (a.lockRoom === 0n) return `${head}, and that is reached. You can send again when some comes back to Canton.`;
  return a.lockRoom < a.lockCap ? `${head}. ${n(a.lockCap - a.lockRoom)} ${a.symbol} is out, so you can send up to ${n(a.lockRoom)} ${a.symbol}.` : null;
}
/** The same line for an amount over the cap, which says the cap even while none is out. */
export const overCapWords = (a: RouteAsset): string => capWords(a) ?? `Up to ${showUnits(a.lockCap, a.decimals)} ${a.symbol} of ${a.name} can be on AggLayer chains at once for now.`;
export const minimumWords = (a: RouteAsset, least: bigint) => `The smallest amount for this route is ${showUnits(least, a.decimals)} ${a.symbol}.`;
export const notTakenWords = (by: string, amount: string) => `Not taken yet. If it is not taken by ${by}, your ${amount} is free again in your Canton account.`;
export const lapsedWords = (amount: string) => `Not moved. Your ${amount} is free again in your Canton account.`;
