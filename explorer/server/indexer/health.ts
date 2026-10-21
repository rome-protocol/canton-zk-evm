import type { Pool, PoolClient } from "pg";

export type Status = "ok" | "degraded" | "down";

export interface HealthRow { id: string; status: Status; value?: unknown; detail?: string | null }

const UPSERT = `
  insert into health_checks (check_id, status, value, changed_at, checked_at, detail)
  select r.id, r.status, r.value::jsonb, now(), now(), r.detail from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as r(id, status, value, detail)
  on conflict (check_id) do update set status = excluded.status, value = excluded.value, detail = excluded.detail, checked_at = excluded.checked_at,
    changed_at = case when health_checks.status = excluded.status then health_checks.changed_at else excluded.changed_at end`;

/** Writes the rows of health_checks, in the caller's transaction when given a client. `changed_at` moves only when the status does. */
export async function setHealth(db: Pool | PoolClient, rows: HealthRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.query(UPSERT, [
    rows.map((r) => r.id), rows.map((r) => r.status), rows.map((r) => (r.value === undefined ? null : JSON.stringify(r.value))), rows.map((r) => r.detail ?? null),
  ]);
}

/** Sets back to `ok` the rows among `ids` that a stop left `down`, in the caller's transaction when given a client. A row that does not exist stays absent. */
export async function clearStops(db: Pool | PoolClient, ids: string[]): Promise<void> {
  await db.query("update health_checks set status = 'ok', value = null, detail = null, changed_at = now(), checked_at = now() where check_id = any($1::text[]) and status = 'down'", [ids]);
}
