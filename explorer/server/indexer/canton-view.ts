/**
 * The Linked to Canton view: what each block's Canton update says beyond the update itself, and the rollup behind the header (migration 0049).
 *
 * Three passes fill the open rows of `canton_updates`, each over rows still open (a partial index each), oldest first, a batch at a time:
 *   attempts  the commit attempts of the block's number up to the one that committed, and the settlement time from the proof start, once the producer's journal
 *             has joined the block to its attempt;
 *   settle    for a block the journal does not hold: the settlement time from the block's own timestamp (whole seconds, the builder's clock);
 *   legs      the block's legs by kind, once every gateway's legs and the twin legs of the block are indexed (an earlier block is closed with the counts it had).
 * Each pass says the record times it touched, and the hours of those (and of what the journal loader marked in `canton_view_dirty`) are computed again from
 * the facts in one transaction per day. Nothing is incremented, so a pass twice changes nothing and a fact that arrives late reaches its hour.
 */
import type { Pool, PoolClient } from "pg";
import { TIME_EDGES, emptyHist, histLength } from "./stats-hist.ts";

const HOUR = 3_600_000, DAY = 86_400_000;
export const BATCH = 5000, MAX_BATCHES = 20, KEPT_HIST_DAYS = 8;

interface Touched { min: number | null; max: number | null; rows: number }
const none = (): Touched => ({ min: null, max: null, rows: 0 });
const merge = (a: Touched, b: Touched): Touched => ({ min: a.min === null ? b.min : b.min === null ? a.min : Math.min(a.min, b.min), max: a.max === null ? b.max : b.max === null ? a.max : Math.max(a.max, b.max), rows: a.rows + b.rows });

/** Runs an `update ... returning record_time` wrapped as a CTE named `u`: how many rows it changed and the span of their record times. */
async function touched(db: Pool | PoolClient, cte: string, values: unknown[]): Promise<Touched> {
  const { rows: [r] } = await db.query(
    `${cte} select count(*)::int as n, extract(epoch from min(record_time))::float8 * 1000 as lo, extract(epoch from max(record_time))::float8 * 1000 as hi from u`, values);
  return { min: r.lo === null ? null : Number(r.lo), max: r.hi === null ? null : Number(r.hi), rows: r.n };
}

/** Commit attempts and the settlement time from the proof start, for the blocks the journal has joined to their attempt. */
const ATTEMPTS = `
  with open as (select u.update_id, u.record_time from canton_updates u where u.commit_attempts is null and u.record_time >= $1
                   and exists (select 1 from blocks b join block_attempts a on a.attempt_id = b.attempt_id where b.update_id = u.update_id)
                 order by u.record_time limit $2),
  pick as (select distinct on (o.update_id) o.update_id, o.record_time, b.number, b.timestamp as bts, a.attempt_id, a.cut_at, a.proof_started_at
             from open o join blocks b on b.update_id = o.update_id join block_attempts a on a.attempt_id = b.attempt_id order by o.update_id, b.number),
  u as (update canton_updates c set
          commit_attempts = 1 + (select count(*) from block_attempts x where x.number = p.number and x.attempt_id <> p.attempt_id and x.submitted_at is not null and x.cut_at <= p.cut_at),
          settle_from = case when p.proof_started_at is not null then 'proof_start' else 'block_time' end,
          settle_seconds = case when extract(epoch from p.record_time - coalesce(p.proof_started_at, p.bts)) >= 0 then extract(epoch from p.record_time - coalesce(p.proof_started_at, p.bts)) end
        from pick p where c.update_id = p.update_id returning c.record_time)`;

/** The settlement time from the block's timestamp, for an update that has no journal behind it. */
const SETTLE = `
  with open as (select u.update_id, u.record_time from canton_updates u where u.settle_from is null order by u.record_time limit $1),
  u as (update canton_updates c set settle_from = 'block_time',
          settle_seconds = (select case when extract(epoch from o.record_time - b.timestamp) >= 0 then extract(epoch from o.record_time - b.timestamp) end from blocks b where b.update_id = o.update_id order by b.number limit 1)
        from open o where c.update_id = o.update_id returning c.record_time)`;

