import { formatCoin, formatPeriod, formatWait } from "./format.ts";
import type { FaucetInfo } from "./faucet-client.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The builder grant's settings, when it is on. */
export function builderOf(info: FaucetInfo | null | undefined) {
  const b = info?.builder;
  return b && b.on && b.amount ? { ...b, amount: b.amount } : null;
}

/** Where "Sign in with GitHub" goes: the explorer sends the person to GitHub, and GitHub back to the Faucet page with the result. */
export const builderStartPath = (address: string) => `/api/faucet/github/start?address=${encodeURIComponent(address.toLowerCase())}`;

/** A period in whole days when it is, else as the faucet words it: 7 days, 1 day, 36 hours. */
export function formatDays(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? "1 day" : `${seconds / 86400} days`;
  return formatPeriod(seconds);
}

/**
 * The offer: "Building on Ostia? Sign in with GitHub for 100 tROME." It shows only when the builder grant is on. It names the address it is for, because the
 * sign-in sends the coins there: the connected wallet's, or the one typed on the Faucet page. With no good address yet the words are there, and the link waits for one.
 */
export function BuilderGrant({ info, address, coin }: { info: FaucetInfo | null | undefined; address: string | null; coin: { symbol: string; decimals: number } }) {
  const b = builderOf(info);
  if (!b) return null;
  const amount = `${formatCoin(b.amount, coin.decimals)} ${coin.symbol}`;
  const ready = address !== null && ADDRESS.test(address.trim());
  return (
    <p className="small builder-grant">
      Building on Ostia? {ready ? <a href={builderStartPath(address!.trim())}>Sign in with GitHub</a> : <span className="muted" title="Enter your address first">Sign in with GitHub</span>} for {amount}.
      {!ready && <span className="muted"> Enter your address first.</span>}
    </p>
  );
}

export type BuilderCode =
  | "queued" | "young" | "account" | "address" | "day" | "ip" | "hour" | "queue" | "empty" | "state" | "denied" | "github" | "busy" | "bad" | "off" | "origin" | "problem";
const CODES: readonly string[] = ["queued", "young", "account", "address", "day", "ip", "hour", "queue", "empty", "state", "denied", "github", "busy", "bad", "off", "origin", "problem"];

/** What the Faucet page was sent back with: `?builder=<code>` and, with it, a ticket, a wait in seconds or a number of days. Anything else is not a result. */
export interface BuilderResult { code: BuilderCode; ticket: string | null; wait: number | null; days: number | null }

export function readBuilderResult(search: string): BuilderResult | null {
  const q = new URLSearchParams(search);
  const code = q.get("builder");
  if (!code || !CODES.includes(code)) return null;
  const ticket = q.get("ticket"), wait = q.get("wait"), days = q.get("days");
  return {
    code: code as BuilderCode,
    ticket: ticket && /^[0-9a-f]{24}$/.test(ticket) ? ticket : null,
    wait: wait && /^\d{1,9}$/.test(wait) ? Number(wait) : null,
    days: days && /^\d{1,4}$/.test(days) ? Number(days) : null,
  };
}

/** The result in plain words, and whether it is good news, a wait, or a problem. Nothing is claimed that the faucet did not say. */
export function builderWords(r: BuilderResult, info: FaucetInfo | null, coin: { symbol: string; decimals: number }): { tone: "ok" | "wait" | "bad"; text: string } {
  const b = info?.builder;
  const period = b?.perAccountSeconds ? formatDays(b.perAccountSeconds) : "few days";
  // A wait of days is said in days, rounded up so that nobody is told to try before the faucet will answer.
  const again = r.wait !== null ? ` Try again in ${r.wait >= 2 * 86400 ? `${Math.ceil(r.wait / 86400)} days` : formatWait(r.wait)}.` : " Try again later.";
  const amount = b?.amount ? `${formatCoin(b.amount, coin.decimals)} ${coin.symbol}` : `${coin.symbol}`;
  switch (r.code) {
    case "queued": return { tone: "ok", text: `Signed in. Your builder grant of ${amount} is queued.` };
    case "young": return { tone: "bad", text: `That GitHub account is less than ${r.days ?? b?.minAccountAgeDays ?? 30} days old, so it does not get a builder grant. The plain faucet above is open to anyone.` };
    case "account": return { tone: "wait", text: `This GitHub account was given a builder grant in the last ${period}.${again}` };
    case "address": return { tone: "wait", text: `This address was given a builder grant in the last ${period}.${again}` };
    case "day": return { tone: "wait", text: `Today's builder grants are all given out.${r.wait !== null ? again : " Try again tomorrow."}` };
    case "ip": return { tone: "wait", text: `This connection asked for coins a moment ago.${again}` };
    case "hour": return { tone: "wait", text: `The faucet has given out all it gives in an hour.${again}` };
    case "queue": return { tone: "wait", text: `The faucet's line is full, so this was turned away, not lost: nothing was taken from you.${again}` };
    case "empty": return { tone: "bad", text: "The faucet is empty right now, so nothing was sent." };
    case "state": return { tone: "bad", text: "That sign-in ran out or was already used, so nothing was sent. Start it again." };
    case "denied": return { tone: "bad", text: "You did not allow the sign-in on GitHub, so nothing was sent." };
    case "github": return { tone: "bad", text: "GitHub could not be read just now, so nothing was sent. Try again in a moment." };
    case "busy": return { tone: "wait", text: `Many people are signing in at this moment.${again}` };
    case "bad": return { tone: "bad", text: "That is not an address. An address is 0x and 40 hex digits." };
    case "off": return { tone: "bad", text: "The builder grant is off on this explorer." };
    case "origin": return { tone: "bad", text: "That sign-in was started from another site, so nothing was sent. To get a builder grant, start it from this page." };
    case "problem": return { tone: "bad", text: "The sign-in did not finish, and nothing was taken from you. Try again in a moment." };
  }
}
