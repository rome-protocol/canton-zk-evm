/**
 * The five big tables are range-partitioned by block number, in partitions of one fixed width. The width is chosen once, on the
 * first run, and kept in meta as partition_width: a reindex by range and the load test must always see the same partitions, so a
 * different width asked for later is refused. The maintenance makes every partition from block 0 to the head, and two more ahead
 * of it, so that an insert never meets a block number with no partition. Old partitions are left alone.
 */
import type { Pool, PoolClient } from "pg";

export const PARTITIONED_TABLES = ["transactions", "tx_traces", "logs", "internal_calls", "token_transfers"] as const;
export const DEFAULT_PARTITION_WIDTH = 250_000;
export const PARTITIONS_AHEAD = 2;

type Db = Pool | PoolClient;

export function partitionName(table: string, index: number): string {
  return `${table}_p${String(index).padStart(6, "0")}`;
}

/** Records the width on the first call and returns the recorded one; a later call with another width throws. */
export async function recordPartitionWidth(db: Db, width: number = DEFAULT_PARTITION_WIDTH): Promise<number> {
  if (!Number.isSafeInteger(width) || width < 1) throw new Error(`the partition width must be a whole number of blocks, not ${width}`);
  await db.query("insert into meta (key, value) values ('partition_width', $1) on conflict (key) do nothing", [String(width)]);
  const { rows } = await db.query<{ value: string }>("select value from meta where key = 'partition_width'");
  const recorded = Number(rows[0]?.value);
  if (recorded !== width) {
    throw new Error(`the partitions were made ${recorded} blocks wide and the width is fixed once: ${width} was asked for`);
  }
  return recorded;
}

/** Makes the partitions that are missing, and returns their names. `width` only matters on the first call. */
export async function ensurePartitions(db: Db, opts: { head: number; width?: number }): Promise<string[]> {
  if (!Number.isSafeInteger(opts.head) || opts.head < 0) throw new Error(`the head must be a block number, not ${opts.head}`);
  const width = await recordPartitionWidth(db, opts.width);
  const last = Math.floor(opts.head / width) + PARTITIONS_AHEAD;
  const { rows } = await db.query<{ relname: string }>(
    "select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent where p.relname = any($1)",
    [[...PARTITIONED_TABLES]],
  );
  const have = new Set(rows.map((r) => r.relname));
  const made: string[] = [];
  for (let index = 0; index <= last; index++) {
    for (const table of PARTITIONED_TABLES) {
      const name = partitionName(table, index);
      if (have.has(name)) continue;
      // Names and numbers only, made here: nothing from outside reaches the statement.
      await db.query(`create table if not exists ${name} partition of ${table} for values from (${index * width}) to (${(index + 1) * width})`);
      made.push(name);
    }
  }
  return made;
}
