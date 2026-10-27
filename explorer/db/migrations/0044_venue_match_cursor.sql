-- The payment match goes on from the block it last matched up to, so that its work follows the legs indexed since and not every trade ever offered.
alter table canton_venue_cursor add column matched_block bigint not null default 0 check (matched_block >= 0);
