/**
 * The producer's journal, loaded into the lifecycle tables (design sections 2.5, 4.4 and 4.6; builder/README.md, "The journal", is the
 * authority on the lines). One JSON line per event, in `journal/YYYY-MM-DD.jsonl`. The loader reads whole lines from its cursor (the file and
 * the byte offset, in `cursors` stream 'journal'), applies them, and commits the cursor with the rows in one transaction. A line read twice
 * does no harm: every write sets the same values again.
 *
 * Within one read the lines of a run are applied in the order of their sequence numbers, so a line that arrived out of order still finds its
 * attempt. An attempt's other lines need its `cut` line (the block number is there); lines of an attempt with no `cut` are counted as orphans
 * and said in the health. A gap in the sequence is a line the producer could not write: counted, and said in the health for an hour.
 */
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { setHealth } from "./health.ts";

export const JOURNAL_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const CHUNK_LINES = 2000, READ_BYTES = 8 * 1024 * 1024, GAP_SHOWN_MS = 3_600_000, POOL_KEPT_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface JournalLine { v: number; run: string; seq: number; time: string; event: string; [k: string]: unknown }

export interface LoadResult {
  /** False when there is no journal to read: no folder is set, it has no file, or it cannot be read. */
  available: boolean;
  error: string | null;
  lines: number;
  malformed: number;
  unknownVersion: number;
  orphans: number;
  /** Lines the producer lost in its latest run, and when the loader saw the latest gap (null for none). */
  gaps: number;
  gapAt: string | null;
}

/** `gaps`/`gapAt` and `orphans`/`unknownVersion`/`malformed`/`oddAt` are kept in the cursor, so the health row still says them on the next load. */
interface Cursor {
  file: string | null; position: number; run: string | null; seq: number; gaps: number; gapAt: string | null;
  orphans: number; unknownVersion: number; malformed: number; oddAt: string | null;
}

