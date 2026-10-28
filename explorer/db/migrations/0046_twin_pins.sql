-- The twins the chain record pins (ZkChain.twins): the ERC-20 and the decimals its Canton twin is minted with. A leg is a lock or a release only for a pinned token, and a twin amount is
-- worked out with the pinned decimals, which are the ones Canton minted with (the EVM token's own may differ).
create table canton_twins (
  token         bytea primary key,
  decimals      int not null check (decimals between 0 and 36),
  ledger_offset bigint not null,
  read_at       timestamptz not null default now()
);
comment on table canton_twins is 'the twins pinned in the chain record, replaced by each custody read that sees the chain record';

-- What each twin token's vaults have taken in (locks) and paid out (releases) over the payment legs, counted once per leg as the legs are indexed: a token page reads one row. twin_totals_block in `meta` is the block
-- the sums are counted up to; the sums are counted again from the start when a vault or a pin is added, or a block is indexed again.
create table twin_totals (
  token         bytea primary key,
  locked        numeric not null default 0,
  released      numeric not null default 0,
  locks         bigint not null default 0,
  releases      bigint not null default 0
);
comment on table twin_totals is 'per twin token: the sums and counts of the lock and release legs up to the block in meta.twin_totals_block';
