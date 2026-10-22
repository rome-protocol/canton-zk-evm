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

const ZERO = "'\\x0000000000000000000000000000000000000000'::bytea";

/** The addresses the facts of blocks `$1` to `$2` name. */
const TOUCHED = `
  select from_address as a from transactions where block_number between $1 and $2
  union select coalesce(to_address, created_contract) from transactions where block_number between $1 and $2
  union select from_address from internal_calls where block_number between $1 and $2
  union select to_address from internal_calls where block_number between $1 and $2
  union select from_address from token_transfers where block_number between $1 and $2 and from_address <> ${ZERO}
  union select to_address from token_transfers where block_number between $1 and $2 and to_address <> ${ZERO}`;

export async function rebuildAggregates(c: Pick<PoolClient, "query">, from: number, to: number, derived: number): Promise<void> {
  const last = Math.min(to, derived);
  if (last < from) return;
  // $1, $2: the range; $3: the facts that count.
  const range = [from, last, derived];

  // The tokens and the holders' balances.
  await c.query(
    `with keys as (select token, holder, tid from (${legsSql("t.block_number between $1 and $2", "derived")}) l group by token, holder, tid),
          tot as (
            select l.token, l.holder, l.tid, sum(l.delta) as value, max(l.block) as updated
            from (${legsSql("t.block_number <= $3 and t.token in (select token from token_transfers where block_number between $1 and $2)", "derived")}) l
            join keys on keys.token = l.token and keys.holder = l.holder and keys.tid = l.tid group by l.token, l.holder, l.tid
          )
     insert into token_balances (token, holder, token_id, value, updated_block, checked_block)
     select token, holder, tid, value, updated, null from tot order by token, holder, tid
     on conflict (token, holder, token_id) do update set value = excluded.value, updated_block = excluded.updated_block, checked_block = null`,
    range,
  );
  // A token that is read, not added up, keeps its values until the check reads them again.
  await c.query(
    `insert into token_balances (token, holder, token_id, value, updated_block, checked_block)
     select token, holder, tid, 0, max(block), null from (${legsSql("t.block_number between $1 and $2", "read")}) l group by token, holder, tid order by token, holder, tid
     on conflict (token, holder, token_id) do update set updated_block = excluded.updated_block, checked_block = null`,
    range.slice(0, 2),
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
       holder_count = (select count(*) from token_balances b where b.token = k.address and b.value > 0)
     where k.address in (select token from token_transfers where block_number between $1 and $2)`,
    [from, last, derived],
  );

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
         (select count(*) from token_transfers where from_address = a.a and block_number <= $3) + (select count(*) from token_transfers where to_address = a.a and to_address <> from_address and block_number <= $3) as transfers,
         (select min(block_number) from (select min(block_number) as block_number from transactions where from_address = a.a union all select min(block_number) from transactions where to_address = a.a
            union all select min(block_number) from transactions where created_contract = a.a) q) as first_tx,
         (select max(block_number) from (select max(block_number) as block_number from transactions where from_address = a.a and block_number <= $3 union all select max(block_number) from transactions where to_address = a.a and block_number <= $3
            union all select max(block_number) from transactions where created_contract = a.a and block_number <= $3) q) as last_tx,
         (select min(block_number) from (select min(block_number) as block_number from internal_calls where from_address = a.a union all select min(block_number) from internal_calls where to_address = a.a) q) as first_in,
         (select max(block_number) from (select max(block_number) as block_number from internal_calls where from_address = a.a and block_number <= $3 union all select max(block_number) from internal_calls where to_address = a.a and block_number <= $3) q) as last_in,
         (select min(block_number) from (select min(block_number) as block_number from token_transfers where from_address = a.a union all select min(block_number) from token_transfers where to_address = a.a) q) as first_tt,
         (select max(block_number) from (select max(block_number) as block_number from token_transfers where from_address = a.a and block_number <= $3 union all select max(block_number) from token_transfers where to_address = a.a and block_number <= $3) q) as last_tt
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

  // The balances read from reth: the range's history is dropped, and the check goes back over the range.
  await c.query("delete from coin_balance_history where block_number between $1 and $2", range.slice(0, 2));
  await c.query("update cursors set position = least(position, $1) where stream = 'balances'", [from - 1]);
}
