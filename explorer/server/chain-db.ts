import type { Pool } from "pg";

/** The database could not be read. The routes answer 502 for it, like a read that reth failed. */
export class ChainDbError extends Error {}

/** One of the newest final blocks, as the home page lists it. */
export interface FinalSummary { number: number; hash: string; timestamp: number; txCount: number; updateId: string; recordTime: string }

/** A final block as the database holds it, with the record's own bytes, which the Verify button needs. */
export interface FinalBlockRow extends FinalSummary {
  parentHash: string;
  gasUsed: number;
  gasLimit: number;
  /** In wei, as a decimal string. */
  baseFee: string;
  miner: string;
  stateRoot: string;
  headerHex: string;
  txsHex: string;
  /** Null when the block has no proof row, which the indexer never writes. */
  proofHex: string | null;
}

export interface FinalBlockTx { hash: string; from: string; to: string | null; success: boolean; /** The input, only for a call of `transfer(address,uint256)`: the page decodes the transfer from it. */ transferInput: string | null }

export interface FinalTxRow {
  hash: string;
  block: { number: number; hash: string; updateId: string };
  from: string;
  to: string | null;
  /** Wei, as a decimal string. */
  value: string;
  nonce: number;
  type: number;
  gas: number;
  gasUsed: number;
  gasPrice: string;
  success: boolean;
  input: string;
  created: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

/** Where a transaction has been, from the lifecycle rows: the times are UTC, null for a stage that has no time (a transaction that came another way has no acceptance time). */
export interface TxLifecycle {
  state: string; reason: string | null; acceptedAt: string | null; acceptedVia: string | null; includedAt: string | null; attempts: number; leftOutReason: string | null;
  proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; committedAt: string | null; finalAt: string | null; finalBlock: number | null; timeToFinalMs: number | null;
}

/** An attempt that is not final yet, as the in-flight panel lists it. */
export interface InFlightAttempt {
  number: number; strategy: string; cutReason: string; stage: "cut" | "built" | "proving" | "proved" | "submitted" | "committed"; txCount: number | null; poolWaiting: number | null;
  cutAt: string; builtAt: string | null; proofStartedAt: string | null; proofEndedAt: string | null; submittedAt: string | null; answeredAt: string | null; outcome: string | null;
}
/** A transaction the explorer knows and that is not final: waiting in reth's pool, or in a block that is being proven. `at` is when it was accepted. */
export interface InFlightTx { hash: string; stage: "waiting" | "proving"; at: string }
export interface InFlight { attempts: InFlightAttempt[]; poolWaiting: { waiting: number; at: string } | null; transactions: InFlightTx[] }

export interface Signers { operator: string; confirmer: string }

/** What the indexer's rows say about the indexer: used for the health route. `started` is false until it has written its first record. */
/** `problems` names every check that is not ok; `down` is true only when one of them is down or has stopped being refreshed (design 6.5: degraded still answers 200). */
export interface IndexerState { started: boolean; problems: string[]; down: boolean; signers: Signers | null }

const hex = (b: Buffer): string => "0x" + b.toString("hex");
const hexOrNull = (b: Buffer | null): string | null => (b === null ? null : hex(b));
const bytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
/** Canton writes the record time with the digits it has; the database keeps microseconds, so the zeros it adds past milliseconds are dropped. */
const isoTime = (s: string): string => s.replace(/(\.\d{3})000Z$/, "$1Z");

const TIME = `to_char(b.record_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const MS = (c: string): string => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const SUMMARY = `b.number, b.hash, extract(epoch from b.timestamp)::bigint as ts, b.tx_count, b.update_id, ${TIME} as record_time`;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const summary = (r: Row): FinalSummary => ({ number: Number(r.number), hash: hex(r.hash), timestamp: Number(r.ts), txCount: r.tx_count, updateId: r.update_id, recordTime: isoTime(r.record_time) });

/** The final blocks and their transactions, read from the tables the indexer fills (design section 4). Nothing here writes. */
/**
 * The checks the indexer refreshes on every round of its timer (every 2 s), whatever their status says: a row of one of these that has not been looked at
 * for three rounds means the indexer is not running (design section 6.5). The other checks are written when they fail, so their age says nothing.
 */
export const REFRESHED_CHECKS: readonly string[] = ["C4", "C5", "derive_lag", "C10"];

export function createChainDb(pool: Pool, { staleSeconds = 6 }: { staleSeconds?: number } = {}) {
  async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
    try {
      return (await pool.query(sql, values)).rows;
    } catch (e) {
      throw new ChainDbError(`the database cannot be read: ${(e as Error).message}`);
    }
  }

  /** The newest final block, or undefined while none is indexed. */
  async function head(): Promise<FinalSummary | undefined> {
    const [r] = await query(`select ${SUMMARY} from blocks b order by b.number desc limit 1`);
    return r && summary(r);
  }

  /** The newest `n` final blocks, newest first. */
  async function latest(n: number): Promise<FinalSummary[]> {
    return (await query(`select ${SUMMARY} from blocks b order by b.number desc limit $1`, [n])).map(summary);
  }

  /** A final block by number or hash, or undefined. `withTxs` false leaves out the record's transactions, which are most of its bytes (`txsHex` is then empty). */
  async function block(key: number | string, withTxs = true): Promise<FinalBlockRow | undefined> {
    const byNumber = typeof key === "number";
    const [r] = await query(
      `select ${SUMMARY}, b.parent_hash, b.gas_used, b.gas_limit, b.base_fee_per_gas::text as base_fee, b.fee_recipient, b.state_root, r.header, ${withTxs ? "r.txs" : "null::bytea as txs"}, p.proof
       from blocks b left join block_records r on r.number = b.number left join proofs p on p.number = b.number
       where ${byNumber ? "b.number = $1" : "b.hash = $1"}`,
      [byNumber ? key : bytes(key)],
    );
    return r && {
      ...summary(r), parentHash: hex(r.parent_hash), gasUsed: Number(r.gas_used), gasLimit: Number(r.gas_limit), baseFee: r.base_fee, miner: hex(r.fee_recipient), stateRoot: hex(r.state_root),
      headerHex: r.header ? (r.header as Buffer).toString("hex") : "", txsHex: r.txs ? (r.txs as Buffer).toString("hex") : "", proofHex: r.proof ? (r.proof as Buffer).toString("hex") : null,
    };
  }

  /** A final block's transactions in order. */
  async function blockTxs(number: number): Promise<FinalBlockTx[]> {
    const rows = await query(
      `select hash, from_address, to_address, status, case when method_id = '\\xa9059cbb'::bytea then input end as transfer_input
       from transactions where block_number = $1 order by tx_index`,
      [number],
    );
    return rows.map((r) => ({ hash: hex(r.hash), from: hex(r.from_address), to: hexOrNull(r.to_address), success: r.status === 1, transferInput: r.transfer_input ? hex(r.transfer_input) : null }));
  }

  /** A final transaction with its receipt's fields and logs, or undefined. */
  async function tx(hash: string): Promise<FinalTxRow | undefined> {
    const [r] = await query(
      `select t.block_number, t.tx_index, t.hash, t.type, t.from_address, t.to_address, t.created_contract, t.nonce, t.value::text as value, t.gas_limit, t.effective_gas_price::text as price,
         t.gas_used, t.status, t.input, b.hash as block_hash, b.update_id
       from tx_hashes h join transactions t on t.block_number = h.block_number and t.tx_index = h.tx_index join blocks b on b.number = t.block_number
       where h.hash = $1`,
      [bytes(hash)],
    );
    if (!r) return undefined;
    const logs = await query("select address, topic0, topic1, topic2, topic3, data from logs where block_number = $1 and tx_index = $2 order by log_index", [r.block_number, r.tx_index]);
    return {
      hash: hex(r.hash), block: { number: Number(r.block_number), hash: hex(r.block_hash), updateId: r.update_id }, from: hex(r.from_address), to: hexOrNull(r.to_address), value: r.value,
      nonce: Number(r.nonce), type: r.type, gas: Number(r.gas_limit), gasUsed: Number(r.gas_used), gasPrice: r.price, success: r.status === 1, input: hex(r.input), created: hexOrNull(r.created_contract),
      logs: logs.map((l) => ({
        address: hex(l.address),
        // A log's topics are the first ones that are set: a null topic ends the list.
        topics: [l.topic0, l.topic1, l.topic2, l.topic3].flatMap((t, i, all) => (t !== null && all.slice(0, i).every((x) => x !== null) ? [hex(t)] : [])),
        data: hex(l.data),
      })),
    };
  }

  /** The number of the block that a Canton update made, or undefined. */
  async function blockOfUpdate(updateId: string): Promise<number | undefined> {
    const [r] = await query("select number from blocks where update_id = $1 order by number limit 1", [updateId]);
    return r && Number(r.number);
  }

  /** The transaction that created a contract and its block, or undefined. */
  async function createdBy(address: string): Promise<{ txHash: string; block: number } | undefined> {
    const [r] = await query("select hash, block_number from transactions where created_contract = $1 order by block_number, tx_index limit 1", [bytes(address)]);
    return r && { txHash: hex(r.hash), block: Number(r.block_number) };
  }

  /** The hash and update of a final block, by number. */
  async function finalOf(number: number): Promise<{ hash: string; updateId: string } | undefined> {
    const [r] = await query("select hash, update_id from blocks where number = $1", [number]);
    return r && { hash: hex(r.hash), updateId: r.update_id };
  }

  /** The lifecycle of a transaction: its row, and the attempt that held it (the committed one first, one settled as committed after it, else the latest). Undefined when no row is kept (no journal, or a transaction nobody accepted). */
  async function lifecycleOf(hash: string): Promise<TxLifecycle | undefined> {
    const [r] = await query(
      `select l.state, l.state_reason, ${MS("l.accepted_at")} as accepted_at, l.accepted_via, ${MS("l.first_included_at")} as included_at, l.attempts, l.last_left_out_reason,
         ${MS("a.proof_started_at")} as proof_started_at, ${MS("a.proof_ended_at")} as proof_ended_at, ${MS("a.submitted_at")} as submitted_at,
         ${MS("case when a.outcome = 'committed' then a.answered_at when a.resolved_outcome = 'committed' then coalesce(a.resolved_at, a.answered_at) end")} as committed_at, ${MS("l.final_at")} as final_at, l.final_block,
         (extract(epoch from l.final_at - l.accepted_at) * 1000)::bigint as time_to_final
       from tx_lifecycle l left join lateral (
         select ba.* from attempt_transactions x join block_attempts ba on ba.attempt_id = x.attempt_id
          where x.tx_hash = l.tx_hash and x.left_out_reason is null order by coalesce(ba.outcome = 'committed' or ba.resolved_outcome = 'committed', false) desc, coalesce(ba.outcome = 'committed', false) desc, ba.attempt_id desc limit 1) a on true
       where l.tx_hash = $1`,
      [bytes(hash)],
    );
    return r && {
      state: r.state, reason: r.state_reason, acceptedAt: r.accepted_at, acceptedVia: r.accepted_via, includedAt: r.included_at, attempts: r.attempts, leftOutReason: r.last_left_out_reason,
      proofStartedAt: r.proof_started_at, proofEndedAt: r.proof_ended_at, submittedAt: r.submitted_at, committedAt: r.committed_at, finalAt: r.final_at,
      finalBlock: r.final_block === null ? null : Number(r.final_block), timeToFinalMs: r.time_to_final === null ? null : Number(r.time_to_final),
    };
  }

  /**
   * The attempts that are not final: the producer cut a block and neither Canton's refusal nor the index's block has closed it. An attempt that was
   * settled as not committed, or that is older than an hour (a run that stopped in the middle), is not in flight.
   */
  async function inFlight(max = 50): Promise<InFlight> {
    const TXS_IN_FLIGHT = 10;
    const rows = await query(
      `select a.number, a.strategy, a.cut_reason, a.tx_count, a.pool_waiting, a.outcome, ${MS("a.cut_at")} as cut_at, ${MS("a.built_at")} as built_at,
         ${MS("a.proof_started_at")} as proof_started_at, ${MS("a.proof_ended_at")} as proof_ended_at, ${MS("a.submitted_at")} as submitted_at, ${MS("a.answered_at")} as answered_at,
         a.proof_outcome
       from block_attempts a
       where a.final_seen_at is null and (a.outcome is null or a.outcome in ('unknown', 'committed')) and a.proof_outcome is distinct from 'failed'
         and (a.resolved_outcome is null or a.resolved_outcome = 'committed') and a.cut_at > now() - interval '1 hour'
         and not exists (select 1 from blocks b where b.attempt_id = a.attempt_id)
       order by a.number, a.attempt_id limit $1`,
      [max],
    );
    const attempts = rows.map((r): InFlightAttempt => {
      const stage = r.outcome === "committed" ? "committed" : r.submitted_at ? "submitted" : r.proof_ended_at ? "proved" : r.proof_started_at ? "proving" : r.built_at ? "built" : "cut";
      return {
        number: Number(r.number), strategy: r.strategy, cutReason: r.cut_reason, stage, txCount: r.tx_count, poolWaiting: r.pool_waiting, cutAt: r.cut_at, builtAt: r.built_at,
        proofStartedAt: r.proof_started_at, proofEndedAt: r.proof_ended_at, submittedAt: r.submitted_at, answeredAt: r.answered_at, outcome: r.outcome,
      };
    });
    const [p] = await query(`select waiting, ${MS("at")} as at from pool_samples order by at desc limit 1`);
    // The newest not-final transactions, by the journal's state. Replaced, dropped and lost ones will not be in a block, so they are not in flight.
    const txs = await query(
      `select tx_hash, state, ${MS("coalesce(accepted_at, updated_at)")} as at from tx_lifecycle where state in ('pending', 'proving') order by coalesce(accepted_at, updated_at) desc, tx_hash limit $1`,
      [TXS_IN_FLIGHT],
    );
    const transactions = txs.map((r): InFlightTx => ({ hash: hex(r.tx_hash), stage: r.state === "proving" ? "proving" : "waiting", at: r.at }));
    return { attempts, poolWaiting: p ? { waiting: p.waiting, at: p.at } : null, transactions };
  }

  /**
   * The indexer's own word on itself: a record written, every check row that is not ok, the checks it has stopped refreshing (a stopped or crashed indexer
   * leaves its last ok rows behind, so a row's age counts as much as its status), and the two signers. Block 1 exists when the genesis is referenced.
   */
  async function indexer(): Promise<IndexerState> {
    const [cursor] = await query("select 1 from cursors where stream = 'reader_updates'");
    const checks = await query("select check_id, status, detail, extract(epoch from now() - checked_at)::float8 as age from health_checks order by check_id");
    const parties = await query("select party, role from canton_parties");
    const party = (role: string) => parties.find((p) => p.role === role)?.party as string | undefined;
    const [operator, confirmer] = [party("operator"), party("confirmer")];
    let down = false;
    const problems = checks.flatMap((c) => {
      if (REFRESHED_CHECKS.includes(c.check_id) && Number(c.age) > staleSeconds) { down = true; return [`${c.check_id}: the indexer has not checked in ${Math.round(Number(c.age))} s`]; }
      if (c.status === "down") down = true;
      return c.status === "ok" ? [] : [`${c.check_id}: ${c.detail ?? c.status}`];
    });
    // A refreshed check with no row has not been looked at at all: after a rebuild from an export (which writes the cursor but runs no check round), or before
    // a new indexer's first round. No row must not read as healthy, or a database with no indexer behind it answers ok.
    if (cursor !== undefined) {
      for (const id of REFRESHED_CHECKS) if (!checks.some((c) => c.check_id === id)) { down = true; problems.push(`${id}: the indexer has not checked yet`); }
    }
    return { started: cursor !== undefined, problems, down, signers: operator && confirmer ? { operator, confirmer } : null };
  }

  /** True once block 1 is indexed: it names reth's genesis as its parent, which the indexer checks before it writes the block. */
  async function genesisReferenced(): Promise<boolean> {
    return (await query("select 1 from blocks where number = 1")).length > 0;
  }

  /** Where stage 2 is (the derive cursor), and the chain instance this database belongs to (the update of block 1). Null while there is none. */
  async function indexFacts(): Promise<{ deriveCursor: number | null; chainInstance: string | null }> {
    const [r] = await query("select (select position from cursors where stream = 'derive') as derive, (select value from meta where key = 'chain_instance') as instance");
    return { deriveCursor: r?.derive === null || r?.derive === undefined ? null : Number(r.derive), chainInstance: r?.instance ?? null };
  }

  return { head, latest, block, blockTxs, tx, blockOfUpdate, createdBy, finalOf, lifecycleOf, inFlight, indexer, genesisReferenced, indexFacts };
}

export type ChainDb = ReturnType<typeof createChainDb>;

/**
 * The tracker's look at final blocks, which is a synchronous question. It answers from what it has read, and a block it does not hold is read in the
 * background, so the next question gets the answer: the tracker asks again on every poll, and the answer is only the update id for a page.
 * A caller that knows the hash it expects passes it: an entry with another hash comes from another chain (after `explorer reset`, or a new chain
 * instance while this process kept running), so it is dropped and read again, and a hash the database still does not hold is asked about only
 * every `mismatchMs`.
 */
export function createFinalBlocks(db: Pick<ChainDb, "finalOf">, { max = 5000, missMs = 1000, mismatchMs = 30_000, now = Date.now } = {}) {
  const held = new Map<number, { hash: string; updateId: string }>();
  const missed = new Map<number, number>();
  const asking = new Set<number>();
  return {
    byNumber(n: number, expectedHash?: string | null): { hash: string; updateId: string } | undefined {
      const have = held.get(n);
      if (have && (!expectedHash || have.hash === expectedHash)) return have;
      if (have) held.delete(n);
      if (asking.has(n) || (missed.get(n) ?? 0) > now()) return undefined;
      asking.add(n);
      void db.finalOf(n).then((f) => {
        if (f && expectedHash && f.hash !== expectedHash) {
          missed.set(n, now() + mismatchMs);
        } else if (f) {
          held.set(n, f);
          if (held.size > max) held.delete(held.keys().next().value as number);
        } else {
          missed.set(n, now() + missMs);
        }
        if (missed.size > max) missed.delete(missed.keys().next().value as number);
      }, () => { missed.set(n, now() + missMs); }).finally(() => asking.delete(n));
      return undefined;
    },
  };
}

export type FinalBlocks = ReturnType<typeof createFinalBlocks>;
