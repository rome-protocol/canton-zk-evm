/**
 * The reads behind the Etherscan-compatible `/api` (design 6.2), as the indexer's rows hold them. Nothing here writes. Etherscan pages by `page` and `offset`, so
 * these reads take a block window, an order, and how many rows to skip and to return; the callers keep `skip + limit` at 10,000 or less (the route checks it), and
 * every side of a union is cut at `skip + limit` rows, so a page costs its own rows however many an address has.
 */
import type { Pool, PoolClient } from "pg";
import { ChainDbError } from "../chain-db.ts";
import { bytes, hex, hexOrNull } from "./chain-rest.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Sort = "asc" | "desc";
/** Which rows: the blocks from `start` to `end` (both included), in `sort` order, `skip` of them passed over and then `limit` taken. */
export interface Window { start: number; end: number; sort: Sort; skip: number; limit: number }

export interface TxRow {
  block: number; index: number; hash: string; blockHash: string; timestamp: number; from: string; to: string | null; created: string | null; value: string; nonce: number; gasLimit: string; gasPrice: string;
  gasUsed: string; cumulativeGasUsed: string; success: boolean; input: string; methodId: string | null;
}
export interface InternalRow {
  block: number; txIndex: number; traceAddress: number[]; hash: string; timestamp: number; callType: string; from: string; to: string | null; value: string; gas: string | null; gasUsed: string | null; error: string | null;
}
export interface TokenMoveRow extends Omit<TxRow, "created" | "value" | "input" | "methodId" | "success" | "to" | "from"> {
  logIndex: number; token: string; from: string; to: string; amount: string | null; tokenId: string | null; name: string | null; symbol: string | null; decimals: number | null;
}
export interface MinedRow { block: number; timestamp: number; reward: string }
export type TokenStandard = "ERC-20" | "ERC-721" | "ERC-1155";
export interface BlockRewardRow { block: number; timestamp: number; miner: string; reward: string }
/** How the producer cuts blocks now: the strategy of the newest run, and its interval when it has one (`fixed_rhythm`). */
export interface Rhythm { strategy: string; intervalMs: number | null }
export type Closest = "before" | "after";
/** One log, with the fields of its transaction and block that Etherscan's `getLogs` carries. */
export interface LogRow {
  block: number; blockHash: string; timestamp: number; logIndex: number; txIndex: number; txHash: string; gasPrice: string; gasUsed: string; address: string; topics: string[]; data: string;
}
/** A `getLogs` filter: an address and/or topics, in a block range, with the topics combined left to right by `and` or `or`. */
export interface LogFilter {
  from: number; to: number; address: string | null; topics: (string | null)[]; ops: ("and" | "or")[]; skip: number; limit: number;
}

export type EtherscanRest = ReturnType<typeof createEtherscanRest>;

const txColumns = `t.block_number, t.tx_index, t.hash, b.hash as block_hash, extract(epoch from b.timestamp)::bigint as ts, t.nonce, t.gas_limit::text as gas_limit,
    t.effective_gas_price::text as price, t.gas_used::text as gas_used, t.cumulative_gas_used::text as cumulative`;

/** A read that the database cancelled for running too long: the door answers it with Etherscan's own words for a query that is too big. */
export class QueryTimeout extends ChainDbError {}

/** The longest a read of this door may run (ms). A client that asks for a wide search is held to it, so that a few of them cannot hold the pool's connections for long. */
export const READ_TIMEOUT_MS = 5000;

/** The SQL of one `tokentx`, `tokennfttx` or `token1155tx` page, and its values. A transfer's standard follows from its columns (ERC-20 has no token_id, ERC-721 no amount, ERC-1155 both), which are
 * the predicates of migration 0028's partial indexes; the same text must be here for the planner to use them. */
