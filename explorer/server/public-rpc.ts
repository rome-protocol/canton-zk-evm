import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import type { Tracker } from "./tracker.ts";

/**
 * The public RPC: what a wallet or a script sees of the chain. It forwards to reth, but it shows only what is final on Canton.
 * reth makes a new block its head while the block is still being proven, and goes back if Canton refuses it. So the public
 * "latest" is reth's finalized block, which is Canton's head, and nothing above it is ever answered. A receipt from here means
 * the block is proven and final on Canton.
 */

/** The methods the public RPC answers. Any other gets -32601. */
export const PUBLIC_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId", "net_version", "web3_clientVersion", "eth_syncing", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getBlockByNumber",
  "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs", "eth_sendRawTransaction",
]);

/** The most calls in one batch. */
export const MAX_BATCH = 20;
/** The biggest body, in bytes. */
export const MAX_BODY = 256 * 1024;

export interface RpcAnswer { status: number; body: unknown; headers?: Record<string, string> }
/** `ip` is the client's address, which the HTTP layer works out. */
export type PublicRpc = (body: string, ip: string) => Promise<RpcAnswer>;

export interface PublicRpcOptions {
  rethUrl: string;
  timeoutMs: number;
  chainId: number;
  ratePerMinute: number;
  tracker: Pick<Tracker, "track" | "admit">;
  /** The most requests being answered at one time, from all clients together. */
  maxInFlight?: number;
  now?: () => number;
  /** How long the finalized number is reused. Zero asks reth every time. */
  finalizedTtlMs?: number;
}

interface RpcError { code: number; message: string; data?: unknown }
type Up = { result: unknown } | { error: RpcError };
type Id = string | number | null;

const err = (code: number, message: string): Up => ({ error: { code, message } });
const NOT_FINAL = "That block is not final on Canton yet.";
const FINAL_TAGS = new Set(["latest", "safe", "pending", "finalized"]);
const QUANTITY = /^0x[0-9a-f]+$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const REFUSED_ANSWER = /already known|known transaction|already imported|already in the pool/i;
const hex = (n: number) => "0x" + n.toString(16);
const quantity = (v: unknown): number => (typeof v === "string" && QUANTITY.test(v) ? Number(BigInt(v)) : NaN);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A block argument made public: a tag becomes the finalized number, a number above it is `above`, anything else is bad. */
type Pinned = { value: unknown } | { above: true } | { bad: true };

class Unreachable extends Error {}

