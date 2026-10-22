/**
 * The stats rollups (design section 8): minute, hour and day rows with histograms, rebuilt from the facts.
 *
 * Every run recomputes the minutes from the earlier of (the cursor minus a lookback) and (the earliest fact time any writer touched since the last run, left in
 * `stats_dirty` by the triggers of migration 0027) to the open minute, a chunk at a time, and replaces the rows of each chunk in one transaction. Nothing is
 * ever incremented, so a run twice changes nothing, and a fact that arrives late (a block caught up after an outage, a journal loaded late) is rolled up by
 * the next run however old it is. Buckets are `floor(epoch / 60 s)`, days are UTC, and `date_trunc` is not used, so the session time zone
 * does not matter. Runs whose settings carry `test = true` are counted apart in the `test_*` columns and left out of everything else.
 */
import type { Pool, PoolClient } from "pg";
import { TIME_EDGES, bucketOf, histLength, type Kind } from "./stats-hist.ts";

export const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const CURSOR = "stats_rollup";
export const TABLES = { minute: "stats_minute", hour: "stats_hour", day: "stats_day" } as const;

export const SCALARS = [
  "blocks", "empty_blocks", "busy_blocks", "txs", "txs_failed", "gas_used", "argument_bytes", "accepted", "lost", "dropped", "replaced", "attempts_refused", "attempts_failed",
  "attempts", "attempts_not_taken", "attempts_skipped", "attempts_cancelled", "ttf_without_acceptance", "clock_skew", "max_txs_in_block", "max_minute_txs", "gas_limit_sum", "traffic_bytes", "traffic_updates",
  "proof_busy_ms", "size_blocks_0", "size_blocks_1", "size_blocks_2", "size_blocks_3", "size_blocks_4", "test_blocks", "test_txs", "test_attempts", "test_proof_busy_ms",
] as const;
type Scalar = (typeof SCALARS)[number];
/** Which histogram columns there are and what kind each one is; the proof size one is five time histograms, one after the other. */
export const HISTS = {
  busy_gap_hist: "time", time_to_final_hist: "time", proof_hist: "time", commit_hist: "time", served_hist: "time", txs_per_block_hist: "count", proof_size_hist: "size",
} as const;
type Hist = keyof typeof HISTS;
const SIZE_CLASSES = 5;
export const sizeClass = (n: number): number => (n <= 0 ? 0 : n <= 10 ? 1 : n <= 100 ? 2 : n <= 1000 ? 3 : 4);
const histLen = (c: Hist): number => (HISTS[c] === "size" ? SIZE_CLASSES * histLength("time") : histLength(HISTS[c] as Kind));

export interface Row { scalars: Record<Scalar, number>; hists: Partial<Record<Hist, number[]>> }
const newRow = (): Row => ({ scalars: Object.fromEntries(SCALARS.map((s) => [s, 0])) as Record<Scalar, number>, hists: {} });
function bump(r: Row, c: Hist, i: number, by = 1): void {
  const h = (r.hists[c] ??= new Array(histLen(c)).fill(0));
  h[i] = (h[i] as number) + by;
}
const hist = (kind: Kind, seconds: number): number => bucketOf(kind, seconds);

/** Sum rows of a finer table into one row of the next (max for the largest block and the busiest minute, sums for the rest, histograms added). */
function aggregate(rows: readonly Record<string, unknown>[]): Row {
  const out = newRow();
  for (const r of rows) {
    for (const s of SCALARS) {
      const v = Number(r[s] ?? 0);
      out.scalars[s] = s === "max_txs_in_block" || s === "max_minute_txs" ? Math.max(out.scalars[s], v) : out.scalars[s] + v;
    }
  }
  for (const c of Object.keys(HISTS) as Hist[]) {
    const parts = rows.map((r) => r[c] as number[] | null).filter((h): h is number[] => Array.isArray(h) && h.length > 0);
    if (parts.length) {
      const sum = new Array(histLen(c)).fill(0) as number[];
      for (const h of parts) for (let i = 0; i < h.length && i < sum.length; i++) sum[i] = (sum[i] as number) + (h[i] as number);
      out.hists[c] = sum;
    }
  }
  return out;
}

async function insertRows(db: PoolClient, table: string, rows: Map<number, Row>): Promise<void> {
  const cols = ["bucket", ...SCALARS, ...Object.keys(HISTS)];
  for (const [bucket, r] of rows) {
    const values = [new Date(bucket), ...SCALARS.map((s) => r.scalars[s]), ...(Object.keys(HISTS) as Hist[]).map((c) => r.hists[c] ?? [])];
    await db.query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, values);
  }
}