export function tokenMovesSql(standard: TokenStandard, a: string | null, token: string | null, w: Window): { sql: string; values: unknown[] } {
  const d = w.sort === "desc" ? "desc" : "asc";
  const kind = standard === "ERC-20" ? "tt.token_id is null" : standard === "ERC-721" ? "tt.amount is null" : "tt.amount is not null and tt.token_id is not null";
  const values: unknown[] = [w.start, w.end, w.skip + w.limit];
  const at = (b: string) => (values.push(bytes(b)), `$${values.length}`);
  const who = a === null ? null : at(a), only = token === null ? "" : ` and tt.token = ${at(token)}`;
  const side = (where: string) =>
    `(select tt.block_number, tt.log_index, tt.batch_index from token_transfers tt
       where ${where} and ${kind} and tt.block_number between $1 and $2${only} order by tt.block_number ${d}, tt.log_index ${d}, tt.batch_index ${d} limit $3)`;
  const keys = who === null ? side("true") : `${side(`tt.from_address = ${who}`)} union ${side(`tt.to_address = ${who}`)}`;
  values.push(w.limit, w.skip);
  return {
    sql: `with k as (${keys})
       select ${txColumns}, tt.log_index, tt.batch_index, tt.token, tt.from_address, tt.to_address, tt.amount::text as amount, tt.token_id::text as token_id, tk.name, tk.symbol, tk.decimals
       from k join token_transfers tt on tt.block_number = k.block_number and tt.log_index = k.log_index and tt.batch_index = k.batch_index
         join tokens tk on tk.address = tt.token
         join transactions t on t.block_number = tt.block_number and t.tx_index = tt.tx_index join blocks b on b.number = tt.block_number
       order by tt.block_number ${d}, tt.log_index ${d}, tt.batch_index ${d} limit $${values.length - 1} offset $${values.length}`,
    values,
  };
}

