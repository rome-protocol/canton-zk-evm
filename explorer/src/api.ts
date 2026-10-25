import type { Lifecycle } from "./block-times.ts";
import type { FaucetInfo } from "./faucet/faucet-client.ts";
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
/** The Canton side as the REST block route gives it: every fact, and none of the record's hex (that is /record, fetched when Verify is pressed). */
export type CantonSummary = Omit<CantonSide, "headerHex" | "txsHex" | "proofHex">;
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

/** One check of /api/health: the word it counts for (`ok`, `degraded` or `down`). */
export interface HealthCheck { id: string; role: string; status: "ok" | "degraded" | "down"; value?: unknown; detail: string | null }
/** What /api/health says: the overall word, whether the index is still starting, and every check it runs. */
export interface ApiHealth { status: "ok" | "degraded" | "down"; starting: boolean; problems: string[]; checks: HealthCheck[] }

/** The health. The server answers 503 with the same fields when a check is down, so that is an answer here too. A body without the list of checks is not one. */
export async function getHealth(): Promise<ApiHealth> {
  const { body } = await call("/api/health", [200, 503]);
  if (!body || typeof body !== "object" || !("checks" in body) || !Array.isArray(body.checks)) throw new ApiError(UNREADABLE, 503);
  return body as ApiHealth;
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
  proofSeconds: number | null; finalSeconds: number | null; commitSeconds: number | null }
export type BlockFilter = "all" | "transactions" | "empty";
/** What a listed transaction moved in tokens: how many moves (counted to a cap, `more` past it) and the first; the whole object is null while stage 2 has not reached its block. */
export interface TokenMove { token: string; amount: string | null; tokenId: string | null; standard: string | null; decimals: number | null }
export interface TokenMoves { count: number; more: boolean; first: TokenMove | null }
/** What is known of an address for showing it by name (GET /api/labels): `kind` is null for an address the index holds nothing of; `amount`s of a token are in base units, shown with its `decimals`. */
export interface Label { address: string; name: string | null; symbol: string | null; kind: "token" | "contract" | "account" | null; standard: string | null; decimals: number | null; verified: boolean }
/** The newest transactions: a page with how many the chain holds (null where the rollups cannot say, and for a filtered list) and when that was counted to. */
export interface TxsPage extends Page<TxListItem> { total: number | null; totalAsOfBlock: number | null; totalAsOf: string | null }
export interface TxListItem { hash: string; block: number; index: number; timestamp: number; from: string; to: string | null; value: string; nonce: number; type: number; gasUsed: number; gasPrice: string; success: boolean; created: string | null; methodId: string | null; tokenMoves: TokenMoves | null;
  /** The Canton update that settled the transaction's block, and the time Canton recorded it. */
  updateId: string; recordTime: string }
/** An attempt at a block that is not final: where it is, and when each step happened (UTC, ISO). Nothing here is a fact of the chain until the block is final. */
export interface InFlightAttempt {
  number: number; strategy: string; cutReason: string; stage: "cut" | "built" | "proving" | "proved" | "submitted" | "committed";
  txCount: number | null; poolWaiting: number | null;
  cutAt: string; builtAt: string | null; proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; answeredAt: string | null; outcome: string | null;
}
/** A transaction that is not final: waiting in reth's pool, or in a block being proven. `at` is when the explorer accepted it (UTC, ISO). */
export interface InFlightTx { hash: string; stage: "waiting" | "proving"; at: string }
export interface InFlight { final: false; attempts: InFlightAttempt[]; poolWaiting: { waiting: number; at: string } | null; transactions: InFlightTx[] }

export const getBlocks = async (limit: number) => (await call(`/api/blocks?limit=${limit}`, [200])).body as Page<BlockListItem>;
export const getTxs = async (limit: number) => (await call(`/api/txs?limit=${limit}`, [200])).body as Page<TxListItem>;
export const getInFlight = async () => (await call("/api/in-flight", [200])).body as InFlight;

