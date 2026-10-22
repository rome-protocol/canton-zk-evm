-- The background check of balances reads the rows with no check yet, oldest first. A row whose token did not answer balanceOf is marked `unanswered`
-- (checked_block stays null, since balanceOf never agreed) and is not offered again until a block touches it. The index holds only the rows the check
-- still has to read, so a turn costs the same on a table of millions (a checked or unanswered row leaves the index).
alter table token_balances add column unanswered boolean not null default false;
create index token_balances_unchecked_idx on token_balances (updated_block, token, holder, token_id) where checked_block is null and not unanswered;
-- A block with an Upgraded(address) log looks up the proxies behind that beacon.
create index proxies_beacon_idx on proxies (beacon) where beacon is not null;
-- Metadata that failed is read again with a growing wait between attempts, oldest attempt first.
alter table tokens add column metadata_attempts int not null default 0;
alter table tokens add column metadata_attempt_block bigint;
create index tokens_metadata_retry_idx on tokens (metadata_attempt_block nulls first, address) where metadata_status <> 'read';
