-- The loader's join looks only at what is not joined yet; these indexes hold exactly those rows, so a load costs the same on a chain of a million blocks.
create index block_attempts_open_idx on block_attempts (block_hash) where (outcome is null or outcome = 'unknown') and resolved_outcome is distinct from 'committed';
create index block_attempts_resolved_idx on block_attempts (block_hash) where resolved_outcome = 'committed' and outcome is distinct from 'committed';
create index blocks_unjoined_idx on blocks (number) where attempt_id is null;
create index canton_updates_unjoined_idx on canton_updates (update_id) where command_id is null;
