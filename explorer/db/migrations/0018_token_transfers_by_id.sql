-- One NFT's (or one ERC-1155 id's) transfers, newest first: the page of its history, the owner the reindex works out again for each id a range moves,
-- and the check that a row of the owners still has a transfer behind it. Without it every id reads the whole collection's history through (token, block).
create index on token_transfers (token, token_id, block_number desc, log_index desc);
