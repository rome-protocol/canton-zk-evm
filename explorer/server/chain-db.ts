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

export interface Signers { operator: string; confirmer: string }

/** What the indexer's rows say about the indexer: used for the health route. `started` is false until it has written its first record. */
export interface IndexerState { started: boolean; problems: string[]; signers: Signers | null }

const hex = (b: Buffer): string => "0x" + b.toString("hex");
const hexOrNull = (b: Buffer | null): string | null => (b === null ? null : hex(b));
const bytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
/** Canton writes the record time with the digits it has; the database keeps microseconds, so the zeros it adds past milliseconds are dropped. */
const isoTime = (s: string): string => s.replace(/(\.\d{3})000Z$/, "$1Z");

const TIME = `to_char(b.record_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
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

  /** A final block by number or hash, or undefined. */
  async function block(key: number | string): Promise<FinalBlockRow | undefined> {
    const byNumber = typeof key === "number";
    const [r] = await query(
      `select ${SUMMARY}, b.parent_hash, b.gas_used, b.gas_limit, b.base_fee_per_gas::text as base_fee, b.fee_recipient, b.state_root, r.header, r.txs, p.proof
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
    const problems = checks.flatMap((c) => {
      if (REFRESHED_CHECKS.includes(c.check_id) && Number(c.age) > staleSeconds) return [`${c.check_id}: the indexer has not checked in ${Math.round(Number(c.age))} s`];
      return c.status === "ok" ? [] : [`${c.check_id}: ${c.detail ?? c.status}`];
    });
    return { started: cursor !== undefined, problems, signers: operator && confirmer ? { operator, confirmer } : null };
  }

  /** True once block 1 is indexed: it names reth's genesis as its parent, which the indexer checks before it writes the block. */
  async function genesisReferenced(): Promise<boolean> {
    return (await query("select 1 from blocks where number = 1")).length > 0;
  }

  return { head, latest, block, blockTxs, tx, blockOfUpdate, createdBy, finalOf, indexer, genesisReferenced };
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
