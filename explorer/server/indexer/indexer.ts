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
import { custodyOnce } from "./custody.ts";
import { venueOnce } from "./venue.ts";
import { RethError } from "../reth.ts";
import { IndexerStop, Paused, RethBehind } from "./errors.ts";
import { recordGenesisSupply, seedGenesis } from "./genesis.ts";
import { clearStops, setHealth, type HealthRow } from "./health.ts";
import { createJournal } from "./journal.ts";
import { createLifecycleChecks } from "./lifecycle.ts";
import { checkIds } from "./db-ids.ts";
import { legsSlot } from "./legs.ts";
import { notify } from "./notify.ts";
import { repairTrexProxies } from "./proxies.ts";
import type { FinalReads, TxTrace } from "./reads.ts";
import { rollupStats, type RollupResult } from "./stats.ts";
import { markNightly, nightlyDue, nightlyWindow, runAudit, type AuditKind, type AuditResult } from "./audit.ts";
import { deriveCursor, stage2 } from "./stage2.ts";
import { checkBalances, type BalanceCheck } from "./balances.ts";
import type { ExportedRecord, RecordsHeader } from "./records.ts";
import { REINDEX_KEY } from "./reindex.ts";
import { checkLegs, legsOf, stage1, type Stage1Input } from "./stage1.ts";

/** Any fixed number; it only has to be the same for every indexer of this schema, and not one the migration runner (001) or the partition maintenance (002) holds. */
export const LOCK_KEY = 7_207_371_003;

export type DeriveShape = "inline" | "behind";

export interface IndexerOptions {
  pool: Pool;
  reads: FinalReads;
  ledger: Ledger;
  pins: Pins;
  chainId: number;
  /** The gateway contract's address, lowercase: its `Leg` events are read as the block's legs. */
  gateway: string;
  /** The chain's genesis.json: its contracts are seeded at first start. Left out, nothing is seeded (the command always names it). */
  genesisFile?: string | null;
  derive: DeriveShape;
  pollMs?: number;
  /** How often `start` runs the checks that are not tied to a block (C4, C5, the derive lag), in milliseconds. Default 2000. */
  checkMs?: number;
  /**
   * The producer's journal folder and status.json. `undefined` leaves the lifecycle out altogether (a test of something else); `null` says there is
   * none, and the health says so. `journalMs` is how often the journal is read (default 1000).
   */
  journalDir?: string | null;
  producerStatusFile?: string | null;
  journalMs?: number;
  /** How often `start` runs C6's sample audit (20 random blocks against reth), in milliseconds. Default 10 minutes. The nightly audit of the previous day follows the first sample after 03:00 UTC. */
  auditMs?: number;
  /** How often `start` runs the stats rollups (design section 8), in milliseconds. Default 10 seconds. */
  rollupMs?: number;
  /**
   * The custody read (the registered tokens and the gateway's holdings, as the gateway party sees them, at the offset of the newest indexed block, set against each token's supply at that block): a Ledger API client built for the gateway party
   * (a token of its own, with the right to read as it and nothing else). Left out, nothing is read and the table stays empty. `ms` is how often `start`
   * reads it (default 30 seconds); `limit` is how many contracts to ask Canton for (default 200, Canton's own list maximum), and a read that fills it fails.
   * The same client reads the Canton side of the swaps (a venue's trades and the funded claims, `venueOnce`), after each custody read.
   */
  custody?: { ledger: Ledger; ms?: number; limit?: number };
  /** For C6's choice of blocks. */
  random?: () => number;
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
  | { state: "caught-up" | "reth-behind" | "paused"; indexed: number }
  | { state: "stopped"; indexed: number; stop: IndexerStop };

const GENESIS_BLOCK = 0;

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query("begin");
    // A reindex holds this key exclusively; each step of the indexer holds it shared until it commits, so the two never work at once.
    if (!(await c.query("select pg_try_advisory_xact_lock_shared($1) as ok", [REINDEX_KEY])).rows[0].ok) throw new Paused();
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
  /** What the walk has seen of Canton, for C4 and C5: the newest block number in any page it read, and the record it is on (read, not yet indexed). */
  let newestSeen = 0;
  let pending: { number: number; since: number } | null = null;
  /** When the ledger end was first seen past the cursor with no record indexed since, while the walk has not reached it: C5's lag when the walk cannot read a record at all. */
  let waitingSince: number | null = null;
  /** When C4 first saw reth's finalized more than one block behind the newest record, while it stays so. */
  let behindSince: number | null = null;
  /** The highest block number that has a partition in every partitioned table. */
  let partitionsThrough = -1;
  /** The producer's journal and the checks that need it. Absent when the options leave the lifecycle out. */
  const lifecycleOn = o.journalDir !== undefined;
  const journal = createJournal({ pool: o.pool, folder: o.journalDir ?? null, now, log });
  const producer = createLifecycleChecks({ pool: o.pool, statusFile: o.producerStatusFile ?? null, now });
  let journalAvailable = false;

