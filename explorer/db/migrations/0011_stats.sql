-- Stats rollups; histograms use fixed log-spaced buckets so that they add up across rows
create table stats_minute (
  bucket           timestamptz primary key,  -- the minute (the hour, the day in the tables below)
  blocks           integer not null,
  empty_blocks     integer not null,
  busy_blocks      integer not null,
  txs              integer not null,
  txs_failed       integer not null,
  gas_used         bigint not null,
  argument_bytes   bigint not null,
  accepted         integer not null,
  lost             integer not null,
  attempts_refused integer not null,
  attempts_failed  integer not null,
  busy_gap_hist    integer[] not null,        -- seconds between busy blocks
  time_to_final_hist integer[] not null,
  proof_hist       integer[] not null,
  commit_hist      integer[] not null
);
create table stats_hour (like stats_minute including all);
create table stats_day  (like stats_minute including all,
  active_addresses integer, new_addresses integer, new_contracts integer, verified_contracts integer);
