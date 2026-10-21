-- Blocks (final only)
create table blocks (
  number            bigint primary key,
  hash              bytea not null unique,
  parent_hash       bytea not null,
  timestamp         timestamptz not null,     -- the header's: the builder's clock, whole seconds
  fee_recipient     bytea not null,
  gas_limit         bigint not null,
  gas_used          bigint not null,
  base_fee_per_gas  numeric(78,0) not null,
  burnt_fees        numeric(78,0) not null,
  priority_fees     numeric(78,0) not null,
  tx_count          integer not null,
  log_count         integer not null,
  size_bytes        integer not null,
  state_root        bytea not null,
  transactions_root bytea not null,
  receipts_root     bytea not null,
  extra_data        bytea not null,
  legs_count        integer not null,
  legs_hash         bytea,                    -- the gateway's legs[number]; null when there are none
  update_id         text not null references canton_updates,  -- not unique: several blocks may share one update later
  record_time       timestamptz not null,     -- the update's, copied for range scans
  attempt_id        bigint,                   -- block_attempts; null when the journal was not available
  indexed_at        timestamptz not null
);
create index on blocks (record_time);
create index on blocks (timestamp);           -- getblocknobytime
create index on blocks (fee_recipient, number desc);
create index on blocks (update_id);
create table block_records (                  -- what the Verify button needs, exactly as Canton holds it
  number      bigint primary key references blocks,
  header      bytea not null,
  txs         bytea not null,                 -- the record keeps hex; we keep the bytes
  contract_id text not null
);
create table proofs (
  number               bigint primary key references blocks,
  proof                bytea not null,        -- 1,344 bytes
  program_vk           bytea not null,
  root_c               bytea not null,
  committed_block_hash bytea not null,        -- from the proof's public values
  matches_pins         boolean not null,
  matches_block        boolean not null
);
