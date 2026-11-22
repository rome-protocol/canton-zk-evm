/**
 * A reader of Ethereum Sepolia with a fixed list of read-only calls: `isClaimed`, the copy address of a token and the pause state of the bridge, the rollup lookup on the rollup manager, and for
 * messages a receiver's code, a claim simulated and the note board's note. The
 * endpoint is a secret (it carries a key): it is never logged, put in an error or sent to a browser, so every failure here is said in words that leave it out.
 */
import { emergencyStateCall, isClaimedCall, noteOfCall, proxyAddressCall, rollupIdCall, wrappedAddressCall } from "./abi.ts";
import { cappedText } from "./capped.ts";
import type { Secret } from "./secret.ts";

export const SEPOLIA_USER_AGENT = "Rome Protocol rome@romeprotocol.com";
export const SEPOLIA_TIMEOUT_MS = 1500;
const NOT_YET_MS = 5000, CLAIMED_MS = 60_000, COPY_MS = 3_600_000, ATTACHED_MS = 60_000;
const MAX_ENTRIES = 500;
const PAUSED_MS = 30_000;
/** A claim is simulated from an address that holds nothing, with the gas a view may use. */
export const SIMULATE_FROM = "0x00000000000000000000000000000000000000f1";
export const SIMULATE_GAS = "0x989680";
const MAX_BYTES = 64 * 1024;

export class SepoliaError extends Error {}

/** The cap on all calls to Sepolia is used up: no call was made, and one is possible in `retryAfterSeconds`. */
export class SepoliaBusy extends SepoliaError {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Ethereum Sepolia reads are at their limit for now");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** How many calls the explorer makes to Sepolia in any second, all clients together, when not set. */
export const SEPOLIA_MAX_PER_SECOND = 5;
const WINDOW_MS = 1000;

export interface SepoliaOptions {
  /** The endpoint, with its key. */
  url: Secret;
  bridge: string;
  /** The rollup manager, for the attached check; null leaves that check out. */
  rollupManager: string | null;
  timeoutMs?: number;
  /** The most upstream calls in any one second, for every client together (the endpoint's throughput is shared). */
  maxPerSecond?: number;
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
  const maxPerSecond = opts.maxPerSecond ?? SEPOLIA_MAX_PER_SECOND;
  if (!Number.isInteger(maxPerSecond) || maxPerSecond < 1) throw new TypeError("maxPerSecond is a whole number from 1");
  /** When each of the calls in the last second was made, oldest first: the room is what the second has not used. */
  const made: number[] = [];
  const kept = new Map<string, { at: number; ttl: number; value: Promise<string> }>();
  let id = 0;

