/**
 * The two steps a person takes by hand, never the indexer by itself (design section 4.4): `reset` wipes the explorer's own tables for a new
 * chain, and `reader-moved` records that the reader party is now hosted by another participant. Both take the indexer's advisory lock, so
 * neither runs while an indexer does.
 */
import type { Pool, PoolClient } from "pg";
import { LOCK_KEY } from "./indexer.ts";

async function withLock<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    if (!(await c.query("select pg_try_advisory_lock($1) as ok", [LOCK_KEY])).rows[0].ok) {
      throw new Error("an indexer holds this database's lock: stop it first");
    }
    try {
      return await fn(c);
    } finally {
      await c.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    c.release();
  }
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Empties every table of the explorer except the list of applied migrations, and keeps `partition_width`, which is fixed once for the schema's
 * partitions. A new chain gets a fresh database: the pins are written again by the first start, and `chain_instance` by block 1.
 */
export async function resetChain(pool: Pool): Promise<{ tables: number }> {
  return withLock(pool, async (c) => {
    const found = await c.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema() and c.relkind in ('r', 'p') and not c.relispartition and c.relname <> 'schema_migrations' order by c.relname`);
    const tables: string[] = found.rows.map((r) => r.relname as string);
    await c.query("begin");
    try {
      const width = (await c.query("select value from meta where key = 'partition_width'")).rows[0]?.value as string | undefined;
      await c.query(`truncate table ${tables.map(quote).join(", ")} restart identity`);
      if (width !== undefined) await c.query("insert into meta (key, value) values ('partition_width', $1)", [width]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
    return { tables: tables.length };
  });
}

export interface ReaderMove { from: string; to: string; lastOffset: number; head: number }

/**
 * Records that the reader party moved to another participant: the new participant is added to `canton_participants` and the old one's last
 * offset kept, the move goes into `meta` (the old participant's last offset, the block head and the time), and the reader cursor is set to the
 * new participant's start. The indexer then reads the new participant from its start and expects the next record to be head + 1.
 */
export async function readerMoved(pool: Pool, participant: string): Promise<ReaderMove> {
  if (participant.trim() === "") throw new Error("reader-moved needs the new participant id");
  return withLock(pool, async (c) => {
    await c.query("begin");
    try {
      const cursor = await c.query("select position, detail from cursors where stream = 'reader_updates' for update");
      const from = cursor.rows[0]?.detail?.participant as string | undefined;
      if (!from) throw new Error("nothing has been read yet, so there is no participant to move from");
      if (from === participant) throw new Error(`the reader is on participant ${participant} already`);
      const lastOffset = Number(cursor.rows[0].position);
      const head = Number((await c.query("select coalesce(max(number), 0) as n from blocks")).rows[0].n);
      await c.query("update canton_participants set last_offset = $2, moved_out_at = now() where participant_id = $1", [from, lastOffset]);
      await c.query(
        `insert into canton_participants (participant_id, first_offset, moved_in_at) values ($1, 0, now())
         on conflict (participant_id) do update set first_offset = 0, last_offset = null, moved_in_at = now(), moved_out_at = null`, [participant]);
      const seq = Number((await c.query("select count(*) as n from meta where key like 'reader\\_move\\_%'")).rows[0].n) + 1;
      const move: ReaderMove & { at: string } = { from, to: participant, lastOffset, head, at: new Date().toISOString() };
      await c.query("insert into meta (key, value) values ($1, $2)", [`reader_move_${seq}`, JSON.stringify(move)]);
      await c.query("insert into meta (key, value) values ('reader_participant', $1) on conflict (key) do update set value = excluded.value", [participant]);
      await c.query("update cursors set position = 0, detail = $1, updated_at = now() where stream = 'reader_updates'", [JSON.stringify({ participant, block: head })]);
      await c.query("commit");
      return { from, to: participant, lastOffset, head };
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
  });
}
