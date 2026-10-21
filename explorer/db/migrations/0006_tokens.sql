-- Tokens and balances
create table tokens (
  address            bytea primary key references contracts,
  standard           text not null,           -- ERC-20, ERC-721, ERC-1155
  name text, symbol text, decimals smallint,
  total_supply       numeric(78,0),
  total_supply_block bigint,
  holder_count       bigint not null default 0,
  transfer_count     bigint not null default 0,
  first_transfer_block bigint not null,
  metadata_status    text not null,           -- read, pending, failed
  balance_mode       text not null default 'derived',  -- derived from transfers, or read with balanceOf
  gateway_wrapped    boolean not null default false     -- made by the gateway contract
);
create index on tokens (holder_count desc);
create index on tokens (transfer_count desc);
create index on tokens using gin ((coalesce(name, '') || ' ' || coalesce(symbol, '')) gin_trgm_ops);
create table token_transfers (
  block_number bigint not null,
  log_index    integer not null,
  batch_index  integer not null default 0,   -- the position in an ERC-1155 TransferBatch
  tx_index     integer not null,
  token        bytea not null,
  from_address bytea not null,
  to_address   bytea not null,
  amount       numeric(78,0),                 -- ERC-20 and ERC-1155
  token_id     numeric(78,0),                 -- ERC-721 and ERC-1155
  primary key (block_number, log_index, batch_index)
) partition by range (block_number);
create index on token_transfers (token, block_number desc);
create index on token_transfers (from_address, block_number desc);
create index on token_transfers (to_address, block_number desc);
create table token_balances (
  token         bytea not null,
  holder        bytea not null,
  token_id      numeric(78,0) not null default 0,  -- 0 for ERC-20; ERC-721 keeps the count of NFTs here
  value         numeric(78,0) not null,     -- for lists and holder counts; tokenbalance reads reth
  updated_block bigint not null,
  checked_block bigint,                       -- when balanceOf last agreed; set to null by a reindex, so it is read again
  primary key (token, holder, token_id)
);
create index on token_balances (holder);
create index on token_balances (token, value desc) where value > 0;
create table nft_owners (token bytea not null, token_id numeric(78,0) not null, owner bytea not null,
  updated_block bigint not null, primary key (token, token_id));
create index on nft_owners (owner);
