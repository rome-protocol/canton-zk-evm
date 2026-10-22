-- Etherscan's tokentx, tokennfttx and token1155tx list the transfers of ONE standard that an address sent or received. A transfer's standard follows from its columns
-- (the indexer writes only transfers of the standard a token is known by): an ERC-20 transfer has no token_id, an ERC-721 transfer has no amount, an ERC-1155 transfer
-- has both. Each list reads the index of its own standard, newest first, so its cost is its own rows however many transfers of the other standards the address has.
create index token_transfers_from_erc20_idx on token_transfers (from_address, block_number desc, log_index desc, batch_index desc) where token_id is null;
create index token_transfers_to_erc20_idx on token_transfers (to_address, block_number desc, log_index desc, batch_index desc) where token_id is null;
create index token_transfers_from_erc721_idx on token_transfers (from_address, block_number desc, log_index desc, batch_index desc) where amount is null;
create index token_transfers_to_erc721_idx on token_transfers (to_address, block_number desc, log_index desc, batch_index desc) where amount is null;
create index token_transfers_from_erc1155_idx on token_transfers (from_address, block_number desc, log_index desc, batch_index desc) where amount is not null and token_id is not null;
create index token_transfers_to_erc1155_idx on token_transfers (to_address, block_number desc, log_index desc, batch_index desc) where amount is not null and token_id is not null;
-- An address and one token together (the contractaddress filter): the rows of that token alone, whatever else the address moved.
create index token_transfers_from_address_token_idx on token_transfers (from_address, token, block_number desc, log_index desc, batch_index desc);
create index token_transfers_to_address_token_idx on token_transfers (to_address, token, block_number desc, log_index desc, batch_index desc);
