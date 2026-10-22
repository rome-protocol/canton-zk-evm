/**
 * The reindex's last step (design section 4.4): every aggregate row a range of blocks touches is worked out again from all of that row's facts, never by
 * incrementing: the address counters and first and last blocks, the contracts' interaction counts, the tokens' transfer and holder counts, the derived
 * token balances and the NFT owners. Only facts up to the derive cursor count, because stage 2 has not counted the blocks after it (it will).
 * The balances that are read from reth are not worked out here: the rows the range touches are marked unchecked (`checked_block` null), the coin
 * balance history of the range is dropped, and the check's cursor goes back to the block before the range, so the background check reads them again.
 * Run twice over the same range it gives the same rows, and the rows are those stage 2 makes block by block.
 */
import type { PoolClient } from "pg";
import { legsSql } from "./tokens.ts";

/** The id a token's balance row is kept under: an ERC-1155's own, 0 for the other standards. */
const ID = "(case when s.standard = 'ERC-1155' then t.token_id else 0 end)";
const ZERO = "'\\x0000000000000000000000000000000000000000'::bytea";

/** The addresses the facts of blocks `$1` to `$2` name. */
const TOUCHED = `
  select from_address as a from transactions where block_number between $1 and $2
  union select coalesce(to_address, created_contract) from transactions where block_number between $1 and $2
  union select from_address from internal_calls where block_number between $1 and $2
  union select to_address from internal_calls where block_number between $1 and $2
  union select from_address from token_transfers where block_number between $1 and $2 and from_address <> ${ZERO}
  union select to_address from token_transfers where block_number between $1 and $2 and to_address <> ${ZERO}`;

/**
 * `full` is a reindex of every block (1 to the head): the rows no fact supports any more (a decoding rule changed, so a transfer or an account is gone)
 * are deleted first, so the tables are what the facts say outright. A range keeps the rows it does not name: the facts it replaced are already gone,
 * so it cannot tell which rows only they supported.
 */