// ---- the facts of one chunk -> minute rows ----

const BLOCKS = `
  select extract(epoch from b.record_time)::float8 * 1000 as rt, extract(epoch from b.indexed_at)::float8 * 1000 as ix,
         extract(epoch from p.record_time)::float8 * 1000 as prt, b.tx_count, b.gas_used::float8 as gas_used, b.gas_limit::float8 as gas_limit,
         a.idle_before_cut_ms, a.cut_reason,
         coalesce(c.argument_bytes, a.argument_bytes) as arg, coalesce(c.traffic_bytes, a.traffic_bytes) as traffic,
         coalesce(r.settings->>'test', '') = 'true' as test,
         (select count(*)::int from transactions t where t.block_number = b.number and t.status = 0) as failed
    from blocks b
    left join block_attempts a on a.attempt_id = b.attempt_id
    left join producer_runs r on r.run_id = a.run_id
    left join canton_updates c on c.update_id = b.update_id
    left join blocks p on p.number = b.number - 1
   where b.record_time >= $1 and b.record_time < $2`;
const TTF = `
  select floor(extract(epoch from l.final_at) / 60)::bigint as m,
         case when l.accepted_at is null then -2 when l.final_at < l.accepted_at then -1
              else width_bucket(extract(epoch from l.final_at - l.accepted_at)::float8, $3::float8[]) end as k, count(*)::int as n
    from tx_lifecycle l
    left join blocks fb on fb.number = l.final_block
    left join block_attempts a on a.attempt_id = fb.attempt_id
    left join producer_runs r on r.run_id = a.run_id
   where l.final_at >= $1 and l.final_at < $2 and coalesce(r.settings->>'test', '') <> 'true'
   group by 1, 2`;
/** Transactions that belong to a test run (a flood test) are left out of the counts: the run of an attempt that carried them says so. */
const NOT_TEST = `not exists (select 1 from attempt_transactions x join block_attempts xa on xa.attempt_id = x.attempt_id join producer_runs xr on xr.run_id = xa.run_id
                                where x.tx_hash = tx_lifecycle.tx_hash and coalesce(xr.settings->>'test', '') = 'true')`;
const COUNT_BY = (col: string, where: string) =>
  `select floor(extract(epoch from ${col}) / 60)::bigint as m, count(*)::int as n from tx_lifecycle where ${col} >= $1 and ${col} < $2 ${where} and ${NOT_TEST} group by 1`;
/** Transactions that left the way to final, by the minute they first did and by what they are now. */
const LOST = `select floor(extract(epoch from lost_at) / 60)::bigint as m, state, count(*)::int as n from tx_lifecycle
               where lost_at >= $1 and lost_at < $2 and state in ('dropped', 'lost', 'replaced') and ${NOT_TEST} group by 1, 2`;
/** A proof longer than this is not looked for across the end of a chunk (it would need a read of all later attempts). */
const PROOF_MAX = "6 hours";
const ATTEMPTS = `
  select extract(epoch from a.cut_at)::float8 * 1000 as cut, extract(epoch from a.proof_started_at)::float8 * 1000 as ps, extract(epoch from a.proof_ended_at)::float8 * 1000 as pe,
         extract(epoch from a.submitted_at)::float8 * 1000 as sub, extract(epoch from a.answered_at)::float8 * 1000 as ans,
         a.outcome, a.proof_outcome, a.tx_count, coalesce(r.settings->>'test', '') = 'true' as test
    from block_attempts a left join producer_runs r on r.run_id = a.run_id
   where (a.cut_at >= $1 and a.cut_at < $2) or (a.answered_at >= $1 and a.answered_at < $2)
      or (a.proof_ended_at >= $1 and a.proof_ended_at < $2::timestamptz + interval '${PROOF_MAX}' and a.proof_started_at < $2)`;
/** The reads, for the test that checks each one has an index to read by. Parameters are as in computeMinutes. */
export const QUERIES = { blocks: BLOCKS, ttf: TTF, accepted: COUNT_BY("accepted_at", ""), lost: LOST, attempts: ATTEMPTS } as const;

