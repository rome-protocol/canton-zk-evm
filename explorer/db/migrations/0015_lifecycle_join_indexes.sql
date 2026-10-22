-- The loader's join looks only at what is not joined yet; these indexes hold exactly those rows, so a load costs the same on a chain of a million blocks.
create index block_attempts_open_idx on block_attempts (block_hash) where (outcome is null or outcome = 'unknown') and resolved_outcome is distinct from 'committed';
create index block_attempts_resolved_idx on block_attempts (block_hash) where resolved_outcome = 'committed' and outcome is distinct from 'committed';
create index blocks_unjoined_idx on blocks (number) where attempt_id is null;
create index block_attempts_no_update_idx on block_attempts (block_hash) where update_id is null and (outcome = 'committed' or resolved_outcome = 'committed');
-- The join of Canton's side reads the unjoined updates from the time the journal began, so an update from before it is never visited again.
create index canton_updates_unjoined_idx on canton_updates (record_time) where command_id is null;
-- The in-flight list and the join of a block to its attempt ask for the block that holds an attempt.
create index blocks_attempt_id_idx on blocks (attempt_id) where attempt_id is not null;
