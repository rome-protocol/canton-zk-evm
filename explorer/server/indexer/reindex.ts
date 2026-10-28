/**
 * `explorer reindex <from> [<to>]` (design section 4.4): works out the stage 1 tables again for a range of blocks, from what the database
 * already holds (the block records, with their proofs and Canton updates) and from reth. It does not read Canton, so it does not depend on
 * what the participant still holds, and it is deterministic: the same range twice gives the same rows.
 *
 * Block by block, in its own database transaction, it deletes the block's fact rows (transactions, their hashes, logs, gateway legs) and
 * writes them again with the block's row. For a block the derive cursor has already passed, it deletes that block's stage 2 rows too and
 * writes them again from reth's traces with stage 2's own derivation, in the same transaction; a block beyond the cursor has none yet and
 * stage 2 will reach it. The derive cursor is never moved, and nothing is deleted before a block has been read and checked, so a reindex that
 * is refused leaves every table as it was, and the live indexer is not held behind a catch-up of the blocks after the range. It leaves the
 * lifecycle, the tracker, the faucet, the verified sources, and the stored records, proofs and Canton updates alone.
 *
 * C10 is checked for every block it writes, with the indexer's own rule (the shared `checkLegs`): a block whose decoded legs do not hash to the
 * gateway's `legs[N]`, or have a leg that cannot be read, makes the row degraded, and a degraded row stays so until clear-check.
 *
 * It takes the reindex lock exclusively. The live indexer takes it shared inside each of its transactions and, while a reindex holds it,
 * does nothing and tries again: its lag shows in the health. The aggregates (address counters, contract and token counts, balances) are
 * rebuilt here from the fact tables once the range is written (aggregates.ts), in one transaction: a range recomputes every aggregate row it touches from
 * all of that row's facts, and marks the balances read from reth as unchecked, for the background check to read again.
 */
import type { Pool, PoolClient } from "pg";
import { IndexerStop } from "./errors.ts";
import { legsSlot } from "./legs.ts";
import type { FinalReads, TxTrace } from "./reads.ts";
import { transactionHashes } from "./rlp.ts";
import { checkLegs, legsOf, writeBlockRow, writeFacts } from "./stage1.ts";
import { deriveCursor, rederive } from "./stage2.ts";
import { rebuildAggregates } from "./aggregates.ts";

/** Any fixed number, the same for every process of this schema; not the indexer's own lock key. */
export const REINDEX_KEY = 7_207_371_004;

export interface ReindexOptions {
  pool: Pool;
  reads: Pick<FinalReads, "block" | "receipts" | "storageAt" | "traces" | "code" | "call">;
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

    // The lock is held and the live indexer is paused, so the derive cursor stays where it is for the whole range.
    const derived = await deriveCursor(o.pool);

    for (let n = from; n <= last; n++) {
      const stored = (await o.pool.query(
        `select b.hash, b.update_id, to_char(b.record_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as record_time, encode(br.header, 'hex') as header, encode(br.txs, 'hex') as txs
         from blocks b join block_records br on br.number = b.number where b.number = $1`, [n])).rows[0];
      if (!stored) throw new Error(`block ${n} has no stored record`);
      const [block, receipts, traces] = await Promise.all([o.reads.block(n), o.reads.receipts(n), n <= derived ? o.reads.traces(n) : Promise.resolve(null)]);
      if (!block || !receipts) throw new Error(`reth has no ${block ? "receipts" : "block"} for block ${n}`);
      if (n <= derived && !traces) throw new Error(`reth has no traces for block ${n}`);
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
      const c = await o.pool.connect();
      try {
        await c.query("begin");
        for (const t of ["tx_hashes", "transactions", "logs"]) await c.query(`delete from ${t} where block_number = $1`, [n]);
        // The first gateway's legs are written again with the block; a registered gateway's are kept: the block's logs do not change, so neither do the legs read from them.
        await c.query("delete from gateway_legs where block_number = $1 and gateway is null", [n]);
        const logCount = await writeBlockRow(c, { record: { number: n, headerHex: stored.header, txsHex: stored.txs, updateId: stored.update_id, recordTime: stored.record_time }, block, receipts, legsCount, legsHash }, true);
        const { rowsTx, rowsLogs } = await writeFacts(c, n, block, receipts, legs);
        if (rowsTx !== block.transactions.length || rowsLogs !== logCount) {
          throw new IndexerStop("C3", `block ${n}: ${block.transactions.length} transactions and ${logCount} logs, but ${rowsTx} and ${rowsLogs} rows were written`, n);
        }
        await checkLegs(c, n, legs, legsHash, problem);
        if (n <= derived) await rederive(c, n, traces as TxTrace[], o.reads);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      if (n % 1000 === 0) log(`reindex: block ${n} of ${last}`);
    }
    if (from <= derived) {
      const c = await o.pool.connect();
      try {
        await c.query("begin");
        await rebuildAggregates(c, from, last, derived, from === 1 && last === head);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    }
    return { from, to: last, blocks: last - from + 1 };
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [REINDEX_KEY]).catch(() => undefined);
    lock.release();
  }
}
