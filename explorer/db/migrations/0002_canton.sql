-- Canton (what the reader party sees, and the producer's own record of what it sent)
create table canton_synchronizers (id smallint generated always as identity primary key,
  synchronizer_id text not null unique, first_seen timestamptz not null);
create table canton_templates (id smallint generated always as identity primary key,
  package_id text not null, package_name text, module text not null, entity text not null,
  unique (package_id, module, entity));
create table canton_parties (id smallint generated always as identity primary key,
  party text not null unique, role text not null check (role in ('operator', 'confirmer')));
  -- only the two signers of the block record; no other party id is ever stored
create table canton_participants (id smallint generated always as identity primary key,
  participant_id text not null unique,        -- the reader's participant, as it reports its own id
  first_offset   bigint,                      -- where the indexer started reading it
  last_offset    bigint,                      -- where it stopped, at a move
  moved_in_at    timestamptz not null,
  moved_out_at   timestamptz);
  -- offsets are local to one participant, so every stored offset says whose it is
create table canton_updates (
  update_id          text primary key,
  participant        smallint not null references canton_participants,
  reader_offset      bigint not null,         -- on that participant
  record_time        timestamptz not null,
  effective_at       timestamptz,
  synchronizer       smallint not null references canton_synchronizers,
  reader_template    smallint not null references canton_templates,  -- BlockRecord
  signatories        smallint[] not null,     -- canton_parties ids
  -- the record's contract id is in block_records, since one update may carry several blocks later
  -- from the producer's journal; null when the journal was not available
  command_id         text,
  submitted_template text,                    -- 'Zk.Chain:ZkChain'
  submitted_choice   text,                    -- 'Advance'
  argument_bytes     integer,
  traffic_bytes      integer,                 -- the builder participant's traffic used across Advance, journalled in `answered`;
                                              -- null when more than one block was in flight or the participant does not report it
  completion_offset  bigint,                  -- on the builder's participant; internal, never served publicly
  unique (participant, reader_offset)
);
create index on canton_updates (record_time);
