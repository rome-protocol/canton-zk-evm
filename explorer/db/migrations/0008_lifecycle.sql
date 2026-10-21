-- The lifecycle, from the producer's journal and from the API (the facts that cannot be worked out later)
create table producer_runs (
  run_id     uuid primary key,
  started_at timestamptz not null,
  stopped_at timestamptz,
  stop_state text,                            -- stopped or crashed
  strategy   text not null,
  settings   jsonb not null,                  -- every setting of the run
  source_commit text not null
);
create table block_attempts (
  attempt_id         bigint generated always as identity primary key,
  run_id             uuid not null references producer_runs,
  attempt_seq        integer not null,        -- the producer's own count within the run
  number             bigint not null,
  block_hash         bytea,                   -- null when the build failed
  parent_hash        bytea,
  strategy           text not null,
  cut_reason         text not null,           -- pool, gather, heartbeat, rhythm, retry, probe
  pool_waiting       integer,
  idle_before_cut_ms integer,
  in_flight_at_cut   smallint not null default 0,
  tx_count           integer,
  gas_used           bigint,
  legs_count         integer,
  rebuilds           smallint not null default 0,
  left_out_count     integer not null default 0,
  cut_at             timestamptz not null,
  built_at           timestamptz,
  proof_queued_at    timestamptz,
  proof_started_at   timestamptz,
  proof_ended_at     timestamptz,
  prover             text,
  proof_outcome      text,                    -- ok, failed, wrong_block
  submitted_at       timestamptz,
  command_id         text,
  argument_bytes     integer,
  answered_at        timestamptz,
  outcome            text,                    -- committed, refused, not_taken, unknown, failed, skipped, cancelled
  reason             text,
  update_id          text,
  completion_offset  bigint,
  resolved_at        timestamptz,
  resolved_outcome   text,
  final_seen_at      timestamptz,
  unique (run_id, attempt_seq)
);
create index on block_attempts (number);
create index on block_attempts (block_hash);
create index on block_attempts (update_id);
create index on block_attempts (cut_at);
create table attempt_transactions (
  attempt_id      bigint not null references block_attempts,
  position        integer not null,
  tx_hash         bytea not null,
  left_out_reason text,                       -- null when it went into the block
  primary key (attempt_id, position)
);
create index on attempt_transactions (tx_hash);
create table tx_lifecycle (                  -- three writers, each owning its columns
  tx_hash             bytea primary key,
  accepted_at         timestamptz,            -- API: when reth took it from our RPC or the faucet
  accepted_via        text,                   -- API: rpc or faucet; null when it came another way
  sender              bytea,                  -- API, or the indexer when it came another way
  nonce               bigint,                 -- the same
  first_included_at   timestamptz,            -- journal loader: built_at of the first attempt that held it
  attempts            smallint not null default 0,  -- journal loader
  last_left_out_reason text,                  -- journal loader
  final_block         bigint,                 -- indexer, stage 1
  final_at            timestamptz,            -- indexer, stage 1: the Canton record time of its block's update
  state               text not null,          -- pending, proving, final, replaced, dropped, lost; by precedence
  state_reason        text,
  resends             smallint not null default 0,  -- API (the tracker)
  updated_at          timestamptz not null
);
create index on tx_lifecycle (state, accepted_at) where state not in ('final', 'replaced');
create index on tx_lifecycle (sender, nonce) where state <> 'final';  -- to mark a replaced transaction
create index on tx_lifecycle (final_at);
create table pool_samples (at timestamptz primary key, waiting integer not null);  -- from the journal's pool events