/** The legs of a block by kind. Lock and release are payments told apart by `twin_legs`, so a payment count leaves them out. */
const LEGS = `
  with open as (select u.update_id, u.record_time from canton_updates u where not u.legs_done order by u.record_time limit $2),
  blk as (select o.update_id, b.number from open o left join blocks b on b.update_id = o.update_id),
  ok as (select update_id from blk group by update_id having coalesce(max(number), -1) <= $1),
  g as (select k.update_id, count(*)::int as total, count(*) filter (where l.kind = 1)::int as dep, count(*) filter (where l.kind = 2)::int as wd, count(*) filter (where l.kind = 3)::int as pay
          from blk k join ok using (update_id) join gateway_legs l on l.block_number = k.number group by k.update_id),
  t as (select k.update_id, count(*) filter (where not w.is_release)::int as locks, count(*) filter (where w.is_release)::int as releases
          from blk k join ok using (update_id) join twin_legs w on w.block_number = k.number group by k.update_id),
  u as (update canton_updates c set legs_done = true, legs_total = coalesce(g.total, 0), legs_deposit = coalesce(g.dep, 0), legs_withdrawal = coalesce(g.wd, 0),
          legs_payment = greatest(coalesce(g.pay, 0) - coalesce(t.locks, 0) - coalesce(t.releases, 0), 0), legs_lock = coalesce(t.locks, 0), legs_release = coalesce(t.releases, 0)
        from ok left join g on g.update_id = ok.update_id left join t on t.update_id = ok.update_id where c.update_id = ok.update_id returning c.record_time)`;

/** The newest block whose legs are all indexed: the head, the slowest registered gateway's cursor and the twin pass, whichever is least (a pass that does not apply is out of it). */
const THROUGH = `select least(
    coalesce((select max(number) from blocks), 0),
    coalesce((select min(legs_cursor) from canton_registry where kind = 'gateway'), 9223372036854775807),
    case when exists (select 1 from canton_registry where kind = 'vault') and exists (select 1 from canton_twins)
         then coalesce((select value::bigint from meta where key = 'twin_totals_block'), 0) else 9223372036854775807 end) as n`;

async function fillOpenRows(pool: Pool, stopped: () => boolean): Promise<Touched> {
  let all = none();
  const { rows: [j] } = await pool.query("select extract(epoch from min(cut_at) - interval '1 hour')::float8 * 1000 as t from block_attempts");
  const journalFrom = j.t === null ? null : new Date(Number(j.t));
  for (let i = 0; i < MAX_BATCHES && !stopped(); i++) {
    const through = Number((await pool.query(THROUGH)).rows[0].n);
    const a = journalFrom === null ? none() : await touched(pool, ATTEMPTS, [journalFrom, BATCH]);
    const s = await touched(pool, SETTLE, [BATCH]);
    const l = await touched(pool, LEGS, [through, BATCH]);
    const here = merge(merge(a, s), l);
    all = merge(all, here);
    if (here.rows === 0) break;
  }
  return all;
}

export interface HourRow {
  hour: number; blocks: number; retried: number; attempts: number; committed: number; refused: number; other: number; settleN: number; settleSum: number;
  deposit: number; withdrawal: number; payment: number; lock: number; release: number; hist: number[] | null;
}

/** The rows of the hours in [from, to) (milliseconds, whole hours), from the facts. An hour with no fact has no row. */
export async function computeHours(db: Pool | PoolClient, from: number, to: number): Promise<Map<number, HourRow>> {
  const rows = new Map<number, HourRow>();
  const at = (h: number): HourRow => {
    let r = rows.get(h);
    if (!r) rows.set(h, r = { hour: h, blocks: 0, retried: 0, attempts: 0, committed: 0, refused: 0, other: 0, settleN: 0, settleSum: 0, deposit: 0, withdrawal: 0, payment: 0, lock: 0, release: 0, hist: null });
    return r;
  };
  const a = new Date(from), b = new Date(to);
  const blocks = await db.query(
    `select floor(extract(epoch from record_time) / 3600)::bigint as h, count(*)::int as blocks, count(*) filter (where commit_attempts > 1)::int as retried,
            count(*) filter (where settle_from = 'proof_start' and settle_seconds is not null)::int as settle_n,
            coalesce(sum(settle_seconds) filter (where settle_from = 'proof_start'), 0)::float8 as settle_sum,
            coalesce(sum(legs_deposit) filter (where legs_done), 0)::int as dep, coalesce(sum(legs_withdrawal) filter (where legs_done), 0)::int as wd,
            coalesce(sum(legs_payment) filter (where legs_done), 0)::int as pay, coalesce(sum(legs_lock) filter (where legs_done), 0)::int as lock,
            coalesce(sum(legs_release) filter (where legs_done), 0)::int as rel
       from canton_updates where record_time >= $1 and record_time < $2 group by 1`, [a, b]);
  for (const r of blocks.rows) {
    const x = at(Number(r.h) * HOUR);
    Object.assign(x, { blocks: r.blocks, retried: r.retried, settleN: r.settle_n, settleSum: r.settle_sum, deposit: r.dep, withdrawal: r.wd, payment: r.pay, lock: r.lock, release: r.rel });
  }
  // An attempt is counted in the hour it was submitted in. A run flagged as a test (settings.test) is left out, as in the stats rollups.
  const attempts = await db.query(
    `select floor(extract(epoch from a.submitted_at) / 3600)::bigint as h, count(*)::int as n,
            count(*) filter (where a.outcome = 'committed' or a.resolved_outcome = 'committed')::int as committed,
            count(*) filter (where a.outcome = 'refused' and a.resolved_outcome is distinct from 'committed')::int as refused
       from block_attempts a left join producer_runs r on r.run_id = a.run_id
      where a.submitted_at >= $1 and a.submitted_at < $2 and coalesce(r.settings->>'test', '') <> 'true' group by 1`, [a, b]);
  for (const r of attempts.rows) {
    const x = at(Number(r.h) * HOUR);
    Object.assign(x, { attempts: r.n, committed: r.committed, refused: r.refused, other: r.n - r.committed - r.refused });
  }
  const hist = await db.query(
    `select floor(extract(epoch from record_time) / 3600)::bigint as h, width_bucket(settle_seconds, $3::float8[]) as bucket, count(*)::int as n
       from canton_updates where record_time >= $1 and record_time < $2 and settle_from = 'proof_start' and settle_seconds is not null group by 1, 2`, [a, b, TIME_EDGES as number[]]);
  for (const r of hist.rows) {
    const x = at(Number(r.h) * HOUR);
    const h = x.hist ?? (x.hist = emptyHist("time"));
    const i = Math.min(Number(r.bucket), histLength("time") - 1);
    h[i] = (h[i] as number) + r.n;
  }
  return rows;
}

