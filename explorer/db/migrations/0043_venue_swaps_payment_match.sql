-- The venue read now records which payment leg settled a trade, and the swaps list walks those rows. The two offset columns were stored and never read, so they go.
alter table canton_venue_trades drop column offered_offset;
alter table canton_funded_claims drop column funded_offset;
alter table canton_venue_trades
  add column payment_block bigint,                                     -- the payment leg that settled it, once the venue read has found it among the indexed legs
  add column payment_leg_index integer,
  add check ((payment_block is null) = (payment_leg_index is null));
-- The swaps list walks the settled trades, newest payment first, and a leg finds its trade by the same two columns.
create index on canton_venue_trades (payment_block desc, payment_leg_index desc) where payment_block is not null;
drop index gateway_legs_block_number_leg_index_idx;
