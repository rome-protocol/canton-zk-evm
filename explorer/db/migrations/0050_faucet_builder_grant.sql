-- The faucet's builder grant: a GitHub account gets a larger amount, once in a period. A grant is a faucet request that also holds the keyed hash of the GitHub
-- account it was given to (never the account's id or name), so the same account can be told from another and from nobody. Plain requests leave it null, and it is
-- cleared with the client key after the retention window. The amount column already holds each request's own amount.
alter table faucet_requests add column builder_account bytea;
create index faucet_requests_builder_account_idx on faucet_requests (builder_account, requested_at desc) where builder_account is not null;
-- The day's count of grants reads the grants of the last 24 hours.
create index faucet_requests_builder_requested_at_idx on faucet_requests (requested_at) where builder_account is not null;
comment on column faucet_requests.builder_account is 'a builder grant: the keyed hash of the GitHub account id; null for a plain request';
