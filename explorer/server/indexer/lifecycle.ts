/**
 * The checks that need the producer (design section 4.5 and the health table of section 8): C8 (the producer's journal against Canton's
 * updates in the index), C9 (the two clocks), and the producer's own rows from its status.json (`producer_alive`, `producer_state`) and from
 * the journal (`prover`). A chain with no new block is `ok`: under `on_demand` that is normal, and the producer's liveness is the age of
 * its status file, never the age of its journal. Without a journal or a status file the rows say so (`degraded`), and the blocks are still indexed.
 */
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { setHealth, type HealthRow } from "./health.ts";
import { SOFT_DEFAULTS, measureSoft, softRow, type SoftLimits } from "./soft.ts";

/** How often the soft-confirmation row is worked out: it reads a day of attempts. */
export const SOFT_EVERY_MS = 60_000;
export const C8_EVERY_MS = 10_000, C8_WITHIN_S = 10, C9_TOLERANCE_MS = 100, ALIVE_WITHIN_MS = 15_000, UNKNOWN_FOR_MS = 60_000, FAILURES_DEGRADED = 3;

export interface ProducerStatus {
  state?: string; updatedAt?: string; consecutiveFailures?: number; blocksUnknown?: number; waitingToBeResolved?: { number?: number; hash?: string } | null; journalError?: { time?: string; error?: string } | null;
  lastError?: { time?: string; error?: string; kind?: string; number?: number } | null;
}

/**
 * What the public health answer says about a failed block: one fixed sentence per kind of failure, as the producer's status file names the kind (`lastError.kind`), and the block's number.
 * The text of the error itself (a tool's own output, a path, a host name) is never passed on: it stays in the producer's log on its machine.
 */
export const FAILURE_REASONS: Record<string, string> = {
  input_tool: "the input tool failed",
  proof: "the proof failed",
  canton_refused: "Canton refused the block",
  canton_not_taken: "Canton did not take the block",
  canton_unresolved: "Canton's answer to the block is not known",
  head: "Canton's head is not the block's parent",
};
const FAILED = "the block failed";

/** The fixed reason of a failure, with the block's number when the status file has one. */
export function failureReason(e: ProducerStatus["lastError"]): string {
  const kind = typeof e?.kind === "string" ? e.kind : "";
  const number = typeof e?.number === "number" && Number.isSafeInteger(e.number) && e.number >= 0 ? e.number : null;
  return `${Object.hasOwn(FAILURE_REASONS, kind) ? FAILURE_REASONS[kind] : FAILED}${number === null ? "" : ` (block ${number})`}`;
}

/** The outcome of a proof as the journal says it: one lowercase word (`failed`, `wrong_block`, `timeout`). Anything else is just `failed`. */
const outcomeWord = (o: unknown): string => (typeof o === "string" && /^[a-z_]{1,24}$/.test(o) ? o : "failed");

export interface LifecycleChecksOptions { pool: Pool; statusFile: string | null; now?: () => number; soft?: SoftLimits }

