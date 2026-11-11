import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import type { Tracker } from "./tracker.ts";
import { isHexBytes } from "./hex.ts";
import { createHeavyLimiter, isHeavy, MAX_IN_FLIGHT } from "./rpc-heavy.ts";
import type { LegCheck } from "./leg-check.ts";

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

/**
 * How many nonces ahead of the sender's next one a transaction may be and still wait for the missing ones, as it does on an Ethereum node (which queues it).
 * One account's batch of sends that arrive in another order than they were signed in (a `forge script` broadcast without `--slow`, parallel sends) gets through.
 */
export const MAX_NONCE_AHEAD = 16;
/** The most transactions held back for a missing nonce, from all senders together, and the most bytes of them (signed transactions, as hex). */
export const MAX_QUEUED = 2048;
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** The most transactions one client (see `clientKey`) may have held back, whatever the number of senders it signs with: the ceiling above is shared, and one client must not be able to fill it. */
export const MAX_QUEUED_PER_CLIENT = 32;
/** The most senders whose held transactions the sweep that runs every second asks reth about (one call each), taken in turn: the calls to reth for the held transactions are bounded however many senders are held. */
export const SWEEP_SENDERS_PER_TICK = 16;
/** How long a transaction waits for the nonce before it, in milliseconds. After that it is forgotten, as a queued transaction is on a node. */
export const QUEUE_TTL_MS = 10 * 60 * 1000;

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
  /** The most heavy calls (eth_call, eth_estimateGas, eth_getLogs) running at one time, from all clients together. */
  heavyConcurrency?: number;
  /** The most heavy calls waiting for a slot. A heavy call past that is refused at once. */
  heavyQueue?: number;
  now?: () => number;
  /** How long the finalized number is reused. Zero asks reth every time. */
  finalizedTtlMs?: number;
  /** Says before a send whether a Canton leg the transaction would record has no Canton side (see leg-check.ts). Absent: no check. */
  legCheck?: LegCheck;
  /** The most nonces ahead a transaction may be and wait for the missing ones. */
  maxNonceAhead?: number;
  /** The most transactions, and the most hex characters of them, that wait for a missing nonce, from all senders together. */
  maxQueued?: number;
  maxQueuedBytes?: number;
  /** The most transactions one client may have waiting for a missing nonce. */
  maxQueuedPerClient?: number;
  /** The most senders the once-a-second sweep asks reth about, in turn. */
  sweepSendersPerTick?: number;
  /** How long a transaction waits for its missing nonce. */
  queueTtlMs?: number;
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

