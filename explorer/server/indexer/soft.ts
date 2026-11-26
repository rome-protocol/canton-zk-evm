/**
 * What to watch once a page tells a person "Done" for a step that is in a block and not yet confirmed. Three things can go wrong after that, and each has a number:
 * a block with transactions that was built and then undone (Canton refused it, or the producer died), a block that takes long to be confirmed, and a transaction that ran
 * more than once and ended failed (a step that ran again after another sender's transaction moved the state). The row is written by the indexer, from the lifecycle tables.
 */
import type { Pool } from "pg";
import type { HealthRow } from "./health.ts";

/** The limits the row is held to. Settings of the indexer (`SOFT_UNDONE_BLOCKS_PER_DAY`, `SOFT_CONFIRM_P99_MS`, `SOFT_RERUN_FAILED_PER_DAY`); a count up to the limit is ok. */
export interface SoftLimits { undonePerDay: number; confirmP99Ms: number; rerunFailedPerDay: number }
export const SOFT_DEFAULTS: SoftLimits = { undonePerDay: 0, confirmP99Ms: 60_000, rerunFailedPerDay: 0 };

/** The window of the two counts, and of the two times. */
export const SOFT_DAY_MS = 86_400_000, SOFT_HOUR_MS = 3_600_000;
/** A block this young that has no answer yet is still in flight, not undone. */
export const SOFT_SETTLE_MS = 600_000;

export interface SoftMeasures {
  /**
   * Blocks with transactions that were built in the last day and never confirmed as built, and the first of them; of those, how many were dropped when the producer stopped cleanly
   * (a deploy, a restart, a reclaim: planned, nothing to fix), and the first of the rest.
   */
  undone: { count: number; first: number | null; atStop: number; firstUnplanned: number | null };
  /** From "in a block" to "confirmed", for the transactions that became final in the last hour. */
  confirm: { count: number; p50Ms: number | null; p99Ms: number | null };
  /** From the public RPC taking a send to "in a block", for the same transactions. */
  sent: { p99Ms: number | null };
  /** Transactions that became final in the last day after more than one run and with a failed result, and the first of them. */
  rerunFailed: { count: number; first: string | null };
}

const seconds = (ms: number): number => Math.round(ms / 1000);

export function softRow(m: SoftMeasures, limits: SoftLimits): HealthRow {
  const why: string[] = [];
  const unplanned = m.undone.count - m.undone.atStop;
  if (unplanned > limits.undonePerDay) why.push(`${unplanned} block${unplanned === 1 ? "" : "s"} with transactions ${unplanned === 1 ? "was" : "were"} undone in the last day, not at a planned stop (the first is block ${m.undone.firstUnplanned})`);
  if (m.confirm.p99Ms !== null && m.confirm.p99Ms > limits.confirmP99Ms) why.push(`a block takes ${seconds(m.confirm.p99Ms)} s to be confirmed at the 99th percentile of the last hour, over the limit of ${seconds(limits.confirmP99Ms)} s`);
  if (m.rerunFailed.count > limits.rerunFailedPerDay) why.push(`${m.rerunFailed.count} transaction${m.rerunFailed.count === 1 ? "" : "s"} that ran more than once ended failed in the last day (the first is ${m.rerunFailed.first})`);
  return {
    id: "soft_confirmation", status: why.length ? "degraded" : "ok",
    value: {
      undoneBlocksLastDay: m.undone.count, undoneAtPlannedStopLastDay: m.undone.atStop, firstUndoneBlock: m.undone.first,
      inBlockToConfirmedMs: { p50: m.confirm.p50Ms, p99: m.confirm.p99Ms, transactions: m.confirm.count }, sentToInBlockP99Ms: m.sent.p99Ms,
      rerunFailedLastDay: m.rerunFailed.count, firstRerunFailed: m.rerunFailed.first,
    },
    threshold: { undoneBlocksPerDay: limits.undonePerDay, confirmP99Ms: limits.confirmP99Ms, rerunFailedPerDay: limits.rerunFailedPerDay },
    detail: why.join("; ") || null,
  };
}

