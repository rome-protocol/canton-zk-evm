import type { Pool } from "pg";
import { TWIN_FLAGS, TWIN_FROM } from "./leg-canton.ts";

/** The most blocks one pass counts, so that a pass is a bounded read of the legs (by block) and not a scan. */
export const TWIN_BATCH_BLOCKS = 5000;

/**
 * Counts the twin legs into `twin_totals`, once per leg: for each pinned twin token, the sum and the number of the legs that locked it into a registered vault and of those a registered vault released.
 * A pass counts the blocks after `meta.twin_totals_block` up to the newest block whose legs are all indexed (the newest indexed block, or the progress of the slowest registered gateway, whichever is
 * less), at most `batch` blocks, in one transaction with the cursor, so a pass that stops anywhere is run again from the cursor. A token page then reads one row, however many legs the token has.
 * With no vault or no pinned twin registered nothing is counted. The sums are forgotten (`resetTwinTotals`) when a vault or a pin is added and when a block is indexed again, and counted again from the first block.
 * Returns the blocks passed over.
 */
export async function twinTotalsOnce(pool: Pick<Pool, "connect" | "query">, batch = TWIN_BATCH_BLOCKS): Promise<{ blocks: number }> {
  const [state] = (await pool.query(
    `select (select coalesce(max(number), 0) from blocks) as head, (select min(legs_cursor) from canton_registry where kind = 'gateway') as slowest,
       (select count(*) from canton_registry where kind = 'vault') as vaults, (select count(*) from canton_twins) as pins,
       (select value from meta where key = 'twin_totals_block') as done`,
  )).rows;
  if (Number(state.vaults) === 0 || Number(state.pins) === 0) return { blocks: 0 };
  const from = state.done === null ? 0 : Number(state.done);
  const to = Math.min(Number(state.head), state.slowest === null ? Infinity : Number(state.slowest), from + batch);
  if (to <= from) return { blocks: 0 };
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      `insert into twin_totals (token, locked, released, locks, releases)
       select token, coalesce(sum(amount) filter (where is_lock), 0), coalesce(sum(amount) filter (where is_release), 0), count(*) filter (where is_lock), count(*) filter (where is_release)
         from (select g.token, g.amount, ${TWIN_FLAGS} from (select * from gateway_legs where kind = 3 and block_number > $1 and block_number <= $2) g ${TWIN_FROM}) x
        where is_lock or is_release group by token
       on conflict (token) do update set locked = twin_totals.locked + excluded.locked, released = twin_totals.released + excluded.released,
         locks = twin_totals.locks + excluded.locks, releases = twin_totals.releases + excluded.releases`,
      [from, to],
    );
    await c.query("insert into meta (key, value) values ('twin_totals_block', $1) on conflict (key) do update set value = excluded.value", [String(to)]);
    await c.query("commit");
    return { blocks: to - from };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
