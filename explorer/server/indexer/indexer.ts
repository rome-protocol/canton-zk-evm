/**
 * The indexer's write path: follows the reader party's block records on Canton, one block at a time, and writes each final block to the
 * explorer's own database (design section 4.3). There is exactly one indexer for a database: a PostgreSQL advisory lock refuses a second.
 *
 * `runOnce` is one look: it reads the records after the reader's cursor and indexes each, stopping at the first block a check refuses.
 * `deriveOnce` is stage 2 for the blocks that stage 1 holds and stage 2 does not. `start` runs them on a timer. `INDEX_DERIVE` says how
 * stage 2 commits: `inline` right after stage 1 in the same database transaction, `behind` on its own so that it may fall behind.
 */
import type { Pool, PoolClient } from "pg";
import type { Pins } from "../config.ts";
import { ensurePartitions, PARTITIONS_AHEAD, recordPartitionWidth } from "../db/partitions.ts";
import type { BlockRecord, Ledger } from "../ledger.ts";
import { RethError } from "../reth.ts";
import { IndexerStop, RethBehind } from "./errors.ts";
import { clearStops, setHealth } from "./health.ts";
import { legsSlot } from "./legs.ts";
import type { FinalReads, TxTrace } from "./reads.ts";
import { deriveCursor, stage2 } from "./stage2.ts";
import { legsOf, stage1, type Stage1Input } from "./stage1.ts";

/** Any fixed number; it only has to be the same for every indexer of this schema, and not one the migration runner (001) or the partition maintenance (002) holds. */
const LOCK_KEY = 7_207_371_003;

export type DeriveShape = "inline" | "behind";

export interface IndexerOptions {
  pool: Pool;
  reads: FinalReads;
  ledger: Ledger;
  pins: Pins;
  chainId: number;
  /** The gateway contract's address, lowercase: its `Leg` events are read as the block's legs. */
  gateway: string;
  derive: DeriveShape;
  pollMs?: number;
  /** After this long without reth having a block the record names, the health says so. */
  rethBehindMs?: number;
  /** After this many reads in a row that fail with a reth error (not just a block reth lacks), `reth_reads` says degraded. Default 3. */
  readErrorsBeforeDegraded?: number;
  log?: (line: string) => void;
  /** Called after each block's stage with what it took, in milliseconds. For the budgets' tests and the log. */
  onTiming?: (t: Timing) => void;
  now?: () => number;
}

export interface Timing { block: number; stage: 1 | 2; readMs: number; writeMs: number; txs: number }

export type RunResult =
  | { state: "caught-up" | "reth-behind"; indexed: number }
  | { state: "stopped"; indexed: number; stop: IndexerStop };

const GENESIS_BLOCK = 0;

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    try {
      await c.query("rollback");
    } catch {
      broken = true; // the connection is gone: the server has rolled the transaction back
    }
    throw e;
  } finally {
    c.release(broken);
  }
}

