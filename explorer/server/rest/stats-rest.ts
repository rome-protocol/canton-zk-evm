/**
 * The reads behind `/api/stats` (design sections 6.1 and 8). Nothing here writes. The rollup rows come from the minute, hour and day tables; the numbers that
 * are live (transactions per second now, what is waiting, what is open, what was lost) come from the tables the rollups are made of.
 * Test runs (settings `test = true`) are left out of the rollup rows. The live lists and counts (open, stuck, lost) and the day's address counts do not
 * look at test runs.
 */
import type { Pool } from "pg";
import { ChainDbError } from "../chain-db.ts";
import { CURSOR, HISTS, SCALARS, TABLES } from "../indexer/stats.ts";
import { TIME_EDGES, histLength } from "../indexer/stats-hist.ts";
import { hex } from "./chain-rest.ts";
import { txTotal as totalOf, type TxTotal } from "./tx-total.ts";

export type Span = keyof typeof TABLES;
export const EXTRAS = ["active_addresses", "new_addresses", "new_contracts", "verified_contracts"] as const;
export type Column = (typeof SCALARS)[number] | keyof typeof HISTS | (typeof EXTRAS)[number];
const COLUMNS: ReadonlySet<string> = new Set<string>([...SCALARS, ...Object.keys(HISTS), ...EXTRAS]);

/** A rollup row: the start of its bucket in ms, and the columns asked for (numbers, number arrays, or null where a day's extra is not counted yet). */
export type StatsRow = { bucket: number } & Partial<Record<Column, number | number[] | null>>;

export interface OpenCounts { open: number; noAcceptanceTime: number; normal: number | null; slow: number | null; stuck: number; beingProven: number; waiting: number }
export interface StuckItem { txHash: string; state: string; ageSeconds: number; acceptedAt: string }
export interface LostItem { txHash: string; state: string; reason: string | null; at: string }

/** An open transaction is stuck when it is older than this. */
export const STUCK_SECONDS = 120;
/** How many stuck and lost transactions are listed. */
export const LIST_MAX = 100;

export interface StatsRest {
  /** The rows of one table with `from` <= bucket < `to` (ms), oldest first, with only the columns asked for. */
  rows(span: Span, from: number, to: number, columns: readonly Column[]): Promise<StatsRow[]>;
  /** The most transactions in one minute of [from, to), and the minute; null with no minute row. */
  peak(from: number, to: number): Promise<{ at: number; txs: number } | null>;
  /** Transactions in blocks whose record time is in (now - 60 s, now]: what the rate of the last minute is made of. */
  lastMinuteTxs(now: number): Promise<number>;
  /** When the rollups last ran (the cursor's `updated_at`), when the day's extras were last made, and the first day with a row. Null where nothing has run. */
  state(): Promise<{ asOf: number | null; extrasAt: number | null; since: number | null }>;
  /** The newest sample of reth's pool count, or null. */
  pool(): Promise<{ waiting: number; at: number } | null>;
  /** The open transactions (pending or being proven) by age. Without `slowAfterSeconds` there is no split into normal and slow. */
  open(now: number, slowAfterSeconds: number | null): Promise<OpenCounts>;
  /** The stuck ones, oldest first, at most LIST_MAX. */
  stuck(now: number): Promise<StuckItem[]>;
  /** The lost transactions and the dropped ones, each: all of them ever, and the newest LIST_MAX; and how many were replaced by their sender, ever. */
  lost(): Promise<{ lost: { total: number; items: LostItem[] }; dropped: { total: number; items: LostItem[] }; replaced: number }>;
  /** The newest run of the producer that is not a test run: its strategy and when it started. Null when no run is known. */
  cutting(): Promise<{ strategy: string; since: number } | null>;
  /** The chain's transactions since its first block, exact through the newest final block (one function with /api/txs); null where the rollups cannot say. */
  txTotal(): Promise<TxTotal | null>;
  /** The faucet's requests made in [from, to): by state, and the time from request to final as a time histogram (empty when none is final). */
  faucet(from: number, to: number): Promise<{
    requests: number; sent: number; final: number; failed: number; hist: number[];
    /** The requests it turned away in [from, to) by reason, and when the counting began (null when it never did). */
    turnedAway: { since: number | null; byReason: Record<"address" | "ip" | "hour" | "captcha", number> };
  }>;
}