/** The windows of the stats routes, and the metrics /api/stats/series draws. */
export type StatsWindow = "1h" | "6h" | "24h" | "7d" | "30d";
export const STATS_WINDOWS: readonly StatsWindow[] = ["1h", "6h", "24h", "7d", "30d"];
/** A time as its middle and its 95th percentile, in seconds, and how many facts it is read from (null where there is none). `capped`: a figure at the top of the histogram's range. */
export interface StatsSpread { median: number; p95: number; samples: number; capped: boolean }
export interface StatsSize { size: string; median: number | null; p95: number | null; samples: number; capped: boolean }
export interface StatsLostItem { txHash: string; state: string; reason: string | null; at: string }
export interface StatsSummary {
  window: StatsWindow; rows: "minute" | "hour" | "day"; from: string; to: string; asOf: string | null; dataSince: string | null;
  tps: { now: number; peak: number | null; peakAt: string | null };
  blockTime: StatsSpread | null; timeToFinal: StatsSpread | null; commitTime: StatsSpread | null; served: StatsSpread | null;
  proofTime: (StatsSpread & { bySize: StatsSize[] }) | null;
  txsPerBlock: { mean: number | null; median: number | null; max: number | null; nonEmptyMean: number | null; nonEmptyMedian: number | null };
  blocks: { count: number; empty: number; busy: number; /** Committed attempts over the decided ones (committed, refused, failed, unknown), not a per-height first-try share; null when none was decided. */ firstTry: number | null; bySize: { size: string; count: number }[] };
  /** `successRate` is accepted transactions that became final over those and the lost and dropped ones; an EVM revert is not in it. `reverted` is the EVM-status count (a normal outcome); `failed` is its deprecated name. */
  txs: { count: number; failed: number; reverted: number; successRate: number | null; accepted: number; acceptedFinal: number; lost: number; droppedByChain: number; delayedByRedo: number; allTime: { total: number; asOfBlock: number; asOf: string } | null };
  attempts: { total: number; committed: number; unknown: number; decided: number; refused: number; failed: number; notTaken: number; refusedShare: number | null; failedShare: number | null; notTakenShare: number | null };
  fullness: number | null;
  canton: { argumentBytesPerBlock: number | null; argumentBytesPerTx: number | null; trafficBytesPerBlock: number | null; trafficReported: number };
  prover: { maxBusyRatio10m: number | null; windowsOver: number; windowsCounted: number; windowSeconds: number; loadedAbove: number; meanBusyRatio: number; busyMs: number };
  quality: { withoutAcceptanceTime: number; clockSkew: number };
  /** Absent from a server older than this page: the page then shows the rule's p95 as unknown. */
  rule?: { slowAboveSeconds: number; hoursCounted: number; hoursMeasured: number; hoursAbove: number | null; worstHourP95: number | null; worstHourAt: string | null; windowsOverByDay: { day: string; windowsOver: number; windowsCounted: number }[] };
  test: { blocks: number; txs: number; attempts: number; proverBusyMs: number };
  today: { date: string; activeAddresses: number | null; newAddresses: number | null; newContracts: number | null; verifiedContracts: number | null; countedAt: string | null } | null;
  waiting: { open: number; pool: { waiting: number; at: string; ageSeconds: number } | null };
  acceptedNotFinal: {
    normal: number | null; slow: number | null; stuck: number; beingProven: number; waiting: number; noAcceptanceTime: number;
    slowAfterSeconds: number | null; stuckAfterSeconds: number; listed: { txHash: string; state: string; ageSeconds: number; acceptedAt: string }[];
  };
  lost: { window: number; total: number; listed: StatsLostItem[] };
  dropped: { window: number; total: number; listed: StatsLostItem[] };
  replaced: { window: number; total: number };
  cutting: { strategy: string; since: string } | null;
  faucet: StatsSummaryFaucet;
}
export type StatsMetric = "txs" | "tps" | "busiest_minute_tps" | "blocks" | "empty_blocks" | "txs_per_block" | "success_rate" | "time_to_final_p50" | "time_to_final_p95" | "proof_time_p50" | "proof_time_p95" | "busy_ratio";
export interface StatsSeries { metric: string; unit: string; window: StatsWindow; step: "1m" | "10m" | "1h" | "1d"; from: string; to: string; asOf: string | null; points: { at: string; value: number | null }[] }
/** The API's own description (OpenAPI), which the API page lists its routes from. */
/** The limits the server holds, as its description states them (each group is there as the server applies it). */
export interface ApiLimits {
  pageSize?: number; rpcPerMinute?: number;
  rest?: { perSecond: number; burst: number };
  etherscan?: { perSecond: number; perMinute: number; maxPageBytes?: number };
  verification?: { perHour: number; maxBodyKb: number };
  streams?: { perClient: number };
}
export interface OpenApiDoc {
  info?: { "x-limits"?: ApiLimits };
  /** `/api` itself is the Etherscan-compatible door: it is listed only where the server serves it, with each module's actions in `x-modules`. */
  paths?: Record<string, Partial<Record<"get" | "post", { summary?: string; "x-modules"?: Record<string, string[]> }>>>;
}
export const getOpenApi = async () => (await call("/api/openapi.json", [200])).body as OpenApiDoc;
export const getStatsSummary = async (window: StatsWindow) => (await call(`/api/stats/summary?window=${window}`, [200])).body as StatsSummary;
export const getStatsSeries = async (metric: StatsMetric, window: StatsWindow, step?: StatsSeries["step"]) =>
  (await call(`/api/stats/series?metric=${metric}&window=${window}${step ? `&step=${step}` : ""}`, [200])).body as StatsSeries;

