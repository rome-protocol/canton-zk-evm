-- What the tracker and the faucet need to pick up where they stopped, which the first tables of 0009 did not hold.
-- Each API instance keeps the rows it follows in memory and reads the rows other instances changed, by updated_at.
alter table tracked_transactions
  add column added_at     timestamptz,
  add column state        text not null default 'pending',   -- the tracker's own word: pending, proving, final, replaced, dropped
  add column reason       text,
  add column block_number bigint,
  add column block_hash   bytea,
  add column update_id    text,
  add column updated_at   timestamptz not null default now();
create index on tracked_transactions (updated_at);

alter table faucet_requests
  add column tries      smallint not null default 0,         -- refusals from the chain for this transfer
  add column sent_nonce bigint,                              -- the nonce it was sent with, kept after the hand-over
  add column watching   boolean not null default false,      -- the tracker let go of it and the faucet follows it by hash
  add column updated_at timestamptz not null default now();
create index on faucet_requests (updated_at);
