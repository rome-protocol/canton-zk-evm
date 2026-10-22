-- The blocks list can be filtered to the blocks with transactions or to the empty ones; each filter pages through an index of its own rows,
-- in the list's order (newest first), so a page costs its own rows however few empty blocks there are.
create index blocks_with_txs_idx on blocks (number desc) where tx_count > 0;
create index blocks_empty_idx on blocks (number desc) where tx_count = 0 and number > 0;
