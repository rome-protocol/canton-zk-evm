/**
 * The indexer's reads from reth: final blocks only, over reth's HTTP port, and only the methods below. The API role has its own, shorter
 * list (server/reth.ts) with no trace method, so only the indexer can ask for a block's traces. A read that comes back as bad data is a
 * RethError that names its method.
 */
import { RethError } from "../reth.ts";

export const FINAL_READ_METHODS: ReadonlySet<string> = new Set([
  "eth_getBlockByNumber", "eth_getBlockReceipts", "trace_replayBlockTransactions", "eth_getStorageAt", "eth_getCode",
]);

type Json = Record<string, unknown>;

export interface FinalTx {
  hash: string;
  type: number;
  from: string;
  to: string | null;
  nonce: number;
  value: bigint;
  gas: number;
  gasPrice: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  input: string;
  accessList: unknown | null;
  authorizationList: unknown | null;
}

export interface FinalBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  gasLimit: number;
  gasUsed: number;
  baseFeePerGas: bigint;
  miner: string;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  extraData: string;
  /** reth's size for the block, in bytes; null when it sends none. */
  size: number | null;
  transactions: FinalTx[];
}

export interface FinalLog { address: string; topics: string[]; data: string }

export interface FinalReceipt {
  transactionHash: string;
  status: number;
  gasUsed: number;
  cumulativeGasUsed: number;
  effectiveGasPrice: bigint;
  contractAddress: string | null;
  logs: FinalLog[];
}

/** One transaction's replay: its output (the revert data of a failed one) and how many calls its trace holds, the transaction's own included. */
export interface TxTrace { transactionHash: string; output: string; calls: number; error: string | null }

const bad = (what: string): never => { throw new Error(`${what} is not valid`); };
const re = (r: RegExp, what: string) => (v: unknown): string => (typeof v === "string" && r.test(v) ? v : bad(what));
const hash = re(/^0x[0-9a-f]{64}$/, "a hash");
const address = re(/^0x[0-9a-f]{40}$/, "an address");
const data = re(/^0x([0-9a-f]{2})*$/, "a byte string");
const quantity = re(/^0x(0|[1-9a-f][0-9a-f]*)$/, "a quantity");
const big = (v: unknown) => BigInt(quantity(v));
const num = (v: unknown): number => { const n = big(v); return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : bad("a quantity"); };
const orNull = <T>(v: unknown, f: (x: unknown) => T): T | null => (v === null || v === undefined ? null : f(v));
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : bad("an object"));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : bad("a list"));

function tx(v: unknown): FinalTx {
  const t = obj(v);
  return {
    hash: hash(t.hash), type: num(t.type ?? "0x0"), from: address(t.from), to: orNull(t.to, address), nonce: num(t.nonce), value: big(t.value), gas: num(t.gas),
    gasPrice: orNull(t.gasPrice, big), maxFeePerGas: orNull(t.maxFeePerGas, big), maxPriorityFeePerGas: orNull(t.maxPriorityFeePerGas, big), input: data(t.input),
    accessList: t.accessList ?? null, authorizationList: t.authorizationList ?? null,
  };
}

function block(v: unknown): FinalBlock {
  const b = obj(v);
  return {
    number: num(b.number), hash: hash(b.hash), parentHash: hash(b.parentHash), timestamp: num(b.timestamp), gasLimit: num(b.gasLimit), gasUsed: num(b.gasUsed),
    baseFeePerGas: big(b.baseFeePerGas), miner: address(b.miner), stateRoot: hash(b.stateRoot), transactionsRoot: hash(b.transactionsRoot), receiptsRoot: hash(b.receiptsRoot),
    extraData: data(b.extraData), size: orNull(b.size, num), transactions: list(b.transactions).map(tx),
  };
}

function receipt(v: unknown): FinalReceipt {
  const r = obj(v);
  return {
    transactionHash: hash(r.transactionHash), status: num(r.status), gasUsed: num(r.gasUsed), cumulativeGasUsed: num(r.cumulativeGasUsed ?? r.gasUsed),
    effectiveGasPrice: big(r.effectiveGasPrice), contractAddress: orNull(r.contractAddress, address),
    logs: list(r.logs).map((l) => ({ address: address(obj(l).address), topics: list(obj(l).topics).map(hash), data: data(obj(l).data) })),
  };
}

function trace(v: unknown): TxTrace {
  const t = obj(v);
  const calls = list(t.trace);
  const top = calls.length > 0 ? obj(calls[0]) : null;
  return { transactionHash: hash(t.transactionHash), output: data(t.output ?? "0x"), calls: calls.length, error: top && typeof top.error === "string" ? top.error : null };
}

/** `traceTimeoutMs` is for the trace replay of a block, which can take much longer than the other reads (a heavy block is replayed whole). */
export function createFinalReads(url: string, timeoutMs: number, traceTimeoutMs: number = timeoutMs) {
  let id = 0;

  async function rpc(method: string, params: unknown[], limitMs: number = timeoutMs): Promise<unknown> {
    if (!FINAL_READ_METHODS.has(method)) throw new RethError(`${method} is not on the list of methods the indexer may call`);
    let body: { result?: unknown; error?: { message?: string } };
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(limitMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new RethError(`${method}: cannot reach reth (${(e as Error).message})`);
    }
    if (body.error) throw new RethError(`${method}: reth answered "${body.error.message ?? "an error"}"`, true);
    return body.result;
  }

  async function read<T>(method: string, params: unknown[], parse: (v: unknown) => T, limitMs: number = timeoutMs): Promise<T> {
    const result = await rpc(method, params, limitMs);
    try {
      return parse(result);
    } catch (e) {
      throw new RethError(`${method}: ${(e as Error).message}`);
    }
  }

  const tag = (n: number) => "0x" + n.toString(16);

  return {
    /** Block n with its transactions, or null when reth does not have it. */
    block: (n: number) => read("eth_getBlockByNumber", [tag(n), true], (v) => (v === null ? null : block(v))),
    /** The hash of block n (no transactions asked for), or null when reth does not have it. */
    hashAt: (n: number) => read("eth_getBlockByNumber", [tag(n), false], (v) => (v === null ? null : hash(obj(v).hash))),
    /** The number of reth's finalized block, or null when it has none. */
    finalized: () => read("eth_getBlockByNumber", ["finalized", false], (v) => (v === null ? null : num(obj(v).number))),
    /** The receipts of block n, or null when reth does not have it. */
    receipts: (n: number) => read("eth_getBlockReceipts", [tag(n)], (v) => (v === null ? null : list(v).map(receipt))),
    /** The replay of every transaction of block n (`trace_replayBlockTransactions` with the "trace" tracer), or null when reth does not have it. */
    traces: (n: number) => read("trace_replayBlockTransactions", [tag(n), ["trace"]], (v) => (v === null ? null : list(v).map(trace)), traceTimeoutMs),
    /** One storage slot of an account at block n, as 32 bytes. */
    storageAt: (account: string, slot: string, n: number) => read("eth_getStorageAt", [account, slot, tag(n)], re(/^0x[0-9a-f]{64}$/, "a storage word")),
    /** An account's code at block n (`0x` for none): the genesis contracts are checked at block 0. */
    code: (account: string, n: number) => read("eth_getCode", [account, tag(n)], data),
    rpc,
  };
}

export type FinalReads = ReturnType<typeof createFinalReads>;