  /** Reads what is new in the producer's journal into the lifecycle tables (a no-op when the lifecycle is left out). */
  async function loadJournal() {
    if (!lifecycleOn) return null;
    const r = await journal.load();
    journalAvailable = r.available;
    if (r.lines > 0) await notify(o.pool, { kind: "inflight" });
    return r;
  }

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
    // The first key, the one from block 0: a later key added to the pins file for a program switch does not make this database another chain's.
    const pinned: [string, string][] = [
      ["chain_id", String(o.chainId)], ["genesis_hash", genesis.hash], ["program_vk", o.pins.keys[0]!.programVK], ["root_c", o.pins.keys[0]!.rootC], ["gateway_address", o.gateway],
    ];
    for (const [key, value] of pinned) {
      await o.pool.query("insert into meta (key, value) values ($1, $2) on conflict do nothing", [key, value]);
      const have = (await o.pool.query("select value from meta where key = $1", [key])).rows[0].value as string;
      if (have !== value) {
        throw await stop(new IndexerStop("pins", `this database was made for ${key} ${have}, but this indexer is set to ${value}: it belongs to another chain or another set of pins`, null, { key, database: have, setting: value }));
      }
    }
    await clearStops(o.pool, ["pins"]);
    if (o.genesisFile) {
      try {
        const seeded = await seedGenesis(o.pool, o.reads, o.genesisFile, o.gateway);
        if (seeded > 0) log(`indexer: seeded ${seeded} genesis contracts`);
        await recordGenesisSupply(o.pool, o.genesisFile);
        await clearStops(o.pool, ["genesis"]);
      } catch (e) {
        if (e instanceof IndexerStop) throw await stop(e);
        throw e;
      }
    }
    // A database indexed before the chain instance was kept has it from block 1's record.
    await o.pool.query("insert into meta (key, value) select 'chain_instance', update_id from blocks where number = 1 on conflict do nothing");
    await o.pool.query("insert into cursors (stream, position, updated_at) values ('derive', 0, now()) on conflict do nothing");
    // The proxies of an implementation authority (ERC-3643, ONCHAINID) that were made before the indexer knew them: looked at once.
    try {
      const repaired = await repairTrexProxies(o.pool, o.reads);
      if (repaired > 0) log(`indexer: found ${repaired} proxies of an implementation authority among the contracts made before`);
    } catch (e) {
      log(`indexer: the look at earlier implementation-authority proxies failed and is tried again at the next start: ${(e as Error).message}`);
    }
    // The participant is read from Canton when the walk first needs it (runOnce), not here: a rebuild from a file does not need Canton.
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

  async function indexedHead(): Promise<{ number: number; hash: string } | null> {
    const r = await o.pool.query("select number, hash from blocks order by number desc limit 1");
    return r.rowCount ? { number: Number(r.rows[0].number), hash: "0x" + (r.rows[0].hash as Buffer).toString("hex") } : null;
  }

  /** The stop for a database that does not belong to the chain being read. It says what was seen, and the indexer never wipes anything by itself. */
  const otherChain = (why: string, head: number, seen: Record<string, unknown>) =>
    new IndexerStop("chain_instance", `this database belongs to another chain instance: ${why}. Nothing was changed; \`explorer reset\` starts a database for the new chain`, head || null, seen);

  /** The chain instance guard (design section 4.4), (a) and (b), at every look. A new chain from the same genesis has the same chain id, genesis hash and pins, so only these tell. */
  async function guardChain(head: { number: number; hash: string } | null, cursorOffset: number, ledgerEnd: number): Promise<void> {
    if (head) {
      const have = await o.reads.hashAt(head.number);
      if (have === null) throw otherChain(`reth has no block ${head.number}, which is indexed`, head.number, { head: head.number, indexed: head.hash });
      if (have !== head.hash) throw otherChain(`reth's block ${head.number} is ${have}, but ${head.hash} is indexed`, head.number, { head: head.number, indexed: head.hash, reth: have });
    }
    if (ledgerEnd < cursorOffset) {
      throw otherChain(`the reader's ledger end ${ledgerEnd} is below the cursor's offset ${cursorOffset}`, head?.number ?? 0, { ledgerEnd, cursor: cursorOffset });
    }
    await clearStops(o.pool, ["chain_instance"]);
  }

