/**
 * The reads behind the Etherscan-compatible `/api` (design 6.2), as the indexer's rows hold them. Nothing here writes. Etherscan pages by `page` and `offset`, so
 * these reads take a block window, an order, and how many rows to skip and to return; the callers keep `skip + limit` at 10,000 or less (the route checks it), and
 * every side of a union is cut at `skip + limit` rows, so a page costs its own rows however many an address has.
 */
import type { Pool } from "pg";
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

export type EtherscanRest = ReturnType<typeof createEtherscanRest>;

export function createEtherscanRest(pool: Pool) {
  async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
    try {
      return (await pool.query(sql, values)).rows;
    } catch (e) {
      throw new ChainDbError(`the database cannot be read: ${(e as Error).message}`);
    }
  }

  /** The newest final block (null before the first), and the block stage 2 has derived up to: what stage 2 writes is complete only up to the second. */
  async function heads(): Promise<{ head: number | null; cursor: number }> {
    const [h] = await query("select number from blocks order by number desc limit 1");
    const [c] = await query("select position from cursors where stream = 'derive'");
    return { head: h ? Number(h.number) : null, cursor: c ? Number(c.position) : 0 };
  }

  const dirOf = (w: Window): "asc" | "desc" => (w.sort === "asc" ? "asc" : "desc");
  const txColumns = `t.block_number, t.tx_index, t.hash, b.hash as block_hash, extract(epoch from b.timestamp)::bigint as ts, t.nonce, t.gas_limit::text as gas_limit,
    t.effective_gas_price::text as price, t.gas_used::text as gas_used, t.cumulative_gas_used::text as cumulative`;
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
    const d = dirOf(w);
    const values: unknown[] = [standard, w.start, w.end, w.skip + w.limit];
    const at = (b: string) => (values.push(bytes(b)), `$${values.length}`);
    const who = a === null ? null : at(a), only = token === null ? "" : ` and tt.token = ${at(token)}`;
    const side = (where: string) =>
      `(select tt.block_number, tt.log_index, tt.batch_index from token_transfers tt join tokens tk on tk.address = tt.token and tk.standard = $1
         where ${where} and tt.block_number between $2 and $3${only} order by tt.block_number ${d}, tt.log_index ${d}, tt.batch_index ${d} limit $4)`;
    const keys = who === null ? side("true") : `${side(`tt.from_address = ${who}`)} union ${side(`tt.to_address = ${who}`)}`;
    values.push(w.limit, w.skip);
    const rows = await query(
      `with k as (${keys})
       select ${txColumns}, tt.log_index, tt.batch_index, tt.token, tt.from_address, tt.to_address, tt.amount::text as amount, tt.token_id::text as token_id, tk.name, tk.symbol, tk.decimals
       from k join token_transfers tt on tt.block_number = k.block_number and tt.log_index = k.log_index and tt.batch_index = k.batch_index
         join tokens tk on tk.address = tt.token
         join transactions t on t.block_number = tt.block_number and t.tx_index = tt.tx_index join blocks b on b.number = tt.block_number
       order by tt.block_number ${d}, tt.log_index ${d}, tt.batch_index ${d} limit $${values.length - 1} offset $${values.length}`,
      values,
    );
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

  return { heads, txlist, internalOf, internalOfTx, internalInBlocks, tokenMoves, mined };
}