/** The minute rows of [from, to) (milliseconds, whole minutes), from the facts. Minutes with no fact have no row. */
export async function computeMinutes(db: Pool | PoolClient, from: number, to: number): Promise<Map<number, Row>> {
  const rows = new Map<number, Row>();
  const a = new Date(from), b = new Date(to);
  const at = (ms: number | null): Row | null => {
    if (ms === null || !(ms >= from && ms < to)) return null;
    const m = Math.floor(ms / MINUTE) * MINUTE;
    let r = rows.get(m);
    if (!r) rows.set(m, (r = newRow()));
    return r;
  };
  const seconds = (r: Row, from_: number, to_: number): number | null => {
    const d = (to_ - from_) / 1000;
    if (d < 0) { r.scalars.clock_skew++; return null; }
    return d;
  };

  for (const x of (await db.query(BLOCKS, [a, b])).rows) {
    const r = at(Number(x.rt)) as Row;
    const n = Number(x.tx_count);
    if (x.test) { r.scalars.test_blocks++; r.scalars.test_txs += n; continue; }
    const s = r.scalars;
    s.blocks++; s.txs += n; s.txs_failed += Number(x.failed); s.gas_used += Number(x.gas_used); s.gas_limit_sum += Number(x.gas_limit);
    if (n === 0) s.empty_blocks++;
    s[`size_blocks_${sizeClass(n)}` as Scalar]++;
    s.max_txs_in_block = Math.max(s.max_txs_in_block, n);
    bump(r, "txs_per_block_hist", hist("count", n));
    if (x.arg !== null) s.argument_bytes += Number(x.arg);
    if (x.traffic !== null) { s.traffic_bytes += Number(x.traffic); s.traffic_updates++; }
    const busy = x.cut_reason === "rhythm" || (x.idle_before_cut_ms !== null && Number(x.idle_before_cut_ms) < 1000);
    if (busy) {
      s.busy_blocks++;
      if (x.prt !== null) { const d = seconds(r, Number(x.prt), Number(x.rt)); if (d !== null) bump(r, "busy_gap_hist", hist("time", d)); }
    }
    const d = seconds(r, Number(x.rt), Number(x.ix));
    if (d !== null) bump(r, "served_hist", hist("time", d));
  }

  for (const x of (await db.query(TTF, [a, b, TIME_EDGES as number[]])).rows) {
    const r = at(Number(x.m) * MINUTE) as Row, k = Number(x.k), n = Number(x.n);
    if (k === -2) r.scalars.ttf_without_acceptance += n;
    else if (k === -1) r.scalars.clock_skew += n;
    else bump(r, "time_to_final_hist", k, n);
  }
  for (const x of (await db.query(COUNT_BY("accepted_at", ""), [a, b])).rows) (at(Number(x.m) * MINUTE) as Row).scalars.accepted += Number(x.n);
  for (const x of (await db.query(LOST, [a, b])).rows) (at(Number(x.m) * MINUTE) as Row).scalars[x.state as "lost" | "dropped" | "replaced"] += Number(x.n);

  const L = histLength("time");
  for (const x of (await db.query(ATTEMPTS, [a, b])).rows) {
    const cut = x.cut === null ? null : Number(x.cut), ps = x.ps === null ? null : Number(x.ps), pe = x.pe === null ? null : Number(x.pe);
    const sub = x.sub === null ? null : Number(x.sub), ans = x.ans === null ? null : Number(x.ans);
    // Prover busy time: the span clipped to each minute, whatever the proof's outcome. Test runs add to their own column.
    if (ps !== null && pe !== null && pe > ps) {
      const busyCol = x.test ? "test_proof_busy_ms" : "proof_busy_ms";
      for (let m = Math.max(from, Math.floor(ps / MINUTE) * MINUTE); m < to && m < pe; m += MINUTE) {
        const overlap = Math.min(pe, m + MINUTE) - Math.max(ps, m);
        if (overlap > 0) (at(m) as Row).scalars[busyCol] += Math.round(overlap);
      }
    }
    const r0 = at(cut);
    if (x.test) { if (r0) r0.scalars.test_attempts++; continue; }
    if (r0) {
      const s = r0.scalars;
      s.attempts++;
      // One bucket for each attempt, so the shares add up to at most all attempts: refused, then failed, then not taken. Skipped (nothing to include) and cancelled ones are counted apart and are not failures.
      if (x.outcome === "refused") s.attempts_refused++;
      else if (x.outcome === "failed" || x.proof_outcome === "failed" || x.proof_outcome === "wrong_block") s.attempts_failed++;
      else if (x.outcome === "not_taken") s.attempts_not_taken++;
      else if (x.outcome === "skipped") s.attempts_skipped++;
      else if (x.outcome === "cancelled") s.attempts_cancelled++;
    }
    const r1 = at(x.proof_outcome === "ok" ? pe : null);
    if (r1 && ps !== null && pe !== null) {
      const d = seconds(r1, ps, pe);
      if (d !== null) { const k = hist("time", d); bump(r1, "proof_hist", k); bump(r1, "proof_size_hist", sizeClass(Number(x.tx_count ?? 0)) * L + k); }
    }
    const r2 = at(x.outcome === "committed" ? ans : null);
    if (r2 && sub !== null && ans !== null) { const d = seconds(r2, sub, ans); if (d !== null) bump(r2, "commit_hist", hist("time", d)); }
  }
  for (const r of rows.values()) r.scalars.max_minute_txs = r.scalars.txs;
  return rows;
}

