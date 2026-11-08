/**
 * The reads behind the REST routes of the chain (design 6.1): blocks, transactions and Canton updates, as the indexer's rows hold them. Nothing here writes.
 * Lists take a keyset (the parts of the last row's sort key) and a limit, and are asked for one row more than they show, so that the caller knows if there is a next page.
 */
import type { Pool } from "pg";
import { ChainDbError } from "../chain-db.ts";
import { blockLegs as legsOfBlock, type LegCanton } from "../indexer/leg-canton.ts";
import { txTotal as totalOf, type TxTotal } from "./tx-total.ts";
import { addHists, quantile } from "../indexer/stats-hist.ts";
import { ATTEMPT_SPAN_HOURS, sameTry } from "../indexer/canton-view.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A Canton amount's own scale (Daml Numeric 10): the unit of a Canton token's custody, on the token page and on the twins page. */
export const CUSTODY_DECIMALS = 10;
export const hex = (b: Buffer): string => "0x" + b.toString("hex");
export const hexOrNull = (b: Buffer | null): string | null => (b === null ? null : hex(b));
export const bytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
export const MS = (c: string): string => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const US = (c: string): string => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.replace(/(\.\d{3})000Z/, "$1Z");
export const isoTime = (s: string): string => s.replace(/(\.\d{3})000Z$/, "$1Z");

/** A trace address as a page key: "t", then the indexes joined by "-" (the top call, which has none, is just "t"). */
export const traceKey = (a: number[]): string => "t" + a.join("-");
export const addressOfKey = (key: string): number[] => (key === "t" ? [] : key.slice(1).split("-").map(Number));

export interface BlockListItem { number: number; hash: string; timestamp: number; txCount: number; gasUsed: number; gasLimit: number; miner: string; legsCount: number; baseFee: string; updateId: string; recordTime: string;
  /** ZisK's time for the block, the way from the producer's cut to Canton's record time, and Canton's own commit (the producer's submit to the record time), in seconds; null for a block the journal did not write. */
  proofSeconds: number | null; finalSeconds: number | null; commitSeconds: number | null }
export type BlockFilter = "all" | "transactions" | "empty";
export type TxFilter = "all" | "failed" | "calls";
export interface TxListItem {
  hash: string; block: number; index: number; timestamp: number; from: string; to: string | null; value: string; nonce: number; type: number; gasUsed: number; gasPrice: string; success: boolean; created: string | null;
  /** The input's first 4 bytes as 0x hex; null for a transaction with no input (a plain transfer or a creation with no arguments). */
  methodId: string | null;
  /**
   * The token moves of the transaction's logs (stage 2's rows): how many, and the first. Null while stage 2 has not reached the transaction's block, which is not the same as
   * none: `count` is 0 and `first` null for a transaction that moved no token. A count stops at TOKEN_MOVES_CAP; `more` says there are more than that.
   */
  tokenMoves: TokenMoves | null;
  /** The Canton update that settled the transaction's block, and the time Canton recorded it (every transaction here is in a final block, so both are always there). */
  updateId: string; recordTime: string;
}
export interface TokenMove { token: string; amount: string | null; tokenId: string | null; standard: string | null; decimals: number | null }
export interface TokenMoves { count: number; more: boolean; first: TokenMove | null }
/** The most token moves counted for one transaction in a list; a transaction with more says `more`. */
export const TOKEN_MOVES_CAP = 100;
export interface BlockExtras {
  legsCount: number;
  /** The producer's attempt that made the block, from its journal; null before the journal is loaded. */
  lifecycle: { strategy: string; cutReason: string; cutAt: string; builtAt: string | null; proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; answeredAt: string | null } | null;
}
export interface LegItem { legIndex: number; txIndex: number; logIndex: number; kind: string; gateway: string | null; legId: string; token: string; account: string; amount: string; canton: LegCanton | null }
export interface LogItem { logIndex: number; position: number; address: string; topics: string[]; data: string }
export interface InternalItem { traceAddress: number[]; callType: string; from: string; to: string | null; value: string; gas: number | null; gasUsed: number | null; selector: string | null; inputSize: number | null; error: string | null }
export interface TransferItem { logIndex: number; batchIndex: number; methodId: string | null; creation: boolean; timestamp: number; token: string; standard: string | null; from: string; to: string; amount: string | null; tokenId: string | null }
export interface TxPlace { block: number; index: number }
export interface TxTrace { callCount: number; revertReason: string | null; revertData: string | null }
export interface UpdateItem { updateId: string; recordTime: string; effectiveAt: string | null; participant: string; offset: number; synchronizer: string; block: number | null;
  /** How many EVM transactions the update settled (its block's); null for an update that carries no block. */
  txCount: number | null }