/** What /api/blocks/:id adds to a block's page: the producer's times for the attempt that made it (null when the journal holds none) and its gateway legs. */
export interface BlockDetail { number: number; legsCount: number | null; derived: boolean; lifecycle: Lifecycle | null }
export const getBlockDetail = async (id: string) => (await call(`/api/blocks/${encodeURIComponent(id)}`, [200])).body as BlockDetail;
/** The faucet's own address, or null when it has none (the faucet is off). */
/** What /api/faucet says; null when the faucet is off or cannot be read. */
export const getFaucetInfo = async () => { try { return (await call("/api/faucet", [200])).body as FaucetInfo; } catch { return null; } };
export const getFaucetAddress = async () => ((await call("/api/faucet", [200])).body as { address?: string | null }).address ?? null;
/** A block as /api/blocks/:id gives it: the block's own facts, the Canton summary with no record hex, and no list of transactions. */
export type BlockSummary = Omit<ApiBlock, "transactions" | "canton"> & { canton: CantonSummary | null; legsCount: number | null; derived: boolean; lifecycle: Lifecycle | null };
export const getBlockSummary = async (id: string) => (await call(`/api/blocks/${encodeURIComponent(id)}`, [200])).body as BlockSummary;
export const getBlock = async (id: string) => (await call(`/api/block/${encodeURIComponent(id)}`, [200])).body as ApiBlock;
export const getTx = async (hash: string) => (await call(`/api/tx/${encodeURIComponent(hash)}`, [200])).body as ApiTx;
/** What /api/txs/:hash adds to a transaction: the stage 2 fields, null until its block is derived. `derived` is false while the explorer has not read the block's calls. */
export type ApiTxDetail = Omit<ApiTxSeen, "logs"> & {
  derived: boolean; callCount: number | null; revertReason: string | null;
  /** Its place in its block, 0-based; null until a block holds it. */
  index: number | null;
  /** In wei, as the sender signed them; null for a legacy transaction, which has one gas price. */
  maxFeePerGas: string | null; maxPriorityFeePerGas: string | null;
};
export const getTxDetail = async (hash: string) => (await call(`/api/txs/${encodeURIComponent(hash)}`, [200])).body as ApiTxDetail;
export const getAddress = async (address: string) => (await call(`/api/address/${encodeURIComponent(address)}`, [200])).body as ApiAddress;

/** A gateway leg a block recorded, as the legs route gives it. */
export interface LegItem { legIndex: number; txIndex: number; logIndex: number; kind: string; legId: string; token: string; account: string; amount: string }
/** A Canton update that carries a block. `offset` is on the reader party's participant, never the builder's completion offset. */
export interface UpdateItem { updateId: string; recordTime: string; effectiveAt: string | null; participant: string; offset: number; synchronizer: string; block: number | null;
  /** How many EVM transactions the update settled (its block's); null for an update that carries no block. */
  txCount: number | null }
export interface UpdateDetail extends UpdateItem {
  template: { packageId: string; packageName: string | null; module: string; entity: string };
  contractId: string | null;
  blockHash: string | null;
  signatories: { role: string; party: string }[];
  /** What the producer's journal says it submitted for the update; null when the journal does not hold it. */
  producerRecord: { template: string | null; choice: string | null; commandId: string | null; argumentBytes: number | null; trafficBytes: number | null } | null;
}

/** An update in the window around one. The template and the choice are what the producer's log says it submitted, null where the log does not hold the update; `txCount` is the block's. */
export interface UpdateAroundItem extends UpdateItem { submittedTemplate: string | null; submittedChoice: string | null }

