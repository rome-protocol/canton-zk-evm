-- The gateway's legs, as the EVM recorded them (public EVM data; nothing from Canton)
create table gateway_legs (
  block_number bigint not null,
  leg_index    integer not null,              -- the order of the block's running hash
  tx_index     integer not null,
  log_index    integer not null,
  kind         smallint not null,             -- deposit, withdrawal, payment, as the gateway encodes them
  leg_id       bytea not null,
  token        bytea not null,
  account      bytea not null,                -- recipient, burner or payee
  amount       numeric(78,0) not null,
  party        text,                          -- a withdrawal's Canton party, exactly as written on the EVM
  primary key (block_number, leg_index)
);
create index on gateway_legs (leg_id);
create index on gateway_legs (token, block_number desc);
create index on gateway_legs (account, block_number desc);
