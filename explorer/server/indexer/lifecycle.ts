/**
 * The checks that need the producer (design section 4.5 and the health table of section 8): C8 (the producer's journal against Canton's
 * updates in the index), C9 (the two clocks), and the producer's own rows from its status.json (`producer_alive`, `producer_state`) and from
 * the journal (`prover`). A chain with no new block is `ok`: under `on_demand` that is normal, and the producer's liveness is the age of
 * its status file, never the age of its journal. Without a journal or a status file the rows say so (`degraded`), and the blocks are still indexed.
 */
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { setHealth, type HealthRow } from "./health.ts";

export const C8_EVERY_MS = 10_000, C8_WITHIN_S = 10, C9_TOLERANCE_MS = 100, ALIVE_WITHIN_MS = 15_000, UNKNOWN_FOR_MS = 60_000, FAILURES_DEGRADED = 3;

export interface ProducerStatus {
  state?: string; updatedAt?: string; consecutiveFailures?: number; blocksUnknown?: number; journalError?: { time?: string; error?: string } | null;
  lastError?: { time?: string; error?: string } | null;
}

export interface LifecycleChecksOptions { pool: Pool; statusFile: string | null; now?: () => number }

export function createLifecycleChecks(o: LifecycleChecksOptions) {
  const now = o.now ?? Date.now;
  let lastC8 = -Infinity;
  let unknownSince: number | null = null;

  async function readStatus(): Promise<{ status: ProducerStatus } | { error: string }> {
    if (!o.statusFile) return { error: "no producer status file is set (PRODUCER_STATUS_FILE), so the producer's state is not known" };
    try {
      const j = JSON.parse(await readFile(o.statusFile, "utf8")) as unknown;
      if (typeof j !== "object" || j === null || Array.isArray(j)) return { error: "the producer's status file is not a JSON object" };
      return { status: j as ProducerStatus };
    } catch (e) {
      return { error: `the producer's status file cannot be read: ${(e as Error).message}` };
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
      const unknown = typeof s.blocksUnknown === "number" ? s.blocksUnknown : 0;
      if (unknown > 0) unknownSince ??= now(); else unknownSince = null;
      const failures = typeof s.consecutiveFailures === "number" ? s.consecutiveFailures : 0;
      const why: string[] = [];
      if (s.state !== undefined && s.state !== "running") why.push(`the producer is ${s.state}`);
      if (failures >= FAILURES_DEGRADED) why.push(`${failures} blocks in a row have failed${s.lastError?.error ? `: ${s.lastError.error.slice(0, 200)}` : ""}`);
      if (unknownSince !== null && now() - unknownSince > UNKNOWN_FOR_MS) why.push(`the outcome of ${unknown} block(s) has not been known for ${Math.round((now() - unknownSince) / 1000)} s`);
      if (s.journalError) why.push(`the producer cannot write its journal: ${String(s.journalError.error ?? "").slice(0, 200)}`);
      rows.push({ id: "producer_state", status: why.length ? "degraded" : "ok", value: { state: s.state ?? null, consecutiveFailures: failures, blocksUnknown: unknown },
        threshold: { consecutiveFailures: FAILURES_DEGRADED, unknownMs: UNKNOWN_FOR_MS }, detail: why.join("; ") || null });
    }
    const last = await o.pool.query("select number, proof_outcome, reason from block_attempts where proof_outcome is not null order by proof_ended_at desc nulls last, cut_at desc limit 1");
    const bad = last.rowCount ? last.rows[0].proof_outcome !== "ok" : false;
    rows.push({ id: "prover", status: bad ? "degraded" : "ok", value: last.rowCount ? { number: Number(last.rows[0].number), outcome: last.rows[0].proof_outcome } : null,
      detail: bad ? `the last proof (block ${last.rows[0].number}) ended ${last.rows[0].proof_outcome}` : null });
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
        where a.outcome = 'committed' and a.update_id is not null and a.answered_at < now() - make_interval(secs => $1)
          and a.answered_at >= (select coalesce(min(record_time), 'infinity') from canton_updates)
          and not exists (select 1 from canton_updates u where u.update_id = a.update_id)`, [C8_WITHIN_S])).rows[0];
    const orphan = (await o.pool.query(
      `select count(*) as n, min(b.number) as first from blocks b
        where b.attempt_id is null and b.record_time < now() - make_interval(secs => $1) and b.record_time >= (select min(started_at) from producer_runs)`, [C8_WITHIN_S])).rows[0];
    const m = Number(missing.n), w = Number(orphan.n);
    const why: string[] = [];
    if (m > 0) why.push(`${m} blocks the producer says committed have no update in the index after ${C8_WITHIN_S} s (the first is block ${missing.first})`);
    if (w > 0) why.push(`${w} indexed blocks have no committed attempt in the journal (the first is block ${orphan.first}): another producer, or a lost journal`);
    return { id: "C8", status: why.length ? "degraded" : "ok", value: { committedWithoutUpdate: m, blocksWithoutAttempt: w }, threshold, detail: why.join("; ") || null };
  }

  async function c9(): Promise<HealthRow> {
    const r = await o.pool.query(
      `select a.number, extract(epoch from (a.answered_at - u.record_time)) * 1000 as ms from block_attempts a join canton_updates u on u.update_id = a.update_id
        where a.outcome = 'committed' and a.answered_at is not null order by a.answered_at desc limit 100`);
    let worst: { number: number; ms: number } | null = null;
    for (const x of r.rows) if (worst === null || Number(x.ms) < worst.ms) worst = { number: Number(x.number), ms: Math.round(Number(x.ms)) };
    const bad = worst !== null && worst.ms < -C9_TOLERANCE_MS;
    return { id: "C9", status: bad ? "degraded" : "ok", value: { worstMs: worst?.ms ?? null, checked: r.rowCount }, threshold: { toleranceMs: C9_TOLERANCE_MS },
      detail: bad ? `block ${worst!.number}: the producer's answer is ${-worst!.ms} ms before Canton's record time, so one of the two clocks is wrong` : null };
  }

  /** Runs the checks and writes their rows. C8 runs every 10 s (or at once with `force`), the others every call. */
  async function run(journalAvailable: boolean, force = false): Promise<void> {
    const rows = [...(await producerRows()), await c9()];
    if (force || now() - lastC8 >= C8_EVERY_MS) {
      lastC8 = now();
      rows.push(await c8(journalAvailable));
    }
    await setHealth(o.pool, rows);
  }

  return { run };
}