const PAGE = 25;
const cursor = (name: string, c: string | null) => (c ? `&${name}=${encodeURIComponent(c)}` : "");
/** The paged lists. `before` is the cursor of a list that runs newest first, `after` of one that runs in order; null asks for the first page. */
export const getBlockPage = async (before: string | null, limit = PAGE, filter: BlockFilter = "all") => (await call(`/api/blocks?limit=${limit}${cursor("before", before)}${filter === "all" ? "" : `&filter=${filter}`}`, [200])).body as Page<BlockListItem>;
/** The address of the blocks as a file: the newest blocks of the filter, with the list's columns. */
export const blocksCsvPath = (filter: BlockFilter) => `/api/blocks?format=csv&filter=${filter}`;
export type TxFilter = "all" | "failed" | "calls";
/** The final transactions, newest first, a page at a time; `filter` keeps the reverted ones or the calls into contracts (a transaction with input). */
export const getTxPage = async (before: string | null, limit = PAGE, filter: TxFilter = "all") => (await call(`/api/txs?limit=${limit}${cursor("before", before)}${filter === "all" ? "" : `&filter=${filter}`}`, [200])).body as TxsPage;
/**
 * The transactions oldest first, after a key (`next` of the page before) or from the first: the way to open the list's last page. The page count is `total` over the page
 * size where the total is known. Open the last page with `limit` = `total` % size || size (the full size when that is 0), so that it does not repeat rows of the page before;
 * then page on with `after` and the normal size. The page is in the order the server gives it, oldest first.
 */
export const getTxPageOldest = async (after: string | null, limit = PAGE, filter: TxFilter = "all") => (await call(`/api/txs?order=asc&limit=${limit}${cursor("after", after)}${filter === "all" ? "" : `&filter=${filter}`}`, [200])).body as TxsPage;
/** The newest final transactions of the filter as a file, with the list's columns. */
export const txsCsvPath = (filter: TxFilter) => `/api/txs?format=csv&filter=${filter}`;
/** A block's record as Canton holds it, read only when Verify is pressed. */
export const getBlockRecord = async (id: string | number) => (await call(`/api/blocks/${encodeURIComponent(String(id))}/record`, [200])).body as { number: number; hash: string; contractId: string; header: string; txs: string; proof: string | null };
export const getBlockTxs = async (id: string, after: string | null, limit = PAGE) => (await call(`/api/blocks/${encodeURIComponent(id)}/transactions?limit=${limit}${cursor("after", after)}`, [200])).body as Page<TxListItem>;
export const getBlockLegs = async (id: string, after: string | null, limit = PAGE) => (await call(`/api/blocks/${encodeURIComponent(id)}/legs?limit=${limit}${cursor("after", after)}`, [200])).body as Page<LegItem>;
/** A gateway leg as the legs routes give it: what the EVM recorded, with the block and the transaction that made it. `txHash` is null when the explorer has not stored that transaction; `party` is the Canton party a withdrawal paid, null on the other kinds. */
export interface LegListItem extends LegItem { block: number; txHash: string | null; party: string | null }
export const getLegPage = async (before: string | null, limit = PAGE) => (await call(`/api/legs?limit=${limit}${cursor("before", before)}`, [200])).body as Page<LegListItem>;
export const getLeg = async (id: string) => (await call(`/api/legs/${encodeURIComponent(id)}`, [200])).body as LegListItem;
export const getUpdates = async (before: string | null, limit = PAGE) => (await call(`/api/canton/updates?limit=${limit}${cursor("before", before)}`, [200])).body as Page<UpdateItem>;
export const getUpdate = async (id: string) => (await call(`/api/canton/updates/${encodeURIComponent(id)}`, [200])).body as UpdateDetail;
/** The updates just newer and just older than one, by the list's key, newest first, the update itself among them. */
export const getUpdatesAround = async (id: string) => (await call(`/api/canton/updates/${encodeURIComponent(id)}/around`, [200])).body as { items: UpdateAroundItem[] };