async function writeHours(db: PoolClient, from: number, to: number, rows: Map<number, HourRow>, now: Date): Promise<void> {
  await db.query("delete from canton_view_hour where hour >= $1 and hour < $2", [new Date(from), new Date(to)]);
  for (const r of rows.values()) {
    await db.query(
      `insert into canton_view_hour (hour, blocks, retried_blocks, attempts, attempts_committed, attempts_refused, attempts_other, settle_n, settle_sum,
         legs_deposit, legs_withdrawal, legs_payment, legs_lock, legs_release, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [new Date(r.hour), r.blocks, r.retried, r.attempts, r.committed, r.refused, r.other, r.settleN, r.settleSum, r.deposit, r.withdrawal, r.payment, r.lock, r.release, now]);
    if (r.hist) await db.query("insert into canton_view_hist (hour, settle_hist) values ($1, $2)", [new Date(r.hour), r.hist]);
  }
}

export interface ViewResult { rows: number; hours: number }
export interface ViewOptions { now?: () => number; stopped?: () => boolean }

/** Recomputes the hours of [from, to] (milliseconds), a day at a time, each day in one transaction. Returns the hours written. */
export async function recomputeHours(pool: Pool, from: number, to: number, now: Date, stopped: () => boolean = () => false): Promise<number> {
  const start = Math.floor(from / HOUR) * HOUR, end = Math.floor(to / HOUR) * HOUR + HOUR;
  let written = 0;
  for (let a = start; a < end && !stopped(); a += DAY) {
    const b = Math.min(a + DAY, end);
    const db = await pool.connect();
    try {
      await db.query("begin");
      const rows = await computeHours(db, a, b);
      await writeHours(db, a, b, rows, now);
      await db.query("commit");
      written += rows.size;
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      db.release();
    }
  }
  return written;
}

/** One run, in words: it fills the open rows, then recomputes the hours they (and the journal loader) touched. Safe to run twice; two passes at once only repeat work. */
export async function refreshCantonView(pool: Pool, o: ViewOptions = {}): Promise<ViewResult> {
  const now = new Date((o.now ?? Date.now)());
  const stopped = o.stopped ?? (() => false);
  const t = await fillOpenRows(pool, stopped);
  // The journal loader's marks are taken in the transaction that is rolled back if the hours cannot be written, so a failure leaves them for the next pass.
  const claim = await pool.connect();
  let from = t.min, to = t.max;
  try {
    await claim.query("begin");
    const { rows: [d] } = await claim.query("with d as (delete from canton_view_dirty returning at) select extract(epoch from min(at))::float8 * 1000 as t from d");
    if (d.t !== null) {
      from = from === null ? Number(d.t) : Math.min(from, Number(d.t));
      to = Math.max(to ?? 0, now.getTime());
    }
    let hours = 0;
    if (from !== null && to !== null) {
      // The claim stays open while the hours are written (outside it, on other connections): a failure rolls the marks back.
      hours = await recomputeHours(pool, from, to, now, stopped);
    }
    await claim.query("commit");
    await pool.query("delete from canton_view_hist where hour < $1", [new Date(now.getTime() - KEPT_HIST_DAYS * DAY)]);
    return { rows: t.rows, hours };
  } catch (e) {
    await claim.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    claim.release();
  }
}
