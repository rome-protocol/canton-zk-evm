-- Faucet requests are kept 90 days. When a settled request is older, its row goes and its day's count stays here.
create table faucet_daily_counts (
  day      date primary key,                 -- the day of the request, in UTC
  requests integer not null,
  failed   integer not null
);
-- `nonce` holds the nonce of the payout for as long as the request lives, as it was first designed to. `sent_nonce` (0012) is the faucet's own copy for its logic.
comment on column faucet_requests.nonce is 'the payout''s nonce: set when the batch is signed, and kept after it is sent';
