-- The tracker and the faucet
create table tracked_transactions (
  tx_hash      bytea primary key,
  raw          bytea,                         -- the signed bytes; removed 7 days after it settles
  bytes        integer not null,
  sender       bytea not null,
  nonce        bigint not null,
  open         boolean not null,
  sends        smallint not null default 1,
  refusals     smallint not null default 0,
  last_sent_at timestamptz not null,
  settled_at   timestamptz
);
create index on tracked_transactions (sender) where open;
create index on tracked_transactions (last_sent_at) where open;
create table faucet_batches (batch_id bigint generated always as identity primary key,
  signed_at timestamptz not null, first_nonce bigint not null, size integer not null, sent_at timestamptz);
create table faucet_requests (
  ticket         uuid primary key,
  address        bytea not null,
  client_key     bytea not null,              -- keyed hash of the client's address (its /64 for IPv6)
  amount         numeric(78,0) not null,
  state          text not null,               -- queued, sent, final, failed
  reason         text,
  batch_id       bigint references faucet_batches,
  nonce          bigint,
  tx_hash        bytea,
  signed_raw     bytea,                       -- removed once the request is final or failed
  counts         boolean not null default true,  -- false when it came to nothing, so the address gets its turn back
  requested_at   timestamptz not null,
  sent_at        timestamptz,
  final_at       timestamptz,
  final_block    bigint
);
create index on faucet_requests (address, requested_at desc);
create index on faucet_requests (client_key, requested_at desc);
create index on faucet_requests (requested_at);
create index on faucet_requests (state, requested_at) where state in ('queued', 'sent');
