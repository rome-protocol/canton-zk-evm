-- Addresses, contracts, code and verification
create table addresses (
  address              bytea primary key,
  first_seen_block     bigint not null,
  last_active_block    bigint not null,
  sent_count           bigint not null default 0,
  received_count       bigint not null default 0,
  internal_count       bigint not null default 0,
  token_transfer_count bigint not null default 0,
  is_contract          boolean not null default false,
  coin_balance         numeric(78,0),         -- at coin_balance_block, refreshed after each block that touched it;
  coin_balance_block   bigint                 -- for lists and sorting only: tools get balances from reth
);
create index on addresses (coin_balance desc) where coin_balance > 0;
create index on addresses ((sent_count + received_count) desc);  -- the addresses list, by transactions
create table coin_balance_history (address bytea not null, block_number bigint not null,
  value numeric(78,0) not null, primary key (address, block_number));
create table bytecodes (code_hash bytea primary key, code bytea not null, size integer not null);
  -- one copy of each code: clones share it
create table contracts (
  address                bytea primary key,
  origin                 text not null check (origin in ('genesis', 'create')),
  creator                bytea,               -- this and the next three are null for a genesis contract
  creation_block         bigint,
  creation_tx_index      integer,
  creation_trace_address integer[],           -- {} when the transaction itself created it
  runtime_code_hash      bytea not null references bytecodes,
  creation_code_hash     bytea references bytecodes,
  name                   text,                -- from the verified source, else the token's name
  verified_source        bigint,              -- verified_sources.id
  match_type             text,                -- full, partial, similar (the same code verified at another address)
  interaction_count      bigint not null default 0,  -- transactions sent to it
  last_interaction_block bigint,
  destroyed_block        bigint
);
  -- every genesis account with code (the gateway, and any other) is seeded at first start, with its code
create index on contracts (creation_block desc);
create index on contracts (interaction_count desc);
create index on contracts (runtime_code_hash);
create index on contracts using gin (name gin_trgm_ops);  -- search by name (pg_trgm)
create table proxies (
  proxy          bytea primary key references contracts,
  kind           text not null,               -- eip1967, eip1822, beacon, eip1167, other
  implementation bytea,
  beacon         bytea,
  checked_block  bigint not null,
  verified_at    timestamptz                  -- set by verifyproxycontract
);
create table verified_sources (
  id                bigint generated always as identity primary key,
  address           bytea not null unique,    -- the contract it was verified against
  runtime_code_hash bytea not null,
  language          text not null,            -- solidity
  compiler_version  text not null,            -- v0.8.30+commit.73712a01
  code_format       text not null,            -- solidity-single-file, solidity-standard-json-input
  contract_path     text not null,
  contract_name     text not null,
  optimizer_enabled boolean,
  optimizer_runs    integer,
  evm_version       text,
  settings          jsonb not null,           -- the full compiler settings
  sources           jsonb not null,           -- path -> content
  abi               jsonb not null,
  compiler_metadata jsonb,
  constructor_args  bytea,
  libraries         jsonb,
  license           text,
  match_type        text not null,            -- full or partial
  verified_at       timestamptz not null
);
create index on verified_sources (runtime_code_hash);
create table verification_jobs (
  guid          uuid primary key,
  kind          text not null,                -- source or proxy
  address       bytea not null,
  request       jsonb not null,               -- sources dropped once the job ends
  request_bytes integer not null,
  status        text not null,                -- pending, running, pass, fail, already
  result        text,                         -- the exact text Etherscan's checkverifystatus gives
  client_key    bytea not null,               -- keyed hash of the client's address
  lease_until   timestamptz,
  created_at    timestamptz not null,
  started_at    timestamptz,
  finished_at   timestamptz
);
create index on verification_jobs (status, created_at) where status in ('pending', 'running');
create index on verification_jobs (client_key, created_at);
create table abi_fragments (                  -- decoding without outside lookups
  fragment_hash bytea primary key,            -- sha256 of the fragment's canonical JSON
  selector      bytea not null,               -- 4 bytes for a function or error, 32 for an event
  kind          text not null,                -- function, event, error
  fragment      jsonb not null,
  source        text not null                 -- standard (ERC-20/721/1155, the gateway, proxies) or verified
);
create index on abi_fragments (selector, kind);
