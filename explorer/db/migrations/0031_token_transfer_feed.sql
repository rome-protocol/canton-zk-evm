-- The feed of every token's transfers (GET /api/token-transfers) lists them newest first by (block, log, batch), all of them or the transfers of one standard.
-- The primary key answers the unfiltered list. A filter by standard reads the index of its own standard, so its cost is its own rows however many transfers of the other
-- standards come between them. The standard follows from the columns as in 0028: an ERC-20 transfer has no token_id, an ERC-721 transfer has no amount, an ERC-1155
-- transfer has both.
create index token_transfers_feed_erc20_idx on token_transfers (block_number desc, log_index desc, batch_index desc) where token_id is null;
create index token_transfers_feed_erc721_idx on token_transfers (block_number desc, log_index desc, batch_index desc) where amount is null;
create index token_transfers_feed_erc1155_idx on token_transfers (block_number desc, log_index desc, batch_index desc) where amount is not null and token_id is not null;
