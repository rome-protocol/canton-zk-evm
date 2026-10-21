/**
 * The steps a person takes by hand, never the indexer by itself (design section 4.4): `reset` wipes the explorer's own tables for a new
 * chain, and `reader-moved` records that the reader party is now hosted by another participant. `clear-check` sets C10 back to ok once a person has looked. Both reset and reader-moved take the indexer's advisory lock, so
 * neither runs while an indexer does.
 */
import type { Pool, PoolClient } from "pg";
import { FAUCET_LOCK, LOCKS, TRACKER_LOCK } from "../leader.ts";
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
 * The explorer's database is one with the migrations table and `meta`, and `meta` holds the partition width or the chain id. Anything else is
 * somebody else's database, or the wrong one, and nothing in it is touched.
 */
async function checkIsExplorer(c: PoolClient): Promise<void> {
  const have = await c.query("select to_regclass('schema_migrations') as m, to_regclass('meta') as t");
  const looks = have.rows[0].m !== null && have.rows[0].t !== null
    && (await c.query("select 1 from meta where key in ('partition_width', 'chain_id') limit 1")).rowCount! > 0;
  if (!looks) throw new Error("this database does not look like the explorer's (no migrations table, or no meta with the partition width or chain id): nothing was changed");
}

/**
 * The API's tracker and faucet loops write to the explorer's tables, and an instance left running would write the old chain's rows into the
 * wiped ones. Each loop's advisory lock is taken here, and a lock that is held means an API is up.
 */
async function takeApiLocks(c: PoolClient): Promise<number[]> {
  const taken: number[] = [];
  for (const [which, name] of [[TRACKER_LOCK, "tracker"], [FAUCET_LOCK, "faucet"]] as const) {
    if (!(await c.query("select pg_try_advisory_lock($1, $2) as ok", [LOCKS, which])).rows[0].ok) {
      for (const t of taken) await c.query("select pg_advisory_unlock($1, $2)", [LOCKS, t]);
      throw new Error(`an API instance holds this database's ${name} lock: stop the API first, then reset`);
    }
    taken.push(which);
  }
  return taken;
}

/**
 * Empties every table of the explorer except the list of applied migrations, and keeps `partition_width`, which is fixed once for the schema's
 * partitions. A new chain gets a fresh database: the pins are written again by the first start, and `chain_instance` by block 1. It refuses a
 * database that is not the explorer's, and while an indexer or an API (the tracker or faucet lock) is up: stop both first.
 */
export async function resetChain(pool: Pool): Promise<{ tables: number }> {
  return withLock(pool, async (c) => {
    await checkIsExplorer(c);
    const taken = await takeApiLocks(c);
    try {
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
    } finally {
      for (const t of taken) await c.query("select pg_advisory_unlock($1, $2)", [LOCKS, t]);
    }
  });
}

/**
 * Sets C10 back to `ok` once a person has looked at the block it names, and keeps who cleared it and which block it was in the row's value. C10 stays
 * degraded until then, by design: a block whose legs disagree is still one that disagrees. Only C10 can be cleared this way; every other row follows its check.
 */
export async function clearCheck(pool: Pool, id: string, by: string): Promise<void> {
  if (id !== "C10") throw new Error("only C10 can be cleared by hand; every other check follows what it measures");
  if (by.trim() === "") throw new Error("clear-check needs to know who clears it");
  const done = await pool.query(
    `update health_checks set status = 'ok', detail = null, changed_at = now(), checked_at = now(),
       value = jsonb_build_object('clearedBy', $1::text, 'clearedAt', now(), 'clearedBlock', value -> 'block')
     where check_id = 'C10' and status <> 'ok'`, [by]);
  if (!done.rowCount) throw new Error("C10 is not degraded, so there is nothing to clear");
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