const AT_STOP = "coalesce(r.stop_state, '') = 'stopped' and (a.outcome is null or a.resolved_outcome is not distinct from 'restarted')";
const whole = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v)));

/** Reads the four measures from the lifecycle tables, against the clock `nowMs`. */
export async function measureSoft(pool: Pool, nowMs: number): Promise<SoftMeasures> {
  const at = "to_timestamp($1 / 1000.0)";
  const [undone, times, rerun] = await Promise.all([
    // Built (it has a hash), with transactions, and neither answered as committed, nor settled as committed, nor seen final: a block still in flight is left out until it has had time to settle.
    // One dropped when its producer run stopped cleanly (no answer, or settled as restarted, in a run that ended 'stopped') is counted apart: a deploy or a reclaim does it, and nothing is wrong.
    pool.query(
      `select count(*) as n, min(a.number) as first,
              count(*) filter (where ${AT_STOP}) as at_stop, min(a.number) filter (where not (${AT_STOP})) as first_unplanned
         from block_attempts a left join producer_runs r on r.run_id = a.run_id
        where a.tx_count > 0 and a.block_hash is not null and a.cut_at > ${at} - $2 * interval '1 millisecond' and a.cut_at < ${at} - $3 * interval '1 millisecond'
          and a.outcome is distinct from 'committed' and a.resolved_outcome is distinct from 'committed' and a.final_seen_at is null`, [nowMs, SOFT_DAY_MS, SOFT_SETTLE_MS]),
    // The time of the attempt that committed the transaction, as the transaction's lifecycle shows it (committedAt - includedAt), for what became final in the last hour.
    pool.query(
      `select count(*) as n,
              percentile_cont(0.5) within group (order by s.confirm_ms) as p50, percentile_cont(0.99) within group (order by s.confirm_ms) as p99,
              percentile_cont(0.99) within group (order by s.sent_ms) filter (where s.sent_ms is not null) as sent_p99
         from (select extract(epoch from (case when a.outcome = 'committed' then a.answered_at else coalesce(a.resolved_at, a.answered_at) end - l.first_included_at)) * 1000 as confirm_ms,
                      extract(epoch from (l.first_included_at - l.accepted_at)) * 1000 as sent_ms
                 from tx_lifecycle l
                 join lateral (select ba.outcome, ba.answered_at, ba.resolved_at from attempt_transactions x join block_attempts ba on ba.attempt_id = x.attempt_id
                                where x.tx_hash = l.tx_hash and x.left_out_reason is null and (ba.outcome = 'committed' or ba.resolved_outcome = 'committed') order by ba.attempt_id desc limit 1) a on true
                where l.final_at > ${at} - $2 * interval '1 millisecond' and l.final_at <= ${at} and l.first_included_at is not null) s
        where s.confirm_ms is not null and s.confirm_ms >= 0`, [nowMs, SOFT_HOUR_MS]),
    pool.query(
      `select count(*) as n, (array_agg(l.tx_hash order by l.final_at))[1] as first
         from tx_lifecycle l join tx_hashes h on h.hash = l.tx_hash join transactions t on t.block_number = h.block_number and t.tx_index = h.tx_index
        where l.attempts > 1 and t.status = 0 and l.final_at > ${at} - $2 * interval '1 millisecond' and l.final_at <= ${at}`, [nowMs, SOFT_DAY_MS]),
  ]);
  const u = undone.rows[0], t = times.rows[0], r = rerun.rows[0];
  return {
    undone: { count: Number(u.n), first: u.first === null ? null : Number(u.first), atStop: Number(u.at_stop), firstUnplanned: u.first_unplanned === null ? null : Number(u.first_unplanned) },
    confirm: { count: Number(t.n), p50Ms: whole(t.p50), p99Ms: whole(t.p99) },
    sent: { p99Ms: whole(t.sent_p99) },
    rerunFailed: { count: Number(r.n), first: r.first === null ? null : `0x${(r.first as Buffer).toString("hex")}` },
  };
}