  /** (c): the first record after the cursor is the next block, or a block already indexed (a replay) with the same hash. */
  async function guardFirstRecord(r: BlockRecord, head: { number: number; hash: string } | null, cursorPosition: number): Promise<void> {
    const headNumber = head?.number ?? 0;
    if (r.number === headNumber + 1) return;
    if (r.number <= headNumber) {
      const have = (await o.pool.query("select hash from blocks where number = $1", [r.number])).rows[0]?.hash as Buffer | undefined;
      if (have && "0x" + have.toString("hex") === r.blockHash) return;
      throw otherChain(`the first record after the cursor is block ${r.number} with hash ${r.blockHash}, not the one indexed`, headNumber, { head: headNumber, record: r.number, recordHash: r.blockHash });
    }
    // The move is named only while the cursor is still at the new participant's start, and the latest is the highest number (not the highest text).
    const moves = cursorPosition === 0 ? (await o.pool.query("select key, value from meta where key like 'reader\\_move\\_%'")).rows as { key: string; value: string }[] : [];
    const move = moves.sort((a, b) => Number(b.key.slice("reader_move_".length)) - Number(a.key.slice("reader_move_".length)))[0];
    const after = move ? ` after the move to participant ${JSON.parse(move.value).to}` : "";
    throw otherChain(`there is a gap${after}: the first record after the cursor is block ${r.number}, and block ${headNumber + 1} was expected`, headNumber, { head: headNumber, record: r.number, expected: headNumber + 1 });
  }