export interface UpdateDetail extends UpdateRow {
  template: { packageId: string; packageName: string | null; module: string; entity: string }; contractId: string | null; blockHash: string | null; signatories: { role: string; party: string }[];
  /** What the producer's journal says it submitted for the update; null for an update the journal does not hold. */
  producerRecord: { template: string | null; choice: string | null; commandId: string | null; argumentBytes: number | null; trafficBytes: number | null } | null;
  view: UpdateView;
}
/** The legs of a block by kind; a payment here is one that is neither a lock nor a release. */
export interface UpdateLegs { total: number; deposit: number; withdrawal: number; payment: number; lock: number; release: number }
export type UpdateStatus = "first" | "retried";
/** What the Linked to Canton list adds to an update. Each is null where nothing holds it: attempts and status need the producer's journal, legs wait for the block's legs to be indexed. */
export interface UpdateRow extends UpdateItem {
  /** `first`: committed on the first attempt; `retried`: after more than one. */
  status: UpdateStatus | null;
  /** Submissions to Canton for the block up to and including the one that committed. */
  attempts: number | null;
  /** Of those attempts, the ones Canton refused (and that were not found committed after all). Null with `attempts`. */
  refused: number | null;
  /** Seconds from `settleFrom` to Canton's record time; null when not worked out or when the two clocks disagree. */
  settleSeconds: number | null;
  /** `proofStart` (the proof's start in the producer's journal) or `blockTime` (the block's own timestamp, whole seconds). */
  settleFrom: "proofStart" | "blockTime" | null;
  submittedTemplate: string | null; submittedChoice: string | null;
  legs: UpdateLegs | null;
}
export type UpdateFilter = "all" | "first" | "retried" | "refused" | "legs";
export interface AttemptItem { number: number; outcome: string; reason: string | null; committed: boolean; cutAt: string; builtAt: string | null; proofStartedAt: string | null; proofEndedAt: string | null; proofOutcome: string | null; submittedAt: string | null; answeredAt: string | null }
export interface TimelineStep { step: "built" | "proofStarted" | "proofDone" | "submitted" | "committed"; at: string; source: "producer" | "block" | "canton" }
export interface UpdateView {
  attempts: AttemptItem[]; timeline: TimelineStep[];
  /** The proof is checked by the confirmers when the block is committed, and the committed update is the evidence: the record exists only if they accepted it. */
  proofCheck: { evidence: "committed update"; confirmers: number; matchesPins: boolean | null; matchesBlock: boolean | null };
}
export interface CantonStats {
  asOf: string | null; dataSince: string | null;
  blocks: number; retriedBlocks: number;
  /** `submitted` is every attempt; `pending` of them have no answer yet and are left out of the rate. */
  attempts: { submitted: number; committed: number; refused: number; pending: number; other: number; since: string | null };
  successRate: number | null;
  settlement: { window: string; from: string; to: string; blocks: number; averageSeconds: number | null; p95Seconds: number | null; /** The p95 is above the last bucket edge: it is at least `p95Seconds`. */ p95Capped: boolean; basis: "proofStart" };
  legs: { deposit: number; withdrawal: number; payment: number; lock: number; release: number; total: number };
}
export const STATS_WINDOWS = { "24h": 24, "7d": 168 } as const;
/** An update in the list around one: what the producer's log says it submitted is null for an update the log does not hold. */
export interface UpdateAroundItem extends UpdateItem { submittedTemplate: string | null; submittedChoice: string | null }
export interface BlockRecordRow { number: number; hash: string; contractId: string; headerHex: string; txsHex: string; proofHex: string | null }

export const txSelect = `t.block_number, t.tx_index, t.hash, extract(epoch from b.timestamp)::bigint as ts, t.from_address, t.to_address, t.value::text as value, t.nonce, t.type, t.gas_used,
  t.effective_gas_price::text as price, t.status, t.created_contract, t.method_id, b.update_id, ${US("b.record_time")} as record_time`;
export const txItem = (r: Row): TxListItem => ({
  hash: hex(r.hash), block: Number(r.block_number), index: r.tx_index, timestamp: Number(r.ts), from: hex(r.from_address), to: hexOrNull(r.to_address), value: r.value, nonce: Number(r.nonce),
  type: r.type, gasUsed: Number(r.gas_used), gasPrice: r.price, success: r.status === 1, created: hexOrNull(r.created_contract), methodId: hexOrNull(r.method_id), tokenMoves: null, updateId: r.update_id, recordTime: isoTime(r.record_time),
});

