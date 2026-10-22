-- The transactions list can be filtered to the reverted transactions or to the calls into contracts (a transaction with input); each filter pages
-- through an index of its own rows, in the list's order (newest first), so a page costs its own rows however few the others are.
create index transactions_failed_idx on transactions (block_number desc, tx_index desc) where status = 0;
create index transactions_calls_idx on transactions (block_number desc, tx_index desc) where method_id is not null;