const bytes = (h: unknown): Buffer | null => (typeof h === "string" && /^(0x)?([0-9a-fA-F]{2})+$/.test(h) ? Buffer.from(h.replace(/^0x/, ""), "hex") : null);
const whole = (n: unknown): number | null => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : typeof n === "string" && /^\d{1,15}$/.test(n) ? Number(n) : null);
const text = (s: unknown, max = 600): string | null => (typeof s === "string" ? s.slice(0, max) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const hashes = (v: unknown): Buffer[] => list(v).map(bytes).filter((b): b is Buffer => b !== null && b.length === 32);
const OUT_BACK = new Set(["refused", "not_taken", "failed"]);

/** Parses a line; null with the reason when it is not a line of format 1. */
export function parseLine(raw: string): { line: JournalLine } | { bad: "malformed" | "version" } {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { bad: "malformed" };
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return { bad: "malformed" };
  const o = j as Record<string, unknown>;
  if (o.v !== 1) return { bad: typeof o.v === "number" ? "version" : "malformed" };
  const time = typeof o.time === "string" ? Date.parse(o.time) : NaN;
  if (typeof o.run !== "string" || !UUID.test(o.run) || whole(o.seq) === null || Number.isNaN(time) || typeof o.event !== "string") return { bad: "malformed" };
  return { line: o as JournalLine };
}

/** Applies the lines of one read, in the caller's transaction. Returns the number of lines that had no attempt to belong to. */
async function applyLines(c: PoolClient, lines: JournalLine[]): Promise<number> {
  let orphans = 0;
  const ids = new Map<string, number>();
  const pool = new Map<string, number>();
  const idOf = async (run: unknown, attempt: unknown): Promise<number | null> => {
    const seq = whole(attempt);
    if (typeof run !== "string" || seq === null) return null;
    const key = `${run}/${seq}`;
    const known = ids.get(key);
    if (known !== undefined) return known;
    const r = await c.query("select attempt_id from block_attempts where run_id = $1 and attempt_seq = $2", [run, seq]);
    if (!r.rowCount) return null;
    ids.set(key, Number(r.rows[0].attempt_id));
    return Number(r.rows[0].attempt_id);
  };
  const set = async (id: number, cols: Record<string, unknown>): Promise<void> => {
    const keys = Object.keys(cols);
    await c.query(`update block_attempts set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where attempt_id = $1`, [id, ...keys.map((k) => cols[k])]);
  };
  const ensureRun = (run: string, time: string, strategy: string) =>
    c.query("insert into producer_runs (run_id, started_at, strategy, settings, source_commit) values ($1, $2, $3, '{}', '') on conflict do nothing", [run, time, strategy]);

  const attemptsOf = async (id: number, includedOnly: boolean): Promise<Buffer[]> =>
    (await c.query(`select tx_hash from attempt_transactions where attempt_id = $1 ${includedOnly ? "and left_out_reason is null" : ""}`, [id])).rows.map((r) => r.tx_hash as Buffer);
  /** Gives the transactions of an attempt back to `pending` where they were being proven: the block did not commit. */
  const putBack = async (id: number, time: string, why: string): Promise<void> => {
    await c.query(
      `update tx_lifecycle t set state = 'pending', state_reason = $3, updated_at = $2 from attempt_transactions a
        where a.attempt_id = $1 and a.left_out_reason is null and a.tx_hash = t.tx_hash and t.state = 'proving' and t.updated_at <= $2`,
      [id, time, why],
    );
  };
  /** Writes states of the journal loader's own kind: final and replaced stay, and an older event does not undo a newer word. */
  const setState = (hs: Buffer[], reasons: (string | null)[], state: string, time: string) =>
    c.query(
      `insert into tx_lifecycle (tx_hash, state, state_reason, updated_at)
       select h, $3, r, $2 from unnest($1::bytea[], $4::text[]) as t(h, r)
       on conflict (tx_hash) do update set
         state = case when tx_lifecycle.state in ('final', 'replaced') or excluded.updated_at < tx_lifecycle.updated_at then tx_lifecycle.state else excluded.state end,
         state_reason = case when tx_lifecycle.state in ('final', 'replaced') or excluded.updated_at < tx_lifecycle.updated_at then tx_lifecycle.state_reason else excluded.state_reason end,
         updated_at = greatest(tx_lifecycle.updated_at, excluded.updated_at)`,
      [hs, time, state, reasons],
    );
  const leftOut = async (id: number, from: number, items: unknown[], time: string): Promise<void> => {
    const rows = items.map((x) => ({ h: bytes((x as { transaction?: unknown })?.transaction), r: text((x as { reason?: unknown })?.reason, 300) ?? "left out" }))
      .filter((x): x is { h: Buffer; r: string } => x.h !== null && x.h.length === 32);
    if (rows.length === 0) return;
    await c.query(
      `insert into attempt_transactions (attempt_id, position, tx_hash, left_out_reason)
       select $1, $2::int + o - 1, h, r from unnest($3::bytea[], $4::text[]) with ordinality as t(h, r, o) on conflict do nothing`,
      [id, from, rows.map((x) => x.h), rows.map((x) => x.r)],
    );
    await c.query(
      `insert into tx_lifecycle (tx_hash, last_left_out_reason, state, updated_at) select h, r, 'pending', $3 from unnest($1::bytea[], $2::text[]) as t(h, r)
       on conflict (tx_hash) do update set last_left_out_reason = excluded.last_left_out_reason`,
      [rows.map((x) => x.h), rows.map((x) => x.r), time],
    );
  };

  for (const ev of lines) {
    const t = ev.time;
    switch (ev.event) {
      case "run_started":
        await c.query(
          `insert into producer_runs (run_id, started_at, strategy, settings, source_commit) values ($1, $2, $3, $4, $5)
           on conflict (run_id) do update set started_at = excluded.started_at, strategy = excluded.strategy, settings = excluded.settings, source_commit = excluded.source_commit`,
          [ev.run, t, text(ev.strategy) ?? "unknown", JSON.stringify(ev.settings ?? {}), text(ev.source_commit) ?? ""],
        );
        break;
      case "run_stopped":
        await ensureRun(ev.run, t, "unknown");
        await c.query("update producer_runs set stopped_at = $2, stop_state = $3 where run_id = $1", [ev.run, t, text(ev.state, 40) ?? "stopped"]);
        break;
      case "pool": {
        const w = whole(ev.waiting);
        if (w !== null) pool.set(t, w);
        break;
      }
      case "cut": {
        const number = whole(ev.number), seq = whole(ev.attempt);
        if (number === null || seq === null) { orphans++; break; }
        await ensureRun(ev.run, t, text(ev.strategy) ?? "unknown");
        const r = await c.query(
          `insert into block_attempts (run_id, attempt_seq, number, strategy, cut_reason, pool_waiting, idle_before_cut_ms, in_flight_at_cut, cut_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (run_id, attempt_seq) do update set number = excluded.number, strategy = excluded.strategy, cut_reason = excluded.cut_reason,
             pool_waiting = excluded.pool_waiting, idle_before_cut_ms = excluded.idle_before_cut_ms, in_flight_at_cut = excluded.in_flight_at_cut, cut_at = excluded.cut_at
           returning attempt_id`,
          [ev.run, seq, number, text(ev.strategy) ?? "unknown", text(ev.cut_reason, 40) ?? "unknown", whole(ev.pool_waiting), whole(ev.idle_before_cut_ms), whole(ev.in_flight_at_cut) ?? 0, t],
        );
        ids.set(`${ev.run}/${seq}`, Number(r.rows[0].attempt_id));
        break;
      }
      case "built": case "skipped": {
        const id = await idOf(ev.run, ev.attempt);
        if (id === null) { orphans++; break; }
        const out = list(ev.left_out);
        if (ev.event === "skipped") {
          await set(id, { tx_count: 0, rebuilds: whole(ev.rebuilds) ?? 0, left_out_count: out.length, outcome: "skipped" });
          await leftOut(id, 0, out, t);
          break;
        }
        const txs = hashes(ev.tx_hashes);
        await set(id, {
          block_hash: bytes(ev.block_hash), parent_hash: bytes(ev.parent_hash), tx_count: txs.length, gas_used: whole(ev.gas_used), legs_count: whole(ev.legs) ?? 0,
          rebuilds: whole(ev.rebuilds) ?? 0, left_out_count: out.length, built_at: t,
        });
        if (txs.length > 0) {
          await c.query(
            "insert into attempt_transactions (attempt_id, position, tx_hash) select $1, o - 1, h from unnest($2::bytea[]) with ordinality as t(h, o) on conflict do nothing",
            [id, txs],
          );
          await c.query(
            `insert into tx_lifecycle (tx_hash, first_included_at, attempts, state, updated_at)
             select h, $2, 1, 'proving', $2 from unnest($1::bytea[]) as t(h)
             on conflict (tx_hash) do update set
               first_included_at = least(coalesce(tx_lifecycle.first_included_at, excluded.first_included_at), excluded.first_included_at),
               attempts = (select count(*) from attempt_transactions a where a.tx_hash = tx_lifecycle.tx_hash and a.left_out_reason is null),
               state = case when tx_lifecycle.state in ('final', 'replaced') or excluded.updated_at < tx_lifecycle.updated_at then tx_lifecycle.state else 'proving' end,
               state_reason = case when tx_lifecycle.state in ('final', 'replaced') or excluded.updated_at < tx_lifecycle.updated_at then tx_lifecycle.state_reason else null end,
               updated_at = greatest(tx_lifecycle.updated_at, excluded.updated_at)`,
            [txs, t],
          );
        }
        await leftOut(id, txs.length, out, t);
        break;
      }
      case "proof_queued": case "proof_started": case "proof_ended": {
        const id = await idOf(ev.run, ev.attempt);
        if (id === null) { orphans++; break; }
        const col = ev.event === "proof_queued" ? "proof_queued_at" : ev.event === "proof_started" ? "proof_started_at" : "proof_ended_at";
        await set(id, { [col]: t, prover: text(ev.prover, 100), ...(ev.event === "proof_ended" ? { proof_outcome: text(ev.outcome, 40) } : {}) });
        break;
      }
      case "submitted": {
        const id = await idOf(ev.run, ev.attempt);
        if (id === null) { orphans++; break; }
        await set(id, { submitted_at: t, command_id: text(ev.command_id, 200), argument_bytes: whole(ev.argument_bytes) });
        break;
      }
      case "answered": {
        const id = await idOf(ev.run, ev.attempt);
        if (id === null) { orphans++; break; }
        const outcome = text(ev.outcome, 40);
        await set(id, {
          answered_at: t, outcome, reason: text(ev.reason), update_id: text(ev.update_id, 200), completion_offset: whole(ev.completion_offset), traffic_bytes: whole(ev.traffic_bytes),
        });
        if (outcome !== null && OUT_BACK.has(outcome)) await putBack(id, t, `the block was ${outcome.replace("_", " ")}`);
        break;
      }
      case "resolved": {
        const id = await idOf(typeof ev.attempt_run === "string" ? ev.attempt_run : ev.run, ev.attempt);
        if (id === null) { orphans++; break; }
        const outcome = text(ev.outcome, 40) === "committed" ? "committed" : text(ev.outcome, 40);
        await set(id, { resolved_at: t, resolved_outcome: outcome });
        if (outcome !== "committed") await putBack(id, t, outcome === "restarted" ? "the producer restarted before the block was answered" : "the block did not commit");
        break;
      }
      case "final_seen": {
        const id = await idOf(ev.run, ev.attempt);
        if (id === null) { orphans++; break; }
        await set(id, { final_seen_at: t });
        break;
      }
      case "cancelled": {
        const id = await idOf(ev.run, ev.attempt);
        if (id === null) { orphans++; break; }
        await set(id, { outcome: "cancelled", reason: text(ev.reason) ?? text(ev.depends_on) });
        await putBack(id, t, "the block was cancelled");
        break;
      }
      case "lost": {
        const items = list(ev.transactions).map((x) => ({ h: bytes((x as { transaction?: unknown })?.transaction), r: text((x as { error?: unknown })?.error, 300) ?? "reth would not take it back" }))
          .filter((x): x is { h: Buffer; r: string } => x.h !== null && x.h.length === 32);
        if (items.length) await setState(items.map((x) => x.h), items.map((x) => x.r), "lost", t);
        break;
      }
      case "excluded": {
        const h = bytes(ev.transaction);
        if (h === null || h.length !== 32) break;
        const why = `held back until ${text(ev.until, 40) ?? "later"}: ${text(ev.reason, 250) ?? "no reason given"}`;
        await c.query(
          `insert into tx_lifecycle (tx_hash, last_left_out_reason, state, updated_at) values ($1, $2, 'pending', $3)
           on conflict (tx_hash) do update set last_left_out_reason = excluded.last_left_out_reason`,
          [h, why, t],
        );
        break;
      }
      default: // attempt_failed (not a block attempt) and events a later producer adds: nothing to keep
        break;
    }
  }
  if (pool.size) {
    await c.query(
      "insert into pool_samples (at, waiting) select * from unnest($1::timestamptz[], $2::int[]) on conflict (at) do update set waiting = excluded.waiting",
      [[...pool.keys()], [...pool.values()]],
    );
  }
  return orphans;
}

/**
 * Joins the producer's attempts to the blocks Canton made final, whichever came first (by block hash and by update id): `blocks.attempt_id`, and
 * the producer's side of the update (`canton_updates.command_id` and the rest). An attempt whose outcome the producer never knew is settled
 * as committed when its block hash is an indexed block.
 */
export async function joinAttempts(pool: Pool): Promise<void> {
  // Only attempts whose outcome is open and blocks with no attempt yet (the partial indexes of migration 0015 hold exactly those).
  await pool.query(
    // The attempt was not committed as far as the journal knows, so a resolved_at it has is the time of something else (the next run's restart): the block's record time replaces it.
    `update block_attempts a set resolved_outcome = 'committed', update_id = coalesce(a.update_id, b.update_id), resolved_at = b.record_time
       from blocks b where b.hash = a.block_hash and (a.outcome is null or a.outcome = 'unknown') and a.resolved_outcome is distinct from 'committed'`,
  );
  // An attempt the producer settled itself (unknown, then resolved committed) never had an update id: the indexed block gives it.
  await pool.query(
    `update block_attempts a set update_id = b.update_id
       from blocks b where b.hash = a.block_hash and a.update_id is null and (a.outcome = 'committed' or a.resolved_outcome = 'committed')`,
  );
  const best = `select a.attempt_id from block_attempts a
                  where a.block_hash = b.hash and (a.outcome = 'committed' or a.resolved_outcome = 'committed')
                  order by coalesce(a.outcome = 'committed', false) desc, a.cut_at desc, a.attempt_id desc limit 1`;
  await pool.query(
    `update blocks b set attempt_id = (${best})
      where b.attempt_id is null and b.number >= coalesce((select min(number) from block_attempts), 0)
        and exists (select 1 from block_attempts a where a.block_hash = b.hash and (a.outcome = 'committed' or a.resolved_outcome = 'committed'))`,
  );
  // A block that was joined to an attempt only settled as committed moves to one the producer itself saw committed, when that one arrives later.
  await pool.query(
    `update blocks b set attempt_id = (${best})
      from block_attempts cur
      where cur.attempt_id = b.attempt_id and cur.resolved_outcome = 'committed' and cur.outcome is distinct from 'committed'
        and exists (select 1 from block_attempts a where a.block_hash = b.hash and a.outcome = 'committed')`,
  );
  await pool.query(
    `update canton_updates u set command_id = a.command_id, submitted_template = 'Zk.Chain:ZkChain', submitted_choice = 'Advance', argument_bytes = a.argument_bytes,
            traffic_bytes = a.traffic_bytes, completion_offset = a.completion_offset
       from block_attempts a where a.update_id = u.update_id and u.command_id is null and a.command_id is not null
        and u.record_time >= (select min(cut_at) from block_attempts) - interval '1 hour'   -- Canton's clock and the producer's differ: slack, never a tight bound
        and (a.outcome = 'committed' or a.resolved_outcome = 'committed')`,
  );
}

async function readCursor(pool: Pool | PoolClient): Promise<Cursor> {
  const r = await pool.query("select position, detail from cursors where stream = 'journal'");
  const d = (r.rows[0]?.detail ?? {}) as Partial<Cursor>;
  return { file: d.file ?? null, position: Number(r.rows[0]?.position ?? 0), run: d.run ?? null, seq: d.seq ?? 0, gaps: d.gaps ?? 0, gapAt: d.gapAt ?? null,
    orphans: d.orphans ?? 0, unknownVersion: d.unknownVersion ?? 0, malformed: d.malformed ?? 0, oddAt: d.oddAt ?? null };
}

async function writeCursor(c: PoolClient, k: Cursor): Promise<void> {
  await c.query(
    `insert into cursors (stream, position, detail, updated_at) values ('journal', $1, $2, now())
     on conflict (stream) do update set position = excluded.position, detail = excluded.detail, updated_at = excluded.updated_at`,
    [k.position, JSON.stringify({ file: k.file, run: k.run, seq: k.seq, gaps: k.gaps, gapAt: k.gapAt, orphans: k.orphans, unknownVersion: k.unknownVersion, malformed: k.malformed, oddAt: k.oddAt })],
  );
}

/** Orders a read's lines by run (in order of first appearance) and sequence, drops the repeats, and counts the gaps against the cursor. */
function arrange(lines: JournalLine[], k: Cursor): { ordered: JournalLine[]; gapped: number; lastRun: string | null; lastSeq: number; gapTime: string | null } {
  const runs = new Map<string, Map<number, JournalLine>>();
  for (const l of lines) {
    const m = runs.get(l.run) ?? new Map<number, JournalLine>();
    m.set(l.seq, l);
    runs.set(l.run, m);
  }
  const ordered: JournalLine[] = [];
  let gapped = 0, gapTime: string | null = null, lastRun = k.run, lastSeq = k.seq;
  for (const [run, m] of runs) {
    const seqs = [...m.keys()].sort((a, b) => a - b);
    let expected = run === k.run ? k.seq + 1 : 1;
    for (const s of seqs) {
      if (s > expected) { gapped += s - expected; gapTime = m.get(s)!.time; }
      if (s >= expected || run !== k.run) expected = s + 1;
      ordered.push(m.get(s)!);
    }
    if (run !== k.run || seqs[seqs.length - 1]! > lastSeq) { lastRun = run; lastSeq = Math.max(run === k.run ? lastSeq : 0, seqs[seqs.length - 1]!); }
  }
  return { ordered, gapped, lastRun, lastSeq, gapTime };
}

export interface JournalOptions { pool: Pool; folder: string | null; now?: () => number; log?: (line: string) => void }

export function createJournal(o: JournalOptions) {
  const now = o.now ?? Date.now;
  let lastPrune = 0;

  async function files(): Promise<string[]> {
    return (await readdir(o.folder as string)).filter((f) => JOURNAL_FILE.test(f)).sort();
  }

  /** Reads and applies everything new in the journal, joins it to the blocks, and writes the row `journal` of health_checks. */
  let joinedHead: number | null = null;

  async function load(): Promise<LoadResult> {
    const res: LoadResult = { available: false, error: null, lines: 0, malformed: 0, unknownVersion: 0, orphans: 0, gaps: 0, gapAt: null };
    try {
      if (!o.folder) {
        res.error = "no journal folder is set (JOURNAL_DIR), so the lifecycle of blocks and transactions is blank";
      } else {
        const names = await files();
        if (names.length === 0) res.error = `there is no journal file in ${o.folder}, so the lifecycle of blocks and transactions is blank`;
        else {
          res.available = true;
          await readAll(names, res);
        }
      }
    } catch (e) {
      res.available = false;
      res.error = `the journal cannot be read: ${(e as Error).message}`;
    }
    const k = await readCursor(o.pool);
    res.gaps = k.gaps;
    res.gapAt = k.gapAt;
    if (res.available) {
      // The join looks only at what is not joined yet, and only when a line was applied or the indexed head moved.
      const head = Number((await o.pool.query("select coalesce(max(number), -1) as n from blocks")).rows[0].n);
      if (res.lines > 0 || joinedHead === null || head !== joinedHead) {
        await joinAttempts(o.pool);
        joinedHead = head;
      }
    }
    if (now() - lastPrune > 3_600_000) {
      lastPrune = now();
      await o.pool.query("delete from pool_samples where at < now() - make_interval(days => $1)", [POOL_KEPT_DAYS]);
    }
    const recentGap = k.gapAt !== null && now() - Date.parse(k.gapAt) < GAP_SHOWN_MS && k.gaps > 0;
    const recentOdd = k.oddAt !== null && now() - Date.parse(k.oddAt) < GAP_SHOWN_MS;
    const problems = [
      res.error,
      recentGap ? `${k.gaps} journal lines of the producer's run were lost (a gap in the sequence); the lifecycle misses what they said` : null,
      recentOdd && k.orphans > 0 ? `${k.orphans} journal lines belong to attempts with no cut line` : null,
      recentOdd && k.unknownVersion > 0 ? `${k.unknownVersion} journal lines are of a format this indexer does not know` : null,
      recentOdd && k.malformed > 0 ? `${k.malformed} journal lines could not be read` : null,
    ].filter((x): x is string => x !== null);
    await setHealth(o.pool, [{ id: "journal", status: problems.length ? "degraded" : "ok", value: { available: res.available, gaps: k.gaps, orphans: k.orphans, unknownVersion: k.unknownVersion, malformed: k.malformed, oddAt: k.oddAt }, detail: problems.join("; ") || null }]);
    return res;
  }

  async function commitCursor(k: Cursor, apply?: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await o.pool.connect();
    try {
      await c.query("begin");
      if (apply) await apply(c);
      await writeCursor(c, k);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async function readAll(names: string[], res: LoadResult): Promise<void> {
    let k = await readCursor(o.pool);
    // A cursor whose file is gone (the files are removed after 30 days) goes on with the first file after it; none yet means the first file.
    if (k.file === null || !names.includes(k.file)) {
      const next = k.file === null ? names[0] : names.find((n) => n > (k.file as string));
      if (next === undefined) return;
      k = { ...k, file: next, position: 0 };
    }
    let savedUnknown = res.unknownVersion, savedMalformed = res.malformed; // what the cursor already holds of this load's counts
    for (;;) {
      const file = k.file as string;
      const nextFile = names.find((n) => n > file);
      const fh = await open(join(o.folder as string, file), "r");
      let size: number, got: number, buf: Buffer;
      try {
        size = (await fh.stat()).size;
        if (k.position > size) k = { ...k, position: 0 }; // the file is shorter than the cursor says: read it again, the lines are idempotent
        buf = Buffer.alloc(Math.min(READ_BYTES, size - k.position));
        got = buf.length ? (await fh.read(buf, 0, buf.length, k.position)).bytesRead : 0;
      } finally {
        await fh.close();
      }
      // Only whole lines count. The last line of an older file that was cut short for good (a crash) is dropped with a count.
      const lines: { text: string; end: number }[] = [];
      let from = 0;
      for (let nl = buf.indexOf(10, from); nl >= 0 && nl < got; nl = buf.indexOf(10, from)) {
        lines.push({ text: buf.subarray(from, nl).toString("utf8"), end: nl + 1 });
        from = nl + 1;
      }
      if (from < got && nextFile !== undefined && k.position + got >= size) { res.malformed++; lines.push({ text: "", end: got }); }
      const base = k.position;
      for (let at = 0; at < lines.length; at += CHUNK_LINES) {
        const slice = lines.slice(at, at + CHUNK_LINES);
        const parsed: JournalLine[] = [];
        for (const { text: s } of slice) {
          if (s.trim() === "") continue;
          const p = parseLine(s);
          if ("line" in p) parsed.push(p.line);
          else if (p.bad === "version") res.unknownVersion++;
          else res.malformed++;
        }
        const arranged = arrange(parsed, k);
        const gaps = arranged.lastRun === k.run ? k.gaps + arranged.gapped : arranged.gapped;
        const next: Cursor = { ...k, file, position: base + slice[slice.length - 1]!.end, run: arranged.lastRun, seq: arranged.lastSeq, gaps, gapAt: arranged.gapTime ?? k.gapAt };
        const odd = (extra: { orphans: number; unknownVersion: number; malformed: number }) => {
          if (extra.orphans + extra.unknownVersion + extra.malformed === 0) return;
          const at = new Date(now()).toISOString();
          if (next.oddAt === null || now() - Date.parse(next.oddAt) >= GAP_SHOWN_MS) { next.orphans = 0; next.unknownVersion = 0; next.malformed = 0; }
          next.orphans += extra.orphans; next.unknownVersion += extra.unknownVersion; next.malformed += extra.malformed; next.oddAt = at;
        };
        const du = res.unknownVersion - savedUnknown, dm = res.malformed - savedMalformed;
        savedUnknown = res.unknownVersion; savedMalformed = res.malformed;
        odd({ orphans: 0, unknownVersion: du, malformed: dm });
        // `next` is written after this runs, in the same transaction, so the orphans counted by applyLines are in it.
        await commitCursor(next, async (c) => { const n = await applyLines(c, arranged.ordered); res.orphans += n; odd({ orphans: n, unknownVersion: 0, malformed: 0 }); });
        k = next;
        res.lines += parsed.length;
      }
      if (k.position < size) {
        if (k.position === base) return; // a line is still being written
        continue; // more of this file to read
      }
      if (nextFile === undefined) return;
      k = { ...k, file: nextFile, position: 0 };
      await commitCursor(k);
    }
  }

  return { load };
}

export type Journal = ReturnType<typeof createJournal>;