/**
 * What a client's bucket is keyed on. An IPv6 customer holds a whole /64, so each one is one client: rotating through the
 * addresses of a /64 gives no new bucket. An IPv4 address written in IPv6 form is the IPv4 address.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.split("%")[0]!.split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function createPublicRpc(o: PublicRpcOptions): PublicRpc {
  const { rethUrl, timeoutMs, chainId, tracker, now = Date.now, finalizedTtlMs = 500, maxInFlight = 64 } = o;
  let inFlight = 0;
  const perMs = o.ratePerMinute / 60000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  let cached: { at: number; value: Promise<number> } | undefined;
  let id = 0;

  /** Takes `cost` tokens from the client's bucket: it holds a minute's worth and refills steadily. Returns the wait in seconds when it is short. */
  function take(address: string, cost: number): number | null {
    const ip = clientKey(address), t = now(), cap = o.ratePerMinute;
    const b = buckets.get(ip) ?? { tokens: cap, at: t };
    b.tokens = Math.min(cap, b.tokens + (t - b.at) * perMs);
    b.at = t;
    buckets.delete(ip);
    buckets.set(ip, b); // the newest at the end
    if (buckets.size > 10000) {
      // Never the client in hand: its bucket is deducted from below, and a deleted one would give it a free request and a fresh bucket.
      for (const [k, v] of buckets) if (k !== ip && (v.tokens + (t - v.at) * perMs >= cap || buckets.size > 10000)) buckets.delete(k);
    }
    if (b.tokens < cost) return Math.max(1, Math.ceil((Math.min(cost, cap) - b.tokens) / perMs / 1000));
    b.tokens -= cost;
    return null;
  }

  async function up(method: string, params: unknown[]): Promise<Up> {
    let body: { result?: unknown; error?: RpcError };
    try {
      const res = await fetch(rethUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new Unreachable(`${method}: ${(e as Error).message}`);
    }
    if (body.error) return { error: { code: body.error.code, message: body.error.message, ...(body.error.data === undefined ? {} : { data: body.error.data }) } };
    if (!("result" in body)) throw new Unreachable(`${method}: no result`);
    return { result: body.result };
  }

  /** The number of reth's finalized block, which is Canton's head. */
  function finalizedNumber(): Promise<number> {
    const t = now();
    if (cached && t - cached.at < finalizedTtlMs) return cached.value;
    const value = up("eth_getBlockByNumber", ["finalized", false]).then((r) => {
      if ("error" in r) throw new Unreachable(`finalized: ${r.error.message}`);
      if (r.result === null) return 0;
      const n = quantity((r.result as { number?: unknown }).number);
      if (Number.isNaN(n)) throw new Unreachable("finalized: not a block");
      return n;
    });
    const mine = { at: t, value };
    cached = mine;
    value.catch(() => { if (cached === mine) cached = undefined; });
    return value;
  }

  /** True when `hash` is the block at height `n` in reth's chain. Below the finalized number that is the final block. */
  async function canonical(n: number, hash: unknown): Promise<boolean> {
    const at = await up("eth_getBlockByNumber", [hex(n), false]);
    return "result" in at && isObject(at.result) && typeof hash === "string" && typeof at.result.hash === "string" && at.result.hash.toLowerCase() === hash.toLowerCase();
  }

  /** A block named by its hash: final only when it is at or below the finalized number and is the block at that height. A hash reth does not know goes to reth as it is. */
  async function finalBlock(hash: string, fin: number): Promise<Pinned> {
    const b = await up("eth_getBlockByHash", [hash, false]);
    if (!("result" in b) || !isObject(b.result)) return { value: hash };
    const n = quantity(b.result.number);
    return n <= fin && (await canonical(n, hash)) ? { value: hash } : { above: true };
  }

  /** Where a block argument points, in the public view. */
  async function pin(v: unknown, fin: number, allowHash = true): Promise<Pinned> {
    if (v === undefined || v === null) return { value: hex(fin) };
    if (typeof v === "string") {
      if (HASH.test(v)) return allowHash ? finalBlock(v, fin) : { bad: true }; // reth takes a block hash as a plain string too
      if (FINAL_TAGS.has(v)) return { value: hex(fin) };
      if (v === "earliest") return { value: v };
      const n = quantity(v);
      return Number.isNaN(n) ? { bad: true } : n > fin ? { above: true } : { value: v };
    }
    if (!isObject(v)) return { bad: true };
    if ("blockNumber" in v) {
      const p = await pin(v.blockNumber, fin);
      return "value" in p ? { value: { ...v, blockNumber: p.value } } : p;
    }
    if (allowHash && typeof v.blockHash === "string") {
      const p = await finalBlock(v.blockHash, fin);
      return "value" in p ? { value: v } : p;
    }
    return { bad: true };
  }

  const STATE_AT: Record<string, number> = { eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_call: 1, eth_estimateGas: 1, eth_getStorageAt: 2 };

  async function sendRaw(params: unknown[]): Promise<Up> {
    const raw = params[0];
    if (params.length !== 1 || typeof raw !== "string" || !/^0x([0-9a-f]{2})+$/i.test(raw)) return err(-32602, "Send the signed transaction as one 0x hex string.");
    let tx: ReturnType<typeof parseTransaction>, from: string;
    try {
      tx = parseTransaction(raw as Hex);
      from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    } catch {
      return err(-32602, "That is not a signed transaction this chain can read.");
    }
    if (tx.chainId === undefined) return err(-32000, `This transaction is not tied to a chain. Sign it for chain ${chainId}.`);
    if (tx.chainId !== chainId) return err(-32000, `This transaction is signed for chain ${tx.chainId}. This chain is ${chainId}.`);
    const hash = keccak256(raw as Hex), lower = raw.toLowerCase();
    // A transaction ahead of the sender's next nonce cannot go into a block yet. Following it would fill the tracker's list with
    // entries that wait for something the sender may never send, so it is refused here, before the tracker or reth see it.
    const nonce = tx.nonce ?? 0;
    const pool = await up("eth_getTransactionCount", [from, "pending"]);
    if ("error" in pool) return pool;
    const next = quantity(pool.result);
    if (Number.isNaN(next)) throw new Unreachable("eth_getTransactionCount: not a number");
    if (nonce > next) return err(-32000, `nonce gap: send the missing transactions first. This transaction has nonce ${nonce}, and the chain expects ${next} next.`);
    // Ask before reth takes it: a transaction that cannot be followed is refused, not accepted and then forgotten.
    const full = tracker.admit(lower, hash, from);
    if (full) return err(-32005, full);
    /** The tracker is a safety net. Its failure never turns a send that reth took into an error. */
    const follow = (): void => {
      try {
        tracker.track(lower, hash, from, nonce);
      } catch (e) {
        console.error(`rpc: cannot follow ${hash}: ${(e as Error).message}`);
      }
    };
    let sent: Up;
    try {
      sent = await up("eth_sendRawTransaction", [raw]);
    } catch (e) {
      // reth may have taken it before the wait ran out. If so, the wallet's answer is an error and the tracker is the only one who knows.
      if (e instanceof Unreachable) follow();
      throw e;
    }
    // A hash is returned only when reth accepted the transaction, and reth's answer is returned as it is.
    if ("result" in sent && typeof sent.result === "string") {
      const answered = sent.result.toLowerCase();
      if (answered !== hash) console.error(`rpc: reth's hash ${answered} is not the Keccak of the transaction`);
      follow();
    } else if ("error" in sent && REFUSED_ANSWER.test(sent.error.message)) {
      follow(); // reth holds it already, from an earlier send
    }
    return sent;
  }

  async function handle(method: string, params: unknown[], fin: () => Promise<number>): Promise<Up> {
    if (!PUBLIC_METHODS.has(method)) return err(-32601, `The method ${method} does not exist or is not available.`);
    const bad = err(-32602, "Invalid params.");
    switch (method) {
      case "eth_sendRawTransaction":
        return sendRaw(params);
      case "eth_blockNumber":
        return { result: hex(await fin()) };
      case "eth_getBlockByNumber": {
        const p = await pin(params[0], await fin(), false);
        if ("bad" in p) return bad;
        return "above" in p ? { result: null } : up(method, [p.value, ...params.slice(1)]);
      }
      case "eth_feeHistory": {
        const f = await fin(), p = await pin(params[1], f, false);
        if (params.length < 2 || "bad" in p) return bad;
        return up(method, [params[0], "above" in p ? hex(f) : p.value, ...params.slice(2)]);
      }
      case "eth_getBlockByHash": {
        const f = await fin(); // the finalized number is read before the block, so the block cannot be newer than it
        const r = await up(method, params);
        if (!("result" in r) || !isObject(r.result)) return r;
        const n = quantity(r.result.number);
        return n <= f && (await canonical(n, r.result.hash)) ? r : { result: null };
      }
      case "eth_getTransactionByHash": {
        const f = await fin();
        const r = await up(method, params);
        if (!("result" in r) || !isObject(r.result) || r.result.blockNumber === null) return r; // in the pool: no block yet, which is the honest answer
        const n = quantity(r.result.blockNumber);
        if (n <= f) return (await canonical(n, r.result.blockHash)) ? r : { result: null }; // not the block at that height: not shown
        // Its block is still being proven: until it is final the transaction is shown as the pool's are, with no block yet.
        return { result: { ...r.result, blockHash: null, blockNumber: null, transactionIndex: null } };
      }
      case "eth_getTransactionReceipt": {
        const f = await fin();
        const r = await up(method, params);
        if (!("result" in r) || !isObject(r.result)) return r;
        const n = quantity(r.result.blockNumber);
        return n <= f && (await canonical(n, r.result.blockHash)) ? r : { result: null };
      }
      case "eth_getLogs": {
        const f = await fin(), filter = params[0];
        if (!isObject(filter) || params.length !== 1) return bad;
        if (filter.blockHash !== undefined) {
          const b = await pin({ blockHash: filter.blockHash }, f);
          return "above" in b ? { result: [] } : "bad" in b ? bad : up(method, params);
        }
        const from = await pin(filter.fromBlock, f, false), to = await pin(filter.toBlock, f, false);
        if ("bad" in from || "bad" in to) return bad;
        if ("above" in from) return { result: [] };
        return up(method, [{ ...filter, fromBlock: from.value, toBlock: "above" in to ? hex(f) : to.value }]);
      }
    }
    const at = STATE_AT[method];
    if (at === undefined) return up(method, params);
    // The pool's count is what a wallet needs to pick its next nonce.
    if (method === "eth_getTransactionCount" && params[1] === "pending") return up(method, params);
    if (params.length < at) return up(method, params); // reth names the missing argument
    const p = await pin(params[at], await fin());
    if ("bad" in p) return bad;
    if ("above" in p) return err(-32000, NOT_FINAL);
    const next = [...params];
    next[at] = p.value;
    return up(method, next);
  }

  /** One call of a request, answered as JSON-RPC. */
  async function one(req: unknown, fin: () => Promise<number>): Promise<unknown> {
    if (!isObject(req) || typeof req.method !== "string" || (req.params !== undefined && !Array.isArray(req.params))) {
      return { jsonrpc: "2.0", id: null, ...err(-32600, "Invalid request.") };
    }
    const callId: Id = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
    try {
      return { jsonrpc: "2.0", id: callId, ...(await handle(req.method, (req.params as unknown[] | undefined) ?? [], fin)) };
    } catch (e) {
      console.error(`rpc: ${(e as Error).message}`);
      return { jsonrpc: "2.0", id: callId, ...err(-32603, e instanceof Unreachable ? "The chain cannot be reached right now. Try again in a moment." : "Something went wrong in the RPC. Try again in a moment.") };
    }
  }

  return async (text, ip) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const batch = Array.isArray(parsed) ? (parsed as unknown[]) : null;
    const wait = take(ip, batch ? Math.max(1, batch.length) : 1);
    if (wait !== null) {
      return { status: 429, headers: { "retry-after": String(wait) }, body: { jsonrpc: "2.0", id: null, ...err(-32005, `Too many requests. Try again in ${wait} s.`) } };
    }
    if (parsed === undefined) return { status: 200, body: { jsonrpc: "2.0", id: null, ...err(-32700, "Parse error: the body is not JSON.") } };
    if (batch && batch.length > MAX_BATCH) return { status: 200, body: { jsonrpc: "2.0", id: null, ...err(-32600, `A batch holds at most ${MAX_BATCH} calls.`) } };
    if (batch && batch.length === 0) return { status: 200, body: { jsonrpc: "2.0", id: null, ...err(-32600, "An empty batch.") } };
    // Many clients together cannot hold more than `maxInFlight` requests: the rest are told to come back, and reth is not saturated.
    if (inFlight >= maxInFlight) {
      return { status: 503, headers: { "retry-after": "1" }, body: { jsonrpc: "2.0", id: null, ...err(-32005, "The RPC is busy. Try again in a moment.") } };
    }
    inFlight++;
    try {
      // One view of the chain for the whole request.
      let seen: Promise<number> | undefined;
      const fin = () => (seen ??= finalizedNumber());
      return { status: 200, body: batch ? await Promise.all(batch.map((r) => one(r, fin))) : await one(parsed, fin) };
    } finally {
      inFlight--;
    }
  };
}
