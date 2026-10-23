/**
 * How many transactions the chain holds: the day rollups' sum through their cursor, plus the transactions of the final blocks newer than the cursor.
 * The newest block is the one of the latest record time, the axis the rollups and the tail are cut on (the number rises with it on a real chain). One statement, so the two halves come from one snapshot. Neither half is a count over the transactions: the rollups are a few hundred rows however long the chain
 * is, and the tail is a range of the record-time index, a few minutes of blocks while the rollups run.
 */

export type TxTotalQuery = (sql: string) => Promise<Array<Record<string, any>>>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The most the cursor may trail the newest block for the tail to be counted. Past it the rollups are not keeping up (a first build, a rebuild, a stopped indexer) and the total is not given. */
export const TAIL_MAX_MS = 60 * 60_000;

/** `asOfBlock` is the newest final block the total holds; `asOf` is its record time (epoch ms). */
export interface TxTotal { total: number; asOfBlock: number; asOf: number }

/**
 * The live transactions and the test runs' together, as the lists hold both. Null when the rollups cannot say: none has run, the first day they hold is after the first
 * block's day, their cursor trails the newest block by more than TAIL_MAX_MS, or no block is indexed.
 */
export async function txTotal(query: TxTotalQuery): Promise<TxTotal | null> {
  const [r] = await query(
    `with cur as (select position::bigint as p from cursors where stream = 'stats_rollup'),
          newest as (select number, record_time from blocks order by record_time desc, number desc limit 1)
     select (select coalesce(sum(txs::bigint + test_txs), 0)::float8 from stats_day) as n,
            (select extract(epoch from min(bucket))::float8 * 1000 from stats_day) as since,
            (select extract(epoch from min(record_time))::float8 * 1000 from blocks) as first,
            (select p::float8 from cur) as at,
            (select number::float8 from newest) as newest_number,
            (select extract(epoch from record_time)::float8 * 1000 from newest) as newest_at,
            case when (select extract(epoch from record_time)::float8 * 1000 from newest) - (select p from cur) <= ${TAIL_MAX_MS}
                 then (select coalesce(sum(tx_count), 0)::float8 from blocks where record_time >= timestamptz 'epoch' + (select p from cur) * interval '1 millisecond')
            end as tail`);
  if (!r || r.since === null || r.at === null || r.newest_number === null || r.tail === null) return null;
  const first = r.first === null ? Infinity : Number(r.first);
  if (Number(r.since) > Math.floor(first / 86_400_000) * 86_400_000) return null;
  return { total: Number(r.n) + Number(r.tail), asOfBlock: Number(r.newest_number), asOf: Number(r.newest_at) };
}
