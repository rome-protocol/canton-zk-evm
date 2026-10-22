import type { Lifecycle } from "./block-times.ts";
/** What the server's API answers, as the pages read it. The server's field test holds each answer to exactly these fields. */
export interface LatestBlock { number: number; hash: string; timestamp: number; txCount: number; updateId: string; recordTime: string }
export interface ApiStatus {
  chainId: number;
  chainName: string;
  /** The Canton network the chain runs on, as the header names it; null when the explorer has not been told. */
  networkName: string | null;
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
  /** True when this explorer serves the public RPC at /rpc. */
  publicRpc: boolean;
  /** The newest block the index holds, how many blocks it is behind Canton's finalized head (null while unknown), where stage 2 is, and the chain instance. */
  indexHead: number | null;
  indexLag: number | null;
  deriveCursor: number | null;
  chainInstance: string | null;
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
  /** "unindexed": final on Canton, and the explorer's indexer has not written the block yet (the status says when the indexer is behind or stopped). */
  status: "final" | "proving" | "unindexed" | "genesis";
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
/** Where a transaction is. Pending: in reth's pool. Proving: in a block that is being proven. Final: in a block that is final on Canton. Unindexed: in a block Canton holds that the explorer has not indexed yet. Replaced and dropped: it will not be in a block. */
export type TxState = "pending" | "proving" | "unindexed" | "final" | "replaced" | "dropped";
/** Where a transaction has been, from the producer's journal and the API. A stage that has no time is null, and so is the whole of it when no row is kept. */
export interface TxLifecycle {
  state: string; reason: string | null; acceptedAt: string | null; acceptedVia: string | null; includedAt: string | null; attempts: number; leftOutReason: string | null;
  proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; committedAt: string | null; finalAt: string | null; finalBlock: number | null; timeToFinalMs: number | null;
}
interface ApiTxCommon {
  hash: string;
  /** The state, with "waiting" for pending. */
  status: "final" | "proving" | "unindexed" | "waiting" | "replaced" | "dropped";
  state: TxState;
  /** A plain sentence about why, when there is one. */
  reason: string | null;
  lifecycle: TxLifecycle | null;
  block: { number: number; hash: string | null; updateId: string | null } | null;
  from: string;
  to: string | null;
  nonce: number;
  gasUsed: number | null;
  gasPrice: string | null;
  fee: string | null;
  success: boolean | null;
  logs: Log[];
  transfer: Transfer | null;
  toToken: string | null;
  /** The contract this transaction created. */
  created: string | null;
}
/** A transaction that reth holds, in its pool or in a block. */
export interface ApiTxSeen extends ApiTxCommon {
  /** In wei, as a decimal string. */
  value: string;
  type: number;
  gas: number;
  input: string;
}
/** A transaction the explorer accepted but reth no longer holds: it is being sent again, or it was replaced or dropped. Only who sent it and its nonce are known. */
export interface ApiTxUnseen extends ApiTxCommon {
  value: null;
  type: null;
  gas: null;
  input: null;
}
export type ApiTx = ApiTxSeen | ApiTxUnseen;
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

/** A token or verified contract whose name starts with what was typed. */
export interface SearchMatch { kind: "token" | "contract"; name: string; symbol: string | null; address: string; path: string }
/** What the search found: the page to open (the first match, for a name), and every match when a name matched more than one. */
export type SearchResult = { found: true; path: string; matches: SearchMatch[] } | { found: false; message: string };

/** What the search box typed is: the page to open, or the server's own "not found" message. */
export async function search(q: string): Promise<SearchResult> {
  try {
    const { body } = await call(`/api/search?q=${encodeURIComponent(q)}`, [200]);
    const found = body as { path: string; matches?: SearchMatch[] };
    return { found: true, path: found.path, matches: found.matches ?? [] };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { found: false, message: e.message };
    throw e;
  }
}

/** A page of a list, newest first. `next` is the cursor of the following page, null on the last. */
export interface Page<T> { items: T[]; next: string | null }
export interface BlockListItem { number: number; hash: string; timestamp: number; txCount: number; gasUsed: number; gasLimit: number; miner: string; legsCount: number; baseFee: string; updateId: string; recordTime: string;
  /** ZisK's time for the block, and the way from the producer's cut to Canton's record time, in seconds; null where the producer's journal has no times. */
  proofSeconds: number | null; finalSeconds: number | null }
export type BlockFilter = "all" | "transactions" | "empty";
export interface TxListItem { hash: string; block: number; index: number; timestamp: number; from: string; to: string | null; value: string; nonce: number; type: number; gasUsed: number; gasPrice: string; success: boolean; created: string | null; methodId: string | null }
/** An attempt at a block that is not final: where it is, and when each step happened (UTC, ISO). Nothing here is a fact of the chain until the block is final. */
export interface InFlightAttempt {
  number: number; strategy: string; cutReason: string; stage: "cut" | "built" | "proving" | "proved" | "submitted" | "committed";
  txCount: number | null; poolWaiting: number | null;
  cutAt: string; builtAt: string | null; proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; answeredAt: string | null; outcome: string | null;
}
export interface InFlight { final: false; attempts: InFlightAttempt[]; poolWaiting: { waiting: number; at: string } | null }

export const getBlocks = async (limit: number) => (await call(`/api/blocks?limit=${limit}`, [200])).body as Page<BlockListItem>;
export const getTxs = async (limit: number) => (await call(`/api/txs?limit=${limit}`, [200])).body as Page<TxListItem>;
export const getInFlight = async () => (await call("/api/in-flight", [200])).body as InFlight;

/** What /api/blocks/:id adds to a block's page: the producer's times for the attempt that made it (null when the journal holds none) and its gateway legs. */
export interface BlockDetail { number: number; legsCount: number | null; derived: boolean; lifecycle: Lifecycle | null }
export const getBlockDetail = async (id: string) => (await call(`/api/blocks/${encodeURIComponent(id)}`, [200])).body as BlockDetail;
/** The faucet's own address, or null when it has none (the faucet is off). */
export const getFaucetAddress = async () => ((await call("/api/faucet", [200])).body as { address?: string | null }).address ?? null;
export const getBlock = async (id: string) => (await call(`/api/block/${encodeURIComponent(id)}`, [200])).body as ApiBlock;
export const getTx = async (hash: string) => (await call(`/api/tx/${encodeURIComponent(hash)}`, [200])).body as ApiTx;
export const getAddress = async (address: string) => (await call(`/api/address/${encodeURIComponent(address)}`, [200])).body as ApiAddress;

/** A gateway leg a block recorded, as the legs route gives it. */
export interface LegItem { legIndex: number; txIndex: number; logIndex: number; kind: string; legId: string; token: string; account: string; amount: string }
/** A Canton update that carries a block. `offset` is on the reader party's participant, never the builder's completion offset. */
export interface UpdateItem { updateId: string; recordTime: string; effectiveAt: string | null; participant: string; offset: number; synchronizer: string; block: number | null }
export interface UpdateDetail extends UpdateItem {
  template: { packageId: string; packageName: string | null; module: string; entity: string };
  contractId: string | null;
  blockHash: string | null;
  signatories: { role: string; party: string }[];
  /** What the producer's journal says it submitted for the update; null when the journal does not hold it. */
  producerRecord: { template: string | null; choice: string | null; commandId: string | null; argumentBytes: number | null; trafficBytes: number | null } | null;
}

/** An update in the window around one. The template and the choice are what the producer's log says it submitted, null where the log does not hold the update; `txCount` is the block's. */
export interface UpdateAroundItem extends UpdateItem { submittedTemplate: string | null; submittedChoice: string | null; txCount: number | null }

const PAGE = 25;
const cursor = (name: string, c: string | null) => (c ? `&${name}=${encodeURIComponent(c)}` : "");
/** The paged lists. `before` is the cursor of a list that runs newest first, `after` of one that runs in order; null asks for the first page. */
export const getBlockPage = async (before: string | null, limit = PAGE, filter: BlockFilter = "all") => (await call(`/api/blocks?limit=${limit}${cursor("before", before)}${filter === "all" ? "" : `&filter=${filter}`}`, [200])).body as Page<BlockListItem>;
/** The address of the blocks as a file: the newest blocks of the filter, with the list's columns. */
export const blocksCsvPath = (filter: BlockFilter) => `/api/blocks?format=csv&filter=${filter}`;
export const getBlockTxs = async (id: string, after: string | null, limit = PAGE) => (await call(`/api/blocks/${encodeURIComponent(id)}/transactions?limit=${limit}${cursor("after", after)}`, [200])).body as Page<TxListItem>;
export const getBlockLegs = async (id: string, after: string | null, limit = PAGE) => (await call(`/api/blocks/${encodeURIComponent(id)}/legs?limit=${limit}${cursor("after", after)}`, [200])).body as Page<LegItem>;
export const getUpdates = async (before: string | null, limit = PAGE) => (await call(`/api/canton/updates?limit=${limit}${cursor("before", before)}`, [200])).body as Page<UpdateItem>;
export const getUpdate = async (id: string) => (await call(`/api/canton/updates/${encodeURIComponent(id)}`, [200])).body as UpdateDetail;
/** The updates just newer and just older than one, by the list's key, newest first, the update itself among them. */
export const getUpdatesAround = async (id: string) => (await call(`/api/canton/updates/${encodeURIComponent(id)}/around`, [200])).body as { items: UpdateAroundItem[] };
