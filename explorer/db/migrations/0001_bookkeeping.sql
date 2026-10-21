-- Bookkeeping. schema_migrations itself is made by the runner (explorer/server/db/migrate.ts) before the first file.
-- One extension, for searching names.
create extension if not exists pg_trgm;

create table meta (key text primary key, value text not null);
  -- chain_id, genesis_hash, program_vk, root_c, gateway_address: the pins, checked at every start
  -- chain_instance: the update id of block 1's record
  -- reader_participant, and one entry per reader move
  -- partition_width: blocks per partition, fixed once
create table cursors (
  stream     text primary key,            -- 'reader_updates', 'derive', 'journal'
  position   bigint not null,             -- reader_updates: the offset on detail's participant
                                          -- derive: the last block stage 2 has written
                                          -- journal: the byte offset in detail's file
  detail     jsonb,                       -- reader_updates: participant id and block number; journal: the file name
  updated_at timestamptz not null
);
