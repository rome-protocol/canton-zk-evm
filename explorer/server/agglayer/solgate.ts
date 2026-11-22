/**
 * A reader for Solgate's public API: its list of chains (is Ostia listed, what Hadrian is called and what coin it uses) and its list of tokens (which of them have an address on Ostia). It sends a GET to
 * two fixed paths and nothing else, checks every answer field by field, keeps an answer for half a minute, and never rejects: an answer that cannot be read is "unknown" (null).
 */
import { AGGKIT_USER_AGENT } from "./aggkit.ts";
import { cappedText } from "./capped.ts";

export const SOLGATE_PATHS = { chains: "/v1/chains", assets: "/v1/tokens" } as const;
export const SOLGATE_TIMEOUT_MS = 3000;
/** How long a good answer is kept, and a failed one (short, so Solgate coming back is seen soon). */
export const SOLGATE_CACHE_MS = 30_000;
export const SOLGATE_FAILED_MS = 5000;
const MAX_BYTES = 512 * 1024;

export interface SolgateChain { networkId: number; name: string; nativeSymbol: string; chainId: number | null }
export interface SolgateToken {
  symbol: string;
  name: string;
  decimals: number;
  /** The places the token has on Solana (Solgate's `splDecimals`), or its own decimals when Solgate gives none. */
  places: number;
  /** The token's address on each network that has one, lower case, by the network's id. */
  evm: Record<number, string>;
}
export interface SolgateView { chains: Map<number, SolgateChain>; assets: SolgateToken[] }
export interface SolgateReader { read(): Promise<SolgateView | null> }

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const whole = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const words = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max;

function chainsOf(body: unknown): Map<number, SolgateChain> {
  const list = record(body)?.chains;
  if (!Array.isArray(list) || list.length > 200) throw new Error("chains");
  const out = new Map<number, SolgateChain>();
  for (const v of list) {
    const c = record(v);
    if (!c || !whole(c.networkId, 2 ** 32 - 1) || !words(c.name, 80) || !words(c.nativeSymbol, 20)) continue;
    out.set(c.networkId, { networkId: c.networkId, name: c.name, nativeSymbol: c.nativeSymbol, chainId: whole(c.chainId) ? c.chainId : null });
  }
  return out;
}

function tokensOf(body: unknown): SolgateToken[] {
  const list = record(body)?.tokens;
  if (!Array.isArray(list) || list.length > 2000) throw new Error("tokens");
  const out: SolgateToken[] = [];
  for (const v of list) {
    const t = record(v);
    if (!t || typeof t.symbol !== "string" || !/^[A-Za-z0-9._-]{1,12}$/.test(t.symbol) || !words(t.name, 80) || !whole(t.decimals, 36)) continue;
    const evm: Record<number, string> = {};
    for (const [k, a] of Object.entries(record(t.evm) ?? {})) if (/^\d{1,10}$/.test(k) && Number(k) < 2 ** 32 && typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) evm[Number(k)] = a.toLowerCase();
    out.push({ symbol: t.symbol, name: t.name, decimals: t.decimals, places: whole(t.splDecimals, 36) ? t.splDecimals : t.decimals, evm });
  }
  return out;
}

export interface SolgateOptions { baseUrl: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => number }

export function createSolgateReader(opts: SolgateOptions): SolgateReader {
  const root = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? SOLGATE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let kept: { at: number; ttl: number; view: Promise<SolgateView | null> } | null = null;

  async function get(path: string): Promise<unknown> {
    const res = await doFetch(root + path, { headers: { accept: "application/json", "user-agent": AGGKIT_USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    return JSON.parse(await cappedText(res, MAX_BYTES, () => new Error("too long")));
  }

  return {
    read() {
      const t = now();
      if (kept && t - kept.at < kept.ttl) return kept.view;
      const entry = { at: t, ttl: SOLGATE_CACHE_MS, view: Promise.resolve<SolgateView | null>(null) };
      entry.view = Promise.all([get(SOLGATE_PATHS.chains), get(SOLGATE_PATHS.assets)])
        .then(([c, k]): SolgateView => ({ chains: chainsOf(c), assets: tokensOf(k) }))
        .catch(() => { entry.ttl = SOLGATE_FAILED_MS; return null; });
      kept = entry;
      return entry.view;
    },
  };
}
