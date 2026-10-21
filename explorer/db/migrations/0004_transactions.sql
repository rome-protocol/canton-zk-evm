-- Transactions and their receipts (one row each: final-only means every transaction has its receipt)
create table transactions (
  block_number             bigint not null,
  tx_index                 integer not null,
  hash                     bytea not null,
  type                     smallint not null,
  from_address             bytea not null,
  to_address               bytea,             -- null for a creation
  created_contract         bytea,             -- the receipt's contractAddress
  nonce                    bigint not null,
  value                    numeric(78,0) not null,
  gas_limit                bigint not null,
  gas_price                numeric(78,0),
  max_fee_per_gas          numeric(78,0),
  max_priority_fee_per_gas numeric(78,0),
  effective_gas_price      numeric(78,0) not null,
  gas_used                 bigint not null,
  cumulative_gas_used      bigint not null,
  status                   smallint not null, -- 1 success, 0 failure (revert data and call count: tx_traces)
  method_id                bytea,             -- the input's first 4 bytes
  input                    bytea not null,
  access_list              jsonb,
  authorization_list       jsonb,             -- EIP-7702
  log_count                integer not null,
  primary key (block_number, tx_index)
) partition by range (block_number);
create index on transactions (from_address, block_number desc, tx_index desc);
create index on transactions (to_address, block_number desc, tx_index desc) where to_address is not null;
create index on transactions (created_contract) where created_contract is not null;
create table tx_hashes (hash bytea primary key, block_number bigint not null, tx_index integer not null);
  -- a partitioned table cannot have a unique index on the hash alone, so lookups by hash go through this one
create table tx_traces (                      -- stage 2; a row only for a transaction with sub-calls or a revert
  block_number  bigint not null,
  tx_index      integer not null,
  call_count    integer not null,             -- every sub-call in the trace, stored or not
  revert_data   bytea,                        -- the transaction's output when it failed (trace_replayBlockTransactions)
  revert_reason text,                         -- Error(string) or Panic(uint256); a custom error is decoded when served
  primary key (block_number, tx_index)
) partition by range (block_number);
  -- a block at or below the derive cursor with no row here: no sub-calls and no revert data

create table logs (
  block_number bigint not null,
  log_index    integer not null,
  tx_index     integer not null,
  address      bytea not null,
  topic0 bytea, topic1 bytea, topic2 bytea, topic3 bytea,
  data         bytea not null,
  primary key (block_number, log_index)
) partition by range (block_number);
create index on logs (address, block_number);
create index on logs (topic0, block_number);
  -- getLogs needs an address or topic0 (or a range of at most 10,000 blocks); topics 1 to 3 filter within that

create table internal_calls (                 -- calls that move value, create or self-destruct: Etherscan's "internal transactions"
  block_number   bigint not null,
  tx_index       integer not null,
  trace_address  integer[] not null,          -- the path in the call tree; the top call is not stored
  call_type      text not null,               -- call, delegatecall, staticcall, callcode, create, create2, selfdestruct
  from_address   bytea not null,
  to_address     bytea,                       -- the new address for a creation
  value          numeric(78,0) not null,
  gas            bigint,
  gas_used       bigint,
  input_selector bytea,
  input_size     integer,
  error          text,
  primary key (block_number, tx_index, trace_address)
) partition by range (block_number);
create index on internal_calls (from_address, block_number desc);
create index on internal_calls (to_address, block_number desc);
  -- the whole call tree of one transaction is read from reth (trace_transaction, final blocks only) when its page asks
