/**
 * The reads behind the REST routes of the chain (design 6.1): blocks, transactions and Canton updates, as the indexer's rows hold them. Nothing here writes.
 * Lists take a keyset (the parts of the last row's sort key) and a limit, and are asked for one row more than they show, so that the caller knows if there is a next page.
 */
import type { Pool } from "pg";
import { ChainDbError } from "../chain-db.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const hex = (b: Buffer): string => "0x" + b.toString("hex");
export const hexOrNull = (b: Buffer | null): string | null => (b === null ? null : hex(b));
export const bytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
export const MS = (c: string): string => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const US = (c: string): string => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.replace(/(\.\d{3})000Z/, "$1Z");
export const isoTime = (s: string): string => s.replace(/(\.\d{3})000Z$/, "$1Z");
const LEG_KINDS = ["", "deposit", "withdrawal", "payment"] as const;

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
}
export interface BlockExtras {
  legsCount: number;
  /** The producer's attempt that made the block, from its journal; null before the journal is loaded. */
  lifecycle: { strategy: string; cutReason: string; cutAt: string; builtAt: string | null; proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; answeredAt: string | null } | null;
}
export interface LegItem { legIndex: number; txIndex: number; logIndex: number; kind: string; legId: string; token: string; account: string; amount: string }
export interface LogItem { logIndex: number; position: number; address: string; topics: string[]; data: string }
export interface InternalItem { traceAddress: number[]; callType: string; from: string; to: string | null; value: string; gas: number | null; gasUsed: number | null; selector: string | null; inputSize: number | null; error: string | null }
export interface TransferItem { logIndex: number; batchIndex: number; token: string; from: string; to: string; amount: string | null; tokenId: string | null }
export interface TxPlace { block: number; index: number }
export interface TxTrace { callCount: number; revertReason: string | null; revertData: string | null }
export interface UpdateItem { updateId: string; recordTime: string; effectiveAt: string | null; participant: string; offset: number; synchronizer: string; block: number | null }
export interface UpdateDetail extends UpdateItem {
  template: { packageId: string; packageName: string | null; module: string; entity: string }; contractId: string | null; blockHash: string | null; signatories: { role: string; party: string }[];
  /** What the producer's journal says it submitted for the update; null for an update the journal does not hold. */
  producerRecord: { template: string | null; choice: string | null; commandId: string | null; argumentBytes: number | null; trafficBytes: number | null } | null;
}
/** An update in the list around one: what the producer's log says it submitted is null for an update the log does not hold. */
export interface UpdateAroundItem extends UpdateItem { submittedTemplate: string | null; submittedChoice: string | null; txCount: number | null }
export interface BlockRecordRow { number: number; hash: string; contractId: string; headerHex: string; txsHex: string; proofHex: string | null }

export const txSelect = `t.block_number, t.tx_index, t.hash, extract(epoch from b.timestamp)::bigint as ts, t.from_address, t.to_address, t.value::text as value, t.nonce, t.type, t.gas_used,
  t.effective_gas_price::text as price, t.status, t.created_contract, t.method_id`;
export const txItem = (r: Row): TxListItem => ({
  hash: hex(r.hash), block: Number(r.block_number), index: r.tx_index, timestamp: Number(r.ts), from: hex(r.from_address), to: hexOrNull(r.to_address), value: r.value, nonce: Number(r.nonce),
  type: r.type, gasUsed: Number(r.gas_used), gasPrice: r.price, success: r.status === 1, created: hexOrNull(r.created_contract), methodId: hexOrNull(r.method_id),
});

export type ChainRest = ReturnType<typeof createChainRest>;

