import type { Pool } from "pg";
import type { FinalReads } from "./reads.ts";
import { TWIN_FLAGS, TWIN_FROM } from "./leg-canton.ts";
import { SELECTORS, tryCall } from "./tokens.ts";

/** The most blocks one pass counts, so that a pass is a bounded read of the legs (by block) and not a scan. */
export const TWIN_BATCH_BLOCKS = 5000;

/**
 * Counts the twin legs into `twin_totals`, once per leg (and writes each lock and release to `twin_legs`, which the list of the newest ones reads by its key): for each pinned twin token, the sum and the number of the legs that locked it into a registered vault and of those a registered vault released.
 * A pass counts the blocks after `meta.twin_totals_block` up to the newest block whose legs are all indexed (the newest indexed block, or the progress of the slowest registered gateway, whichever is
 * less), at most `batch` blocks, in one transaction with the cursor, so a pass that stops anywhere is run again from the cursor. A token page then reads one row, however many legs the token has.
 * With no vault or no pinned twin registered nothing is counted. The sums are forgotten (`resetTwinTotals`) when a vault, a pin or a gateway is added or removed and when a block is indexed again, and counted again from the first block.
 * What the registered vaults hold of each pinned token is read from reth at the block the pass counts to (`to`), and written with the sums in the same transaction, so that the twin's supply and the vaults'
 * balance are two numbers of one block, never one of the index's live balances against sums that trail it. It is read only by the pass that reaches the end (a pass that stops at its batch writes none: it
 * is not the block that is shown, and reth is not asked about an old block for nothing). A token that does not answer leaves it null. Returns the blocks passed over.
 */
export async function twinTotalsOnce(pool: Pick<Pool, "connect" | "query">, reads: Pick<FinalReads, "call">, batch = TWIN_BATCH_BLOCKS): Promise<{ blocks: number }> {
  const [state] = (await pool.query(
    `select (select coalesce(max(number), 0) from blocks) as head, (select min(legs_cursor) from canton_registry where kind = 'gateway') as slowest,
       (select count(*) from canton_registry where kind = 'vault') as vaults, (select count(*) from canton_twins) as pins,
       (select value from meta where key = 'twin_totals_block') as done`,
  )).rows;
  if (Number(state.vaults) === 0 || Number(state.pins) === 0) return { blocks: 0 };
  const from = state.done === null ? 0 : Number(state.done);
  const to = Math.min(Number(state.head), state.slowest === null ? Infinity : Number(state.slowest), from + batch);
  if (to <= from) return { blocks: 0 };
  const atEnd = from + batch >= Math.min(Number(state.head), state.slowest === null ? Infinity : Number(state.slowest));
  const pins = (await pool.query("select token from canton_twins order by token")).rows.map((r) => r.token as Buffer);
  const vaults = (await pool.query("select encode(address, 'hex') as a from canton_registry where kind = 'vault' order by address")).rows.map((r) => r.a as string);
  const balances = await Promise.all(pins.map(async (t) => {
    if (!atEnd) return null;
    const parts = await Promise.all(vaults.map(async (v) => {
      const out = await tryCall(reads, "0x" + t.toString("hex"), SELECTORS.balanceOf + "0".repeat(24) + v, to);
      return out !== null && /^0x[0-9a-f]{64}$/.test(out) ? BigInt(out) : null;
    }));
    let sum = 0n;
    for (const p of parts) { if (p === null) return null; sum += p; }
    return sum.toString();
  }));
  const c = await pool.connect();
  try {
    await c.query("begin");
    // One read of the legs, sorted once into locks and releases: it is written as the legs (`twin_legs`) and counted into the sums, in this one statement.
    await c.query(
      `with x as materialized (
         select g.block_number, g.leg_index, g.token, g.amount, ${TWIN_FLAGS}
           from (select * from gateway_legs where kind = 3 and block_number > $1 and block_number <= $2) g ${TWIN_FROM}
       ), legs as (
         insert into twin_legs (block_number, leg_index, is_release) select block_number, leg_index, is_release from x where is_lock or is_release
       )
       insert into twin_totals (token, locked, released, locks, releases)
       select token, coalesce(sum(amount) filter (where is_lock), 0), coalesce(sum(amount) filter (where is_release), 0), count(*) filter (where is_lock), count(*) filter (where is_release)
         from x where is_lock or is_release group by token
       on conflict (token) do update set locked = twin_totals.locked + excluded.locked, released = twin_totals.released + excluded.released,
         locks = twin_totals.locks + excluded.locks, releases = twin_totals.releases + excluded.releases`,
      [from, to],
    );
    await c.query(
      `insert into twin_totals (token, vault_balance) select t.token, t.v::numeric from unnest($1::bytea[], $2::text[]) as t(token, v)
       on conflict (token) do update set vault_balance = excluded.vault_balance`,
      [pins, balances],
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
