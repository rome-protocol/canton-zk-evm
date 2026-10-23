-- The token list can be kept to the tokens the gateway wrapped (GET /api/tokens?gateway=true: the From Canton tab), in each order that has an index (most holders, most transfers,
-- newest). Few tokens are wrapped, so each partial index is small, and a page reads its own rows in the list's order instead of walking every token to find them.
create index tokens_gateway_holder_count_idx on tokens (holder_count desc, address desc) where gateway_wrapped;
create index tokens_gateway_transfer_count_idx on tokens (transfer_count desc, address desc) where gateway_wrapped;
create index tokens_gateway_first_transfer_idx on tokens (first_transfer_block desc, address desc) where gateway_wrapped;