/** A log of a transaction. `decoded` is null while the emitting contract has no verified interface. */
export interface TxLog { logIndex: number; /** Its place among the transaction's own logs, from 0. */ position: number; address: string; topics: string[]; data: string; decoded: { name: string; signature: string; args: { name: string; type: string; value: string }[] } | null }
/** A call that moved value, from the transaction's trace. `traceAddress` places it in the call tree ("t0-1" is the second call of the first call). */
export interface InternalCall { traceAddress: number[]; callType: string; from: string; to: string | null; value: string; gas: number | null; gasUsed: number | null; selector: string | null; inputSize: number; error: string | null }
/** `methodId` and `timestamp` are the transaction's (no method for a creation, and `creation` says it was one); `standard` is the token's, null where the explorer holds no row for it. */
export interface TokenTransfer { logIndex: number; batchIndex: number; methodId: string | null; creation: boolean; timestamp: number; token: string; standard: TokenStandard | null; from: string; to: string; amount: string | null; tokenId: string | null }
/** A page of a list read from the derived stage: `derived` is false while the explorer has not read the transaction's block, and the page is empty. */
export type DerivedPage<T> = Page<T> & { derived?: boolean };
const afterTx = (hash: string, sub: string, after: string | null, limit: number) => `/api/txs/${encodeURIComponent(hash)}/${sub}?limit=${limit}${cursor("after", after)}`;
export const getTxLogs = async (hash: string, after: string | null, limit = PAGE) => (await call(afterTx(hash, "logs", after, limit), [200])).body as Page<TxLog>;
export const getTxInternal = async (hash: string, after: string | null, limit = PAGE) => (await call(afterTx(hash, "internal", after, limit), [200])).body as DerivedPage<InternalCall>;
export const getTxTransfers = async (hash: string, after: string | null, limit = PAGE) => (await call(afterTx(hash, "token-transfers", after, limit), [200])).body as DerivedPage<TokenTransfer>;
export interface TraceFrame { traceAddress: number[]; type: "call" | "create" | "suicide"; callType: string; from: string; to: string | null; value: string; gas: number | null; gasUsed: number | null; input: string; inputSize: number; error: string | null; created: string | null }
export const getTxTrace = async (hash: string) => (await call(`/api/txs/${encodeURIComponent(hash)}/trace`, [200])).body as { frames: TraceFrame[]; truncated: boolean };
/** The receipt of a final transaction as reth gave it. */
export const getTxReceipt = async (hash: string) => (await call(`/api/txs/${encodeURIComponent(hash)}?raw=1`, [200])).body as Record<string, unknown>;

/** An address of the list: the balance is the database's copy, as of `balanceBlock`; the page of one address reads reth's own. */
export interface AddressListItem { address: string; kind: "account" | "contract" | "token"; balance: string | null; balanceBlock: number | null; txCount: number }
export type AddressSort = "balance" | "txs";
/** The first transaction that sent an address value: who, which transaction, when and how much. */
export interface AddressFunding { from: string; txHash: string; block: number; timestamp: number; value: string }
/** One address. `balance` is reth's at the final block `balanceBlock`, null when there is no final block to read it at; the counters are the explorer's, complete as far as `derived`. */
export interface AddressDetail {
  address: string; kind: "account" | "contract" | "token"; balance: string | null; balanceBlock: number | null;
  sentCount: number; receivedCount: number; internalCount: number; tokenTransferCount: number; erc20TransferCount?: number | null; nftTransferCount?: number | null; firstSeenBlock: number | null; firstSeenTimestamp: number | null; lastActiveBlock: number | null; lastActiveTimestamp: number | null;
  /** The contracts it made. */
  createdCount: number;
  /** True when `createdCount` stopped at its ceiling: the address made more. */
  createdCountCapped: boolean;
  /** Who sent it its first coin, null when the explorer cannot say (no such transaction held, the address was there before it, or a token transfer reached it first). */
  fundedBy: AddressFunding | null;
  token: { name: string | null; symbol: string | null; decimals: number | null } | null; createdBy: { txHash: string | null; block: number } | null; derived: boolean;
}
export interface AddressInternalItem extends InternalCall { txHash: string; block: number; txIndex: number }
export interface AddressTransferItem extends TokenTransfer { txHash: string; block: number; txIndex: number }
/** The indexer's own spelling of a token standard. */
export type TokenStandard = "ERC-20" | "ERC-721" | "ERC-1155";
/** What an address holds of a token: `totalSupply` and `decimals` are the token's, null where it has none. */
export interface Holding { token: string; standard: TokenStandard; name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null; tokenId: string; value: string; updatedBlock: number }
export interface CoinPoint { block: number; balance: string }
const of = (a: string, sub = "") => `/api/addresses/${encodeURIComponent(a)}${sub}`;
export const getAddressList = async (sort: AddressSort, before: string | null, limit = PAGE) => (await call(`/api/addresses?sort=${sort}&limit=${limit}${cursor("before", before)}`, [200])).body as DerivedPage<AddressListItem>;
/** What a token is called and counts in, from the token route, which reads no balance from reth. */
export interface TokenInfo { address: string; standard: TokenStandard; name: string | null; symbol: string | null; decimals: number | null }
export const getTokenInfo = async (a: string) => (await call(`/api/tokens/${encodeURIComponent(a)}`, [200])).body as TokenInfo;
/** A token of the list: counts are the explorer's, complete as far as `derived`. `metadataStatus` is read, pending or failed; name, symbol, decimals and supply are null until the contract has answered. */
export interface TokenListItem extends TokenInfo {
  totalSupply: string | null; holderCount: number; transferCount: number; firstTransferBlock: number; gatewayWrapped: boolean; metadataStatus: "read" | "pending" | "failed";
  /** Who made the token's contract, in which block and when (ISO time): all null for a contract of the genesis state, which no creation made. `verified` is whether its source is. */
  creator: string | null; creationBlock: number | null; createdAt: string | null; verified: boolean;
}
export type TokenSort = "holders" | "transfers" | "newest";
/** One token: `balanceMode` says whether its balances are summed from the Transfer logs ("derived") or read with balanceOf. */
/**
 * What the gateway holds on Canton of the instrument a token was registered for: `custody` is in base units of `custodyDecimals`, and `supply` the token's own
 * totalSupply (null when it did not answer); both are read at block `supplyBlock` (the custody at the ledger offset `ledgerOffset` of that block's record), at `readAt`.
 */