export function createLifecycleChecks(o: LifecycleChecksOptions) {
  const now = o.now ?? Date.now;
  const soft = o.soft ?? SOFT_DEFAULTS;
  let lastC8 = -Infinity;
  let lastSoft = -Infinity;
  let unknownSince: number | null = null;

  async function readStatus(): Promise<{ status: ProducerStatus } | { error: string }> {
    if (!o.statusFile) return { error: "no producer status file is set (PRODUCER_STATUS_FILE), so the producer's state is not known" };
    try {
      const j = JSON.parse(await readFile(o.statusFile, "utf8")) as unknown;
      if (typeof j !== "object" || j === null || Array.isArray(j)) return { error: "the producer's status file is not a JSON object" };
      return { status: j as ProducerStatus };
    } catch (e) {
      console.error(`producer status: cannot read the status file: ${(e as Error).message}`);
      return { error: "the producer's status file cannot be read" };
    }
  }

  /** `producer_alive`, `producer_state` and `prover`. */
  async function producerRows(): Promise<HealthRow[]> {
    const rows: HealthRow[] = [];
    const read = await readStatus();
    if ("error" in read) {
      rows.push({ id: "producer_alive", status: "degraded", detail: read.error }, { id: "producer_state", status: "degraded", detail: read.error });
    } else {
      const s = read.status;
      const updated = typeof s.updatedAt === "string" ? Date.parse(s.updatedAt) : NaN;
      const age = Number.isNaN(updated) ? null : Math.max(0, now() - updated);
      const stale = age === null || age > ALIVE_WITHIN_MS;
      rows.push({ id: "producer_alive", status: stale ? "degraded" : "ok", value: { ageMs: age }, threshold: { ms: ALIVE_WITHIN_MS },
        detail: stale ? (age === null ? "the producer's status file has no updatedAt" : `the producer's status file was last written ${Math.round(age / 1000)} s ago`) : null });
      // `blocksUnknown` counts since the loop started and never goes down; `waitingToBeResolved` is set while a block's outcome is not known.
      const waiting = typeof s.waitingToBeResolved === "object" && s.waitingToBeResolved !== null ? s.waitingToBeResolved : null;
      const unknown = typeof s.blocksUnknown === "number" ? s.blocksUnknown : 0;
      if (waiting) unknownSince ??= now(); else unknownSince = null;
      const failures = typeof s.consecutiveFailures === "number" ? s.consecutiveFailures : 0;
      const why: string[] = [];
      if (s.state !== undefined && s.state !== "running") why.push(`the producer is ${s.state}`);
      if (failures >= FAILURES_DEGRADED) why.push(`${failures} blocks in a row have failed; the last: ${failureReason(s.lastError)}`);
      if (unknownSince !== null && now() - unknownSince > UNKNOWN_FOR_MS) why.push(`the outcome of block ${waiting?.number ?? "?"} has not been known for ${Math.round((now() - unknownSince) / 1000)} s`);
      if (s.journalError) why.push("the producer cannot write its journal");
      rows.push({ id: "producer_state", status: why.length ? "degraded" : "ok", value: { state: s.state ?? null, consecutiveFailures: failures, blocksUnknown: unknown, waitingToBeResolved: waiting && { number: waiting.number ?? null, hash: waiting.hash ?? null } },
        threshold: { consecutiveFailures: FAILURES_DEGRADED, unknownMs: UNKNOWN_FOR_MS }, detail: why.join("; ") || null });
    }
    // Only the last six hours of attempts is read: cut_at is indexed, and a proof that ended longer ago is no news.
    const last = await o.pool.query("select number, proof_outcome, reason from block_attempts where proof_outcome is not null and cut_at > to_timestamp($1 / 1000.0) - interval '6 hours' order by proof_ended_at desc nulls last, cut_at desc limit 1", [now()]);
    const bad = last.rowCount ? last.rows[0].proof_outcome !== "ok" : false;
    rows.push({ id: "prover", status: bad ? "degraded" : "ok", value: last.rowCount ? { number: Number(last.rows[0].number), outcome: outcomeWord(last.rows[0].proof_outcome) } : null,
      detail: bad ? `the last proof (block ${Number(last.rows[0].number)}) ended ${outcomeWord(last.rows[0].proof_outcome)}` : null });
    return rows;
  }

  async function c8(journalAvailable: boolean): Promise<HealthRow> {
    const threshold = { seconds: C8_WITHIN_S };
    const runs = Number((await o.pool.query("select count(*) as n from producer_runs")).rows[0].n);
    if (!journalAvailable || runs === 0) {
      return { id: "C8", status: "degraded", threshold, detail: "there is no producer journal loaded, so the producer cannot be checked against Canton's updates" };
    }
    const missing = (await o.pool.query(
      `select count(*) as n, min(a.number) as first from block_attempts a
        where a.outcome = 'committed' and a.update_id is not null and a.cut_at > to_timestamp($2 / 1000.0) - interval '6 hours' and a.answered_at < now() - make_interval(secs => $1)
          and a.answered_at >= (select coalesce(min(record_time), 'infinity') from canton_updates)
          and not exists (select 1 from canton_updates u where u.update_id = a.update_id)`, [C8_WITHIN_S, now()])).rows[0];
    const orphan = (await o.pool.query(
      `select count(*) as total, count(*) filter (where b.record_time > to_timestamp($2 / 1000.0) - interval '6 hours') as n,
              min(b.number) filter (where b.record_time > to_timestamp($2 / 1000.0) - interval '6 hours') as first
         from blocks b
        where b.attempt_id is null and b.record_time < now() - make_interval(secs => $1) and b.record_time >= (select min(started_at) from producer_runs)`, [C8_WITHIN_S, now()])).rows[0];
    // The status follows the last six hours, as the first count does: one lost line must not keep C8 degraded for the life of the database. The value keeps the all-time number.
    const m = Number(missing.n), w = Number(orphan.n), wAll = Number(orphan.total);
    const why: string[] = [];
    if (m > 0) why.push(`${m} blocks the producer says committed have no update in the index after ${C8_WITHIN_S} s (the first is block ${missing.first})`);
    if (w > 0) why.push(`${w} indexed blocks have no committed attempt in the journal (the first is block ${orphan.first}): another producer, or a lost journal`);
    return { id: "C8", status: why.length ? "degraded" : "ok", value: { committedWithoutUpdate: m, blocksWithoutAttempt: wAll, blocksWithoutAttemptLastSixHours: w }, threshold, detail: why.join("; ") || null };
  }

  async function c9(): Promise<HealthRow> {
    const r = await o.pool.query(
      `select a.number, extract(epoch from (a.answered_at - u.record_time)) * 1000 as ms from block_attempts a join canton_updates u on u.update_id = a.update_id
        where a.outcome = 'committed' and a.answered_at is not null and a.cut_at > to_timestamp($1 / 1000.0) - interval '6 hours' order by a.answered_at desc limit 100`, [now()]);
    let worst: { number: number; ms: number } | null = null;
    for (const x of r.rows) if (worst === null || Number(x.ms) < worst.ms) worst = { number: Number(x.number), ms: Math.round(Number(x.ms)) };
    const bad = worst !== null && worst.ms < -C9_TOLERANCE_MS;
    return { id: "C9", status: bad ? "degraded" : "ok", value: { worstMs: worst?.ms ?? null, checked: r.rowCount }, threshold: { toleranceMs: C9_TOLERANCE_MS },
      detail: bad ? `block ${worst!.number}: the producer's answer is ${-worst!.ms} ms before Canton's record time, so one of the two clocks is wrong` : null };
  }

  /** Runs the checks and writes their rows. C8 runs every 10 s and the soft-confirmation row every minute (or at once with `force`), the others every call. */
  async function run(journalAvailable: boolean, force = false): Promise<void> {
    const rows = [...(await producerRows()), await c9()];
    if (force || now() - lastC8 >= C8_EVERY_MS) {
      lastC8 = now();
      rows.push(await c8(journalAvailable));
    }
    if (force || now() - lastSoft >= SOFT_EVERY_MS) {
      lastSoft = now();
      // A read that fails is left out of this turn: the row is then not refreshed, and it turns stale (degraded) after three of its own intervals.
      try {
        rows.push(softRow(await measureSoft(o.pool, now()), soft));
      } catch (e) {
        console.error(`soft confirmation: cannot read the lifecycle: ${(e as Error).message}`);
      }
    }
    await setHealth(o.pool, rows);
  }

  return { run };
}