// ---- hours and days from the rows below ----

async function rebuildUp(db: PoolClient, child: string, parent: string, span: number, from: number, to: number): Promise<number[]> {
  const first = Math.floor(from / span) * span, touched: number[] = [];
  for (let p = first; p < to; p += span) {
    const kids = (await db.query(`select * from ${child} where bucket >= $1 and bucket < $2`, [new Date(p), new Date(p + span)])).rows;
    touched.push(p);
    if (kids.length === 0) { await db.query(`delete from ${parent} where bucket = $1`, [new Date(p)]); continue; }
    const row = aggregate(kids);
    const cols = ["bucket", ...SCALARS, ...Object.keys(HISTS)];
    const values = [new Date(p), ...SCALARS.map((s) => row.scalars[s]), ...(Object.keys(HISTS) as Hist[]).map((c) => row.hists[c] ?? [])];
    // An upsert, so the columns of a day that are not sums (the address counts) stay.
    await db.query(
      `insert into ${parent} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
       on conflict (bucket) do update set ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`, values);
  }
  return touched;
}

async function dayExtras(db: Pool, day: number): Promise<void> {
  const a = new Date(day), b = new Date(day + DAY);
  const { rows: [r] } = await db.query("select min(number) as lo, max(number) as hi from blocks where record_time >= $1 and record_time < $2", [a, b]);
  const lo = r.lo === null ? null : String(r.lo), hi = r.hi === null ? null : String(r.hi);
  await db.query(
    `update stats_day set
       active_addresses = case when $3::bigint is null then 0 else (select count(distinct from_address)::int from transactions where block_number between $3 and $4) end,
       new_addresses = case when $3::bigint is null then 0 else (select count(*)::int from addresses where first_seen_block between $3 and $4) end,
       new_contracts = case when $3::bigint is null then 0 else (select count(*)::int from contracts where creation_block between $3 and $4) end,
       verified_contracts = (select count(distinct address)::int from verified_sources where verified_at >= $1 and verified_at < $2)
     where bucket = $1`, [a, b, lo, hi]);
}

export interface RollupOptions {
  now?: () => number;
  /** How far back before the cursor a run recomputes, to repair late facts. Default 15 minutes. */
  lookbackMs?: number;
  /** The minutes a transaction covers while backfilling. Default 60. */
  chunkMs?: number;
  /** The current day's extras are recomputed at most this often. Default 5 minutes. */
  extrasEveryMs?: number;
}
export interface RollupResult { from: number | null; to: number; minutes: number }

async function firstFact(pool: Pool): Promise<number | null> {
  const { rows: [r] } = await pool.query(`
    select extract(epoch from least(
      (select min(record_time) from blocks), (select min(cut_at) from block_attempts),
      (select min(least(accepted_at, final_at)) from tx_lifecycle), (select min(lost_at) from tx_lifecycle)))::float8 * 1000 as t`);
  return r.t === null ? null : Number(r.t);
}

/** The advisory lock a run holds: two runs (the loop, a command) never work at once, and a rebuild keeps the loop out until it is done. */
const LOCK = 7_020_220;
export const KEPT_MINUTE_DAYS = 30;

/** Takes the earliest fact time any writer left since the last run, and moves the cursor back to it. Returns it (null when nothing was left). */
async function claimDirty(db: PoolClient): Promise<number | null> {
  const { rows: [r] } = await db.query(`with d as (delete from stats_dirty returning at) select extract(epoch from min(at))::float8 * 1000 as t from d`);
  const t = r.t === null ? null : Math.floor(Number(r.t) / MINUTE) * MINUTE;
  if (t !== null) await db.query("update cursors set position = least(position, $2) where stream = $1", [CURSOR, t]);
  return t;
}

