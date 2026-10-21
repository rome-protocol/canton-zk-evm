/**
 * The address counters (design section 5.2): for every account a block touched, the transactions it sent and received, the internal calls it is in,
 * its first and last block, and whether it is a contract. The counters add up, so they are written by stage 2 once for each block, behind the derive
 * cursor's guard; a reindex rebuilds them from the fact tables, where each is a plain count.
 */
import type { PoolClient } from "pg";

/**
 * Adds block `n`'s counts, from the rows stage 1 and stage 2 have written for it (so it runs after them). A transaction counts for its sender and for
 * the account it was sent to, or, for a creation, for the contract it made. An internal call counts once for each of its two accounts, once when they
 * are the same, failed or not, as it is listed.
 */
export async function countAddresses(c: Pick<PoolClient, "query">, n: number): Promise<void> {
  await c.query(
    `with touched(a, s, r, i) as (
       select from_address, 1, 0, 0 from transactions where block_number = $1
       union all select coalesce(to_address, created_contract), 0, 1, 0 from transactions where block_number = $1 and coalesce(to_address, created_contract) is not null
       union all select from_address, 0, 0, 1 from internal_calls where block_number = $1
       union all select to_address, 0, 0, 1 from internal_calls where block_number = $1 and to_address is not null and to_address <> from_address
     ), total as (select a, sum(s) as s, sum(r) as r, sum(i) as i from touched group by a)
     insert into addresses (address, first_seen_block, last_active_block, sent_count, received_count, internal_count, is_contract)
     select a, $1, $1, s, r, i, exists (select 1 from contracts k where k.address = total.a) from total order by a
     on conflict (address) do update set
       first_seen_block = least(addresses.first_seen_block, excluded.first_seen_block), last_active_block = greatest(addresses.last_active_block, excluded.last_active_block),
       sent_count = addresses.sent_count + excluded.sent_count, received_count = addresses.received_count + excluded.received_count,
       internal_count = addresses.internal_count + excluded.internal_count, is_contract = addresses.is_contract or excluded.is_contract`,
    [n],
  );
}
