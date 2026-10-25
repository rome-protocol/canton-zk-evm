-- Why the tracker dropped a transaction, so the success rate counts only the drops the chain itself causes.
--   drop_cause  chain     it went missing on every resend, or reth refused it because its pool was full
--               sender    reth refused it for a reason of the sender's (no funds, a nonce gap, a fee too low, a gas limit too low)
--               explorer  the explorer gave up on it (it held too many unconfirmed transactions)
--               stuck     it waited in reth's pool for the longest wait with no block (the sender's fee or nonce, or the chain: not told apart)
--   null        not dropped by the tracker, or dropped before this column (those count as sender-side, not in the rate)
alter table tx_lifecycle add column drop_cause text;
-- The rate's own drops are only the chain-side ones: the column counted every dropped transaction the RPC or the faucet accepted.
alter table stats_minute rename column accepted_dropped to accepted_dropped_chain;
alter table stats_hour rename column accepted_dropped to accepted_dropped_chain;
alter table stats_day rename column accepted_dropped to accepted_dropped_chain;
-- The rows already written hold the old meaning: ask the next rollup run to recompute them from the first fact on.
insert into stats_dirty (at)
  select least((select min(record_time) from blocks), (select min(cut_at) from block_attempts), (select min(least(accepted_at, final_at)) from tx_lifecycle), (select min(lost_at) from tx_lifecycle));
