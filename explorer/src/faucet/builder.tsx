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

/** GitHub's mark (Octicons "mark-github", MIT licence), inlined: no image request and no dependency. */
const MARK =
  "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z";

function GitHubMark() {
  return (
    <svg className="gh-mark" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false">
      <path fill="currentColor" d={MARK} />
    </svg>
  );
}

/**
 * The offer: "Building on Ostia? Get 100 tROME." and a "Sign in with GitHub" button carrying GitHub's mark. It shows only when the builder grant is on. It names the
 * address it is for, because the sign-in sends the coins there: the connected wallet's, or the one typed on the Faucet page. With no good address yet the button is
 * there but off, with "Enter your address first."; with one it is an ordinary link, so the browser makes a top-level navigation from our page to the start path.
 */
export function BuilderGrant({ info, address, coin }: { info: FaucetInfo | null | undefined; address: string | null; coin: { symbol: string; decimals: number } }) {
  const b = builderOf(info);
  if (!b) return null;
  const amount = `${formatCoin(b.amount, coin.decimals)} ${coin.symbol}`;
  const ready = address !== null && ADDRESS.test(address.trim());
  return (
    <div className="builder-grant">
      <p className="small builder-line">Building on Ostia? Get {amount}.</p>
      {ready ? (
        <a className="gh-btn" href={builderStartPath(address!.trim())}>
          <GitHubMark />
          <span>Sign in with GitHub</span>
        </a>
      ) : (
        <>
          <button type="button" className="gh-btn" disabled aria-describedby="builder-hint">
            <GitHubMark />
            <span>Sign in with GitHub</span>
          </button>
          <p className="small muted builder-hint" id="builder-hint">Enter your address first.</p>
        </>
      )}
    </div>
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
