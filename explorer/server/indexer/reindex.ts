/**
 * `explorer reindex <from> [<to>]` (design section 4.4): works out the stage 1 tables again for a range of blocks, from what the database
 * already holds (the block records, with their proofs and Canton updates) and from reth. It does not read Canton, so it does not depend on
 * what the participant still holds, and it is deterministic: the same range twice gives the same rows.
 *
 * Block by block, in its own database transaction, it deletes the block's fact rows (transactions, their hashes, logs, gateway legs) and
 * writes them again with the block's row. It leaves the lifecycle, the tracker, the faucet, the verified sources, and the stored records,
 * proofs and Canton updates alone. Stage 2's rows for the range and everything after it are dropped and the derive cursor goes back before
 * the range, so that stage 2 works them out again behind the new facts.
 *
 * It takes the reindex lock exclusively. The live indexer takes it shared inside each of its transactions and, while a reindex holds it,
 * does nothing and tries again: its lag shows in the health. The aggregates (address counters, contract and token counts, balances) are
 * rebuilt here from the fact tables as the slices that add them land; this slice has none.
 */
import type { Pool, PoolClient } from "pg";
import { IndexerStop, LegUndecodable } from "./errors.ts";
import { setHealth } from "./health.ts";
import { legsSlot } from "./legs.ts";
import type { FinalReads } from "./reads.ts";
import { transactionHashes } from "./rlp.ts";
import { legsOf, writeBlockRow, writeFacts } from "./stage1.ts";

/** Any fixed number, the same for every process of this schema; not the indexer's own lock key. */
export const REINDEX_KEY = 7_207_371_004;

export interface ReindexOptions {
  pool: Pool;
  reads: Pick<FinalReads, "block" | "receipts" | "storageAt">;
  gateway: string;
  log?: (line: string) => void;
  /** How long to wait for the lock (an in-flight block of the live indexer, or another reindex) before giving up. Default 60 s. */
  lockWaitMs?: number;
}

const hex = (b: Buffer): string => "0x" + b.toString("hex");

async function takeLock(o: ReindexOptions): Promise<PoolClient> {
  const c = await o.pool.connect();
  const until = Date.now() + (o.lockWaitMs ?? 60_000);
  for (;;) {
    if ((await c.query("select pg_try_advisory_lock($1) as ok", [REINDEX_KEY])).rows[0].ok) return c;
    if (Date.now() >= until) {
      c.release();
      throw new Error("another reindex, or a block of the indexer, still holds the reindex lock");
    }
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

/** Reindexes blocks `from` to `to` (the head when `to` is null). Returns the range done. Throws a plain Error for a block that reth and the database do not agree on. */
export async function reindexRange(o: ReindexOptions, from: number, to: number | null): Promise<{ from: number; to: number; blocks: number }> {
  const log = o.log ?? (() => undefined);
  const lock = await takeLock(o);
  try {
    const pinned = await o.pool.query("select value from meta where key = 'gateway_address'");
    if (pinned.rowCount && pinned.rows[0].value !== o.gateway) {
      throw new Error(`this database was made for the gateway ${pinned.rows[0].value}, but this reindex is set to ${o.gateway}`);
    }
    const head = Number((await o.pool.query("select coalesce(max(number), 0) as n from blocks")).rows[0].n);
    const last = to ?? head;
    if (from < 1 || last < from || last > head) throw new Error(`the range ${from} to ${last} is not within the indexed blocks 1 to ${head}`);

    // Stage 2 works the range and everything after it out again; its old rows would collide with the new ones.
    await o.pool.query("with d as (delete from tx_traces where block_number >= $1) update cursors set position = least(position, $1::bigint - 1), updated_at = now() where stream = 'derive'", [from]);

    let leg: LegUndecodable | null = null;
    for (let n = from; n <= last; n++) {
      const stored = (await o.pool.query(
        `select b.hash, b.update_id, to_char(b.record_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as record_time, encode(br.header, 'hex') as header, encode(br.txs, 'hex') as txs
         from blocks b join block_records br on br.number = b.number where b.number = $1`, [n])).rows[0];
      if (!stored) throw new Error(`block ${n} has no stored record`);
      const [block, receipts] = await Promise.all([o.reads.block(n), o.reads.receipts(n)]);
      if (!block || !receipts) throw new Error(`reth has no ${block ? "receipts" : "block"} for block ${n}`);
      if (block.hash !== hex(stored.hash)) throw new Error(`block ${n}: reth's hash is ${block.hash}, but the stored block is ${hex(stored.hash)}: this database belongs to another chain instance`);
      const hashes = transactionHashes(stored.txs, n);
      if (hashes.length !== block.transactions.length || hashes.some((h, k) => h !== block.transactions[k]!.hash)) {
        throw new Error(`block ${n}: the stored record's ${hashes.length} transactions do not hash to reth's ${block.transactions.length}, in order`);
      }
      if (receipts.length !== block.transactions.length || receipts.some((x, k) => x.transactionHash !== block.transactions[k]!.hash)) {
        throw new Error(`block ${n}: reth's receipts are not those of its ${block.transactions.length} transactions, in order`);
      }
      const { legs, count: legsCount, problem } = legsOf(receipts, o.gateway, n);
      const legsHash = legsCount > 0 ? await o.reads.storageAt(o.gateway, legsSlot(n), n) : null;
      leg ??= problem;
      const c = await o.pool.connect();
      try {
        await c.query("begin");
        for (const t of ["tx_hashes", "transactions", "logs", "gateway_legs"]) await c.query(`delete from ${t} where block_number = $1`, [n]);
        const logCount = await writeBlockRow(c, { record: { number: n, headerHex: stored.header, txsHex: stored.txs, updateId: stored.update_id, recordTime: stored.record_time }, block, receipts, legsCount, legsHash }, true);
        const { rowsTx, rowsLogs } = await writeFacts(c, n, block, receipts, legs);
        if (rowsTx !== block.transactions.length || rowsLogs !== logCount) {
          throw new IndexerStop("C3", `block ${n}: ${block.transactions.length} transactions and ${logCount} logs, but ${rowsTx} and ${rowsLogs} rows were written`, n);
        }
        await c.query("commit");
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      if (n % 1000 === 0) log(`reindex: block ${n} of ${last}`);
    }
    if (leg) await setHealth(o.pool, [{ id: "C10", status: "degraded", value: { block: leg.block }, detail: leg.message }]);
    return { from, to: last, blocks: last - from + 1 };
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [REINDEX_KEY]).catch(() => undefined);
    lock.release();
  }
}