export interface CantonCustody { instrumentAdmin: string; instrumentId: string; custody: string; custodyDecimals: number; holdings: number; supply: string | null; supplyBlock: number; ledgerOffset: number; readAt: string }
export interface TokenDetail extends TokenListItem { totalSupplyBlock: number | null; balanceMode: string; derived: boolean; canton: CantonCustody | null }
export interface TokenHolder { holder: string; tokenId: string; value: string; updatedBlock: number }
const tk = (a: string, sub = "") => `/api/tokens/${encodeURIComponent(a)}${sub}`;
/**
 * The token list's page: `total` is the list's own count (of the standard and/or the gateway filter asked, or of all), `counts` is each standard's and `gatewayCount` is the gateway-wrapped
 * tokens' (the From Canton tab), both whatever is asked.
 */
export interface TokenListPage extends DerivedPage<TokenListItem> { total: number; counts: Record<TokenStandard, number>; gatewayCount: number }
/** The tokens in the order of `sort`, a page at a time; of one standard and/or only those the gateway wrapped when asked. */
export const getTokenList = async (sort: TokenSort, before: string | null, limit = PAGE, standard?: TokenStandard, gateway = false) => (await call(`/api/tokens?sort=${sort}&limit=${limit}${cursor("before", before)}${standard ? `&standard=${standard}` : ""}${gateway ? "&gateway=true" : ""}`, [200])).body as TokenListPage;
/**
 * The same list from its other end, after a key (`next` of the page before) or from the first: the way to open the list's last page. Open it with `limit` = `total` % size || size
 * (the full size when that is 0), so that the last page does not repeat rows of the page before; then page on with `after` and the normal size. The page is in the order the
 * server gives it, the reverse of the list's.
 */