  async function indexRecord(r: BlockRecord, startOffset: number, participant: string): Promise<void> {
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
      record: r, block, receipts, legs, legsCount, legsHash, genesisHash: genesisHash as string, participantId: participant, startOffset, pins: o.pins,
    };
    await inTransaction(o.pool, async (c) => {
      const w1 = now();
      const done = await stage1(c, input);
      await clearStops(c, ["record"]);
      if (done.written && n === 1) await c.query("insert into meta (key, value) values ('chain_instance', $1) on conflict do nothing", [r.updateId]);
      if (done.written) await checkLegs(c, n, legs, legsHash, legProblem);
      // Told to the API instances when this transaction commits (design 6.4).
      if (done.written) await notify(c, { kind: "final", number: n });
      const w2 = now();
      o.onTiming?.({ block: n, stage: 1, readMs: read1, writeMs: w2 - w1, txs: block.transactions.length });
      // The derive cursor is read again under the shared lock: stage 2 follows in this transaction only when the cursor is right behind this block;
      // otherwise (a catch-up is still owed) the block is left to catchUpDerive, and the walk goes on.
      if (done.written && inline && (await deriveCursor(c)) === n - 1) {
        await stage2(c, n, traces as TxTrace[], o.reads);
        await notify(c, { kind: "derived", number: n });
        o.onTiming?.({ block: n, stage: 2, readMs: 0, writeMs: now() - w2, txs: block.transactions.length });
      }
    });
  }

  /** One look at Canton: index every record after the reader's cursor. Throws for a read that failed (Canton, reth or the database unreachable), which is retried. */
  async function runOnce(): Promise<RunResult> {
    if (stopped) return { state: "stopped", indexed: 0, stop: stopped };
    let indexed = 0;
    try {
      const me = (participantId ??= await o.ledger.participantId());
      const cursor = await readerCursor();
      if (cursor.participant && cursor.participant !== me) {
        throw new IndexerStop("participant", `the reader's cursor belongs to participant ${cursor.participant}, but this one is ${me}: offsets are local to a participant, and a move is an explicit step`, null);
      }
      await clearStops(o.pool, ["participant"]);
      const end = await o.ledger.ledgerEnd();
      const head = await indexedHead();
      await guardChain(head, cursor.position, end);
      if (end > cursor.position) waitingSince ??= now(); else waitingSince = null;
      if (end > cursor.position) {
        let from = cursor.position;
        let first = true;
        // Page by page: each record is committed before the next page is read, so memory stays at one page, a Canton read that fails partway
        // keeps the blocks before it (the cursor has moved), and a stop request takes effect between records.
        walk: for await (const page of o.ledger.recordPages(cursor.position, end)) {
          if (page.length > 0) newestSeen = Math.max(newestSeen, ...page.map((r) => r.number));
          for (const r of page) {
            if (!isRunning()) break walk;
            if (first) {
              first = false;
              await guardFirstRecord(r, head, cursor.position);
            }
            pending ??= { number: r.number, since: Date.parse(r.recordTime) };
            await indexRecord(r, from, me);
            pending = null;
            waitingSince = null;
            from = r.offset;
            indexed++;
          }
        }
        if (isRunning()) waitingSince = null;
      }
      pending = null;
      if (!inline || stopRequested) return { state: "caught-up", indexed };
      await catchUpDerive();
      return { state: "caught-up", indexed };
    } catch (e) {
      if (e instanceof RethBehind) return { state: "reth-behind", indexed };
      if (e instanceof Paused) return { state: "paused", indexed };
      if (e instanceof IndexerStop) return { state: "stopped", indexed, stop: await stop(e) };
      waitingSince ??= now(); // a read that failed with records still waiting: C5 counts from here
      throw e;
    }
  }

  const DEGRADED_LAG_S = 5, DOWN_LAG_S = 30, BEHIND_BLOCKS = 1, BEHIND_FOR_MS = 2000, DERIVE_LAG_S = 60;

  /**
   * The checks that are not tied to one block, run every `checkMs` by `start` (and by a test, one at a time): C4 (reth's finalized against the
   * newest record), C5 (the index against the newest record, in blocks and in seconds since that record became readable), and the derive lag
   * (stage 2 behind stage 1). Each writes its row of health_checks. C10's row is made `ok` here when no block with legs has been seen yet.
   * "The newest record" is the newest the walk has read from Canton, or the indexed head when the walk has nothing newer.
   */
  async function checkOnce(): Promise<void> {
    const t = now();
    const head = (await indexedHead())?.number ?? 0;
    const newest = Math.max(newestSeen, head);
    // C5 and derive_lag read only the database and Canton's side, so a reth that does not answer must not stop them: C4 says so itself.
    let finalized = 0;
    let c4Row: HealthRow;
    try {
      finalized = (await o.reads.finalized()) ?? 0;
      const behind = newest - finalized;
      if (behind > BEHIND_BLOCKS) behindSince ??= t; else behindSince = null;
      const c4 = behindSince !== null && t - behindSince > BEHIND_FOR_MS;
      c4Row = { id: "C4", status: c4 ? "degraded" : "ok", value: { finalized, newest }, threshold: { behindBlocks: BEHIND_BLOCKS, forMs: BEHIND_FOR_MS },
        detail: c4 ? `reth's finalized block ${finalized} is ${behind} blocks behind the newest record, block ${newest}` : null };
    } catch (e) {
      c4Row = { id: "C4", status: "degraded", value: { newest }, threshold: { behindBlocks: BEHIND_BLOCKS, forMs: BEHIND_FOR_MS }, detail: `reth's finalized block cannot be read: ${(e as Error).message}` };
    }
    // The lag in seconds is the longer of two: the record the walk is on, and the time since the ledger end was ahead of the cursor with no progress (a walk that cannot read yields no record).
    const waited = Math.max(pending ? t - pending.since : 0, waitingSince !== null ? t - waitingSince : 0);
    const lagSeconds = Math.max(0, Math.round(waited / 100) / 10);
    const lagBlocks = Math.max(0, newest - head);
    const at = await deriveCursor(o.pool);
    const waiting = await o.pool.query("select extract(epoch from now() - indexed_at) as s from blocks where number = $1", [at + 1]);
    const deriveSeconds = waiting.rowCount ? Math.max(0, Math.round(Number(waiting.rows[0].s) * 10) / 10) : 0;
    // A warning-only check must not hold back the others: when the id columns cannot be read, db_ids says so and the rows above are still written.
    let idsRow: HealthRow;
    try {
      idsRow = await checkIds(o.pool);
    } catch (e) {
      idsRow = { id: "db_ids", status: "degraded", detail: `the id columns cannot be read: ${(e as Error).message}` };
    }
    await setHealth(o.pool, [
      c4Row,
      { id: "C5", status: lagSeconds > DOWN_LAG_S ? "down" : lagSeconds > DEGRADED_LAG_S ? "degraded" : "ok", value: { lagBlocks, lagSeconds }, threshold: { degradedSeconds: DEGRADED_LAG_S, downSeconds: DOWN_LAG_S },
        detail: lagSeconds > DEGRADED_LAG_S ? `the index is ${lagBlocks} blocks behind, and its oldest waiting record became readable ${lagSeconds} s ago` : null },
      { id: "derive_lag", status: deriveSeconds > DERIVE_LAG_S ? "degraded" : "ok", value: { blocks: Math.max(0, head - at), seconds: deriveSeconds }, threshold: { degradedSeconds: DERIVE_LAG_S },
        detail: deriveSeconds > DERIVE_LAG_S ? `stage 2 is ${Math.max(0, head - at)} blocks behind stage 1, and the block it waits on was indexed ${deriveSeconds} s ago` : null },
      idsRow,
    ]);
    // C10 is written only by blocks that have legs; its row is made ok when none was seen, and its look is refreshed (the status is not) so that a quiet chain does not read as a stale check.
    await o.pool.query("insert into health_checks (check_id, status, value, changed_at, checked_at) values ('C10', 'ok', null, now(), now()) on conflict (check_id) do update set checked_at = now()");
    if (lifecycleOn) await producer.run(journalAvailable);
  }

  /** C6 (design section 4.5): blocks fetched again from reth and compared with the index. Writes the row and returns it. */
  const auditOnce = async (kind: AuditKind): Promise<AuditResult> => {
    const at = new Date(now());
    return runAudit(o.pool, o.reads, kind, o.random, undefined, kind === "day" ? await nightlyWindow(o.pool, at) : undefined);
  };

  /** The stats rollups, up to the open minute (design section 8). Safe to run again. */
  const rollupStatsOnce = (): Promise<RollupResult> => rollupStats(o.pool, { now });

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
        const res = await stage2(c, n, traces, o.reads);
        await notify(c, { kind: "derived", number: n });
        o.onTiming?.({ block: n, stage: 2, readMs: read, writeMs: now() - w, txs: traces.length });
        return res;
      });
      done++;
    }
  }

  /** One turn of the background check of balances (balances.ts), behind the derive cursor. */
  const balancesOnce = (opts?: { blocks?: number; tokenBatch?: number }): Promise<BalanceCheck> => checkBalances(o.pool, o.reads, opts);

  /** Stage 2 alone, for the `behind` shape. */
  async function deriveOnce(): Promise<RunResult> {
    if (stopped) return { state: "stopped", indexed: 0, stop: stopped };
    try {
      return { state: "caught-up", indexed: await catchUpDerive() };
    } catch (e) {
      if (e instanceof RethBehind) return { state: "reth-behind", indexed: 0 };
      if (e instanceof Paused) return { state: "paused", indexed: 0 };
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
            if (r.state === "paused") {
              // A reindex has the database: nothing to report, the lag shows in the health.
            } else if (r.state === "reth-behind") {
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
    const checkMs = o.checkMs ?? 2000;
    const checks = async () => {
      while (running) {
        try {
          await checkOnce();
        } catch (e) {
          log(`indexer (checks): ${(e as Error).message}`);
        }
        for (let waited = 0; running && waited < checkMs; waited += 50) await sleep(50);
      }
    };
    // The check of balances reads from reth at older blocks and is never on the way of a block, so a failure is logged and said as the other reads are.
    const balancesLoop = async () => {
      let errors = 0;
      while (running) {
        let again = false;
        try {
          const r = await balancesOnce();
          errors = 0;
          await report("balances", null);
          again = r.blocks + r.checked + r.retried > 0;
        } catch (e) {
          if (!(e instanceof Paused)) {
            log(`indexer (balances): ${(e as Error).message}`);
            if (e instanceof RethError && ++errors >= errorLimit) await report("balances", e.message);
          }
        }
        if (!again) for (let waited = 0; running && waited < checkMs; waited += 50) await sleep(50);
      }
    };
    const journalMs = o.journalMs ?? 1000;
    const journalLoop = async () => {
      while (running && lifecycleOn) {
        try {
          await loadJournal();
        } catch (e) {
          log(`indexer (journal): ${(e as Error).message}`);
        }
        for (let waited = 0; running && waited < journalMs; waited += 50) await sleep(50);
      }
    };
    const auditMs = o.auditMs ?? 600_000;
    const audits = async () => {
      while (running) {
        try {
          await auditOnce("sample");
          if (await nightlyDue(o.pool, new Date(now()))) {
            // The day counts as audited only when every block was read; otherwise the next pass tries again.
            if ((await auditOnce("day")).complete) await markNightly(o.pool, new Date(now()));
          }
        } catch (e) {
          log(`indexer (audit): ${(e as Error).message}`);
        }
        for (let waited = 0; running && waited < auditMs; waited += 50) await sleep(50);
      }
    };
    const rollupMs = o.rollupMs ?? 10_000;
    const statsLoop = async () => {
      while (running) {
        try {
          await rollupStatsOnce();
        } catch (e) {
          log(`indexer (stats): ${(e as Error).message}`);
        }
        for (let waited = 0; running && waited < rollupMs; waited += 50) await sleep(50);
      }
    };
    // The custody is Canton's side only and never on the way of a block: a read that fails is logged, and the last rows stay with the time they were read at.
    const custodyMs = o.custody?.ms ?? 30_000;
    const custodyLoop = async () => {
      let failing = "", venueFailing = "";
      while (running && o.custody) {
        try {
          await custodyOnce(o.pool, o.custody.ledger, o.reads, o.custody.limit ?? 200, (participantId ??= await o.ledger.participantId()), o.chainId);
          failing = "";
        } catch (e) {
          // Said once for each kind of failure, not on every pass.
          if (failing !== (e as Error).message) log(`indexer (custody): ${(e as Error).message}`);
          failing = (e as Error).message;
        }
        // The Canton side of the swaps (a venue's trades and the funded claims) is read the same way, as the gateway party, and fails on its own.
        try {
          await venueOnce(o.pool, o.custody.ledger, (participantId ??= await o.ledger.participantId()), o.chainId);
          venueFailing = "";
        } catch (e) {
          if (venueFailing !== (e as Error).message) log(`indexer (venue trades): ${(e as Error).message}`);
          venueFailing = (e as Error).message;
        }
        for (let waited = 0; running && waited < custodyMs; waited += 50) await sleep(50);
      }
    };
    const finished = Promise.all([...loops.map((l) => l()), checks(), balancesLoop(), journalLoop(), audits(), statsLoop(), custodyLoop()]);
    return async () => { stopRequested = true; running = false; await finished; };
  }

  /**
   * Builds the database from an export of block records (design section 4.4): each record goes through stage 1 as if Canton had sent it, with
   * every check, and reth is read as for any block. A record at or below the database's head is not sent through stage 1 (that would move the
   * reader's cursor back): it is skipped after its hash is checked against the stored block, so the rebuild can be run again, or resumed after
   * an interruption, or on a database that has some of the blocks. The header must name this chain. Stage 2 follows when it is `behind`.
   * Returns the records written.
   */
  async function rebuild(records: AsyncIterable<RecordsHeader | ExportedRecord>): Promise<number> {
    let written = 0;
    for await (const item of records) {
      if (stopped) throw stopped;
      if ("format" in item) {
        if (item.chainId !== o.chainId || item.genesisHash !== genesisHash) throw new Error(`the records are for chain ${item.chainId} with genesis ${item.genesisHash}, not for chain ${o.chainId} with genesis ${genesisHash}`);
        continue;
      }
      if (item.chainId !== o.chainId) throw new Error(`block ${item.number}: the record is for chain ${item.chainId}, not ${o.chainId}`);
      try {
        const have = await o.pool.query("select hash from blocks where number = $1", [item.number]);
        const head = Number((await o.pool.query("select coalesce(max(number), 0) as n from blocks")).rows[0].n);
        if (item.number <= head) {
          const stored = have.rowCount ? "0x" + (have.rows[0].hash as Buffer).toString("hex") : null;
          if (stored !== item.blockHash) {
            throw new IndexerStop("C2", `block ${item.number} is indexed with hash ${stored ?? "(none)"}, but the record says ${item.blockHash}: this database belongs to another chain instance`, item.number);
          }
          continue;
        }
        await indexRecord(item, item.participant.firstOffset ?? item.offset, item.participant.id);
      } catch (e) {
        if (e instanceof IndexerStop) throw await stop(e);
        throw e;
      }
      written++;
    }
    if (!inline) await catchUpDerive();
    return written;
  }

  return { open, close, runOnce, deriveOnce, balancesOnce, checkOnce, auditOnce, rollupStatsOnce, loadJournal, start, rebuild, stopped: () => stopped };
}

export type Indexer = ReturnType<typeof createIndexer>;
