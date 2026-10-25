-- The success rate counts only the chain's own failures: a transaction the public RPC accepted that became final, over those that became final, were lost or were dropped.
-- A transaction that reverted in the EVM is a normal outcome and is not a failure of the chain (txs_failed stays, as the EVM-status count).
-- Four more counts per minute, hour and day:
--   accepted_final      accepted by the RPC and final, by the minute of its final record time (test runs left out, like every count here)
--   delayed_by_redo     the same, and carried earlier by an attempt that did not commit (refused, failed, or unknown and never found committed): a delay, not a failure
--   attempts_committed  attempts that committed (outcome committed, or resolved as committed later)
--   attempts_unknown    attempts whose answer never came and that were not found committed
alter table stats_minute add column accepted_final integer not null default 0, add column delayed_by_redo integer not null default 0,
  add column attempts_committed integer not null default 0, add column attempts_unknown integer not null default 0;
alter table stats_hour add column accepted_final integer not null default 0, add column delayed_by_redo integer not null default 0,
  add column attempts_committed integer not null default 0, add column attempts_unknown integer not null default 0;
alter table stats_day add column accepted_final integer not null default 0, add column delayed_by_redo integer not null default 0,
  add column attempts_committed integer not null default 0, add column attempts_unknown integer not null default 0;
-- The rows already written have zeros in the new columns: ask the next rollup run to recompute them from the first fact on.
insert into stats_dirty (at)
  select least((select min(record_time) from blocks), (select min(cut_at) from block_attempts), (select min(least(accepted_at, final_at)) from tx_lifecycle), (select min(lost_at) from tx_lifecycle));
