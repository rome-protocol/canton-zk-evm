-- The indexes that the REST pages' keysets and searches read through. Each one matches an ORDER BY and its keyset comparison exactly, so a page costs its own rows, not the table.

-- Canton updates, newest first, after the key (record time, update id).
create index canton_updates_record_time_id_idx on canton_updates (record_time desc, update_id desc);

-- Contracts by place of creation (newest or oldest first). The expressions are the ones the page orders and compares on: a contract of the genesis has no place and counts as block 0.
create index contracts_creation_place_idx on contracts ((coalesce(creation_block, 0)), (coalesce(creation_tx_index, 0)), address);

-- Tokens by the block of their first transfer (newest first).
create index tokens_first_transfer_idx on tokens (first_transfer_block desc, address desc);

-- The name search reads a token's name and its symbol each on its own.
create index tokens_name_trgm_idx on tokens using gin (name gin_trgm_ops);
create index tokens_symbol_trgm_idx on tokens using gin (symbol gin_trgm_ops);

-- What an address holds, in the order of the page (token, id).
create index token_balances_holdings_idx on token_balances (holder, token, token_id) where value > 0;
