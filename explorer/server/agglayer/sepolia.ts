/**
 * A reader of Ethereum Sepolia with a fixed list of read-only calls: `isClaimed` and the copy address of a token on the bridge, and the rollup lookup on the rollup manager. The
 * endpoint is a secret (it carries a key): it is never logged, put in an error or sent to a browser, so every failure here is said in words that leave it out.
 */
import { isClaimedCall, proxyAddressCall, rollupIdCall, wrappedAddressCall } from "./abi.ts";
import { cappedText } from "./capped.ts";
import type { Secret } from "./secret.ts";

export const SEPOLIA_USER_AGENT = "Rome Protocol rome@romeprotocol.com";
export const SEPOLIA_TIMEOUT_MS = 1500;
const NOT_YET_MS = 5000, CLAIMED_MS = 60_000, COPY_MS = 3_600_000, ATTACHED_MS = 60_000;
const MAX_ENTRIES = 500;
const MAX_BYTES = 64 * 1024;

export class SepoliaError extends Error {}

export interface SepoliaOptions {
  /** The endpoint, with its key. */
  url: Secret;
  bridge: string;
  /** The rollup manager, for the attached check; null leaves that check out. */
  rollupManager: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const uint32 = (n: number): number => {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 32) throw new TypeError("a number must be whole and below 2^32");
  return n;
};
const addr = (a: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new TypeError("an address is 0x and 40 hex digits");
  return a;
};

export function createSepoliaReader(opts: SepoliaOptions) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? SEPOLIA_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const kept = new Map<string, { at: number; ttl: number; value: Promise<string> }>();
  let id = 0;

  /** One eth_call at the latest block; the answer is a 32-byte word. */
  async function call(to: string, data: string): Promise<string> {
    let res: Response;
    try {
      res = await doFetch(opts.url.reveal(), {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": SEPOLIA_USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
    } catch {
      throw new SepoliaError("Ethereum Sepolia cannot be reached");
    }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new SepoliaError(`Ethereum Sepolia answered HTTP ${res.status}`); }
    let body: unknown;
    try {
      body = JSON.parse(await cappedText(res, MAX_BYTES, () => new Error()));
    } catch {
      throw new SepoliaError("Ethereum Sepolia did not answer with JSON");
    }
    const b = body as { result?: unknown; error?: unknown } | null;
    if (!b || typeof b !== "object" || b.error !== undefined) throw new SepoliaError("Ethereum Sepolia refused the call");
    if (typeof b.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.result)) throw new SepoliaError("Ethereum Sepolia answered with something that is not one word");
    return b.result;
  }

  /** A call kept for `ttl` ms; a failure is not kept. */
  function cached(to: string, data: string, ttl: (word: string) => number): Promise<string> {
    const key = `${to}:${data}`, t = now();
    const had = kept.get(key);
    if (had && t - had.at < had.ttl) return had.value;
    const value = call(to, data);
    const entry = { at: t, ttl: NOT_YET_MS, value };
    kept.delete(key);
    kept.set(key, entry);
    if (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value as string);
    value.then((w) => { entry.ttl = ttl(w); }, () => { if (kept.get(key) === entry) kept.delete(key); });
    return value;
  }

  return {
    /** Whether the bridge on Sepolia has paid out the deposit with this number from `sourceNetwork` (the network the deposit was sent from). */
    async isClaimed(depositCount: number, sourceNetwork: number): Promise<boolean> {
      const w = await cached(opts.bridge, isClaimedCall(uint32(depositCount), uint32(sourceNetwork)), (x) => (BigInt(x) === 0n ? NOT_YET_MS : CLAIMED_MS));
      return BigInt(w) !== 0n;
    },
    /** The address the copy of a token from `originNetwork` has on Sepolia, and whether the copy has been made yet. */
    async copyOf(originNetwork: number, token: string): Promise<{ address: string; exists: boolean }> {
      const [proxy, wrapped] = await Promise.all([
        cached(opts.bridge, proxyAddressCall(uint32(originNetwork), addr(token)), () => COPY_MS),
        cached(opts.bridge, wrappedAddressCall(originNetwork, token), (x) => (BigInt(x) === 0n ? NOT_YET_MS : COPY_MS)),
      ]);
      const hex = (w: string) => "0x" + w.slice(26).toLowerCase();
      return { address: hex(proxy), exists: BigInt(wrapped) !== 0n };
    },
    /** Whether Ostia (by its chain id) is attached to AggLayer: the rollup manager gives it a rollup number. Null when no rollup manager is set. */
    async attached(chainId: number): Promise<boolean | null> {
      if (!opts.rollupManager) return null;
      return BigInt(await cached(opts.rollupManager, rollupIdCall(chainId), () => ATTACHED_MS)) !== 0n;
    },
  };
}

export type SepoliaReader = ReturnType<typeof createSepoliaReader>;