export function createStatsRest(pool: Pool): StatsRest {
  type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
    try {
      return (await pool.query(sql, values)).rows;
    } catch (e) {
      throw new ChainDbError(`the database cannot be read: ${(e as Error).message}`);
    }
  }
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const iso = (ms: number): string => new Date(ms).toISOString();

  async function rows(span: Span, from: number, to: number, columns: readonly Column[]): Promise<StatsRow[]> {
    const wanted = [...new Set(columns)];
    for (const c of wanted) if (!COLUMNS.has(c) || (span !== "day" && (EXTRAS as readonly string[]).includes(c))) throw new Error(`no column ${c} in ${TABLES[span]}`);
    const out = await query(
      `select extract(epoch from bucket)::float8 * 1000 as bucket${wanted.map((c) => `, ${c}`).join("")} from ${TABLES[span]} where bucket >= $1 and bucket < $2 order by bucket`,
      [new Date(from), new Date(to)]);
    return out.map((r) => {
      const row: StatsRow = { bucket: Number(r.bucket) };
      for (const c of wanted) row[c] = Array.isArray(r[c]) ? (r[c] as unknown[]).map(Number) : num(r[c]);
      return row;
    });
  }

  async function peak(from: number, to: number) {
    const [r] = await query("select extract(epoch from bucket)::float8 * 1000 as at, txs from stats_minute where bucket >= $1 and bucket < $2 order by txs desc, bucket limit 1", [new Date(from), new Date(to)]);
    return r ? { at: Number(r.at), txs: Number(r.txs) } : null;
  }

  async function lastMinuteTxs(now: number): Promise<number> {
    const [r] = await query(
      `select coalesce(sum(b.tx_count), 0)::float8 as n
         from blocks b left join block_attempts a on a.attempt_id = b.attempt_id left join producer_runs r on r.run_id = a.run_id
        where b.record_time > $1 and b.record_time <= $2 and coalesce(r.settings->>'test', '') <> 'true'`,
      [new Date(now - 60_000), new Date(now)]);
    return Number(r?.n ?? 0);
  }

  async function state() {
    const [c] = await query("select extract(epoch from updated_at)::float8 * 1000 as at, detail from cursors where stream = $1", [CURSOR]);
    const [s] = await query("select extract(epoch from min(bucket))::float8 * 1000 as since from stats_day");
    return { asOf: c ? Number(c.at) : null, extrasAt: c?.detail?.extrasAt ? Number(c.detail.extrasAt) : null, since: num(s?.since) };
  }

  async function poolSample() {
    const [r] = await query("select extract(epoch from at)::float8 * 1000 as at, waiting from pool_samples order by at desc limit 1");
    return r ? { waiting: Number(r.waiting), at: Number(r.at) } : null;
  }

  async function open(now: number, slowAfter: number | null): Promise<OpenCounts> {
    const [r = {}] = await query(
      `with o as (select state, extract(epoch from ($1::timestamptz - accepted_at))::float8 as age from tx_lifecycle where state in ('pending', 'proving'))
       select count(*)::int as open, count(*) filter (where state = 'proving')::int as proving, count(*) filter (where state = 'pending')::int as pending, count(*) filter (where age is null)::int as none,
              count(*) filter (where age > $2)::int as stuck,
              count(*) filter (where age <= $2 and ($3::float8 is null or age <= $3))::int as normal,
              count(*) filter (where age <= $2 and $3::float8 is not null and age > $3)::int as slow
         from o`,
      [new Date(now), STUCK_SECONDS, slowAfter]);
    return { open: Number(r.open), noAcceptanceTime: Number(r.none), normal: slowAfter === null ? null : Number(r.normal), slow: slowAfter === null ? null : Number(r.slow), stuck: Number(r.stuck), beingProven: Number(r.proving), waiting: Number(r.pending) };
  }

  async function stuck(now: number): Promise<StuckItem[]> {
    const out = await query(
      `select tx_hash, state, extract(epoch from accepted_at)::float8 * 1000 as at from tx_lifecycle
        where state in ('pending', 'proving') and accepted_at < $1 order by accepted_at, tx_hash limit $2`,
      [new Date(now - STUCK_SECONDS * 1000), LIST_MAX]);
    return out.map((r) => ({ txHash: hex(r.tx_hash), state: r.state, ageSeconds: Math.floor((now - Number(r.at)) / 1000), acceptedAt: iso(Number(r.at)) }));
  }

  async function lostOf(state: string) {
    const [t] = await query("select count(*)::int as n from tx_lifecycle where state = $1", [state]);
    const out = await query(
      `select tx_hash, state, state_reason, extract(epoch from lost_at)::float8 * 1000 as at from tx_lifecycle
        where state = $1 order by lost_at desc, tx_hash limit $2`, [state, LIST_MAX]);
    return { total: Number(t?.n ?? 0), items: out.map((r): LostItem => ({ txHash: hex(r.tx_hash), state: r.state, reason: r.state_reason, at: iso(Number(r.at)) })) };
  }
  async function lost() {
    const [lost, dropped, [r]] = await Promise.all([lostOf("lost"), lostOf("dropped"), query("select count(*)::int as n from tx_lifecycle where state = 'replaced'")]);
    return { lost, dropped, replaced: Number(r?.n ?? 0) };
  }

  async function cutting() {
    const [r] = await query(
      "select strategy, extract(epoch from started_at)::float8 * 1000 as at from producer_runs where coalesce(settings->>'test', '') <> 'true' order by started_at desc, run_id limit 1");
    return r ? { strategy: String(r.strategy), since: Number(r.at) } : null;
  }

  async function faucet(from: number, to: number) {
    const [c = {}] = await query(
      `select count(*)::int as requests, count(*) filter (where sent_at is not null)::int as sent, count(*) filter (where state = 'final')::int as final,
              count(*) filter (where state = 'failed')::int as failed from faucet_requests where requested_at >= $1 and requested_at < $2`, [new Date(from), new Date(to)]);
    const k = await query(
      `select width_bucket(greatest(0, extract(epoch from final_at - requested_at)::float8), $3::float8[]) as k, count(*)::int as n from faucet_requests
        where requested_at >= $1 and requested_at < $2 and state = 'final' and final_at is not null group by 1`, [new Date(from), new Date(to), TIME_EDGES as number[]]);
    const hist = new Array(histLength("time")).fill(0) as number[];
    for (const x of k) hist[Number(x.k)] = Number(x.n);
    const byReason = { address: 0, ip: 0, hour: 0, captcha: 0 };
    for (const r of await query("select reason, sum(n)::float8 as n from faucet_refusals where minute >= $1 and minute < $2 group by reason", [new Date(from), new Date(to)])) byReason[r.reason as keyof typeof byReason] = Number(r.n);
    const [since] = await query("select extract(epoch from min(since))::float8 * 1000 as at from faucet_refusals_since");
    return { requests: Number(c.requests ?? 0), sent: Number(c.sent ?? 0), final: Number(c.final ?? 0), failed: Number(c.failed ?? 0), hist, turnedAway: { since: num(since?.at), byReason } };
  }

  return { rows, peak, lastMinuteTxs, state, txTotal: () => totalOf(query), pool: poolSample, open, stuck, lost, cutting, faucet };
}
