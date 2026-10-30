-- The lock and release legs themselves, written by the same pass that counts them into twin_totals (once per leg, in one transaction with its cursor, and forgotten with the sums), so that the list of the newest
-- twin legs reads its own rows by the key and not the payment legs of the whole history. Each row says whether the leg is a release (a lock otherwise); the leg is read from gateway_legs by the same key.
create table twin_legs (
  block_number bigint not null,
  leg_index    integer not null,
  is_release   boolean not null,
  primary key (block_number, leg_index)
);
comment on table twin_legs is 'the lock and release legs counted into twin_totals, up to the block in meta.twin_totals_block';
-- A database that counted the sums before this table existed has no rows here for them: they are counted again from the first block.
delete from twin_totals;
delete from meta where key = 'twin_totals_block';
