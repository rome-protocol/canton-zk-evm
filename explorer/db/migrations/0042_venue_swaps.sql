-- The Canton side of the swaps, as the gateway party's read shows it (Daml 0.4.0). A leg is matched to it by its id, when the leg is read:
-- a payment (kind 3) by `pay_id` of a venue trade, a deposit (kind 1) by `claim_id` of a funded claim. No Canton party id is kept: not the venue's, not the seller's.
create table canton_gateway_tokens (            -- every registered token's contract the read has seen, so that a trade or a claim still names its instrument once the contract is archived
  contract_id      text primary key,
  evm_token        bytea not null check (length(evm_token) = 20),
  instrument_admin text not null check (instrument_admin <> ''),
  instrument_id    text not null check (instrument_id <> '')
);
create table canton_venue_trades (              -- a venue's trade that the gateway saw offered; its payment on the EVM settles it
  pay_id            bytea primary key check (length(pay_id) = 32),
  claim_id          bytea not null check (length(claim_id) = 32),
  token             bytea not null check (length(token) = 20),
  payee             bytea not null check (length(payee) = 20),
  recipient         bytea not null check (length(recipient) = 20),   -- the EVM buyer, who claims the wrapped token
  evm_amount        numeric(78,0) not null check (evm_amount > 0),   -- the ERC-20 amount of the payment
  gateway_token     text not null,                                   -- the registered token's contract (canton_gateway_tokens)
  offered_update_id text not null,
  offered_offset    bigint not null check (offered_offset >= 0)
);
create index on canton_venue_trades (claim_id);
create table canton_funded_claims (             -- what a settled trade leaves: the gateway holds the Canton token, the recipient may claim its wrapped form
  claim_id          bytea primary key check (length(claim_id) = 32),
  recipient         bytea not null check (length(recipient) = 20),
  amount            numeric(78,0) not null check (amount > 0),       -- the Canton side's amount, in base units of 10 decimals
  gateway_token     text not null,
  funded_update_id  text not null,                                   -- the Canton update that settled the trade (the block's own)
  funded_offset     bigint not null check (funded_offset >= 0)
);
-- How far the gateway's read has got. Offsets are local to one participant, so the cursor says whose it is; one row.
create table canton_venue_cursor (
  only_row       boolean primary key default true check (only_row),
  participant_id text not null,
  ledger_offset  bigint not null check (ledger_offset >= 0),
  read_at        timestamptz not null
);
-- The swaps list walks the payments, newest first, and takes the ones that a venue's trade is behind.
create index on gateway_legs (block_number desc, leg_index desc) where kind = 3;
