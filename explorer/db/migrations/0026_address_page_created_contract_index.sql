-- An address's page of transactions reads the ones that created it through `created_contract`, newest first, after a key (block, index). The old index held the
-- address alone, with no order; on a table of millions of rows the planner then walked the primary key backwards, filtering on the address, and read the whole table
-- for an address that created nothing (seconds a page). This one is the page's ORDER BY and keyset comparison exactly, like the indexes of `from_address` and `to_address`.
create index transactions_created_contract_place_idx on transactions (created_contract, block_number desc, tx_index desc) where created_contract is not null;
drop index transactions_created_contract_idx;
