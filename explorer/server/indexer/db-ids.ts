/**
 * db_ids: how much of each id column's range the database has used. A column that counts up (an identity or serial column) stops the indexer
 * when it reaches the largest value its type holds, so the row warns well before: `degraded` above 50% for any one of them, and `down` above
 * 90%, which turns the uptime check on `/api/health` red.
 */
import type { Pool } from "pg";
import type { HealthRow } from "./health.ts";

export const IDS_DEGRADED = 0.5;
export const IDS_DOWN = 0.9;

export interface IdUse { table: string; column: string; used: number; max: number }

/** Every identity or serial sequence of the explorer's schema with its table, column, last value handed out and largest value it can reach. */
export async function readIdUse(pool: Pool): Promise<IdUse[]> {
  const { rows } = await pool.query(`
    select t.relname as "table", a.attname as "column", coalesce(pg_sequence_last_value(c.oid), 0)::text as used, sq.seqmax::text as max
    from pg_sequence sq
    join pg_class c on c.oid = sq.seqrelid
    join pg_depend d on d.objid = c.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
    join pg_class t on t.oid = d.refobjid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where c.relnamespace = current_schema()::regnamespace`);
  return rows.map((r) => ({ table: r.table as string, column: r.column as string, used: Number(r.used), max: Number(r.max) }));
}

const percent = (u: IdUse) => Math.round((u.used / u.max) * 1000) / 10;

/** The db_ids row for the sequences read: the status follows the fullest one, the value lists the highest few. */
export function idsRow(uses: IdUse[]): HealthRow {
  const sorted = [...uses].sort((a, b) => b.used / b.max - a.used / a.max);
  const top = sorted[0];
  const worst = top ? top.used / top.max : 0;
  const status = worst > IDS_DOWN ? "down" : worst > IDS_DEGRADED ? "degraded" : "ok";
  return {
    id: "db_ids", status,
    value: { highest: sorted.slice(0, 3).map((u) => ({ table: u.table, column: u.column, used: u.used, max: u.max, percent: percent(u) })), counted: uses.length },
    threshold: { degradedPercent: IDS_DEGRADED * 100, downPercent: IDS_DOWN * 100 },
    detail: top && status !== "ok" ? `${top.table}.${top.column} has used ${percent(top)}% of its ids (${top.used} of ${top.max}); the indexer stops when they run out` : null,
  };
}

export async function checkIds(pool: Pool): Promise<HealthRow> {
  return idsRow(await readIdUse(pool));
}