/**
 * The items with their token moves: one query for the whole page (the rows of the transactions' own blocks that belong to them, each transaction's first CAP + 1 by log), never one
 * for each item. An item in a block above the derive cursor keeps `tokenMoves` null: stage 2 has not written its transfers, so none is not known.
 */
export async function withTokenMoves(query: (sql: string, values?: unknown[]) => Promise<Row[]>, items: TxListItem[]): Promise<TxListItem[]> {
  if (items.length === 0) return items;
  const [c] = await query("select position from cursors where stream = 'derive'");
  const cursor = c ? Number(c.position) : 0;
  const ready = items.filter((t) => t.block <= cursor);
  if (ready.length === 0) return items;
  const rows = await query(
    `select m.block_number, m.tx_index, m.n, m.token, m.amount, m.token_id, tk.standard, tk.decimals
     from (select x.block_number, x.tx_index, row_number() over (partition by x.block_number, x.tx_index order by x.log_index, x.batch_index) as n, x.token, x.amount::text as amount, x.token_id::text as token_id
           from token_transfers x join unnest($1::bigint[], $2::int[]) as k(block_number, tx_index) on x.block_number = k.block_number and x.tx_index = k.tx_index) m
       left join tokens tk on tk.address = m.token
     where m.n <= $3 order by m.block_number, m.tx_index, m.n`,
    [ready.map((t) => t.block), ready.map((t) => t.index), TOKEN_MOVES_CAP + 1],
  );
  const by = new Map<string, TokenMoves>();
  for (const r of rows) {
    const key = `${r.block_number}:${r.tx_index}`;
    const n = Number(r.n);
    if (n === 1) by.set(key, { count: 1, more: false, first: { token: hex(r.token), amount: r.amount, tokenId: r.token_id, standard: r.standard, decimals: r.decimals === null || r.decimals === undefined ? null : Number(r.decimals) } });
    else {
      const m = by.get(key) as TokenMoves;
      m.count = Math.min(n, TOKEN_MOVES_CAP);
      m.more = n > TOKEN_MOVES_CAP;
    }
  }
  return items.map((t) => (t.block <= cursor ? { ...t, tokenMoves: by.get(`${t.block}:${t.index}`) ?? { count: 0, more: false, first: null } } : t));
}

export type ChainRest = ReturnType<typeof createChainRest>;

