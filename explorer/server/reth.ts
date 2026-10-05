import { decodeAbiParameters } from "viem";

/**
 * The explorer's whole view of reth: its HTTP RPC, and only the methods below. reth's HTTP port serves the eth, net and
 * web3 methods, so the pool (txpool) is out of reach; the explorer never touches the builder's WebSocket or Engine ports.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBlockReceipts",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBalance", "eth_getTransactionCount",
  "eth_getCode", "eth_call",
  // For the faucet: the chain id, fee data and the signed transfer.
  "eth_chainId", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_sendRawTransaction",
]);

export class RethError extends Error {
  /** True when reth answered with a JSON-RPC error (such as a reverted call); false when it could not be reached or answered nonsense. */
  readonly answered: boolean;
  constructor(message: string, answered = false) {
    super(message);
    this.answered = answered;
  }
}

export interface Tx {
  hash: string;
  /** Null while the transaction is only in reth's pool. */
  blockNumber: number | null;
  blockHash: string | null;
  index: number | null;
  from: string;
  to: string | null;
  value: bigint;
  nonce: number;
  type: number;
  gas: number;
  input: string;
}

export interface Block<T = string> {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  gasUsed: number;
  gasLimit: number;
  baseFeePerGas: bigint | null;
  miner: string;
  stateRoot: string;
  transactions: T[];
}

export interface Log { address: string; topics: string[]; data: string }

export interface Receipt {
  transactionHash: string;
  success: boolean;
  gasUsed: number;
  effectiveGasPrice: bigint;
  /** The address a contract-creating transaction made. */
  contractAddress: string | null;
  logs: Log[];
}

export interface TokenInfo { name: string; symbol: string; decimals: number }

export type BlockId = number | "latest" | "finalized" | string;

type Json = Record<string, unknown>;

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DATA = /^0x([0-9a-f]{2})*$/;

function bad(what: string): never {
  throw new RethError(`reth sent a value that is not a valid ${what}`);
}
const hex = (re: RegExp, what: string) => (v: unknown): string => (typeof v === "string" && re.test(v) ? v : bad(what));
const hash = hex(HASH, "hash");
const address = hex(ADDRESS, "address");
const data = hex(DATA, "byte string");
const big = (v: unknown): bigint => BigInt(hex(QUANTITY, "quantity")(v));
const num = (v: unknown): number => Number(big(v));
const orNull = <T>(v: unknown, f: (x: unknown) => T): T | null => (v === null || v === undefined ? null : f(v));
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : bad("object"));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : bad("list"));

function tx(v: unknown): Tx {
  const t = obj(v);
  return {
    hash: hash(t.hash), blockNumber: orNull(t.blockNumber, num), blockHash: orNull(t.blockHash, hash), index: orNull(t.transactionIndex, num),
    from: address(t.from), to: orNull(t.to, address), value: big(t.value), nonce: num(t.nonce), type: num(t.type), gas: num(t.gas), input: data(t.input),
  };
}

function receipt(v: unknown): Receipt {
  const r = obj(v);
  return {
    transactionHash: hash(r.transactionHash), success: num(r.status) === 1, gasUsed: num(r.gasUsed), effectiveGasPrice: big(r.effectiveGasPrice),
    contractAddress: orNull(r.contractAddress, address),
    logs: list(r.logs).map((l) => ({ address: address(obj(l).address), topics: list(obj(l).topics).map(hash), data: data(obj(l).data) })),
  };
}

function block<T>(v: unknown, item: (x: unknown) => T): Block<T> {
  const b = obj(v);
  return {
    number: num(b.number), hash: hash(b.hash), parentHash: hash(b.parentHash), timestamp: num(b.timestamp), gasUsed: num(b.gasUsed),
    gasLimit: num(b.gasLimit), baseFeePerGas: orNull(b.baseFeePerGas, big), miner: address(b.miner), stateRoot: hash(b.stateRoot),
    transactions: list(b.transactions).map(item),
  };
}

const SELECTOR = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567" };

