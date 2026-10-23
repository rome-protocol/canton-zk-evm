import { clientKey } from "./public-rpc.ts";

/**
 * The rate limits of the public routes (design 6.6). Every limit is per client: the connection's address, or the address in the trusted header behind our
 * own proxy, and an IPv6 client counts as its whole /64 (`clientKey`, the same grouping the public RPC and the live streams use). There are no API keys.
 * `/rpc` has its own token bucket (public-rpc.ts), the live streams their own count (rest/stream.ts), and the faucet its own limits; this file holds the rest.
 */

/** One bucket: it holds `capacity` tokens and refills at `perSecond` tokens a second. */
export interface Bucket { capacity: number; perSecond: number }

/** The rules, each a list of buckets that must all have a token. */
export const RULES = {
  /** REST for the pages: 20 a second, bursts of 60. */
  rest: [{ capacity: 60, perSecond: 20 }],
  /** Etherscan's `/api`: 10 a second and 600 a minute. */
  etherscan: [{ capacity: 10, perSecond: 10 }, { capacity: 600, perSecond: 10 }],
  /** Contract verification: 30 an hour. */
  verification: [{ capacity: 30, perSecond: 30 / 3600 }],
} as const satisfies Record<string, readonly Bucket[]>;

/** The biggest source a verification request may carry (the queue checks the decoded source against it). */
export const MAX_VERIFY_SOURCE = 500 * 1024;
/**
 * The biggest raw body of a verification request. A form encodes the source (each byte that is not a letter, a digit or one of `-._~` becomes `%XX`, three bytes; Solidity grows
 * about 1.3 times), so the body is read up to three times the source, and the other fields' room; the source's own 500 KB is checked after decoding.
 */
export const MAX_VERIFY_BODY = 3 * MAX_VERIFY_SOURCE + 64 * 1024;

/** How many clients a limiter remembers. A client that has been quiet long enough to hold a full bucket is forgotten first. */
const MAX_CLIENTS = 10_000;

export interface Limiter {
  /** Takes one token from each of the client's buckets, or none of them. Returns null when it took them, else the seconds to wait before one is there. */
  take(address: string): number | null;
}

export function createLimiter(buckets: readonly Bucket[], now: () => number = Date.now): Limiter {
  const clients = new Map<string, { tokens: number[]; at: number }>();
  const refilled = (c: { tokens: number[]; at: number }, t: number) =>
    buckets.map((b, i) => Math.min(b.capacity, c.tokens[i]! + ((t - c.at) / 1000) * b.perSecond));
  return {
    take(address) {
      const key = clientKey(address), t = now();
      const had = clients.get(key);
      const tokens = had ? refilled(had, t) : buckets.map((b) => b.capacity);
      clients.delete(key);
      const state = { tokens, at: t };
      clients.set(key, state); // the newest at the end
      if (clients.size > MAX_CLIENTS) {
        // Never the client in hand: a deleted bucket would give it a free request and a fresh bucket.
        for (const [k, v] of clients) if (k !== key && refilled(v, t).every((x, i) => x >= buckets[i]!.capacity)) clients.delete(k);
        // Still over: the longest quiet go, a tenth at a time, so a flood of new addresses does not pay for a sweep on every request.
        for (const k of clients.keys()) { if (clients.size <= MAX_CLIENTS * 0.9) break; if (k !== key) clients.delete(k); }
      }
      const short = tokens.map((x, i) => (x >= 1 ? 0 : (1 - x) / buckets[i]!.perSecond));
      const wait = Math.max(...short);
      if (wait > 0) return Math.max(1, Math.ceil(wait));
      for (let i = 0; i < tokens.length; i++) tokens[i]! -= 1;
      return null;
    },
  };
}

export interface Limits { rest: Limiter; etherscan: Limiter; verification: Limiter }

export function createLimits(now: () => number = Date.now): Limits {
  return { rest: createLimiter(RULES.rest, now), etherscan: createLimiter(RULES.etherscan, now), verification: createLimiter(RULES.verification, now) };
}

/** The answers of 6.6. A client that is refused is told how long to wait, in whole seconds. */
export const retryAfter = (seconds: number): Record<string, string> => ({ "retry-after": String(seconds) });
export const REST_REFUSED = (seconds: number): string => `Too many requests. Try again in ${seconds} s.`;
/** Etherscan's own answer to a client over its rate: `status` "0", HTTP 200. */
export const ETHERSCAN_REFUSED = { status: "0", message: "NOTOK", result: "Max rate limit reached" } as const;
export const verificationRefused = (seconds: number) => ({ status: "0", message: "NOTOK", result: `Verification limit reached: 30 requests an hour for each client. Try again in ${seconds} s.` });
export const verificationTooBig = () => ({ status: "0", message: "NOTOK", result: `The request is too big: the source of a verification request is at most ${MAX_VERIFY_SOURCE / 1024} KB.` });

/** What an Etherscan proxy request may weigh: the public RPC's own body limit (a contract creation sent with ethers goes by POST). */
export const MAX_PROXY_BODY = 256 * 1024;
/** The JSON-RPC answer to a proxy request over that limit, in the shape ethers reads. */
export const proxyTooBig = () => ({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `The request is too big: a proxy request is at most ${MAX_PROXY_BODY / 1024} KB.` } });

/** True when an Etherscan request is for the proxy module (the module may be in the query or in the form body). */
export function isProxy(query: URLSearchParams, body: string | undefined): boolean {
  const mod = (q: URLSearchParams) => (q.get("module") ?? "").toLowerCase();
  if (mod(query) === "proxy") return true;
  if (!body) return false;
  try { return mod(new URLSearchParams(body)) === "proxy"; } catch { return false; }
}

/** True when an Etherscan request asks to verify a contract (the action may be in the query or in the form body). */
export function isVerification(query: URLSearchParams, body: string | undefined): boolean {
  const names = new Set(["verifysourcecode", "verifyproxycontract"]);
  const action = (q: URLSearchParams) => (q.get("action") ?? "").toLowerCase();
  if (names.has(action(query))) return true;
  if (!body) return false;
  try { return names.has(action(new URLSearchParams(body))); } catch { return false; }
}