  /** One JSON-RPC read at the latest block. A call that reverts is `reverted` (the node's error code 3, or its words); any other refusal is an error. `max` bounds the answer in bytes. */
  async function rpc(method: string, params: unknown[], max = MAX_BYTES): Promise<{ result: string } | "reverted"> {
    let res: Response;
    try {
      res = await doFetch(opts.url.reveal(), {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", "user-agent": SEPOLIA_USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
    } catch {
      throw new SepoliaError("Ethereum Sepolia cannot be reached");
    }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new SepoliaError(`Ethereum Sepolia answered HTTP ${res.status}`); }
    let body: unknown;
    try {
      body = JSON.parse(await cappedText(res, max, () => new Error()));
    } catch {
      throw new SepoliaError("Ethereum Sepolia did not answer with JSON");
    }
    const b = body as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    if (!b || typeof b !== "object") throw new SepoliaError("Ethereum Sepolia refused the call");
    if (b.error !== undefined) {
      const e = b.error && typeof b.error === "object" ? b.error : {};
      if (method === "eth_call" && (e.code === 3 || (typeof e.message === "string" && /revert/i.test(e.message)))) return "reverted";
      throw new SepoliaError("Ethereum Sepolia refused the call");
    }
    if (typeof b.result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(b.result)) throw new SepoliaError("Ethereum Sepolia answered with something that is not data");
    return { result: b.result };
  }

  /** One eth_call at the latest block; the answer is a 32-byte word. */
  async function call(to: string, data: string): Promise<string> {
    const r = await rpc("eth_call", [{ to, data }, "latest"]);
    if (r === "reverted" || !/^0x[0-9a-fA-F]{64}$/.test(r.result)) throw new SepoliaError("Ethereum Sepolia answered with something that is not one word");
    return r.result;
  }

  /** Takes a place in the second for one real call, or says how many seconds until there is one. Never makes room for a call that was not made. */
  function take(t: number): number | null {
    while (made.length > 0 && t - made[0]! >= WINDOW_MS) made.shift();
    if (made.length >= maxPerSecond) return Math.max(1, Math.ceil((made[0]! + WINDOW_MS - t) / 1000));
    made.push(t);
    return null;
  }

  /** A call kept for `ttl` ms; a failure is not kept. A repeat of a kept call, or of one on its way, costs no place in the second; a call over the cap is refused, not made and not kept. */
  function cached(key: string, run: () => Promise<string>, ttl: (word: string) => number): Promise<string> {
    const t = now();
    const had = kept.get(key);
    if (had && t - had.at < had.ttl) return had.value;
    const wait = take(t);
    if (wait !== null) return Promise.reject(new SepoliaBusy(wait));
    const value = run();
    const entry = { at: t, ttl: NOT_YET_MS, value };
    kept.delete(key);
    kept.set(key, entry);
    if (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value as string);
    value.then((w) => { entry.ttl = ttl(w); }, () => { if (kept.get(key) === entry) kept.delete(key); });
    return value;
  }

  const word = (to: string, data: string, ttl: (word: string) => number) => cached(`${to}:${data}`, () => call(to, data), ttl);

  return {
    /** Whether the bridge on Sepolia has paid out the deposit with this number from `sourceNetwork` (the network the deposit was sent from). */
    async isClaimed(depositCount: number, sourceNetwork: number): Promise<boolean> {
      const w = await word(opts.bridge, isClaimedCall(uint32(depositCount), uint32(sourceNetwork)), (x) => (BigInt(x) === 0n ? NOT_YET_MS : CLAIMED_MS));
      return BigInt(w) !== 0n;
    },
    /** The address the copy of a token from `originNetwork` has on Sepolia, and whether the copy has been made yet. */
    async copyOf(originNetwork: number, token: string): Promise<{ address: string; exists: boolean }> {
      const [proxy, wrapped] = await Promise.all([
        word(opts.bridge, proxyAddressCall(uint32(originNetwork), addr(token)), () => COPY_MS),
        word(opts.bridge, wrappedAddressCall(originNetwork, token), (x) => (BigInt(x) === 0n ? NOT_YET_MS : COPY_MS)),
      ]);
      const hex = (w: string) => "0x" + w.slice(26).toLowerCase();
      return { address: hex(proxy), exists: BigInt(wrapped) !== 0n };
    },
    /** Whether Ostia (by its chain id) is attached to AggLayer: the rollup manager gives it a rollup number. Null when no rollup manager is set. */
    async attached(chainId: number): Promise<boolean | null> {
      if (!opts.rollupManager) return null;
      return BigInt(await word(opts.rollupManager, rollupIdCall(chainId), () => ATTACHED_MS)) !== 0n;
    },
    /** Whether the bridge is in its emergency state (paused): sends and claims then revert. */
    async paused(): Promise<boolean> {
      return BigInt(await word(opts.bridge, emergencyStateCall(), () => PAUSED_MS)) !== 0n;
    },
    /** Whether an address has code. */
    async hasCode(address: string): Promise<boolean> {
      const a = addr(address).toLowerCase();
      return (await cached(`code:${a}`, async () => { const r = await rpc("eth_getCode", [a, "latest"]); return r === "reverted" ? "0x" : r.result; }, (x) => (x === "0x" ? NOT_YET_MS : CLAIMED_MS))) !== "0x";
    },
    /** Whether `data` sent to the bridge from a fixed address that holds nothing would succeed, at the latest block. A revert is false; a node that refuses for another reason is an error. */
    async wouldPass(data: string): Promise<boolean> {
      const v = await cached(`sim:${data}`, async () => ((await rpc("eth_call", [{ from: SIMULATE_FROM, to: opts.bridge, data, gas: SIMULATE_GAS }, "latest"])) === "reverted" ? "reverted" : "passes"), () => NOT_YET_MS);
      return v === "passes";
    },
    /** The raw answer of the note board's `noteOf` (a board is a setting, so this reads the one address it is given), or null when the call reverts. */
    async noteOf(board: string, originNetwork: number, sender: string): Promise<string | null> {
      const data = noteOfCall(uint32(originNetwork), addr(sender)), to = addr(board).toLowerCase();
      const v = await cached(`note:${to}:${data}`, async () => { const r = await rpc("eth_call", [{ to, data }, "latest"]); return r === "reverted" ? "reverted" : r.result; }, () => NOT_YET_MS);
      return v === "reverted" ? null : v;
    },
  };
}

export type SepoliaReader = ReturnType<typeof createSepoliaReader>;
