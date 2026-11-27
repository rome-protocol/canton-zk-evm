-- Receipts, payouts and offers are walked to the participant's ledger end (cursor meta.status_offset) while the holdings stay at the newest block's offset, so a receipt and a payout keep the offset they
-- were created at and archived (receipt) or paid (payout) at: open at B is created at or before B and not archived or paid at or before B. Rows are read again from the first offset, with their offsets.
delete from gateway_offers;
delete from gateway_payouts;
delete from gateway_receipts;
delete from meta where key in ('status_participant', 'status_offset');

alter table gateway_receipts add column created_offset bigint not null;
alter table gateway_receipts add column archived_offset bigint;
alter table gateway_payouts add column created_offset bigint not null;
alter table gateway_payouts add column paid_offset bigint;
comment on table gateway_receipts is 'the gateway''s receipts: deposits it accepted, with the offset each was created at and, once claimed or returned, archived at (deleted once the custody read is past that offset), amounts in base units of 10 decimals';
comment on table gateway_payouts is 'the payouts the gateway owes (paid_at null) and has paid (with paid_offset), amounts in base units of 10 decimals';