export const getTokenListOldest = async (sort: TokenSort, after: string | null, limit = PAGE, standard?: TokenStandard, gateway = false) => (await call(`/api/tokens?sort=${sort}&order=asc&limit=${limit}${cursor("after", after)}${standard ? `&standard=${standard}` : ""}${gateway ? "&gateway=true" : ""}`, [200])).body as TokenListPage;
export const getToken = async (a: string) => (await call(tk(a), [200])).body as TokenDetail;
export const getTokenHolders = async (a: string, before: string | null, limit = PAGE) => (await call(`${tk(a, "/holders")}?limit=${limit}${cursor("before", before)}`, [200])).body as DerivedPage<TokenHolder>;
export const getTokenTransfers = async (a: string, before: string | null, limit = PAGE) => (await call(`${tk(a, "/transfers")}?limit=${limit}${cursor("before", before)}`, [200])).body as DerivedPage<AddressTransferItem>;
export const getAddressDetail = async (a: string) => (await call(of(a), [200])).body as AddressDetail;
/** Which of an address's transactions a list holds: all, those it sent, or those it received. */
export type TxDirection = "all" | "sent" | "received";
const directionQuery = (d: TxDirection) => (d === "all" ? "" : `&direction=${d}`);
export const getAddressTxs = async (a: string, before: string | null, limit = PAGE, direction: TxDirection = "all") => (await call(`${of(a, "/txs")}?limit=${limit}${cursor("before", before)}${directionQuery(direction)}`, [200])).body as Page<TxListItem>;
/** The newest transactions of an address as a CSV file (up to 1,000), kept to the direction. */
export const addressTxsCsvPath = (a: string, direction: TxDirection = "all") => `${of(a, "/txs")}?format=csv${directionQuery(direction)}`;
export const getAddressInternal = async (a: string, before: string | null, limit = PAGE) => (await call(`${of(a, "/internal")}?limit=${limit}${cursor("before", before)}`, [200])).body as DerivedPage<AddressInternalItem>;
/** An address's transfers also take `nft`: ERC-721 and ERC-1155 together, in one list. */
export interface TransferFilter { token?: string; standard?: TokenStandard | "nft" }
const transferFilter = (f: TransferFilter) => `${f.token ? `&token=${encodeURIComponent(f.token)}` : ""}${f.standard ? `&standard=${f.standard}` : ""}`;
export const getAddressTransfers = async (a: string, before: string | null, limit = PAGE, filter: TransferFilter = {}) => (await call(`${of(a, "/token-transfers")}?limit=${limit}${cursor("before", before)}${transferFilter({ token: filter.token, standard: filter.standard })}`, [200])).body as DerivedPage<AddressTransferItem>;
/** The newest token transfers of an address as a CSV file (up to 1,000), kept to the filter. */
export const addressTransfersCsvPath = (a: string, filter: TransferFilter = {}) => `${of(a, "/token-transfers")}?format=csv${transferFilter(filter)}`;
/** The newest transfers of one token as a CSV file (up to 1,000). */
export const tokenTransfersCsvPath = (a: string) => `${tk(a, "/transfers")}?format=csv`;
/** The transfers of every token, newest first, of one standard when asked. */
export const getAllTokenTransfers = async (before: string | null, limit = PAGE, standard?: TokenStandard) => (await call(`/api/token-transfers?limit=${limit}${cursor("before", before)}${transferFilter({ standard })}`, [200])).body as DerivedPage<AddressTransferItem>;
export const getHoldings = async (a: string, after: string | null, limit = PAGE) => (await call(`${of(a, "/tokens")}?limit=${limit}${cursor("after", after)}`, [200])).body as DerivedPage<Holding>;
/** The contracts an address made, newest first. */
export const getAddressContracts = async (a: string, before: string | null, limit = PAGE) => (await call(`${of(a, "/contracts")}?limit=${limit}${cursor("before", before)}`, [200])).body as DerivedPage<ContractListItem>;
export const getCoinHistory = async (a: string, before: string | null, limit = PAGE) => (await call(`${of(a, "/coin-history")}?limit=${limit}${cursor("before", before)}`, [200])).body as DerivedPage<CoinPoint>;