export function createChainRest(pool: Pool, now: () => number = Date.now) {
  async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
    try {
      return (await pool.query(sql, values)).rows;
    } catch (e) {
      throw new ChainDbError(`the database cannot be read: ${(e as Error).message}`);
    }
  }

  /** The block stage 2 has derived up to (0 before any): a block at or below it has its internal calls, token transfers and counts. */
  async function deriveCursor(): Promise<number> {
    const [r] = await query("select position from cursors where stream = 'derive'");
    return r ? Number(r.position) : 0;
  }

  /** A final block's number from its number or its hash. */
  async function numberOf(key: number | string): Promise<number | undefined> {
    const [r] = typeof key === "number" ? await query("select number from blocks where number = $1", [key]) : await query("select number from blocks where hash = $1", [bytes(key)]);
    return r && Number(r.number);
  }

  /** The newest final blocks; `filter` keeps all of them, the ones with transactions, or the empty ones (genesis is not an empty block). */
  async function blocks(before: number | null, limit: number, filter: BlockFilter = "all"): Promise<BlockListItem[]> {
    const where = { all: "", transactions: "and b.tx_count > 0", empty: "and b.tx_count = 0 and b.number > 0" }[filter];
    const rows = await query(
      `select b.number, b.hash, extract(epoch from b.timestamp)::bigint as ts, b.tx_count, b.gas_used, b.gas_limit, b.fee_recipient, (b.legs_count + (select count(*) from gateway_legs x where x.block_number = b.number and x.gateway is not null)::int) as legs_count, b.base_fee_per_gas::text as base_fee, b.update_id, ${US("b.record_time")} as record_time,
         round(extract(epoch from a.proof_ended_at - a.proof_started_at)::numeric, 3)::float8 as proof_seconds, round(extract(epoch from b.record_time - a.cut_at)::numeric, 3)::float8 as final_seconds,
         round(extract(epoch from b.record_time - a.submitted_at)::numeric, 3)::float8 as commit_seconds
       from blocks b left join block_attempts a on a.attempt_id = b.attempt_id where ($1::bigint is null or b.number < $1) ${where} order by b.number desc limit $2`,
      [before, limit + 1],
    );
    return rows.map((r) => ({
      number: Number(r.number), hash: hex(r.hash), timestamp: Number(r.ts), txCount: r.tx_count, gasUsed: Number(r.gas_used), gasLimit: Number(r.gas_limit), miner: hex(r.fee_recipient),
      legsCount: r.legs_count, baseFee: r.base_fee, updateId: r.update_id, recordTime: isoTime(r.record_time), proofSeconds: r.proof_seconds, finalSeconds: r.final_seconds, commitSeconds: r.commit_seconds,
    }));
  }

  /** The legs count and the producer's times for a final block. */
  async function blockExtras(number: number): Promise<BlockExtras | undefined> {
    const [r] = await query(
      `select (b.legs_count + (select count(*) from gateway_legs x where x.block_number = b.number and x.gateway is not null)::int) as legs_count, a.strategy, a.cut_reason, ${MS("a.cut_at")} as cut_at, ${MS("a.built_at")} as built_at, ${MS("a.proof_started_at")} as proof_started_at,
         ${MS("a.proof_ended_at")} as proof_ended_at, ${MS("a.submitted_at")} as submitted_at, ${MS("a.answered_at")} as answered_at
       from blocks b left join block_attempts a on a.attempt_id = b.attempt_id where b.number = $1`,
      [number],
    );
    return r && {
      legsCount: r.legs_count,
      lifecycle: r.strategy === null ? null : {
        strategy: r.strategy, cutReason: r.cut_reason, cutAt: r.cut_at, builtAt: r.built_at, proofStartedAt: r.proof_started_at, proofEndedAt: r.proof_ended_at, submittedAt: r.submitted_at, answeredAt: r.answered_at,
      },
    };
  }

  /** All transactions, newest first, after the key (block, index) when one is given; `filter` keeps the reverted ones or the calls that name a method (a `to` and at least 4 bytes of input). `moves` false leaves their token moves null: a file that does not write them need not read them. */
  async function txs(before: (number | string)[] | null, limit: number, filter: TxFilter = "all", moves = true, order: "desc" | "asc" = "desc"): Promise<TxListItem[]> {
    const [bn, ix] = before ?? [null, null];
    const where = { all: "", failed: "and t.status = 0", calls: "and t.method_id is not null and t.to_address is not null" }[filter];
    // The key is the last row shown either way: below it newest first, above it oldest first (the list's last page is the first page of this).
    const [past, dir] = order === "desc" ? ["<", "desc"] : [">", "asc"];
    const rows = await query(
      `select ${txSelect} from transactions t join blocks b on b.number = t.block_number
       where ($1::bigint is null or (t.block_number, t.tx_index) ${past} ($1::bigint, $2::int)) ${where} order by t.block_number ${dir}, t.tx_index ${dir} limit $3`,
      [bn, ix, limit + 1],
    );
    return moves ? withTokenMoves(query, rows.map(txItem)) : rows.map(txItem);
  }

  /** How many transactions the chain holds, exact through the newest final block: see tx-total.ts. */
  const txTotal = (): Promise<TxTotal | null> => totalOf(query);

  /** One block's transactions in order, after the index when one is given. */
  async function blockTxs(number: number, after: number | null, limit: number): Promise<TxListItem[]> {
    const rows = await query(
      `select ${txSelect} from transactions t join blocks b on b.number = t.block_number where t.block_number = $1 and ($2::int is null or t.tx_index > $2) order by t.tx_index limit $3`,
      [number, after, limit + 1],
    );
    return withTokenMoves(query, rows.map(txItem));
  }

  /** The legs of a block after the leg index `after`, one more than `limit` of them, each with what Canton shows of the swap it is one side of. */
  async function blockLegs(number: number, after: number | null, limit: number): Promise<LegItem[]> {
    const legs = await legsOfBlock(pool, number, { after, limit: limit + 1 }).catch((e: Error) => { throw new ChainDbError(`the database cannot be read: ${e.message}`); });
    return legs.map((l) => ({ legIndex: l.legIndex, txIndex: l.txIndex, logIndex: l.logIndex, kind: l.kind, gateway: l.gateway, legId: l.legId, token: l.token, account: l.account, amount: l.amount, canton: l.canton }));
  }

  /** A block's record as the Verify page needs it: the header, the transactions and the proof, all as hex. */
  async function record(number: number): Promise<BlockRecordRow | undefined> {
    const [r] = await query(
      "select b.number, b.hash, r.contract_id, r.header, r.txs, p.proof from blocks b join block_records r on r.number = b.number left join proofs p on p.number = b.number where b.number = $1",
      [number],
    );
    return r && { number: Number(r.number), hash: hex(r.hash), contractId: r.contract_id, headerHex: (r.header as Buffer).toString("hex"), txsHex: (r.txs as Buffer).toString("hex"), proofHex: r.proof ? (r.proof as Buffer).toString("hex") : null };
  }

  /** Where a final transaction sits. */
  async function placeOf(hash: string): Promise<TxPlace | undefined> {
    const [r] = await query("select block_number, tx_index from tx_hashes where hash = $1", [bytes(hash)]);
    return r && { block: Number(r.block_number), index: r.tx_index };
  }

  /** The fee caps the sender signed (null for a legacy or EIP-2930 transaction, which has one gas price). */
  async function feeCapsOf(at: TxPlace): Promise<{ maxFeePerGas: string | null; maxPriorityFeePerGas: string | null }> {
    const [r] = await query("select max_fee_per_gas::text as max_fee, max_priority_fee_per_gas::text as max_priority from transactions where block_number = $1 and tx_index = $2", [at.block, at.index]);
    return { maxFeePerGas: r?.max_fee ?? null, maxPriorityFeePerGas: r?.max_priority ?? null };
  }

  /** Stage 2's row for a transaction: undefined until the block is derived. */
  async function traceOf(at: TxPlace): Promise<TxTrace | undefined> {
    const [r] = await query("select call_count, revert_reason, revert_data from tx_traces where block_number = $1 and tx_index = $2", [at.block, at.index]);
    return r && { callCount: r.call_count, revertReason: r.revert_reason, revertData: hexOrNull(r.revert_data) };
  }

  async function txLogs(at: TxPlace, after: number | null, limit: number): Promise<LogItem[]> {
    const rows = await query(
      `select * from (select log_index, address, topic0, topic1, topic2, topic3, data, row_number() over (order by log_index) - 1 as position from logs where block_number = $1 and tx_index = $2) l
       where ($3::int is null or log_index > $3) order by log_index limit $4`,
      [at.block, at.index, after, limit + 1],
    );
    return rows.map((l) => ({
      logIndex: l.log_index, position: Number(l.position), address: hex(l.address),
      topics: [l.topic0, l.topic1, l.topic2, l.topic3].flatMap((t, i, all) => (t !== null && all.slice(0, i).every((x) => x !== null) ? [hex(t)] : [])), data: hex(l.data),
    }));
  }

  async function txInternal(at: TxPlace, after: string | null, limit: number): Promise<InternalItem[]> {
    const rows = await query(
      `select trace_address, call_type, from_address, to_address, value::text as value, gas, gas_used, input_selector, input_size, error from internal_calls
       where block_number = $1 and tx_index = $2 and ($3::int[] is null or trace_address > $3::int[]) order by trace_address limit $4`,
      [at.block, at.index, after === null ? null : addressOfKey(after), limit + 1],
    );
    return rows.map((r) => ({
      traceAddress: r.trace_address, callType: r.call_type, from: hex(r.from_address), to: hexOrNull(r.to_address), value: r.value, gas: r.gas === null ? null : Number(r.gas),
      gasUsed: r.gas_used === null ? null : Number(r.gas_used), selector: hexOrNull(r.input_selector), inputSize: r.input_size, error: r.error,
    }));
  }

  async function txTransfers(at: TxPlace, after: (number | string)[] | null, limit: number): Promise<TransferItem[]> {
    const [li, bi] = after ?? [null, null];
    // The transaction and its block are one row each, and the token's standard one join: the query is the same whatever the page's size.
    const rows = await query(
      `select x.log_index, x.batch_index, x.token, x.from_address, x.to_address, x.amount::text as amount, x.token_id::text as token_id, t.method_id, t.to_address as tx_to,
         extract(epoch from b.timestamp)::bigint as ts, tk.standard
       from token_transfers x join transactions t on t.block_number = x.block_number and t.tx_index = x.tx_index join blocks b on b.number = x.block_number left join tokens tk on tk.address = x.token
       where x.block_number = $1 and x.tx_index = $2 and ($3::int is null or (x.log_index, x.batch_index) > ($3::int, $4::int)) order by x.log_index, x.batch_index limit $5`,
      [at.block, at.index, li, bi, limit + 1],
    );
    return rows.map((r) => ({
      logIndex: r.log_index, batchIndex: r.batch_index, methodId: r.tx_to === null ? null : hexOrNull(r.method_id), creation: r.tx_to === null, timestamp: Number(r.ts), token: hex(r.token), standard: r.standard,
      from: hex(r.from_address), to: hex(r.to_address), amount: r.amount, tokenId: r.token_id,
    }));
  }

  /** The key carries the record time in whole microseconds; it is compared as a time (exactly) on the column itself, so the index on (record_time, update_id) answers it. */
  const EPOCH = "timestamptz 'epoch'";
  const MICROS = "(extract(epoch from u.record_time) * 1000000)::bigint";
  const updateSelect = `u.update_id, ${US("u.record_time")} as record_time, ${US("u.effective_at")} as effective_at, p.participant_id, u.reader_offset, s.synchronizer_id, ${MICROS} as micros,
    (select min(b.number) from blocks b where b.update_id = u.update_id) as block,
    (select b.tx_count from blocks b where b.update_id = u.update_id order by b.number limit 1) as tx_count`;
  const updateItem = (r: Row): UpdateItem => ({
    updateId: r.update_id, recordTime: isoTime(r.record_time), effectiveAt: r.effective_at && isoTime(r.effective_at), participant: r.participant_id, offset: Number(r.reader_offset),
    synchronizer: r.synchronizer_id, block: r.block === null ? null : Number(r.block), txCount: r.tx_count === null ? null : Number(r.tx_count),
  });

  const LEGS_COLS = "u.legs_done, u.legs_total, u.legs_deposit, u.legs_withdrawal, u.legs_payment, u.legs_lock, u.legs_release";
  const rowSelect = `${updateSelect}, u.commit_attempts, u.refused_attempts, u.settle_seconds, u.settle_from, u.submitted_template, u.submitted_choice, ${LEGS_COLS}`;
  const legsOf = (r: Row): UpdateLegs | null => (r.legs_done ? { total: r.legs_total, deposit: r.legs_deposit, withdrawal: r.legs_withdrawal, payment: r.legs_payment, lock: r.legs_lock, release: r.legs_release } : null);
  const updateRow = (r: Row): UpdateRow => ({
    ...updateItem(r), status: r.commit_attempts === null ? null : r.commit_attempts > 1 ? "retried" : "first", attempts: r.commit_attempts, refused: r.refused_attempts, settleSeconds: r.settle_seconds,
    settleFrom: r.settle_from === "proof_start" ? "proofStart" : r.settle_from === "block_time" ? "blockTime" : null, submittedTemplate: r.submitted_template, submittedChoice: r.submitted_choice, legs: legsOf(r),
  });
  const FILTER_SQL: Record<UpdateFilter, string> = { all: "", first: "and u.commit_attempts = 1", retried: "and u.commit_attempts > 1", refused: "and u.refused_attempts > 0", legs: "and u.legs_done and u.legs_total > 0" };

  /** Canton updates, newest first (or oldest first with `asc`), after the key (record time in microseconds, update id); `filter` keeps the ones committed on the first attempt, after more, after a refused attempt, or with legs. */
  async function updates(before: (number | string)[] | null, limit: number, filter: UpdateFilter = "all", asc = false): Promise<(UpdateRow & { micros: number })[]> {
    const [at, id] = before ?? [null, null];
    const op = asc ? ">" : "<", dir = asc ? "asc" : "desc";
    const rows = await query(
      `select ${rowSelect} from canton_updates u join canton_participants p on p.id = u.participant join canton_synchronizers s on s.id = u.synchronizer
       where ($1::bigint is null or (u.record_time, u.update_id) ${op} (${EPOCH} + $1::bigint * interval '1 microsecond', $2::text)) ${FILTER_SQL[filter]} order by u.record_time ${dir}, u.update_id ${dir} limit $3`,
      [at, id, limit + 1],
    );
    return rows.map((r) => ({ ...updateRow(r), micros: Number(r.micros) }));
  }

  const aroundSelect = `${updateSelect}, u.submitted_template, u.submitted_choice`;
  const aroundFrom = "from canton_updates u join canton_participants p on p.id = u.participant join canton_synchronizers s on s.id = u.synchronizer";
  const aroundItem = (r: Row): UpdateAroundItem & { micros: number } => ({
    ...updateItem(r), submittedTemplate: r.submitted_template, submittedChoice: r.submitted_choice, micros: Number(r.micros),
  });

  /** One update as the list around it shows it; undefined when there is no such update. */
  async function aroundOne(updateId: string): Promise<UpdateAroundItem & { micros: number } | undefined> {
    const [r] = await query(`select ${aroundSelect} ${aroundFrom} where u.update_id = $1`, [updateId]);
    return r && aroundItem(r);
  }

  /** The `n` updates after the key (record time in microseconds, update id) and the `n` before it, by the list's own key; newest first, without the update at the key. */
  async function around(at: number, updateId: string, n: number): Promise<{ newer: UpdateAroundItem[]; older: UpdateAroundItem[] }> {
    const key = `(${EPOCH} + $1::bigint * interval '1 microsecond', $2::text)`;
    const [newer, older] = await Promise.all([
      query(`select ${aroundSelect} ${aroundFrom} where (u.record_time, u.update_id) > ${key} order by u.record_time, u.update_id limit $3`, [at, updateId, n]),
      query(`select ${aroundSelect} ${aroundFrom} where (u.record_time, u.update_id) < ${key} order by u.record_time desc, u.update_id desc limit $3`, [at, updateId, n]),
    ]);
    return { newer: newer.reverse().map(aroundItem), older: older.map(aroundItem) };
  }

  /** The block an update carries (its lowest, when it carries more than one); undefined for an update that carries none. */
  async function updateBlock(updateId: string): Promise<number | undefined> {
    const [r] = await query("select min(number) as number from blocks where update_id = $1", [updateId]);
    return r?.number === null || r === undefined ? undefined : Number(r.number);
  }

  /** The attempts that led to a block's commit, its timeline and the check of its proof. */
  async function viewOf(updateId: string, recordTime: string, signatories: { role: string }[]): Promise<UpdateView> {
    const [b] = await query(
      `select b.number, ${MS("b.timestamp")} as ts, b.attempt_id, a.cut_at as cut_at_raw, a.parent_hash as parent_raw, ${MS("a.built_at")} as built_at, ${MS("a.proof_started_at")} as proof_started_at, ${MS("a.proof_ended_at")} as proof_ended_at,
              ${MS("a.submitted_at")} as submitted_at, p.matches_pins, p.matches_block
         from blocks b left join block_attempts a on a.attempt_id = b.attempt_id left join proofs p on p.number = b.number where b.update_id = $1 order by b.number limit 1`, [updateId]);
    const proofCheck = { evidence: "committed update" as const, confirmers: signatories.filter((x) => x.role === "confirmer").length, matchesPins: b?.matches_pins ?? null, matchesBlock: b?.matches_block ?? null };
    const timeline: TimelineStep[] = [];
    const add = (step: TimelineStep["step"], at: string | null, source: TimelineStep["source"]) => { if (at !== null) timeline.push({ step, at: isoTime(at), source }); };
    if (b) {
      if (b.built_at !== null) add("built", b.built_at, "producer"); else add("built", b.ts, "block");
      add("proofStarted", b.proof_started_at, "producer");
      add("proofDone", b.proof_ended_at, "producer");
      add("submitted", b.submitted_at, "producer");
    }
    add("committed", recordTime, "canton");
    let attempts: AttemptItem[] = [];
    if (b && b.attempt_id !== null) {
      const rows = await query(
        `select x.attempt_id, x.outcome, x.resolved_outcome, x.reason, ${MS("x.cut_at")} as cut_at, ${MS("x.built_at")} as built_at, ${MS("x.proof_started_at")} as proof_started_at, ${MS("x.proof_ended_at")} as proof_ended_at,
                x.proof_outcome, ${MS("x.submitted_at")} as submitted_at, ${MS("x.answered_at")} as answered_at
           from block_attempts x left join producer_runs r on r.run_id = x.run_id
          where x.number = $1 and (x.attempt_id = $2 or (${sameTry("x", "r", "$3::timestamptz", "$5::bytea", "$4")})) order by x.cut_at, x.attempt_id`, [b.number, b.attempt_id, b.cut_at_raw, ATTEMPT_SPAN_HOURS, b.parent_raw]);
      attempts = rows.map((x, i) => ({
        number: i + 1, outcome: Number(x.attempt_id) === Number(b.attempt_id) ? "committed" : x.outcome ?? (x.resolved_outcome === "committed" ? "committed" : x.resolved_outcome) ?? "unknown", reason: x.reason,
        committed: Number(x.attempt_id) === Number(b.attempt_id), cutAt: isoTime(x.cut_at), builtAt: x.built_at, proofStartedAt: x.proof_started_at, proofEndedAt: x.proof_ended_at, proofOutcome: x.proof_outcome, submittedAt: x.submitted_at, answeredAt: x.answered_at,
      }));
    }
    return { attempts, timeline, proofCheck };
  }

  async function update(updateId: string): Promise<UpdateDetail | undefined> {
    const [r] = await query(
      `select ${rowSelect}, t.package_id, t.package_name, t.module, t.entity, u.signatories, u.command_id, u.argument_bytes, u.traffic_bytes,
         (select r.contract_id from block_records r join blocks b on b.number = r.number where b.update_id = u.update_id order by b.number limit 1) as contract_id,
         (select b.hash from blocks b where b.update_id = u.update_id order by b.number limit 1) as block_hash
       from canton_updates u join canton_participants p on p.id = u.participant join canton_synchronizers s on s.id = u.synchronizer join canton_templates t on t.id = u.reader_template
       where u.update_id = $1`,
      [updateId],
    );
    if (!r) return undefined;
    const signatories = (await query("select role, party from canton_parties where id = any($1::smallint[]) order by role, id", [r.signatories])).map((s) => ({ role: s.role as string, party: s.party as string }));
    const journal = r.command_id !== null || r.submitted_template !== null;
    const item = updateRow(r);
    return {
      ...item, template: { packageId: r.package_id, packageName: r.package_name, module: r.module, entity: r.entity }, contractId: r.contract_id, blockHash: hexOrNull(r.block_hash),
      signatories,
      producerRecord: journal ? { template: r.submitted_template, choice: r.submitted_choice, commandId: r.command_id, argumentBytes: r.argument_bytes, trafficBytes: r.traffic_bytes } : null,
      view: await viewOf(updateId, item.recordTime, signatories),
    };
  }

  /** The header's figures, from the hourly rollup (`canton_view_hour`, `canton_view_hist`): the totals of every hour, and the settlement time over a window of whole hours (the open hour included). */
  async function cantonStats(window: keyof typeof STATS_WINDOWS = "24h"): Promise<CantonStats> {
    const t = now(), hours = STATS_WINDOWS[window], from = new Date(Math.floor(t / 3_600_000) * 3_600_000 - (hours - 1) * 3_600_000);
    const [[a], win, hist] = await Promise.all([
      query(`select coalesce(sum(blocks), 0)::bigint as blocks, coalesce(sum(retried_blocks), 0)::bigint as retried, coalesce(sum(attempts), 0)::bigint as attempts, coalesce(sum(attempts_committed), 0)::bigint as committed,
               coalesce(sum(attempts_refused), 0)::bigint as refused, coalesce(sum(attempts_pending), 0)::bigint as pending, coalesce(sum(attempts_other), 0)::bigint as other, min(hour) filter (where blocks > 0) as since, min(hour) filter (where attempts > 0) as attempts_since, max(updated_at) as as_of,
               coalesce(sum(legs_deposit), 0)::bigint as dep, coalesce(sum(legs_withdrawal), 0)::bigint as wd, coalesce(sum(legs_payment), 0)::bigint as pay, coalesce(sum(legs_lock), 0)::bigint as lock, coalesce(sum(legs_release), 0)::bigint as rel
             from canton_view_hour`),
      query("select coalesce(sum(settle_n), 0)::bigint as n, coalesce(sum(settle_sum), 0)::float8 as sum from canton_view_hour where hour >= $1", [from]),
      query("select settle_hist from canton_view_hist where hour >= $1", [from]),
    ]);
    const n = Number(win[0]!.n), h = addHists("time", hist.map((x) => x.settle_hist as number[]));
    const q = n === 0 ? null : quantile("time", h, 0.95);
    const iso = (d: Date | null) => (d === null ? null : d.toISOString());
    const submitted = Number(a!.attempts), committed = Number(a!.committed), pending = Number(a!.pending), answered = submitted - pending;
    const [dep, wd, pay, lock, rel] = [a!.dep, a!.wd, a!.pay, a!.lock, a!.rel].map(Number) as [number, number, number, number, number];
    return {
      asOf: iso(a!.as_of), dataSince: iso(a!.since), blocks: Number(a!.blocks), retriedBlocks: Number(a!.retried),
      attempts: { submitted, committed, refused: Number(a!.refused), pending, other: Number(a!.other), since: iso(a!.attempts_since) },
      successRate: answered === 0 ? null : Math.round((committed / answered) * 10000) / 10000,
      settlement: { window, from: from.toISOString(), to: new Date(t).toISOString(), blocks: n, averageSeconds: n === 0 ? null : Math.round((Number(win[0]!.sum) / n) * 1000) / 1000, p95Seconds: q === null ? null : Math.round(q.value * 1000) / 1000, p95Capped: q?.capped ?? false, basis: "proofStart" },
      legs: { deposit: dep, withdrawal: wd, payment: pay, lock, release: rel, total: dep + wd + pay + lock + rel },
    };
  }

  return { deriveCursor, numberOf, blocks, blockExtras, txs, txTotal, blockTxs, blockLegs, record, placeOf, feeCapsOf, traceOf, txLogs, txInternal, txTransfers, updates, update, cantonStats, updateBlock, around, aroundOne };
}