export function createIndexer(o: IndexerOptions) {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? Date.now;
  const inline = o.derive === "inline";
  let lock: PoolClient | null = null;
  let genesisHash: string | null = null;
  let participantId: string | null = null;
  let stopped: IndexerStop | null = null;
  /** Set by the function `start` returns: the walk ends after the record it is on. */
  let stopRequested = false;
  const isRunning = () => !stopRequested;
  /** The highest block number that has a partition in every partitioned table. */
  let partitionsThrough = -1;

  /** Takes the lock, and checks that this database is the one these pins describe (the pins are kept in `meta` and checked at every start). */
  async function open(): Promise<void> {
    const c = await o.pool.connect();
    const got = await c.query("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
    if (!got.rows[0].ok) {
      c.release();
      throw new Error("another indexer holds this database's lock: there is exactly one indexer for a database");
    }
    lock = c;
    const genesis = await o.reads.block(GENESIS_BLOCK);
    if (!genesis) throw new Error("reth has no block 0");
    genesisHash = genesis.hash;
    const pinned: [string, string][] = [
      ["chain_id", String(o.chainId)], ["genesis_hash", genesis.hash], ["program_vk", o.pins.programVK], ["root_c", o.pins.rootC], ["gateway_address", o.gateway],
    ];
    for (const [key, value] of pinned) {
      await o.pool.query("insert into meta (key, value) values ($1, $2) on conflict do nothing", [key, value]);
      const have = (await o.pool.query("select value from meta where key = $1", [key])).rows[0].value as string;
      if (have !== value) {
        throw await stop(new IndexerStop("pins", `this database was made for ${key} ${have}, but this indexer is set to ${value}: it belongs to another chain or another set of pins`, null, { key, database: have, setting: value }));
      }
    }
    await clearStops(o.pool, ["pins"]);
    await o.pool.query("insert into cursors (stream, position, updated_at) values ('derive', 0, now()) on conflict do nothing");
    participantId = await o.ledger.participantId();
  }

  async function close(): Promise<void> {
    if (!lock) return;
    const c = lock;
    lock = null;
    try {
      await c.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    } finally {
      c.release();
    }
  }

  /** A stop is written to the check's row of health_checks as `down`, and the indexer does nothing more until it is started again. */
  async function stop(e: IndexerStop): Promise<IndexerStop> {
    stopped = e;
    log(`indexer stopped at check ${e.check}: ${e.message}`);
    await setHealth(o.pool, [{ id: e.check, status: "down", value: { block: e.block, ...e.seen }, detail: e.message }]);
    return e;
  }

  async function readerCursor(): Promise<{ position: number; participant: string | null }> {
    const r = await o.pool.query("select position, detail from cursors where stream = 'reader_updates'");
    if (!r.rowCount) return { position: 0, participant: null };
    return { position: Number(r.rows[0].position), participant: (r.rows[0].detail?.participant as string | undefined) ?? null };
  }

  /** An insert must never meet a block number with no partition: they are made ahead of the head, as the database module's maintenance does. */
  async function partitionsFor(n: number): Promise<void> {
    if (n <= partitionsThrough) return;
    await ensurePartitions(o.pool, { head: n });
    const width = await recordPartitionWidth(o.pool);
    partitionsThrough = (Math.floor(n / width) + PARTITIONS_AHEAD + 1) * width - 1;
  }

  async function indexRecord(r: BlockRecord, startOffset: number): Promise<void> {
    const n = r.number;
    await partitionsFor(n);
    const t0 = now();
    // Reads from reth: the block and its receipts at once (and the traces too when stage 2 shares the transaction), then the gateway's `legs[n]` if the block has legs.
    const [block, receipts, traces] = await Promise.all([o.reads.block(n), o.reads.receipts(n), inline ? o.reads.traces(n) : Promise.resolve(null)]);
    if (!block) throw new RethBehind(n, "block");
    if (!receipts) throw new RethBehind(n, "receipts");
    if (inline && !traces) throw new RethBehind(n, "traces");
    // A Leg event that cannot be decoded is not a stop (design section 4.5): the block goes in with the legs that decode, its count says how many the chain wrote, and C10 says degraded.
    const { legs, count: legsCount, problem: legProblem } = legsOf(receipts, o.gateway, n);
    const legsHash = legsCount > 0 ? await o.reads.storageAt(o.gateway, legsSlot(n), n) : null;
    const read1 = now() - t0;
    if (inline) await catchUpDerive(n - 1);
    const input: Stage1Input = {
      record: r, block, receipts, legs, legsCount, legsHash, genesisHash: genesisHash as string, participantId: participantId as string, startOffset, pins: o.pins,
    };
    await inTransaction(o.pool, async (c) => {
      const w1 = now();
      const done = await stage1(c, input);
      await clearStops(c, ["record"]);
      if (legProblem && done.written) await setHealth(c, [{ id: "C10", status: "degraded", value: { block: n }, detail: legProblem.message }]);
      const w2 = now();
      o.onTiming?.({ block: n, stage: 1, readMs: read1, writeMs: w2 - w1, txs: block.transactions.length });
      if (done.written && inline) {
        await stage2(c, n, traces as TxTrace[]);
        o.onTiming?.({ block: n, stage: 2, readMs: 0, writeMs: now() - w2, txs: block.transactions.length });
      }
    });
  }

  /** One look at Canton: index every record after the reader's cursor. Throws for a read that failed (Canton, reth or the database unreachable), which is retried. */
  async function runOnce(): Promise<RunResult> {
    if (stopped) return { state: "stopped", indexed: 0, stop: stopped };
    let indexed = 0;
    try {
      const cursor = await readerCursor();
      if (cursor.participant && cursor.participant !== participantId) {
        throw new IndexerStop("participant", `the reader's cursor belongs to participant ${cursor.participant}, but this one is ${participantId}: offsets are local to a participant, and a move is an explicit step`, null);
      }
      await clearStops(o.pool, ["participant"]);
      const end = await o.ledger.ledgerEnd();
      if (end > cursor.position) {
        let from = cursor.position;
        // Page by page: each record is committed before the next page is read, so memory stays at one page, a Canton read that fails partway
        // keeps the blocks before it (the cursor has moved), and a stop request takes effect between records.
        walk: for await (const page of o.ledger.recordPages(cursor.position, end)) {
          for (const r of page) {
            if (!isRunning()) break walk;
            await indexRecord(r, from);
            from = r.offset;
            indexed++;
          }
        }
      }
      if (!inline || stopRequested) return { state: "caught-up", indexed };
      await catchUpDerive();
      return { state: "caught-up", indexed };
    } catch (e) {
      if (e instanceof RethBehind) return { state: "reth-behind", indexed };
      if (e instanceof IndexerStop) return { state: "stopped", indexed, stop: await stop(e) };
      throw e;
    }
  }

  /** Stage 2 for each block that stage 1 holds and the derive cursor has not reached, in order, up to `upTo` when given. */
  async function catchUpDerive(upTo = Infinity): Promise<number> {
    let done = 0;
    for (;;) {
      const at = await deriveCursor(o.pool);
      const head = Number((await o.pool.query("select coalesce(max(number), 0) as n from blocks")).rows[0].n);
      const n = at + 1;
      if (n > head || n > upTo) return done;
      const t0 = now();
      const traces = await o.reads.traces(n);
      if (!traces) throw new RethBehind(n, "traces");
      const read = now() - t0;
      await inTransaction(o.pool, async (c) => {
        const w = now();
        const res = await stage2(c, n, traces);
        o.onTiming?.({ block: n, stage: 2, readMs: read, writeMs: now() - w, txs: traces.length });
        return res;
      });
      done++;
    }
  }

  /** Stage 2 alone, for the `behind` shape. */
  async function deriveOnce(): Promise<RunResult> {
    if (stopped) return { state: "stopped", indexed: 0, stop: stopped };
    try {
      return { state: "caught-up", indexed: await catchUpDerive() };
    } catch (e) {
      if (e instanceof RethBehind) return { state: "reth-behind", indexed: 0 };
      if (e instanceof IndexerStop) return { state: "stopped", indexed: 0, stop: await stop(e) };
      throw e;
    }
  }

  /**
   * Runs the look on a timer (and stage 2 on its own timer in the `behind` shape) until `stopFn` is called or a check stops the indexer, which
   * is reported to `onStop`. A read that fails is logged and tried again on the next turn.
   */
  function start(onStop: (e: IndexerStop) => void = () => undefined): () => Promise<void> {
    let running = true;
    const poll = o.pollMs ?? 250;
    const behindMs = o.rethBehindMs ?? 10_000;
    const errorLimit = o.readErrorsBeforeDegraded ?? 3;
    // The row `reth_reads` is degraded while any loop reports a problem and goes back to ok only when the last one clears it, so the walk and
    // the derive loops, which poll on their own, do not hide each other's report or make the row flap.
    const reporting = new Map<string, string>();
    async function report(loop: string, detail: string | null): Promise<void> {
      try {
        if (detail === null) {
          if (reporting.delete(loop) && reporting.size === 0) await setHealth(o.pool, [{ id: "reth_reads", status: "ok" }]);
        } else if (!reporting.has(loop)) {
          reporting.set(loop, detail);
          await setHealth(o.pool, [{ id: "reth_reads", status: "degraded", detail }]);
        }
      } catch (he) { log(`indexer: ${(he as Error).message}`); }
    }
    const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
    // A reth that answers with an error or does not answer in time (a method it does not serve, a heavy block's replay) halts the walk as surely as a block it lacks, so it is said the same way.
    function loop(name: string, step: () => Promise<RunResult>, logName: string) {
      let behindSince: number | null = null;
      let readErrors = 0;
      return async () => {
        while (running) {
          try {
            const r = await step();
            readErrors = 0;
            if (r.state === "stopped") { onStop(r.stop); running = false; return; }
            if (r.state === "reth-behind") {
              behindSince ??= now();
              if (now() - behindSince >= behindMs) await report(name, "reth does not have the block that Canton's newest record names");
            } else {
              behindSince = null;
              await report(name, null);
            }
          } catch (e) {
            log(`${logName}: ${(e as Error).message}`);
            if (e instanceof RethError && ++readErrors >= errorLimit) await report(name, e.message);
          }
          await sleep(poll);
        }
      };
    }
    const loops = [
      loop("stage1", runOnce, "indexer"),
      ...(inline ? [] : [loop("stage2", deriveOnce, "indexer (stage 2)")]),
    ];
    const finished = Promise.all(loops.map((l) => l()));
    return async () => { stopRequested = true; running = false; await finished; };
  }

  return { open, close, runOnce, deriveOnce, start, stopped: () => stopped };
}

export type Indexer = ReturnType<typeof createIndexer>;