export async function rebuildAggregates(c: Pick<PoolClient, "query">, from: number, to: number, derived: number, full = false): Promise<void> {
  const last = Math.min(to, derived);
  if (last < from) return;
  // The planner chooses the holder's indexes for the look-ups below only when it knows the table; a reindex is rare and the sample is cheap.
  await c.query("analyze token_transfers");
  // $1, $2: the range; $3: the facts that count.
  const range = [from, last, derived];

  if (full) {
    await c.query(`delete from nft_owners o where not exists (select 1 from token_transfers t where t.token = o.token and t.token_id = o.token_id)`);
    // A row stands while a transfer names its holder for its token, and for its id when the token is an ERC-1155 (the other tokens' rows have id 0).
    // The (token, holder, id) the transfers name are worked out once, so the anti-join hashes on all three.
    await c.query(
      `with live as materialized (
         select token, holder, tid from (
           select t.token, t.from_address as holder, ${ID} as tid from token_transfers t join tokens s on s.address = t.token
           union all select t.token, t.to_address, ${ID} from token_transfers t join tokens s on s.address = t.token
         ) q group by token, holder, tid)
       delete from token_balances b using tokens k where k.address = b.token
         and not exists (select 1 from live l where l.token = b.token and l.holder = b.holder and l.tid = b.token_id)`,
    );
    await c.query(
      `delete from addresses a where not exists (select 1 from transactions t where t.from_address = a.address or t.to_address = a.address or t.created_contract = a.address)
         and not exists (select 1 from internal_calls i where i.from_address = a.address or i.to_address = a.address)
         and not exists (select 1 from token_transfers t where a.address <> ${ZERO} and (t.from_address = a.address or t.to_address = a.address))`,
    );
  }

  await rebuildTokens(c, from, last, derived, full);

  // The addresses.
  await c.query(
    `insert into addresses (address, first_seen_block, last_active_block, sent_count, received_count, internal_count, token_transfer_count, is_contract)
     select a.a, least(f.first_tx, f.first_in, f.first_tt), greatest(f.last_tx, f.last_in, f.last_tt), f.sent, f.received, f.internal, f.transfers,
            exists (select 1 from contracts k where k.address = a.a)
     from (${TOUCHED}) a(a)
     cross join lateral (select
         (select count(*) from transactions where from_address = a.a and block_number <= $3) as sent,
         (select count(*) from transactions where to_address = a.a and block_number <= $3) + (select count(*) from transactions where created_contract = a.a and to_address is null and block_number <= $3) as received,
         (select count(*) from internal_calls where from_address = a.a and block_number <= $3) + (select count(*) from internal_calls where to_address = a.a and to_address <> from_address and block_number <= $3) as internal,
         (select count(*) from token_transfers where from_address = a.a and a.a <> ${ZERO} and block_number <= $3) + (select count(*) from token_transfers where to_address = a.a and a.a <> ${ZERO} and to_address <> from_address and block_number <= $3) as transfers,
         (select min(block_number) from (select min(block_number) as block_number from transactions where from_address = a.a union all select min(block_number) from transactions where to_address = a.a
            union all select min(block_number) from transactions where created_contract = a.a) q) as first_tx,
         (select max(block_number) from (select max(block_number) as block_number from transactions where from_address = a.a and block_number <= $3 union all select max(block_number) from transactions where to_address = a.a and block_number <= $3
            union all select max(block_number) from transactions where created_contract = a.a and block_number <= $3) q) as last_tx,
         (select min(block_number) from (select min(block_number) as block_number from internal_calls where from_address = a.a union all select min(block_number) from internal_calls where to_address = a.a) q) as first_in,
         (select max(block_number) from (select max(block_number) as block_number from internal_calls where from_address = a.a and block_number <= $3 union all select max(block_number) from internal_calls where to_address = a.a and block_number <= $3) q) as last_in,
         (select min(block_number) from (select min(block_number) as block_number from token_transfers where from_address = a.a and a.a <> ${ZERO} union all select min(block_number) from token_transfers where to_address = a.a and a.a <> ${ZERO}) q) as first_tt,
         (select max(block_number) from (select max(block_number) as block_number from token_transfers where from_address = a.a and a.a <> ${ZERO} and block_number <= $3 union all select max(block_number) from token_transfers where to_address = a.a and a.a <> ${ZERO} and block_number <= $3) q) as last_tt
     ) f where a.a is not null order by a.a
     on conflict (address) do update set first_seen_block = excluded.first_seen_block, last_active_block = excluded.last_active_block, sent_count = excluded.sent_count,
       received_count = excluded.received_count, internal_count = excluded.internal_count, token_transfer_count = excluded.token_transfer_count, is_contract = excluded.is_contract`,
    range,
  );

  // The contracts' interaction counts.
  await c.query(
    `update contracts k set interaction_count = t.n, last_interaction_block = t.last
     from (
       select k2.address, count(x.tx_index) as n, max(x.block_number) as last from contracts k2
       left join transactions x on x.to_address = k2.address and x.block_number <= $3 and (k2.creation_block is distinct from x.block_number or x.tx_index > k2.creation_tx_index)
       where k2.address in (select to_address from transactions where block_number between $1 and $2 and to_address is not null) or k2.creation_block between $1 and $2
       group by k2.address
     ) t where k.address = t.address`,
    range,
  );

  // The balances read from reth: the range's history is dropped and read again by a catch-up of its own, which does not move the check's live cursor
  // (a reindex of old blocks must not make it walk the whole later chain again). A full reindex starts the live walk over, since it rebuilt the addresses.
  await c.query("delete from coin_balance_history where block_number between $1 and $2", range.slice(0, 2));
  if (full) {
    await c.query("delete from cursors where stream in ('balances_redo', 'balances_redo_end')");
    await c.query("update cursors set position = 0 where stream = 'balances'");
    return;
  }
  const live = Number((await c.query("select position from cursors where stream = 'balances'")).rows[0]?.position ?? 0);
  const end = Math.min(last, live); // blocks the live walk has not reached are read by it when it gets there
  if (end >= from) {
    await c.query(
      `insert into cursors (stream, position, updated_at) values ('balances_redo', $1, now())
       on conflict (stream) do update set position = least(cursors.position, excluded.position), updated_at = excluded.updated_at`, [from - 1]);
    await c.query(
      `insert into cursors (stream, position, updated_at) values ('balances_redo_end', $1, now())
       on conflict (stream) do update set position = greatest(cursors.position, excluded.position), updated_at = excluded.updated_at`, [end]);
  }
}