async function run(pool: Pool, o: RollupOptions, fresh: boolean): Promise<RollupResult> {
  const now = (o.now ?? Date.now)();
  const lookback = o.lookbackMs ?? 15 * MINUTE, chunk = Math.max(MINUTE, Math.floor((o.chunkMs ?? 60 * MINUTE) / MINUTE) * MINUTE);
  const openStart = Math.floor(now / MINUTE) * MINUTE, end = openStart + MINUTE;
  const claim = await pool.connect();
  try {
    await claim.query("begin");
    await claimDirty(claim);
    await claim.query("commit");
  } catch (e) {
    await claim.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    claim.release();
  }
  const cur = (await pool.query("select position, detail from cursors where stream = $1", [CURSOR])).rows[0];
  let start: number;
  if (cur && !fresh) start = Math.min(Math.floor((Number(cur.position) - lookback) / MINUTE) * MINUTE, openStart);
  else {
    const first = await firstFact(pool);
    if (first === null) return { from: null, to: end, minutes: 0 };
    start = Math.floor(first / MINUTE) * MINUTE;
  }
  // Minute rows older than the retention are gone, so an hour in that range can only be rebuilt from its minutes if all of them are computed again: start at its first minute.
  if (start < Math.floor(now / DAY) * DAY - KEPT_MINUTE_DAYS * DAY) start = Math.floor(start / HOUR) * HOUR;
  let extrasAt: number = cur?.detail?.extrasAt ?? 0;
  const setCursor = (db: Pool | PoolClient, position: number, ex: number) =>
    db.query(
      `insert into cursors (stream, position, detail, updated_at) values ($1, $2, $3, $4)
       on conflict (stream) do update set position = excluded.position, detail = excluded.detail, updated_at = excluded.updated_at`,
      [CURSOR, position, JSON.stringify({ extrasAt: ex }), new Date(now)]);
  // The cursor is "recompute from here": it moves back with the first chunk and forward with each, so a run that stops half way is finished by the next.
  const days = new Set<number>();
  for (let a = start; a < end; a += chunk) {
    const b = Math.min(a + chunk, end);
    const db = await pool.connect();
    try {
      await db.query("begin");
      const rows = await computeMinutes(db, a, b);
      await db.query("delete from stats_minute where bucket >= $1 and bucket < $2", [new Date(a), new Date(b)]);
      await insertRows(db, TABLES.minute, rows);
      await rebuildUp(db, TABLES.minute, TABLES.hour, HOUR, a, b);
      for (const d of await rebuildUp(db, TABLES.hour, TABLES.day, DAY, a, b)) days.add(d);
      await setCursor(db, Math.min(b, openStart), extrasAt);
      await db.query("commit");
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      db.release();
    }
  }
  const today = Math.floor(now / DAY) * DAY;
  let did = false;
  for (const d of [...days].sort((x, y) => x - y)) {
    if (d >= today && now - extrasAt < (o.extrasEveryMs ?? 5 * MINUTE)) continue;
    await dayExtras(pool, d);
    if (d >= today) did = true;
  }
  if (did) extrasAt = now;
  await setCursor(pool, openStart, extrasAt);
  // Minute rows are kept 30 days, cut at a day's start so that no hour is left half built.
  await pool.query("delete from stats_minute where bucket < $1", [new Date(today - KEPT_MINUTE_DAYS * DAY)]);
  return { from: start, to: end, minutes: Math.round((end - start) / MINUTE) };
}

/** Runs `fn` holding the advisory lock on one connection; `wait` false gives up (null) when another run holds it. */
async function locked<T>(pool: Pool, wait: boolean, fn: () => Promise<T>): Promise<T | null> {
  const lock = await pool.connect();
  try {
    if (wait) await lock.query("select pg_advisory_lock($1)", [LOCK]);
    else if (!(await lock.query("select pg_try_advisory_lock($1) as ok", [LOCK])).rows[0].ok) return null;
    try {
      return await fn();
    } finally {
      await lock.query("select pg_advisory_unlock($1)", [LOCK]);
    }
  } finally {
    lock.release();
  }
}

/** One run of the rollups, up to the open minute. Safe to run twice. A run that finds another one working does nothing (minutes: 0). */
export async function rollupStats(pool: Pool, o: RollupOptions = {}): Promise<RollupResult> {
  const r = await locked(pool, false, () => run(pool, o, false));
  return r ?? { from: null, to: Math.floor((o.now ?? Date.now)() / MINUTE) * MINUTE + MINUTE, minutes: 0 };
}

/** Forget every rollup row and the cursor, then build them again from the facts. One transaction empties them, and the loop waits out the whole rebuild. */
export async function rebuildStats(pool: Pool, o: RollupOptions = {}): Promise<RollupResult> {
  return (await locked(pool, true, async () => {
    const db = await pool.connect();
    try {
      await db.query("begin");
      for (const t of Object.values(TABLES)) await db.query(`delete from ${t}`);
      await db.query("delete from stats_dirty");
      await db.query("delete from cursors where stream = $1", [CURSOR]);
      await db.query("commit");
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      db.release();
    }
    return run(pool, o, true);
  })) as RollupResult;
}
