import type { HealthRow } from "./indexer/health.ts";

/** A shared ceiling of the account service this full counts as degraded. */
export const ACCOUNTS_DEGRADED_AT = 0.6;
/** And this full counts as failed (`down` for the row; the explorer's own answer stays up, see `advisory` in health.ts). */
export const ACCOUNTS_DOWN_AT = 0.9;
/** A read of the account service that has not answered in this long counts as failed. */
export const ACCOUNTS_TIMEOUT_MS = 2000;

/** One shared ceiling as the account service's `/healthz` reports it: what is counted now and what it allows. */
export interface Ceiling { used: number; limit: number }
/** What the account service says of how full its limits are: the accounts it holds against the participant's cap, and each ceiling that many clients share. */
export interface AccountsUsage { accounts: number; accountCap: number; ceilings: Record<string, Ceiling> }

/** How each ceiling reads in a sentence. A name the service adds later is shown by its own name. */
const WORDS: Record<string, string> = {
  accounts: "accounts held against the participant's cap",
  newAccountsDay: "new accounts opened today",
  executesDay: "transactions today",
  trafficDay: "traffic today",
  takeBacksDay: "take-backs and accepts today",
  publicRelayMinute: "public registry requests this minute",
  waitingTopologies: "account set-ups waiting for a signature",
  waitingTransactions: "transactions waiting for a signature",
  faucetDay: "faucet grants today",
};

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** The usage in a `/healthz` answer, or null when the answer does not carry it (an older service, or something else). */
export function usageOf(body: unknown): AccountsUsage | null {
  const b = body as { accounts?: unknown; accountCap?: unknown; ceilings?: unknown } | null;
  if (!b || typeof b !== "object" || !finite(b.accounts) || !finite(b.accountCap) || b.accountCap < 1) return null;
  if (!b.ceilings || typeof b.ceilings !== "object" || Array.isArray(b.ceilings)) return null;
  const ceilings: Record<string, Ceiling> = {};
  for (const [name, c] of Object.entries(b.ceilings as Record<string, unknown>)) {
    const x = c as { used?: unknown; limit?: unknown } | null;
    if (!x || !finite(x.used) || !finite(x.limit) || x.limit < 1) return null;
    ceilings[name] = { used: x.used, limit: x.limit };
  }
  return { accounts: b.accounts, accountCap: b.accountCap, ceilings };
}

/** Reads `<url>` (the account service's `/healthz`, on this machine) and gives its usage; throws what went wrong, in words. Never sends anything but the GET. */
export async function readUsage(url: string, doFetch: typeof fetch = (...a) => fetch(...a), timeoutMs = ACCOUNTS_TIMEOUT_MS): Promise<{ ok: boolean; usage: AccountsUsage }> {
  const res = await doFetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`the account service answered HTTP ${res.status}`);
  const body = (await res.json()) as { ok?: unknown };
  const usage = usageOf(body);
  if (!usage) throw new Error("the account service did not report its limits");
  return { ok: body.ok === true, usage };
}

const pct = (u: number, l: number) => Math.round((u / l) * 100);

/**
 * The `accounts` health row: every shared ceiling, and the accounts held against the participant's cap, each as a share of what it allows. The worst one gives the word: degraded from 60%,
 * down from 90%. The detail names each one over 60% in a sentence. A service that cannot be read, or that says it is not ok, is degraded: it is down for the `accounts_down` alert, not here.
 */
export function accountsRow(read: { ok: boolean; usage: AccountsUsage } | { error: string }): HealthRow {
  const threshold = { degradedAt: ACCOUNTS_DEGRADED_AT, downAt: ACCOUNTS_DOWN_AT };
  if ("error" in read) return { id: "accounts", status: "degraded", value: null, threshold, detail: `the account service's limits cannot be read: ${read.error}`.slice(0, 300) };
  const { usage } = read;
  const all: Record<string, Ceiling> = { accounts: { used: usage.accounts, limit: usage.accountCap }, ...usage.ceilings };
  const shares = Object.entries(all).map(([name, c]) => ({ name, ...c, share: c.used / c.limit }));
  const worst = Math.max(...shares.map((s) => s.share));
  const status = worst >= ACCOUNTS_DOWN_AT ? "down" : worst >= ACCOUNTS_DEGRADED_AT ? "degraded" : "ok";
  const over = shares.filter((s) => s.share >= ACCOUNTS_DEGRADED_AT).sort((a, b) => b.share - a.share);
  return {
    id: "accounts", status,
    value: { accounts: usage.accounts, accountCap: usage.accountCap, ceilings: Object.fromEntries(shares.map((s) => [s.name, { used: s.used, limit: s.limit, percent: pct(s.used, s.limit) }])) },
    threshold,
    detail: over.length ? over.map((s) => `${WORDS[s.name] ?? s.name}: ${s.used} of ${s.limit} (${pct(s.used, s.limit)}%)`).join("; ") : null,
  };
}
