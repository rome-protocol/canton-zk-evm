-- What an address page reads (GET /api/addresses/:a, its contracts, its NFT transfers), each by an index of its own so that its cost is its own rows.
-- Who funded an address: its first transaction that carried value and succeeded, read oldest first; the filter is the index's own predicate, so an address that is
-- only ever called with no value (a token contract) is not read through all its calls.
create index transactions_funding_idx on transactions (to_address, block_number, tx_index) where value > 0 and status = 1;
-- The contracts an address made, newest first, by the place of the creation as the contract list orders them (a missing place counts as 0), then the address.
create index contracts_creator_place_idx on contracts (creator, coalesce(creation_block, 0) desc, coalesce(creation_tx_index, 0) desc, address desc) where creator is not null;
-- The NFT group of an address's token transfers (ERC-721 and ERC-1155 together): a transfer with a token_id is an NFT transfer, as in 0028 an ERC-20 transfer has none.
create index token_transfers_from_nft_idx on token_transfers (from_address, block_number desc, log_index desc, batch_index desc) where token_id is not null;
create index token_transfers_to_nft_idx on token_transfers (to_address, block_number desc, log_index desc, batch_index desc) where token_id is not null;