/**
 * The tokens and the holders' balances of blocks `from` to `last`, worked out from the facts up to `derived`: the (token, holder, id) keys the range moves are
 * collected once, then each key's legs are summed through the holder's indexes and written in one upsert, so the time follows the range and the facts of the
 * keys and never the number of keys squared. Called by `rebuildAggregates`, and alone by the load test to time it.
 */
export async function rebuildTokens(c: Pick<PoolClient, "query">, from: number, last: number, derived: number, full: boolean): Promise<void> {
  const range = [from, last, derived];
  // The tokens and the holders' balances. The keys are the (token, holder, id) the range moves; each key's legs are looked up through the holder's
  // indexes, so the time follows the range and not the token's whole history.
  const keysOf = (mode: string) => `
    with keys as materialized (select token, holder, tid from (${legsSql("t.block_number between $1 and $2", mode as "derived" | "read")}) l group by token, holder, tid),
         pairs as materialized (select distinct token, holder from keys),
         -- Each (token, holder)'s legs are read once through the holder's indexes and grouped by id; the keys then pick their rows. (Joining the keys to the
         -- legs on token and holder only and checking the id after would read the holder's legs once for each of its ids.)
         sums as materialized (
           select token, holder, tid, sum(delta) as value, max(block) as updated from (
             select p.token, p.holder, ${ID} as tid, (case when s.standard = 'ERC-721' then 1 else t.amount end) as delta, t.block_number as block
             from pairs p join tokens s on s.address = p.token
             join token_transfers t on t.token = p.token and t.to_address = p.holder and t.block_number <= $3
             union all
             select p.token, p.holder, ${ID}, -(case when s.standard = 'ERC-721' then 1 else t.amount end), t.block_number
             from pairs p join tokens s on s.address = p.token
             join token_transfers t on t.token = p.token and t.from_address = p.holder and t.block_number <= $3
           ) q group by token, holder, tid
         ),
         tot as (select m.token, m.holder, m.tid, m.value, m.updated from sums m join keys k on k.token = m.token and k.holder = m.holder and k.tid = m.tid)`;
  await c.query(
    `${keysOf("derived")}
     insert into token_balances (token, holder, token_id, value, updated_block, checked_block, unanswered)
     select token, holder, tid, value, updated, null, false from tot order by token, holder, tid
     on conflict (token, holder, token_id) do update set value = excluded.value, updated_block = excluded.updated_block, checked_block = null, unanswered = false`,
    range,
  );
  // A token that is read, not added up, keeps its values until the check reads them again. The row's block is the last block that moved it, in the
  // range or after it, so a range that ends before the holder's last transfer does not set the block back.
  await c.query(
    `${keysOf("read")}
     insert into token_balances (token, holder, token_id, value, updated_block, checked_block, unanswered)
     select token, holder, tid, 0, updated, null, false from tot order by token, holder, tid
     on conflict (token, holder, token_id) do update set updated_block = greatest(token_balances.updated_block, excluded.updated_block), checked_block = null, unanswered = false`,
    range,
  );
  await c.query(
    `insert into nft_owners (token, token_id, owner, updated_block)
     select distinct on (t.token, t.token_id) t.token, t.token_id, t.to_address, t.block_number
     from token_transfers t join tokens k on k.address = t.token and k.standard = 'ERC-721'
     where t.block_number <= $3 and (t.token, t.token_id) in (select token, token_id from token_transfers where block_number between $1 and $2)
     order by t.token, t.token_id, t.block_number desc, t.log_index desc
     on conflict (token, token_id) do update set owner = excluded.owner, updated_block = excluded.updated_block`,
    range,
  );
  await c.query(
    `update tokens k set
       transfer_count = (select count(*) from token_transfers t where t.token = k.address and t.block_number <= $3),
       first_transfer_block = coalesce((select min(block_number) from token_transfers t where t.token = k.address and t.block_number <= $3), k.first_transfer_block),
       holder_count = (select count(distinct b.holder) from token_balances b where b.token = k.address and b.value > 0)
     where $4::boolean or k.address in (select token from token_transfers where block_number between $1 and $2)`,
    [from, last, derived, full],
  );
}
