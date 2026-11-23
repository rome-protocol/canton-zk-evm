-- What the gateway keeps on Canton besides holdings (Daml 0.6.0), from the same walk of the updates as `gateway_holdings`: a Receipt is a deposit the gateway accepted that its recipient has not claimed yet, a
-- Payout is a withdrawal the gateway owes, and an offer is the transfer that pays one. Each is kept by the hash of its contract id (never stored), with the wrapped ERC-20 (`erc20`) its registered token stands for and the public
-- facts of the record; the sender and the paid party are never read. A receipt and an offer are deleted when archived; a payout stays, with the time it was paid.
create table gateway_receipts (
  contract_hash bytea primary key,
  erc20         bytea not null,
  deposit_id    bytea not null,
  recipient     bytea not null,
  amount        numeric not null,
  created_at    timestamptz not null
);
create index gateway_receipts_recipient_idx on gateway_receipts (recipient, created_at desc);
comment on table gateway_receipts is 'the gateway''s open receipts: deposits it accepted and their recipients have not claimed, amounts in base units of 10 decimals';

create table gateway_payouts (
  contract_hash bytea primary key,
  erc20         bytea not null,
  payout_id     bytea not null,
  amount        numeric not null,
  created_at    timestamptz not null,
  paid_at       timestamptz
);
create index gateway_payouts_payout_idx on gateway_payouts (payout_id);
comment on table gateway_payouts is 'the payouts the gateway owes (paid_at null) and has paid, amounts in base units of 10 decimals';

create table gateway_offers (
  contract_hash  bytea primary key,
  payout_id      bytea not null,
  execute_before timestamptz not null
);
create index gateway_offers_payout_idx on gateway_offers (payout_id);
comment on table gateway_offers is 'the gateway''s open offers of a payout, by the payout they pay';

-- The custody of a token is its wrapped supply plus what is open: the receipts (accepted, not yet claimed) and the unpaid payouts (burned, not yet sent), in base units of 10 decimals like `custody`.
alter table gateway_tokens add column open_receipts numeric(40,0) not null default 0;
alter table gateway_tokens add column open_payouts numeric(40,0) not null default 0;

-- The walk of the updates now also keeps receipts, payouts and offers: it starts again from the first offset, so that those created before this migration are read too (the holdings it has kept are written again as they were).
delete from meta where key in ('holdings_participant', 'holdings_offset');