/** A contract in the list. `origin` is "genesis" for a contract the chain's genesis holds (made by no transaction, so no creator and no creation block) or "create". `matchType` is full, partial, or similar (the same code verified at another address). */
export interface ContractListItem {
  address: string; name: string | null; origin: "genesis" | "create"; creator: string | null; creationBlock: number | null;
  /** When its creation's block was made (ISO), null for a contract the explorer did not see made; `compilerVersion` is its verified source's, null while it has none. */
  createdAt: string | null; compilerVersion: string | null;
  interactionCount: number; verified: boolean; matchType: "full" | "partial" | "similar" | null;
  codeSize: number; destroyedBlock: number | null;
  /** The token standard when the contract is a token. The balance and the counts are the explorer's copy, as of `balanceBlock`; null or 0 for a contract it has not seen move. */
  standard: string | null; balance: string | null; balanceBlock: number | null; txCount: number; internalCount: number;
}
export type VerificationMethod = "etherscan" | "api";
export type VerificationTool = "forge" | "hardhat" | "remix" | "unknown";
/** The contract list's page: `total` is the list's own count (of the `verified` filter asked, or of all), `counts` is each filter's, whatever is asked. */
export interface ContractListPage extends DerivedPage<ContractListItem> { total: number; counts: { all: number; verified: number; notVerified: number } }
export type ContractSort = "interactions" | "newest" | "oldest";
export interface ContractDetail extends ContractListItem {
  creationTxHash: string | null; lastInteractionBlock: number | null; codeHash: string; code: string;
  /** How many logs it wrote, counted up to a ceiling; `eventCountCapped` says the count stopped there. */
  eventCount: number; eventCountCapped: boolean;
  proxy: { kind: string; implementation: string | null; beacon: string | null; checkedBlock: number } | null;
  verification: {
    language: string; compilerVersion: string; codeFormat: string; contractPath: string; contractName: string; optimizerEnabled: boolean | null; optimizerRuns: number | null; evmVersion: string | null;
    license: string | null; verifiedAt: string; matchNote: string | null;
    /** How it was verified and the tool its submitter named; null for a source verified before this was kept. */
    method: VerificationMethod | null; tool: VerificationTool | null;
  } | null;
  derived: boolean;
}
/** The verified source of a contract. Every field after `verified` is empty while nothing is verified. */
export interface ContractSource {
  address: string; verified: boolean; matchType: "full" | "partial" | null; language: string | null; compilerVersion: string | null; codeFormat: string | null; contractPath: string | null; contractName: string | null;
  optimizerEnabled: boolean | null; optimizerRuns: number | null; evmVersion: string | null; license: string | null; settings: unknown; files: { path: string; content: string }[]; abi: unknown;
  constructorArgs: string | null; libraries: unknown; verifiedAt: string | null; matchNote: string | null; method: VerificationMethod | null; tool: VerificationTool | null;
}
const at = (a: string, sub = "") => `/api/contracts/${encodeURIComponent(a)}${sub}`;
export const getContractList = async (sort: ContractSort, verified: boolean | null, before: string | null, limit = PAGE) =>
  (await call(`/api/contracts?sort=${sort}&limit=${limit}${verified === null ? "" : `&verified=${verified}`}${cursor("before", before)}`, [200])).body as ContractListPage;
/**
 * The same list from its other end, after a key (`next` of the page before) or from the first: the way to open the list's last page. Open it with `limit` = `total` % size || size so that the last
 * page does not repeat rows of the page before; then page on with `after` and the normal size. The page is in the order the server gives it, the reverse of the list's.
 */
export const getContractListOldest = async (sort: ContractSort, verified: boolean | null, after: string | null, limit = PAGE) =>
  (await call(`/api/contracts?sort=${sort}&order=asc&limit=${limit}${verified === null ? "" : `&verified=${verified}`}${cursor("after", after)}`, [200])).body as ContractListPage;
export const getContract = async (a: string) => (await call(at(a), [200])).body as ContractDetail;
export const getContractSource = async (a: string) => (await call(at(a, "/source"), [200])).body as ContractSource;

/** A log a contract wrote, with the transaction it is in and that transaction's method id (null when its input is empty). */
export interface ContractEvent { txHash: string; block: number; txIndex: number; logIndex: number; /** The block's time, epoch seconds; absent from a server that does not send it yet. */ timestamp?: number; address: string; topics: string[]; data: string; method: string | null; creation: boolean }
export const getContractEvents = async (a: string, topic0: string | null, before: string | null, limit = PAGE) =>
  (await call(`${at(a, "/events")}?limit=${limit}${topic0 ? `&topic0=${topic0}` : ""}${cursor("before", before)}`, [200])).body as Page<ContractEvent>;

/** What the faucet turned away in a summary window, and why. Only the reason is counted, never who asked. */
export interface StatsTurnedAway { total: number; byReason: { address: number; ip: number; hour: number; captcha: number } }
/** The faucet block of `/api/stats/summary` as the server now serves it. `turnedAway` is null for a window that starts before `turnedAwaySince` (shown as not recorded before that time); both are null where the counting never began. */
export interface StatsSummaryFaucet {
  requests: number; sent: number; final: number; failed: number; timeToFinal: StatsSpread | null;
  turnedAway: StatsTurnedAway | null; turnedAwaySince: string | null;
}
