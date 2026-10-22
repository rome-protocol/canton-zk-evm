/**
 * C6, the audit (design section 4.5): blocks fetched again from reth and compared with what the index holds (hash, transaction count, gas used and
 * log count). Every 10 minutes it looks at 20 random indexed blocks, and every night at the whole previous day. A block that disagrees is named
 * in the row, which is `degraded`, and it is looked at again by every later run, so a sample that happens to miss it does not turn the row ok:
 * the row follows what it measures, and goes back to ok when every block it has named agrees again.
 */
import type { Pool } from "pg";
import type { FinalReads } from "./reads.ts";
import { setHealth, type HealthRow } from "./health.ts";

export const SAMPLE_SIZE = 20;
export interface Mismatch { block: number; what: string }

type AuditReads = Pick<FinalReads, "block" | "receipts">;

interface Stored { hash: Buffer; tx_count: number; gas_used: string; log_count: number }

/** Compares block `n` with reth's copy. Null when they agree. */
export async function auditBlock(pool: Pool, reads: AuditReads, n: number): Promise<Mismatch | null> {
  const stored = (await pool.query("select hash, tx_count, gas_used, log_count from blocks where number = $1", [n])).rows[0] as Stored | undefined;
  if (!stored) return { block: n, what: "the index does not hold it" };
  const [block, receipts] = await Promise.all([reads.block(n), reads.receipts(n)]);
  if (!block) return { block: n, what: "reth does not have it" };
  if (!receipts) return { block: n, what: "reth has no receipts for it" };
  const diffs: string[] = [];
  const hash = "0x" + stored.hash.toString("hex");
  if (hash !== block.hash) diffs.push(`hash ${hash} in the index, ${block.hash} in reth`);
  if (stored.tx_count !== block.transactions.length) diffs.push(`${stored.tx_count} transactions in the index, ${block.transactions.length} in reth`);
  if (Number(stored.gas_used) !== block.gasUsed) diffs.push(`gas used ${stored.gas_used} in the index, ${block.gasUsed} in reth`);
  const logs = receipts.reduce((sum, r) => sum + r.logs.length, 0);
  if (stored.log_count !== logs) diffs.push(`${stored.log_count} logs in the index, ${logs} in reth`);
  return diffs.length === 0 ? null : { block: n, what: diffs.join("; ") };
}

/** Up to `count` distinct block numbers drawn evenly from 1 to the head (all of them when the head is not above `count`). */
export function sampleNumbers(head: number, count: number, random: () => number): number[] {
  if (head <= count) return Array.from({ length: head }, (_, i) => i + 1);
  const picked = new Set<number>();
  while (picked.size < count) picked.add(1 + Math.floor(random() * head));
  return [...picked].sort((a, b) => a - b);
}

/** The blocks named by the last run that found a disagreement, kept in the row's value. */
async function suspects(pool: Pool): Promise<number[]> {
  const r = await pool.query("select value from health_checks where check_id = 'C6'");
  const v = r.rows[0]?.value as { suspect?: unknown } | null | undefined;
  return Array.isArray(v?.suspect) ? (v.suspect as unknown[]).filter((x): x is number => Number.isSafeInteger(x)) : [];
}

export type AuditKind = "sample" | "day";
/** A run's row, and whether every block it chose was read from reth (a mismatch is still a complete run; an unreachable reth is not). */
export type AuditResult = HealthRow & { complete: boolean };
/** The blocks of a nightly run are those with a header time in `[from, to)`. */
export interface AuditWindow { from: Date; to: Date }

const DAY_MS = 86_400_000;
const MAX_CATCH_UP_DAYS = 7;
const startOfDay = (at: Date): number => Math.floor(at.getTime() / DAY_MS) * DAY_MS;

/**
 * What the nightly run at `at` looks at: the whole UTC day before today, and, when the indexer missed nights (it was down, or a run could not read
 * reth), every day since the last run, up to a week.
 */
export async function nightlyWindow(pool: Pool, at: Date): Promise<AuditWindow> {
  const to = startOfDay(at);
  const r = await pool.query("select value from meta where key = 'c6_nightly'");
  const last = r.rowCount ? Date.parse(String(r.rows[0].value)) : NaN;
  // A run on day D looked at everything before D 00:00, so the next one starts there.
  const from = Number.isFinite(last) ? Math.max(last, to - MAX_CATCH_UP_DAYS * DAY_MS) : to - DAY_MS;
  return { from: new Date(Math.min(from, to - DAY_MS)), to: new Date(to) };
}

/**
 * One run of C6: `sample` looks at 20 random blocks, `day` at every block of the window (by the header's time; the previous UTC day by default), and
 * each also at every block an earlier run named. Writes the row and returns it. A read of reth that fails makes the row `degraded` with the error and keeps the blocks it had named.
 */
export async function runAudit(pool: Pool, reads: AuditReads, kind: AuditKind, random: () => number = Math.random, count = SAMPLE_SIZE, window?: AuditWindow): Promise<AuditResult> {
  const named = await suspects(pool);
  const head = Number((await pool.query("select coalesce(max(number), 0) as n from blocks")).rows[0].n);
  const wanted = kind === "sample"
    ? sampleNumbers(head, count, random)
    : await (async () => {
      const w = window ?? await nightlyWindow(pool, new Date());
      return (await pool.query("select number from blocks where timestamp >= $1 and timestamp < $2 order by number", [w.from, w.to])).rows.map((r) => Number(r.number));
    })();
  const numbers = [...new Set([...wanted, ...named])].sort((a, b) => a - b);
  const bad: Mismatch[] = [];
  try {
    const WIDTH = 4;
    for (let i = 0; i < numbers.length; i += WIDTH) {
      const found = await Promise.all(numbers.slice(i, i + WIDTH).map((n) => auditBlock(pool, reads, n)));
      for (const m of found) if (m) bad.push(m);
    }
  } catch (e) {
    const row: HealthRow = { id: "C6", status: "degraded", value: { kind, checked: numbers.length, suspect: [...new Set([...named, ...bad.map((m) => m.block)])] },
      threshold: { sample: count, window: "previous UTC day" }, detail: `the audit could not read reth: ${(e as Error).message}` };
    await setHealth(pool, [row]);
    return { ...row, complete: false };
  }
  const row: HealthRow = {
    id: "C6", status: bad.length > 0 ? "degraded" : "ok",
    value: { kind, checked: numbers.length, mismatches: bad, suspect: bad.map((m) => m.block) }, threshold: { sample: count, window: "previous UTC day" },
    detail: bad.length > 0 ? `block ${bad[0]!.block} disagrees with reth: ${bad[0]!.what}${bad.length > 1 ? ` (and ${bad.length - 1} more: ${bad.slice(1, 6).map((m) => m.block).join(", ")})` : ""}` : null,
  };
  await setHealth(pool, [row]);
  return { ...row, complete: true };
}

/** The UTC day (YYYY-MM-DD) of the last nightly run, kept in `meta`; the nightly run is due once the hour is past `hour` and today has none. */
export async function nightlyDue(pool: Pool, at: Date, hour = 3): Promise<boolean> {
  if (at.getUTCHours() < hour) return false;
  const r = await pool.query("select value from meta where key = 'c6_nightly'");
  return !r.rowCount || r.rows[0].value !== at.toISOString().slice(0, 10);
}

export async function markNightly(pool: Pool, at: Date): Promise<void> {
  await pool.query("insert into meta (key, value) values ('c6_nightly', $1) on conflict (key) do update set value = excluded.value", [at.toISOString().slice(0, 10)]);
}