export function createReth(url: string, timeoutMs: number) {
  let id = 0;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) throw new RethError(`${method} is not on the list of methods the explorer may call`);
    let body: { result?: unknown; error?: { message?: string } };
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new RethError(`${method}: cannot reach reth (${(e as Error).message})`);
    }
    if (body.error) throw new RethError(`${method}: reth answered "${body.error.message ?? "an error"}"`, true);
    return body.result;
  }

  // A call that comes back as bad data is attributed to its method, so a log line says which one.
  async function read<T>(method: string, params: unknown[], parse: (v: unknown) => T): Promise<T> {
    const result = await rpc(method, params);
    try {
      return parse(result);
    } catch (e) {
      throw new RethError(`${method}: ${(e as Error).message}`);
    }
  }

  const byHash = (id: BlockId): id is string => typeof id === "string" && HASH.test(id);
  const tag = (id: BlockId) => (typeof id === "number" ? "0x" + id.toString(16) : id);

  async function getBlock(id: BlockId, full: true): Promise<Block<Tx> | null>;
  async function getBlock(id: BlockId, full?: false): Promise<Block | null>;
  async function getBlock(id: BlockId, full = false): Promise<Block<string> | Block<Tx> | null> {
    const [method, params] = byHash(id) ? ["eth_getBlockByHash", [id, full]] : ["eth_getBlockByNumber", [tag(id), full]];
    return read(method!, params as unknown[], (v) => (v === null ? null : full ? block(v, tx) : block(v, hash)));
  }

  /** One ERC-20 read. A revert means "not a token"; an unreachable reth is still an error. */
  async function erc20(to: string, sel: string): Promise<string | null> {
    try {
      return await read("eth_call", [{ to, data: sel }, "latest"], data);
    } catch (e) {
      if (e instanceof RethError && e.answered) return null;
      throw e;
    }
  }

  return {
    rpc,
    block: getBlock,
    blockNumber: () => read("eth_blockNumber", [], num),
    blockReceipts: (id: BlockId) => read("eth_getBlockReceipts", [tag(id)], (v) => (v === null ? null : list(v).map(receipt))),
    transaction: (h: string) => read("eth_getTransactionByHash", [h], (v) => (v === null ? null : tx(v))),
    receipt: (h: string) => read("eth_getTransactionReceipt", [h], (v) => (v === null ? null : receipt(v))),
    // The balance and the count of sent transactions come from the newest block, which may still be being proven.
    balance: (a: string) => read("eth_getBalance", [a, "latest"], big),
    /** The count of transactions an address has sent: by default as of the newest block, or with "pending" including those waiting in the pool. */
    nonce: (a: string, at: "latest" | "pending" = "latest") => read("eth_getTransactionCount", [a, at], num),
    // For the faucet.
    gasPrice: () => read("eth_gasPrice", [], big),
    priorityFee: () => read("eth_maxPriorityFeePerGas", [], big),
    /** Sends a signed transaction and returns its hash. A refusal from reth is a RethError with `answered` set. */
    sendRaw: (signed: string) => read("eth_sendRawTransaction", [signed], hash),
    code: (a: string) => read("eth_getCode", [a, "latest"], data),
    /** The name, symbol and decimals of an ERC-20 token, or null when the address does not answer those three calls. */
    async token(a: string): Promise<TokenInfo | null> {
      const [n, s, d] = await Promise.all([erc20(a, SELECTOR.name), erc20(a, SELECTOR.symbol), erc20(a, SELECTOR.decimals)]);
      if (!n || !s || !d) return null;
      try {
        const [name] = decodeAbiParameters([{ type: "string" }], n as `0x${string}`);
        const [symbol] = decodeAbiParameters([{ type: "string" }], s as `0x${string}`);
        const [decimals] = decodeAbiParameters([{ type: "uint8" }], d as `0x${string}`);
        return { name, symbol, decimals };
      } catch {
        return null;
      }
    },
  };
}

export type Reth = ReturnType<typeof createReth>;