class Unreachable extends Error {
  /** True when the explorer stopped waiting: reth may still be running the call. */
  timedOut: boolean;
  constructor(message: string, timedOut = false) { super(message); this.timedOut = timedOut; }
}

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
  const { rethUrl, timeoutMs, chainId, tracker, now = Date.now, finalizedTtlMs = 500, maxInFlight = MAX_IN_FLIGHT, heavyConcurrency = 8, heavyQueue = 16 } = o;
  const { maxNonceAhead = MAX_NONCE_AHEAD, maxQueued = MAX_QUEUED, maxQueuedBytes = MAX_QUEUED_BYTES, queueTtlMs = QUEUE_TTL_MS } = o;
  const { maxQueuedPerClient = MAX_QUEUED_PER_CLIENT, sweepSendersPerTick = SWEEP_SENDERS_PER_TICK } = o;
  const heavy = createHeavyLimiter(heavyConcurrency, heavyQueue);
  let inFlight = 0;
  const perMs = o.ratePerMinute / 60000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  let cached: { at: number; value: Promise<number> } | undefined;
  let fee: { at: number; value: Promise<bigint | null> } | undefined;
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
      throw new Unreachable(`${method}: ${(e as Error).message}`, (e as Error).name === "TimeoutError");
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

  /**
   * The base fee of reth's newest block, or null when reth does not say (it cannot be reached, or the chain has no base fee). Reused for as long as the
   * finalized number is. A null never refuses a send: reth's own answer for that send is the answer.
   */
  function baseFee(): Promise<bigint | null> {
    const t = now();
    if (fee && t - fee.at < finalizedTtlMs) return fee.value;
    const value = up("eth_getBlockByNumber", ["latest", false]).then(
      (r) => {
        const v = "result" in r && isObject(r.result) ? r.result.baseFeePerGas : undefined;
        return typeof v === "string" && QUANTITY.test(v) ? BigInt(v) : null;
      },
      () => null,
    );
    fee = { at: t, value };
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

  /** The tail of each sender's chain of sends, by recovered address. */
  const lanes = new Map<string, Promise<void>>();

  /** Runs `job` after the sender's earlier sends: one sender's sends go through reth one after another, in the order they arrive. */
  function inLane<T>(from: string, job: () => Promise<T>): Promise<T> {
    const before = lanes.get(from) ?? Promise.resolve();
    const mine = before.then(job);
    const tail = mine.then(() => undefined, () => undefined);
    lanes.set(from, tail);
    void tail.then(() => {
      if (lanes.get(from) === tail) lanes.delete(from);
    });
    return mine;
  }

  /**
   * Transactions that are ahead of their sender's next nonce, by sender and nonce. An Ethereum node holds such a transaction (it is "queued") and moves it on
   * when the nonce before it arrives; this does the same, in this process, within bounds: a few nonces ahead for each sender, and a count, a size and a time
   * for all senders together. They are not in reth's pool and not in the tracker, so a flood of them fills neither.
   */
  type Waiting = { raw: string; hash: string; at: number; client: string };
  const waiting = new Map<string, Map<number, Waiting>>();
  /** How many transactions each client has waiting. */
  const waitingBy = new Map<string, number>();
  let waitingCount = 0, waitingBytes = 0;
  /** Where the sweep went on from, so that every sender is asked about in turn. */
  let sweepCursor = 0;
  let waitingTimer: ReturnType<typeof setInterval> | undefined;

  function forget(from: string, nonce: number): void {
    const q = waiting.get(from), w = q?.get(nonce);
    if (!q || !w) return;
    q.delete(nonce);
    waitingCount--;
    waitingBytes -= w.raw.length;
    const mine = (waitingBy.get(w.client) ?? 1) - 1;
    if (mine > 0) waitingBy.set(w.client, mine); else waitingBy.delete(w.client);
    if (q.size === 0) waiting.delete(from);
    if (waitingCount === 0 && waitingTimer) { clearInterval(waitingTimer); waitingTimer = undefined; }
  }

  /** Drops what has waited longer than `queueTtlMs`. */
  function expire(): void {
    const t = now();
    for (const [from, q] of [...waiting]) for (const [nonce, w] of [...q]) if (t - w.at >= queueTtlMs) forget(from, nonce);
  }

  /**
   * Sends on the transactions that wait for a nonce that has come, for the senders that have some. A sender's own sends move them on at once; this catches the rest
   * (another instance took the missing nonce). Each sender costs a call to reth, so a tick asks about at most `sweepSendersPerTick` senders, going on from where the
   * last tick stopped: however many senders are held, reth is asked about a bounded number every second.
   */
  function drainAll(): void {
    expire();
    const senders = [...waiting.keys()];
    if (senders.length === 0) return;
    const start = sweepCursor % senders.length, count = Math.min(sweepSendersPerTick, senders.length);
    sweepCursor = (start + count) % senders.length;
    for (let i = 0; i < count; i++) {
      const from = senders[(start + i) % senders.length]!;
      // reth that cannot be reached is said by every other call; it is not said again here every second for each sender.
      void inLane(from, () => release(from, undefined)).catch((e) => { if (!(e instanceof Unreachable)) console.error(`rpc: cannot send on the waiting transactions of ${from}: ${(e as Error).message}`); });
    }
  }

  /**
   * Sends on `from`'s waiting transactions, from nonce `next` (reth's pending count for the sender, read when it is not given) as long as the next nonce is there.
   * Inside the sender's lane. One that is refused is dropped, and the ones after it wait for it for ever until they expire: its sender has its hash and
   * finds it missing, as on a node that dropped it from its queue.
   */
  async function release(from: string, known: number | undefined): Promise<void> {
    expire();
    const q = waiting.get(from);
    if (!q) return;
    let next = known;
    if (next === undefined) {
      const pool = await up("eth_getTransactionCount", [from, "pending"]);
      if ("error" in pool) return;
      next = quantity(pool.result);
      if (Number.isNaN(next)) return;
    }
    for (const nonce of [...q.keys()]) if (nonce < next) forget(from, nonce); // that nonce was used some other way
    for (let w = q.get(next); w; w = q.get(next)) {
      forget(from, next);
      const sent = await forward(w.raw, w.hash, from, next).catch((e) => ({ error: { code: -32603, message: (e as Error).message } }) as Up);
      if (!("result" in sent) && !("error" in sent && REFUSED_ANSWER.test(sent.error.message))) {
        console.error(`rpc: a waiting transaction ${w.hash} from ${from} (nonce ${next}) was not accepted: ${"error" in sent ? sent.error.message : "no answer"}`);
        return;
      }
      next++;
    }
  }

  async function sendRaw(params: unknown[], client: string): Promise<Up> {
    const raw = params[0];
    if (params.length !== 1 || typeof raw !== "string" || !isHexBytes(raw, { upper: true, empty: false })) return err(-32602, "Send the signed transaction as one 0x hex string.");
    let tx: ReturnType<typeof parseTransaction>, from: string;
    try {
      tx = parseTransaction(raw as Hex);
      from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    } catch {
      return err(-32602, "That is not a signed transaction this chain can read.");
    }
    if (tx.chainId === undefined) return err(-32000, `This transaction is not tied to a chain. Sign it for chain ${chainId}.`);
    if (tx.chainId !== chainId) return err(-32000, `This transaction is signed for chain ${tx.chainId}. This chain is ${chainId}.`);
    // reth accepts a transaction that pays less than the base fee and parks it: it is never pending and never built. Following it would hold a place
    // in the tracker's list for an hour, so ten thousand senders with a little dust each could fill the list. It is refused here, with the reason.
    const offered = tx.maxFeePerGas ?? tx.gasPrice;
    if (offered !== undefined) {
      const base = await baseFee();
      if (base !== null && offered < base) return err(-32000, `max fee per gas is below the current base fee: this transaction pays at most ${offered} wei per gas, and the base fee is ${base} wei. Sign it again with a higher max fee per gas.`);
    }
    // One sender's sends go through reth one after another, in the order they arrive: the nonce check below reads reth's pool, so the
    // second transaction of a batch (or of two overlapping requests) has to read it after the first is in the pool.
    return inLane(from, () => sendLocked(raw, tx, from, client));
  }

  async function sendLocked(raw: string, tx: ReturnType<typeof parseTransaction>, from: string, client: string): Promise<Up> {
    const hash = keccak256(raw as Hex), lower = raw.toLowerCase();
    // A transaction ahead of the sender's next nonce cannot go into a block yet. Following it would fill the tracker's list with
    // entries that wait for something the sender may never send, so it is not sent to reth or followed: it waits here, within bounds, for the nonce before it.
    const nonce = tx.nonce ?? 0;
    const pool = await up("eth_getTransactionCount", [from, "pending"]);
    if ("error" in pool) return pool;
    const next = quantity(pool.result);
    if (Number.isNaN(next)) throw new Unreachable("eth_getTransactionCount: not a number");
    // A call that would record a Canton leg with no Canton side is never mined and holds up the sender's later transactions: it is refused here, with the reason,
    // before it takes a nonce. A creation records no leg. The check says nothing when it cannot tell, and then the send goes on. It runs inside the sender's lane and
    // only for a nonce that is not used yet (a held one too): a transaction that is already in the pool or mined gets reth's own answer ("already known", "nonce too low").
    if (o.legCheck && tx.to && nonce >= next) {
      const reason = await o.legCheck({ from, to: tx.to, data: tx.data ?? "0x", value: "0x" + (tx.value ?? 0n).toString(16), gas: "0x" + (tx.gas ?? 0n).toString(16) });
      if (reason) return err(-32000, `This transaction would ask Canton for a leg that has no Canton side now, so no block would take it and it would hold up your later transactions. Make its Canton side first, then send it again. ${reason}`);
    }
    if (nonce > next) return hold(lower, hash, from, nonce, next, client);
    const sent = await forward(lower, hash, from, nonce, raw);
    // The nonce it took may be the one the waiting transactions of the sender wait for.
    if ("result" in sent || ("error" in sent && REFUSED_ANSWER.test(sent.error.message))) await release(from, nonce + 1).catch((e) => console.error(`rpc: cannot send on the waiting transactions of ${from}: ${(e as Error).message}`));
    return sent;
  }

  /** Keeps a transaction that is ahead of the sender's next nonce until the ones before it arrive, and answers with its hash, as a node that queues it does. */
  function hold(lower: string, hash: string, from: string, nonce: number, next: number, client: string): Up {
    if (nonce - next > maxNonceAhead) {
      return err(-32000, `nonce too far ahead: this transaction has nonce ${nonce}, and the chain expects ${next} next. A transaction can wait for at most ${maxNonceAhead} missing nonces before it: send the missing transactions first.`);
    }
    expire();
    const same = waiting.get(from)?.get(nonce);
    if (same?.hash === hash) return { result: hash };
    const replaced = same?.raw.length ?? 0;
    if ((waitingBy.get(client) ?? 0) - (same?.client === client ? 1 : 0) >= maxQueuedPerClient) {
      return err(-32005, `You already have ${maxQueuedPerClient} transactions held back for a missing nonce on this RPC. Send the missing transactions first, or try again in a moment.`);
    }
    if (waitingCount - (same ? 1 : 0) >= maxQueued || waitingBytes - replaced + lower.length > maxQueuedBytes) {
      return err(-32005, `This RPC is holding as many transactions as it can for a missing nonce right now (${maxQueued} transactions, ${Math.round(maxQueuedBytes / 1024)} KiB). Send the missing transactions first, or try again in a moment.`);
    }
    if (same) forget(from, nonce); // a new transaction with the same nonce takes its place, as a replacement does on a node
    let q = waiting.get(from);
    if (!q) waiting.set(from, (q = new Map()));
    q.set(nonce, { raw: lower, hash, at: now(), client });
    waitingBy.set(client, (waitingBy.get(client) ?? 0) + 1);
    waitingCount++;
    waitingBytes += lower.length;
    if (!waitingTimer) { waitingTimer = setInterval(drainAll, 1000); waitingTimer.unref(); }
    return { result: hash };
  }

  /** What follows the nonce check: the tracker is asked, reth is sent the transaction, and the tracker follows it. */
  async function forward(lower: string, hash: string, from: string, nonce: number, rawAsSent?: string): Promise<Up> {
    const raw = rawAsSent ?? lower;
    // Ask before reth takes it: a transaction that cannot be followed is refused, not accepted and then forgotten.
    const full = tracker.admit(lower, hash, from);
    if (full) return err(-32005, full);
    /** The tracker is a safety net. Its failure never turns a send that reth took into an error. */
    const follow = (): void => {
      try {
        tracker.track(lower, hash, from, nonce, "rpc");
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

  async function handle(method: string, params: unknown[], fin: () => Promise<number>, client: string): Promise<Up> {
    if (!PUBLIC_METHODS.has(method)) return err(-32601, `The method ${method} does not exist or is not available.`);
    const bad = err(-32602, "Invalid params.");
    switch (method) {
      case "eth_sendRawTransaction":
        return sendRaw(params, client);
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
  async function one(req: unknown, fin: () => Promise<number>, refused: { n: number }, client: string): Promise<unknown> {
    if (!isObject(req) || typeof req.method !== "string" || (req.params !== undefined && !Array.isArray(req.params))) {
      return { jsonrpc: "2.0", id: null, ...err(-32600, "Invalid request.") };
    }
    const callId: Id = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
    // A heavy call takes a slot, or waits for one in a short queue, or is refused at once. A light call goes straight through.
    let release: (() => void) | null | undefined;
    if (isHeavy(req.method)) {
      release = await heavy.acquire();
      if (release === null) {
        refused.n++;
        return { jsonrpc: "2.0", id: callId, ...err(-32005, "The RPC is busy with other calls of this kind. Try again in 1 s.") };
      }
    }
    try {
      return { jsonrpc: "2.0", id: callId, ...(await handle(req.method, (req.params as unknown[] | undefined) ?? [], fin, client)) };
    } catch (e) {
      console.error(`rpc: ${(e as Error).message}`);
      // reth does not stop a call when the explorer stops waiting for it. A heavy call that timed out keeps its place for one more
      // timeout, so abandoned calls that reth may still be running count against the cap and do not let more in meanwhile.
      if (release && e instanceof Unreachable && e.timedOut) {
        const held = release;
        release = undefined;
        setTimeout(held, timeoutMs).unref();
      }
      return { jsonrpc: "2.0", id: callId, ...err(-32603, e instanceof Unreachable ? "The chain cannot be reached right now. Try again in a moment." : "Something went wrong in the RPC. Try again in a moment.") };
    } finally {
      release?.();
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
      const refused = { n: 0 };
      const body = batch ? await Promise.all(batch.map((r) => one(r, fin, refused, clientKey(ip)))) : await one(parsed, fin, refused, clientKey(ip));
      // Told to come back: 429 with Retry-After when every call of the request was refused. A batch that was partly answered keeps
      // its 200, and each refused call carries the error.
      const all = refused.n > 0 && refused.n === (batch ? batch.length : 1);
      return all ? { status: 429, headers: { "retry-after": "1" }, body } : { status: 200, body };
    } finally {
      inFlight--;
    }
  };
}
