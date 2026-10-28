-- The chain record's registry of EVM contracts (ZkChain.contracts), as the custody read sees it: the gateways whose legs Canton reads beside the first gateway's, and the vaults
-- that hold the ERC-20s behind Canton twins. Public EVM addresses and code hashes only; the gateway party is the twins' instrument admin.
create table canton_registry (
  address       bytea primary key,
  kind          text not null check (kind in ('gateway', 'vault')),
  code_hash     bytea not null,
  admin         text not null,                 -- the gateway party: the admin of the twins' instruments
  legs_cursor   bigint not null default 0,     -- a gateway's legs are indexed up to this block (the block the read first saw it after is the start)
  ledger_offset bigint not null,               -- the ledger offset the registry was read at
  read_at       timestamptz not null default now()
);
comment on table canton_registry is 'the chain record''s registry of EVM contracts, replaced by each custody read; legs_cursor is the progress of a registered gateway''s leg index';

-- A leg of a registered gateway has its gateway's address; null is the chain's first gateway. Its leg_index goes on after the first gateway's legs of the block.
alter table gateway_legs add column gateway bytea;
