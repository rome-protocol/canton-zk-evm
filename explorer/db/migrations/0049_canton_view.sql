-- The Linked to Canton view, one row per block (the update that committed it). What each row says beyond the update itself is worked out once, from the
-- producer's journal (block_attempts), the block and the legs index, and kept on the update so that a page of the list, a filter and the paging read
-- one table by an index. server/indexer/canton-view.ts fills the columns and the rollup below; a row that is not filled yet is null, never a guess.
-- The first statements hold a lock on canton_updates for as long as they scan and index it: fail fast rather than queue the API behind a busy table.
set local lock_timeout = '5s';
alter table canton_updates
  add column commit_attempts smallint,          -- submissions to Canton for this block's number up to and including the one that committed; null when the journal does not hold the block
  add column settle_seconds  double precision,  -- the Canton record time less the block's proof start (settle_from 'proof_start') or less the block's own timestamp ('block_time'); null when negative (clocks)
  add column settle_from     text check (settle_from in ('proof_start', 'block_time')),  -- null until worked out
  add column legs_done       boolean not null default false,  -- the leg columns below are final: every gateway's legs and the twin legs of the block are indexed
  add column legs_total      integer not null default 0,
  add column legs_deposit    integer not null default 0,
  add column legs_withdrawal integer not null default 0,
  add column legs_payment    integer not null default 0,      -- payments that are neither a lock nor a release
  add column legs_lock       integer not null default 0,
  add column legs_release    integer not null default 0;
-- The reads: by the update's key (record_time, update_id), for a filter, and the two passes that fill the columns look only at rows still open.
create index canton_updates_retried_idx on canton_updates (record_time desc, update_id desc) where commit_attempts > 1;
create index canton_updates_first_idx on canton_updates (record_time desc, update_id desc) where commit_attempts = 1;
create index canton_updates_with_legs_idx on canton_updates (record_time desc, update_id desc) where legs_total > 0;
create index canton_updates_attempts_open_idx on canton_updates (record_time) where commit_attempts is null;
create index canton_updates_settle_open_idx on canton_updates (record_time) where settle_from is null;
create index canton_updates_legs_open_idx on canton_updates (record_time) where not legs_done;
-- The rollup of attempts by the hour they were submitted in reads this.
create index block_attempts_submitted_at_idx on block_attempts (submitted_at) where submitted_at is not null;

-- The rollup behind the header: one row per UTC hour, recomputed from the rows above and from block_attempts whenever either changes (never incremented).
create table canton_view_hour (
  hour              timestamptz primary key,
  blocks            integer not null default 0,   -- updates recorded in the hour
  retried_blocks    integer not null default 0,   -- of those, committed after more than one attempt
  attempts          integer not null default 0,   -- commit attempts submitted in the hour (the producer's own count; a run flagged as a test is left out)
  attempts_committed integer not null default 0,
  attempts_refused  integer not null default 0,   -- Canton refused the command
  attempts_other    integer not null default 0,   -- failed, not taken, cancelled, or never answered and never found committed
  attempts_pending  integer not null default 0,   -- submitted and not answered yet (in flight): left out of the rate; counted again when the answer comes
  settle_n          integer not null default 0,   -- blocks whose settlement time runs from the proof start
  settle_sum        double precision not null default 0,
  legs_deposit      integer not null default 0,
  legs_withdrawal   integer not null default 0,
  legs_payment      integer not null default 0,
  legs_lock         integer not null default 0,
  legs_release      integer not null default 0,
  updated_at        timestamptz not null default now()
);
-- Settlement times of the hour in the fixed 5 % buckets of server/indexer/stats-hist.ts (a percentile is read from the sum); kept 8 days.
create table canton_view_hist (
  hour        timestamptz primary key references canton_view_hour on delete cascade,
  settle_hist integer[] not null
);
-- Where the journal loader says a fact was written, so the next pass recomputes the hours from there (a journal read late reaches an old hour).
create table canton_view_dirty (id bigint generated always as identity primary key, at timestamptz not null);
-- Everything already written is worked out by the next passes; the attempts of every past hour are counted again.
insert into canton_view_dirty (at) select min(submitted_at) from block_attempts having min(submitted_at) is not null;
