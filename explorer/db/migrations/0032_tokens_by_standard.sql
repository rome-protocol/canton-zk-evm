-- The token list (GET /api/tokens) can be kept to one standard, in each order that has an index (most holders, most transfers, newest). Each of these reads the rows of
-- its own standard in the list's order, so a page costs its own rows however many tokens of the other standards come between them.
create index tokens_standard_holder_count_idx on tokens (standard, holder_count desc, address desc);
create index tokens_standard_transfer_count_idx on tokens (standard, transfer_count desc, address desc);
create index tokens_standard_first_transfer_idx on tokens (standard, first_transfer_block desc, address desc);
