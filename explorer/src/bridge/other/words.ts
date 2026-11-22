// What the "Other chains" page says. Plain words; "Claim" for the person's own claim step, never "Receive"; never "pending" and never that Rome acts after the person's own transaction. The trust
// lines are the ones the design allows, each only where it applies.
import { SEPOLIA_TX_URL } from "../../copy.ts";
import { GENERIC, plainWords } from "../words.ts";
import type { Range } from "./setup.ts";

/** Under the card, where ETH is sent to Ostia or comes back. */
export const TRUST_ETH = "ETH you send to Ostia stays locked on Ethereum Sepolia, and Ostia cannot send out more of it than came in. While it is on Ostia as WETH, it rests on Rome's keys for the bridge.";
export const TRUST_ALWAYS = "Test tokens only. Ostia has not been independently audited.";
/** Said before the wallet's pop-up on Ethereum Sepolia. */
export const BRING_YOUR_OWN = "Bring your own Sepolia ETH: the amount and the fee are paid from your wallet on Ethereum Sepolia. Get a little from a Sepolia faucet you choose.";
/** Under the Send button: what the person needs on each chain, in the coin of each. `claimName` is the chain of the claim. */
export const feesNote = (dir: "in" | "out", ostiaCoin: string, otherCoin: string, claimName: string) =>
  dir === "in" ? `You need a little ${otherCoin} for fees, and a little ${ostiaCoin} to claim.` : `You need a little ${ostiaCoin} to send, and a little ${otherCoin} to claim on ${claimName}.`;
export const LEAVE_NOTE = "You can leave this page. This transfer stays in Activity.";
export const ACTIVITY_NOTE = "Activity lists the transfers started in this browser.";
export const NOT_YET_OPEN = "Not yet open";

/** The route is not available: nothing is guessed about why. */
export const notAvailable = (name: string) => `${name} is not available right now. Nothing is lost.`;

/** The coin a person pays fees in on a chain of the list. */
export const feeCoin = (route: { id: string }, ostiaCoin: string, side: "ostia" | "other") => (side === "ostia" ? ostiaCoin : route.id === "sepolia" ? "Sepolia ETH" : "ETH");

/** "about 8 to 16 minutes", from a measured range; null when none is set (the page then shows no time). */
export function timeWords(r: Range | null): string | null {
  if (!r) return null;
  const minutes = (s: number) => Math.max(1, Math.round(s / 60));
  if (r.maxSeconds <= 45) return r.minSeconds === r.maxSeconds ? `about ${r.maxSeconds} seconds` : `about ${Math.max(1, Math.round(r.minSeconds))} to ${Math.round(r.maxSeconds)} seconds`;
  const lo = minutes(r.minSeconds), hi = minutes(r.maxSeconds);
  return lo === hi ? `about ${hi} ${hi === 1 ? "minute" : "minutes"}` : `about ${lo} to ${hi} minutes`;
}
/** "4 min of about 16": how long it has been, against the longest measured; null when none is set. */
export function elapsedWords(r: Range | null, seconds: number): string | null {
  if (!r || r.maxSeconds <= 45) return null;
  return `${Math.max(0, Math.floor(seconds / 60))} min of about ${Math.round(r.maxSeconds / 60)}`;
}
/** A time of the day in UTC, "21:44 UTC". */
export const clock = (iso: string | number): string => new Date(iso).toISOString().slice(11, 16) + " UTC";

/** What a look for a step the wallet did not answer says. Only what the look shows: the wallet's count of its transactions has not moved since the step was written, so nothing has been sent from it since; it does not show that no pop-up is still open. */
export const notSentWords = (again: "send" | "claim") => `Nothing has been sent from your wallet since this was started. Check your wallet: if it still has this request open, turn it down, then ${again} again.`;
/** The count has moved: something was sent from the wallet since the step was written, which may or may not be this step. */
export const movedWords = (name: string) => `Your wallet has sent something since this was started. It may be this. Find it in your wallet's activity on ${name}, then paste its transaction hash below.`;
/** The wallet gave no count, or the record has none to compare it with: nothing is known. */
export const noCountWords = (name: string) => `Your wallet does not say what it sent. Find it in its activity on ${name} and paste its hash, or give this up.`;

/** Where a transaction on another chain is shown, for a chain the page knows by its chain id (Ethereum Sepolia); null for any other. */
export function otherTxUrl(chainId: number, hash: string): string | null {
  return chainId === 11155111 && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${SEPOLIA_TX_URL}${hash}` : null;
}

/** What a failed step says, in words. `name` is the chain the step was on. */
export function otherWords(e: unknown, name: string, coin: string): string {
  const x = e as { name?: unknown; code?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown } | null | undefined;
  if (x && x.name === "Stop" && typeof x.message === "string") return x.message;
  if (x && x.name === "Unsure") return "Your wallet did not say whether it sent this. Look in its activity on " + name + ". Nothing more is sent until you have.";
  const inner = x?.cause as { name?: unknown; message?: unknown } | undefined;
  if (inner?.name === "Stop" && typeof inner.message === "string") return inner.message;   // refused before the wallet was asked, with words of its own
  const text = [x?.message, x?.shortMessage, (x?.cause as { message?: unknown } | undefined)?.message].filter((m): m is string => typeof m === "string").join(" ");
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(text)) return `You do not have enough ${coin} on ${name} for this amount and the fee. Get some, then try again.`;
  if (/execution reverted|revert/i.test(text)) return `${name} would not take this. Nothing was sent.`;
  return plainWords(e) === GENERIC && x?.code !== undefined && x.code !== 4001 ? GENERIC : plainWords(e);
}
