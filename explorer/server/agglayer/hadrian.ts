/**
 * A reader of Hadrian's public endpoint: it asks `eth_chainId` and nothing else, and says whether the chain that answers is the one the settings name. A refusal, a timeout, a long answer or
 * another chain is "not reachable"; it never rejects. The answer is kept for 10 s, a failed one for 3 s.
 */
import { AGGKIT_USER_AGENT } from "./aggkit.ts";
import { cappedText } from "./capped.ts";

export const HADRIAN_TIMEOUT_MS = 2000;
export const HADRIAN_CACHE_MS = 10_000;
export const HADRIAN_FAILED_MS = 3000;
const MAX_BYTES = 4096;

export interface HadrianReader { reachable(): Promise<boolean> }
export interface HadrianOptions { url: string; chainId: number; timeoutMs?: number; fetch?: typeof fetch; now?: () => number }

export function createHadrianReader(opts: HadrianOptions): HadrianReader {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;
  let kept: { at: number; ttl: number; up: Promise<boolean> } | null = null;

  async function ask(): Promise<boolean> {
    const res = await doFetch(opts.url, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": AGGKIT_USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? HADRIAN_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (res.status !== 200) return false;
    const body = JSON.parse(await cappedText(res, MAX_BYTES, () => new Error("too long"))) as { result?: unknown } | null;
    return typeof body?.result === "string" && /^0x[0-9a-f]{1,16}$/i.test(body.result) && BigInt(body.result) === BigInt(opts.chainId);
  }

  return {
    reachable() {
      const t = now();
      if (kept && t - kept.at < kept.ttl) return kept.up;
      const entry = { at: t, ttl: HADRIAN_CACHE_MS, up: Promise.resolve(false) };
      entry.up = ask().catch(() => false).then((up) => { if (!up) entry.ttl = HADRIAN_FAILED_MS; return up; });
      kept = entry;
      return entry.up;
    },
  };
}