export function createEtherscanRest(pool: Pool, { timeoutMs = READ_TIMEOUT_MS }: { timeoutMs?: number } = {}) {
  /** One read, in a read-only transaction that has its own statement timeout (set local, so the connection goes back to the pool as it was). */
  async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
    let client: PoolClient;
    try { client = await pool.connect(); } catch (e) { throw new ChainDbError(`the database cannot be read: ${(e as Error).message}`); }
    try {
      await client.query("begin read only");
      await client.query(`set local statement_timeout = ${Math.trunc(timeoutMs)}`);
      const rows = (await client.query(sql, values)).rows;
      await client.query("commit");
      return rows;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      if ((e as { code?: string }).code === "57014") throw new QueryTimeout(`a read ran longer than ${timeoutMs} ms: ${sql.slice(0, 80).replace(/\s+/g, " ")}`);
      throw new ChainDbError(`the database cannot be read: ${(e as Error).message}`);
    } finally { client.release(); }
  }

  /** The newest final block (null before the first), and the block stage 2 has derived up to: what stage 2 writes is complete only up to the second. */
  async function heads(): Promise<{ head: number | null; cursor: number }> {
    const [h] = await query("select number from blocks order by number desc limit 1");
    const [c] = await query("select position from cursors where stream = 'derive'");
    return { head: h ? Number(h.number) : null, cursor: c ? Number(c.position) : 0 };
  }

  const dirOf = (w: Window): "asc" | "desc" => (w.sort === "asc" ? "asc" : "desc");
  const baseOf = (r: Row) => ({
    block: Number(r.block_number), index: r.tx_index as number, hash: hex(r.hash), blockHash: hex(r.block_hash), timestamp: Number(r.ts), nonce: Number(r.nonce), gasLimit: r.gas_limit as string,
    gasPrice: r.price as string, gasUsed: r.gas_used as string, cumulativeGasUsed: r.cumulative as string,
  });

  /** The transactions an address sent, received or was created by, as Etherscan's `txlist` lists them. */
  async function txlist(a: string, w: Window): Promise<TxRow[]> {
    const d = dirOf(w);
    const side = (column: string) =>
      `(select block_number, tx_index from transactions where ${column} = $1 and block_number between $2 and $3 order by block_number ${d}, tx_index ${d} limit $4)`;
    const rows = await query(
      `with k as (${side("from_address")} union ${side("to_address")} union ${side("created_contract")})
       select ${txColumns}, t.from_address, t.to_address, t.created_contract, t.value::text as value, t.status, t.input, t.method_id
       from k join transactions t on t.block_number = k.block_number and t.tx_index = k.tx_index join blocks b on b.number = t.block_number
       order by t.block_number ${d}, t.tx_index ${d} limit $5 offset $6`,
      [bytes(a), w.start, w.end, w.skip + w.limit, w.limit, w.skip],
    );
    return rows.map((r) => ({
      ...baseOf(r), from: hex(r.from_address), to: hexOrNull(r.to_address), created: hexOrNull(r.created_contract), value: r.value, success: r.status === 1, input: hex(r.input), methodId: hexOrNull(r.method_id),
    }));
  }

  const internalColumns = `ic.block_number, ic.tx_index, ic.trace_address, ic.call_type, ic.from_address, ic.to_address, ic.value::text as value, ic.gas::text as gas, ic.gas_used::text as gas_used, ic.error,
    t.hash, extract(epoch from b.timestamp)::bigint as ts`;
  const internalJoins = `join transactions t on t.block_number = ic.block_number and t.tx_index = ic.tx_index join blocks b on b.number = ic.block_number`;
  const internalFrom = `internal_calls ic ${internalJoins}`;
  const internalRow = (r: Row): InternalRow => ({
    block: Number(r.block_number), txIndex: r.tx_index, traceAddress: r.trace_address, hash: hex(r.hash), timestamp: Number(r.ts), callType: r.call_type, from: hex(r.from_address), to: hexOrNull(r.to_address),
    value: r.value, gas: r.gas, gasUsed: r.gas_used, error: r.error,
  });

  /** The internal calls an address made or received, as Etherscan's `txlistinternal` lists them (a call that moves value, a creation, a self-destruct). */
  async function internalOf(a: string, w: Window): Promise<InternalRow[]> {
    const d = dirOf(w);
    const side = (column: string) =>
      `(select block_number, tx_index, trace_address from internal_calls where ${column} = $1 and block_number between $2 and $3 order by block_number ${d}, tx_index ${d}, trace_address ${d} limit $4)`;
    const rows = await query(
      `with k as (${side("from_address")} union ${side("to_address")})
       select ${internalColumns} from k join internal_calls ic on ic.block_number = k.block_number and ic.tx_index = k.tx_index and ic.trace_address = k.trace_address ${internalJoins}
       order by ic.block_number ${d}, ic.tx_index ${d}, ic.trace_address ${d} limit $5 offset $6`,
      [bytes(a), w.start, w.end, w.skip + w.limit, w.limit, w.skip],
    );
    return rows.map(internalRow);
  }

  /** The internal calls of one transaction, in trace order; null for a hash the index does not hold. */
  async function internalOfTx(hash: string, w: Window): Promise<InternalRow[] | null> {
    const [place] = await query("select block_number, tx_index from tx_hashes where hash = $1", [bytes(hash)]);
    if (!place) return null;
    const rows = await query(
      `select ${internalColumns} from ${internalFrom} where ic.block_number = $1 and ic.tx_index = $2 and ic.block_number between $3 and $4
       order by ic.trace_address ${dirOf(w)} limit $5 offset $6`,
      [place.block_number, place.tx_index, w.start, w.end, w.limit, w.skip],
    );
    return rows.map(internalRow);
  }

  /** The internal calls of a range of blocks. */
  async function internalInBlocks(w: Window): Promise<InternalRow[]> {
    const d = dirOf(w);
    const rows = await query(
      `select ${internalColumns} from ${internalFrom} where ic.block_number between $1 and $2
       order by ic.block_number ${d}, ic.tx_index ${d}, ic.trace_address ${d} limit $3 offset $4`,
      [w.start, w.end, w.limit, w.skip],
    );
    return rows.map(internalRow);
  }

  /** The transfers of tokens of one standard that an address sent or received and/or that one token made, as Etherscan's `tokentx`, `tokennfttx` and `token1155tx` list them. */
  async function tokenMoves(standard: TokenStandard, a: string | null, token: string | null, w: Window): Promise<TokenMoveRow[]> {
    const { sql, values } = tokenMovesSql(standard, a, token, w);
    const rows = await query(sql, values);
    return rows.map((r) => ({
      ...baseOf(r), logIndex: r.log_index, token: hex(r.token), from: hex(r.from_address), to: hex(r.to_address), amount: r.amount, tokenId: r.token_id, name: r.name, symbol: r.symbol,
      decimals: r.decimals === null ? null : Number(r.decimals),
    }));
  }

  /** The blocks whose fee recipient is the address; the reward is the priority fees the block paid it (no block reward on Ostia, and the base fee is burnt). */
  async function mined(a: string, w: Window): Promise<MinedRow[]> {
    const d = dirOf(w);
    const rows = await query(
      `select number, extract(epoch from timestamp)::bigint as ts, priority_fees::text as reward from blocks where fee_recipient = $1 and number between $2 and $3 order by number ${d} limit $4 offset $5`,
      [bytes(a), w.start, w.end, w.limit, w.skip],
    );
    return rows.map((r) => ({ block: Number(r.number), timestamp: Number(r.ts), reward: r.reward }));
  }

  /** Whether a transaction succeeded, by its hash; null for a hash the index does not hold (only final blocks are indexed). */
  async function txSuccess(hash: string): Promise<boolean | null> {
    const [r] = await query(
      "select t.status from tx_hashes h join transactions t on t.block_number = h.block_number and t.tx_index = h.tx_index where h.hash = $1",
      [bytes(hash)],
    );
    return r ? r.status === 1 : null;
  }

  /** A block's miner and what it earned: its priority fees (there is no block reward on Ostia, and the base fee is burnt). Null for a block that is not final. */
  async function blockReward(n: number): Promise<BlockRewardRow | null> {
    const [r] = await query("select number, extract(epoch from timestamp)::bigint as ts, fee_recipient, priority_fees::text as reward from blocks where number = $1", [n]);
    return r ? { block: Number(r.number), timestamp: Number(r.ts), miner: hex(r.fee_recipient), reward: r.reward } : null;
  }

  /** The number of the last block at or before a time (`before`), or of the first at or after it (`after`); null when there is none. */
  async function blockAtTime(ts: number, closest: Closest): Promise<number | null> {
    const [r] = await query(
      closest === "before"
        ? "select number from blocks where timestamp <= to_timestamp($1) order by timestamp desc, number desc limit 1"
        : "select number from blocks where timestamp >= to_timestamp($1) order by timestamp asc, number asc limit 1",
      [ts],
    );
    return r ? Number(r.number) : null;
  }

  /** The strategy of the newest producer run; null when no run is recorded. */
  async function rhythm(): Promise<Rhythm | null> {
    const [r] = await query("select strategy, settings->>'interval_ms' as interval_ms from producer_runs order by started_at desc limit 1");
    if (!r) return null;
    const ms = r.interval_ms === null ? NaN : Number(r.interval_ms);
    return { strategy: r.strategy, intervalMs: Number.isFinite(ms) && ms > 0 ? ms : null };
  }

  /** The logs of a filter, oldest first, as Etherscan's `getLogs` lists them. Every part of the filter is a bound on an index: the caller has checked that an address, a topic0 or a short range is there. */
  async function logs(f: LogFilter): Promise<LogRow[]> {
    const values: unknown[] = [f.from, f.to];
    const at = (b: string) => (values.push(bytes(b)), `$${values.length}`);
    const where = ["l.block_number between $1 and $2"];
    if (f.address !== null) where.push(`l.address = ${at(f.address)}`);
    let expr = "";
    let previous = -1, op = 0;
    f.topics.forEach((t, i) => {
      if (t === null) return;
      const term = `l.topic${i} = ${at(t)}`;
      expr = previous < 0 ? term : `(${expr} ${f.ops[op++]} ${term})`;
      previous = i;
    });
    if (expr !== "") where.push(expr);
    values.push(f.limit, f.skip);
    const rows = await query(
      `with k as (select l.block_number, l.log_index, l.tx_index, l.address, l.topic0, l.topic1, l.topic2, l.topic3, l.data from logs l where ${where.join(" and ")}
                  order by l.block_number, l.log_index limit $${values.length - 1} offset $${values.length})
       select k.*, t.hash, t.effective_gas_price::text as price, t.gas_used::text as gas_used, b.hash as block_hash, extract(epoch from b.timestamp)::bigint as ts
       from k join transactions t on t.block_number = k.block_number and t.tx_index = k.tx_index join blocks b on b.number = k.block_number
       order by k.block_number, k.log_index`,
      values,
    );
    return rows.map((r) => ({
      block: Number(r.block_number), blockHash: hex(r.block_hash), timestamp: Number(r.ts), logIndex: r.log_index, txIndex: r.tx_index, txHash: hex(r.hash), gasPrice: r.price, gasUsed: r.gas_used,
      address: hex(r.address), topics: [r.topic0, r.topic1, r.topic2, r.topic3].filter((x) => x !== null).map(hex), data: hex(r.data),
    }));
  }

  return { heads, txlist, internalOf, internalOfTx, internalInBlocks, tokenMoves, mined, txSuccess, blockReward, blockAtTime, rhythm, logs };
}