export function createChainRest(pool: Pool) {
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
      `select b.number, b.hash, extract(epoch from b.timestamp)::bigint as ts, b.tx_count, b.gas_used, b.gas_limit, b.fee_recipient, b.legs_count, b.base_fee_per_gas::text as base_fee, b.update_id, ${US("b.record_time")} as record_time,
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
      `select b.legs_count, a.strategy, a.cut_reason, ${MS("a.cut_at")} as cut_at, ${MS("a.built_at")} as built_at, ${MS("a.proof_started_at")} as proof_started_at,
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

  /** All transactions, newest first, after the key (block, index) when one is given; `filter` keeps the reverted ones or the calls into contracts. */
  async function txs(before: (number | string)[] | null, limit: number, filter: TxFilter = "all"): Promise<TxListItem[]> {
    const [bn, ix] = before ?? [null, null];
    const where = { all: "", failed: "and t.status = 0", calls: "and t.method_id is not null and t.to_address is not null" }[filter];
    const rows = await query(
      `select ${txSelect} from transactions t join blocks b on b.number = t.block_number
       where ($1::bigint is null or (t.block_number, t.tx_index) < ($1::bigint, $2::int)) ${where} order by t.block_number desc, t.tx_index desc limit $3`,
      [bn, ix, limit + 1],
    );
    return rows.map(txItem);
  }

  /** One block's transactions in order, after the index when one is given. */
  async function blockTxs(number: number, after: number | null, limit: number): Promise<TxListItem[]> {
    const rows = await query(
      `select ${txSelect} from transactions t join blocks b on b.number = t.block_number where t.block_number = $1 and ($2::int is null or t.tx_index > $2) order by t.tx_index limit $3`,
      [number, after, limit + 1],
    );
    return rows.map(txItem);
  }

  async function blockLegs(number: number, after: number | null, limit: number): Promise<LegItem[]> {
    const rows = await query(
      `select leg_index, tx_index, log_index, kind, leg_id, token, account, amount::text as amount from gateway_legs where block_number = $1 and ($2::int is null or leg_index > $2) order by leg_index limit $3`,
      [number, after, limit + 1],
    );
    return rows.map((r) => ({ legIndex: r.leg_index, txIndex: r.tx_index, logIndex: r.log_index, kind: LEG_KINDS[r.kind] ?? String(r.kind), legId: hex(r.leg_id), token: hex(r.token), account: hex(r.account), amount: r.amount }));
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
    const rows = await query(
      `select log_index, batch_index, token, from_address, to_address, amount::text as amount, token_id::text as token_id from token_transfers
       where block_number = $1 and tx_index = $2 and ($3::int is null or (log_index, batch_index) > ($3::int, $4::int)) order by log_index, batch_index limit $5`,
      [at.block, at.index, li, bi, limit + 1],
    );
    return rows.map((r) => ({ logIndex: r.log_index, batchIndex: r.batch_index, token: hex(r.token), from: hex(r.from_address), to: hex(r.to_address), amount: r.amount, tokenId: r.token_id }));
  }

  /** The key carries the record time in whole microseconds; it is compared as a time (exactly) on the column itself, so the index on (record_time, update_id) answers it. */
  const EPOCH = "timestamptz 'epoch'";
  const MICROS = "(extract(epoch from u.record_time) * 1000000)::bigint";
  const updateSelect = `u.update_id, ${US("u.record_time")} as record_time, ${US("u.effective_at")} as effective_at, p.participant_id, u.reader_offset, s.synchronizer_id, ${MICROS} as micros,
    (select min(b.number) from blocks b where b.update_id = u.update_id) as block`;
  const updateItem = (r: Row): UpdateItem => ({
    updateId: r.update_id, recordTime: isoTime(r.record_time), effectiveAt: r.effective_at && isoTime(r.effective_at), participant: r.participant_id, offset: Number(r.reader_offset),
    synchronizer: r.synchronizer_id, block: r.block === null ? null : Number(r.block),
  });

  /** Canton updates, newest first, after the key (record time in microseconds, update id). */
  async function updates(before: (number | string)[] | null, limit: number): Promise<(UpdateItem & { micros: number })[]> {
    const [at, id] = before ?? [null, null];
    const rows = await query(
      `select ${updateSelect} from canton_updates u join canton_participants p on p.id = u.participant join canton_synchronizers s on s.id = u.synchronizer
       where ($1::bigint is null or (u.record_time, u.update_id) < (${EPOCH} + $1::bigint * interval '1 microsecond', $2::text)) order by u.record_time desc, u.update_id desc limit $3`,
      [at, id, limit + 1],
    );
    return rows.map((r) => ({ ...updateItem(r), micros: Number(r.micros) }));
  }

  const aroundSelect = `${updateSelect}, u.submitted_template, u.submitted_choice, (select b.tx_count from blocks b where b.update_id = u.update_id order by b.number limit 1) as tx_count`;
  const aroundFrom = "from canton_updates u join canton_participants p on p.id = u.participant join canton_synchronizers s on s.id = u.synchronizer";
  const aroundItem = (r: Row): UpdateAroundItem & { micros: number } => ({
    ...updateItem(r), submittedTemplate: r.submitted_template, submittedChoice: r.submitted_choice, txCount: r.tx_count === null ? null : Number(r.tx_count), micros: Number(r.micros),
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

  async function update(updateId: string): Promise<UpdateDetail | undefined> {
    const [r] = await query(
      `select ${updateSelect}, t.package_id, t.package_name, t.module, t.entity, u.signatories, u.command_id, u.submitted_template, u.submitted_choice, u.argument_bytes, u.traffic_bytes,
         (select r.contract_id from block_records r join blocks b on b.number = r.number where b.update_id = u.update_id order by b.number limit 1) as contract_id,
         (select b.hash from blocks b where b.update_id = u.update_id order by b.number limit 1) as block_hash
       from canton_updates u join canton_participants p on p.id = u.participant join canton_synchronizers s on s.id = u.synchronizer join canton_templates t on t.id = u.reader_template
       where u.update_id = $1`,
      [updateId],
    );
    if (!r) return undefined;
    const signatories = await query("select role, party from canton_parties where id = any($1::smallint[]) order by role, id", [r.signatories]);
    const journal = r.command_id !== null || r.submitted_template !== null;
    return {
      ...updateItem(r), template: { packageId: r.package_id, packageName: r.package_name, module: r.module, entity: r.entity }, contractId: r.contract_id, blockHash: hexOrNull(r.block_hash),
      signatories: signatories.map((s) => ({ role: s.role, party: s.party })),
      producerRecord: journal ? { template: r.submitted_template, choice: r.submitted_choice, commandId: r.command_id, argumentBytes: r.argument_bytes, trafficBytes: r.traffic_bytes } : null,
    };
  }

  return { deriveCursor, numberOf, blocks, blockExtras, txs, blockTxs, blockLegs, record, placeOf, feeCapsOf, traceOf, txLogs, txInternal, txTransfers, updates, update, around, aroundOne };
}
