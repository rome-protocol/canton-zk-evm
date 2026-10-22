-- What the stats rollups hold beyond migration 0011 (design section 8). Every column is added to the minute, hour and day tables alike.
-- Histograms are dense arrays over the fixed edges of server/indexer/stats-hist.ts, so that they add up across rows. A run whose settings carry
-- `test = true` is left out of every other column and counted apart in the `test_*` ones (design 2.7).
alter table stats_minute
  add column attempts               integer  not null default 0,
  add column attempts_not_taken     integer  not null default 0,
  add column ttf_without_acceptance integer  not null default 0,  -- final transactions with no acceptance time: counted apart from the time to final
  add column clock_skew             integer  not null default 0,  -- negative durations left out of the histograms
  add column max_txs_in_block       integer  not null default 0,
  add column gas_limit_sum          bigint   not null default 0,
  add column traffic_bytes          bigint   not null default 0,
  add column traffic_updates        integer  not null default 0,  -- updates that reported traffic
  add column proof_busy_ms          bigint   not null default 0,
  add column test_blocks            integer  not null default 0,
  add column test_txs               integer  not null default 0,
  add column test_attempts          integer  not null default 0,
  add column test_proof_busy_ms     bigint   not null default 0,
  add column txs_per_block_hist     integer[] not null default '{}',
  add column served_hist            integer[] not null default '{}',  -- record time to served
  add column proof_size_hist        integer[] not null default '{}';  -- five size classes, one after the other
alter table stats_hour
  add column attempts               integer  not null default 0,
  add column attempts_not_taken     integer  not null default 0,
  add column ttf_without_acceptance integer  not null default 0,
  add column clock_skew             integer  not null default 0,
  add column max_txs_in_block       integer  not null default 0,
  add column gas_limit_sum          bigint   not null default 0,
  add column traffic_bytes          bigint   not null default 0,
  add column traffic_updates        integer  not null default 0,
  add column proof_busy_ms          bigint   not null default 0,
  add column test_blocks            integer  not null default 0,
  add column test_txs               integer  not null default 0,
  add column test_attempts          integer  not null default 0,
  add column test_proof_busy_ms     bigint   not null default 0,
  add column txs_per_block_hist     integer[] not null default '{}',
  add column served_hist            integer[] not null default '{}',
  add column proof_size_hist        integer[] not null default '{}';
alter table stats_day
  add column attempts               integer  not null default 0,
  add column attempts_not_taken     integer  not null default 0,
  add column ttf_without_acceptance integer  not null default 0,
  add column clock_skew             integer  not null default 0,
  add column max_txs_in_block       integer  not null default 0,
  add column gas_limit_sum          bigint   not null default 0,
  add column traffic_bytes          bigint   not null default 0,
  add column traffic_updates        integer  not null default 0,
  add column proof_busy_ms          bigint   not null default 0,
  add column test_blocks            integer  not null default 0,
  add column test_txs               integer  not null default 0,
  add column test_attempts          integer  not null default 0,
  add column test_proof_busy_ms     bigint   not null default 0,
  add column txs_per_block_hist     integer[] not null default '{}',
  add column served_hist            integer[] not null default '{}',
  add column proof_size_hist        integer[] not null default '{}';
