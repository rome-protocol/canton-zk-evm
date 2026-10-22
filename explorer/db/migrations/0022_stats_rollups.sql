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

-- The columns the rollups did not yet have: the skipped and cancelled attempts apart from the ones not taken, and the time a transaction was first
-- dropped or lost, stored once (updated_at changes on every later write, so it cannot say in which minute a loss happened).
alter table stats_minute add column attempts_skipped integer not null default 0, add column attempts_cancelled integer not null default 0;
alter table stats_hour   add column attempts_skipped integer not null default 0, add column attempts_cancelled integer not null default 0;
alter table stats_day    add column attempts_skipped integer not null default 0, add column attempts_cancelled integer not null default 0;
-- The ten-minute windows of a day with a prover busy over 0.6 are worked out from the minute rows, which are kept 30 days.

alter table tx_lifecycle add column lost_at timestamptz;
update tx_lifecycle set lost_at = updated_at where state in ('dropped', 'lost');
create function tx_lifecycle_lost_at() returns trigger language plpgsql as $$
begin
  if new.state in ('dropped', 'lost') then
    new.lost_at := case when tg_op = 'UPDATE' and old.state in ('dropped', 'lost') and old.lost_at is not null then old.lost_at else new.updated_at end;
  else
    new.lost_at := null;
  end if;
  return new;
end $$;
create trigger tx_lifecycle_lost_at_trg before insert or update on tx_lifecycle for each row execute function tx_lifecycle_lost_at();

-- The indexes the rollup reads by (it runs every ten seconds, so each read of a time window must not scan a table), and the day's address counts.
create index tx_lifecycle_accepted_at_idx on tx_lifecycle (accepted_at);
create index tx_lifecycle_lost_at_idx on tx_lifecycle (lost_at) where lost_at is not null;
create index block_attempts_proof_ended_at_idx on block_attempts (proof_ended_at);
create index block_attempts_answered_at_idx on block_attempts (answered_at);
create index addresses_first_seen_block_idx on addresses (first_seen_block);

-- Late facts. The rollup cursor moves with the clock, and a fact can be written long after its own time (a block caught up after an outage, a journal
-- loaded late). Every write of a fact table therefore leaves the earliest fact time it touched here, and the next rollup run starts from the earliest one,
-- whatever its age. The table is append only, so writers never wait for each other, and a run takes what it finds by deleting it.
create table stats_dirty (id bigint generated always as identity primary key, at timestamptz not null);

create function stats_dirty_blocks() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then insert into stats_dirty (at) select min(record_time) from new_rows having count(*) > 0;
  else insert into stats_dirty (at) select min(record_time) from (select record_time from new_rows union all select record_time from old_rows) x having count(*) > 0;
  end if;
  return null;
end $$;
create function stats_dirty_attempts() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into stats_dirty (at) select min(least(cut_at, proof_started_at, proof_ended_at, submitted_at, answered_at)) from new_rows having count(*) > 0;
  else
    insert into stats_dirty (at) select min(least(cut_at, proof_started_at, proof_ended_at, submitted_at, answered_at))
      from (select * from new_rows union all select * from old_rows) x having count(*) > 0;
  end if;
  return null;
end $$;
create function stats_dirty_lifecycle() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into stats_dirty (at) select min(least(accepted_at, final_at, lost_at)) from new_rows having count(*) > 0;
  else
    insert into stats_dirty (at) select min(least(accepted_at, final_at, lost_at))
      from (select accepted_at, final_at, lost_at from new_rows union all select accepted_at, final_at, lost_at from old_rows) x having count(*) > 0;
  end if;
  return null;
end $$;
create function stats_dirty_runs() returns trigger language plpgsql as $$
begin
  insert into stats_dirty (at) select min(started_at) from new_rows having count(*) > 0;
  return null;
end $$;
-- Stage 2 (the failed transactions of a block) finishes after the block is written: the derive cursor moving marks the block's time.
create function stats_dirty_derive() returns trigger language plpgsql as $$
begin
  if new.stream = 'derive' then insert into stats_dirty (at) select record_time from blocks where number = new.position; end if;
  return null;
end $$;

create trigger stats_dirty_blocks_ins after insert on blocks referencing new table as new_rows for each statement execute function stats_dirty_blocks();
create trigger stats_dirty_blocks_upd after update on blocks referencing old table as old_rows new table as new_rows for each statement execute function stats_dirty_blocks();
create trigger stats_dirty_attempts_ins after insert on block_attempts referencing new table as new_rows for each statement execute function stats_dirty_attempts();
create trigger stats_dirty_attempts_upd after update on block_attempts referencing old table as old_rows new table as new_rows for each statement execute function stats_dirty_attempts();
create trigger stats_dirty_lifecycle_ins after insert on tx_lifecycle referencing new table as new_rows for each statement execute function stats_dirty_lifecycle();
create trigger stats_dirty_lifecycle_upd after update on tx_lifecycle referencing old table as old_rows new table as new_rows for each statement execute function stats_dirty_lifecycle();
create trigger stats_dirty_runs_ins after insert on producer_runs referencing new table as new_rows for each statement execute function stats_dirty_runs();
create trigger stats_dirty_runs_upd after update on producer_runs referencing new table as new_rows for each statement execute function stats_dirty_runs();
create trigger stats_dirty_derive_trg after insert or update on cursors for each row execute function stats_dirty_derive();
