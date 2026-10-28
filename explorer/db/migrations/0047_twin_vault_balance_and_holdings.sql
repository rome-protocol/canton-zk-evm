-- The vaults' balance of a twin token at the block the twin sums are counted to (meta.twin_totals_block), so that the twin card compares two numbers of the same block. Null when it was not read at that block
-- (the token did not answer, or the pass was not the one that reached the head).
alter table twin_totals add column vault_balance numeric;
comment on column twin_totals.vault_balance is 'what the registered vaults hold of the token at the block meta.twin_totals_block, null when not read there';

-- What the gateway party holds on Canton, kept from the walk of the Ledger API updates (a Holding is added when it is created and removed when it is archived), so that the custody read is a number of
-- pages of any count and not one list that a limit can cut. Only a holding the gateway owns and the instrument's admin signed is kept (a twin holding of a user is not). The key is the SHA-256 of the
-- contract id, which is never stored; nothing here is served, only the sums per instrument that `gateway_tokens` keeps.
create table gateway_holdings (
  contract_hash    bytea primary key,
  instrument_admin text not null,
  instrument_id    text not null,
  amount           numeric not null check (amount >= 0)
);
create index gateway_holdings_instrument_idx on gateway_holdings (instrument_admin, instrument_id);
comment on table gateway_holdings is 'the holdings the gateway owns, from the walk of the updates up to the offset in meta.holdings_offset of the participant in meta.holdings_participant';
