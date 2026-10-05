/** What the server's API answers, as the pages read it. The server's field test holds each answer to exactly these fields. */
export interface LatestBlock { number: number; hash: string; timestamp: number; txCount: number; updateId: string; recordTime: string }
export interface ApiStatus {
  chainId: number;
  chainName: string;
  coin: { symbol: string; decimals: number };
  pins: { programVK: string; rootC: string; file: string };
  /** True when reth and Canton can be read and every check the index runs passes. */
  ok: boolean;
  /** True while the explorer is still reading up to the newest block, for the first time or after a new run. `ok` is false meanwhile. A failed check or a failed look is never "starting". */
  starting: boolean;
  problems: string[];
  evm: boolean;
  canton: boolean;
  final: { number: number; hash: string; timestamp: number; recordTime: string } | null;
  proving: { number: number; hash: string; timestamp: number } | null;
  /** The newest final blocks, newest first. */
  latest: LatestBlock[];
  signers: { operator: string; confirmer: string } | null;
  faucet: { on: boolean };
}

/** One fact read from a proof's own bytes, with whether it matches: the two keys against the explorer's pins, the hash against the block. */
export interface Fact { value: string | null; ok: boolean }
export interface Transfer { symbol: string; decimals: number; to: string; value: string }
export interface BlockRow { hash: string; from: string; to: string | null; success: boolean | null; transfer: Transfer | null }
/** The block record on Canton, for a block that is final. The three hex fields are exactly what the record holds. */
export interface CantonSide {
  updateId: string;
  recordTime: string;
  template: string;
  proofBytes: number;
  /** Null when the proof is not 1,344 bytes of hex, so its facts cannot be read. */
  proof: { programVK: Fact; rootC: Fact; blockHash: Fact } | null;
  hashesMatch: boolean;
  headerHex: string;
  txsHex: string;
  proofHex: string;
}
export interface ApiBlock {
  status: "final" | "proving" | "genesis";
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  txCount: number;
  gasUsed: number;
  gasLimit: number;
  /** In wei, as a decimal string. */
  baseFee: string | null;
  miner: string;
  stateRoot: string;
  /** For block 0 only: whether block 1's record names this block as its parent. */
  genesisReferenced: boolean | null;
  canton: CantonSide | null;
  transactions: BlockRow[];
}
export interface Log { address: string; topics: string[]; data: string }
export interface ApiTx {
  hash: string;
  status: "final" | "proving" | "waiting";
  block: { number: number; hash: string | null; updateId: string | null } | null;
  from: string;
  to: string | null;
  /** In wei, as a decimal string. */
  value: string;
  nonce: number;
  type: number;
  gas: number;
  gasUsed: number | null;
  gasPrice: string | null;
  fee: string | null;
  success: boolean | null;
  input: string;
  logs: Log[];
  transfer: Transfer | null;
  toToken: string | null;
  /** The contract this transaction created. */
  created: string | null;
}
export interface ApiAddress {
  address: string;
  kind: "account" | "contract" | "token";
  /** In wei, as a decimal string. */
  balance: string;
  nonce: number;
  token: { name: string; symbol: string; decimals: number } | null;
  createdBy: { txHash: string; block: number } | null;
}

/** A failed call: the server's plain message, or a plain one of ours when it could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const UNREADABLE = "The explorer cannot read the chain right now.";

async function call(path: string, accept: readonly number[]): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(UNREADABLE, 0);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!accept.includes(res.status)) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : UNREADABLE;
    throw new ApiError(message, res.status);
  }
  return { status: res.status, body };
}

/** The status. The server answers 503 with the same fields when a check fails or a node cannot be read, and the pages show that state, so it is an answer here too. */
export async function getStatus(): Promise<ApiStatus> {
  const { body } = await call("/api/status", [200, 503]);
  if (!body || typeof body !== "object" || !("chainId" in body)) throw new ApiError(UNREADABLE, 503);
  return body as ApiStatus;
}

export type SearchResult = { found: true; path: string } | { found: false; message: string };

/** What the search box typed is: the page to open, or the server's own "not found" message. */
export async function search(q: string): Promise<SearchResult> {
  try {
    const { body } = await call(`/api/search?q=${encodeURIComponent(q)}`, [200]);
    return { found: true, path: (body as { path: string }).path };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { found: false, message: e.message };
    throw e;
  }
}

export const getBlock = async (id: string) => (await call(`/api/block/${encodeURIComponent(id)}`, [200])).body as ApiBlock;
export const getTx = async (hash: string) => (await call(`/api/tx/${encodeURIComponent(hash)}`, [200])).body as ApiTx;
export const getAddress = async (address: string) => (await call(`/api/address/${encodeURIComponent(address)}`, [200])).body as ApiAddress;
