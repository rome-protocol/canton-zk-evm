-- How many requests the faucet turned away, by minute (UTC) and reason. Counts only: no address, no client key and no ticket is stored with a refusal.
-- A minute is the finest bucket the stats windows use (1 h to 30 d), so every window adds up exactly. Rows exist only for minutes with a refusal.
create table faucet_refusals (
  minute timestamptz not null,
  reason text not null check (reason in ('address', 'ip', 'hour', 'captcha')),
  n      integer not null check (n > 0),
  primary key (minute, reason)
);
-- When the faucet began to count refusals (the next whole minute after this migration). A window that starts before it was not recorded, which is not the same as nothing refused.
create table faucet_refusals_since (
  since timestamptz primary key
);
insert into faucet_refusals_since (since) values (date_trunc('minute', now()) + interval '1 minute');
comment on table faucet_refusals is 'counts of faucet requests turned away, per UTC minute and reason; no address or client is stored';
comment on column faucet_refusals.reason is 'address: the same address within its window. ip: the same network address within its window. hour: the hourly cap for everyone. captcha: the human check failed';
