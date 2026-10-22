-- The lists sorted on a count or a balance page through an index that has the address as its tie-breaker, so that a page costs its own rows, not the table:
-- each index is the route's ORDER BY and keyset comparison exactly. They replace the single-column indexes of the same sorts, which could not carry the key.

-- A token's holders, most first (value, holder, id).
create index token_balances_token_value_holder_idx on token_balances (token, value desc, holder desc, token_id desc) where value > 0;
drop index token_balances_token_value_idx;

-- Addresses by balance, and by the count of their transactions (sent and received).
create index addresses_coin_balance_address_idx on addresses (coin_balance desc, address desc) where coin_balance > 0;
drop index addresses_coin_balance_idx;
create index addresses_tx_count_address_idx on addresses ((sent_count + received_count) desc, address desc);
drop index addresses_expr_idx;

-- Contracts by interactions.
create index contracts_interaction_count_address_idx on contracts (interaction_count desc, address desc);
drop index contracts_interaction_count_idx;

-- Tokens by holders and by transfers.
create index tokens_holder_count_address_idx on tokens (holder_count desc, address desc);
drop index tokens_holder_count_idx;
create index tokens_transfer_count_address_idx on tokens (transfer_count desc, address desc);
drop index tokens_transfer_count_idx;
