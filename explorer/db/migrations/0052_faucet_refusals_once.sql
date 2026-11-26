-- A request for an address that already got its coins is turned away as 'once' when the faucet gives each address its coins once (FAUCET_ONCE_PER_ADDRESS=1). It is counted like the other refusals.
alter table faucet_refusals drop constraint faucet_refusals_reason_check;
alter table faucet_refusals add constraint faucet_refusals_reason_check check (reason in ('address', 'ip', 'hour', 'captcha', 'once'));
comment on column faucet_refusals.reason is 'address: the same address within its window. once: the address already got its coins from the faucet (once-per-address is on). ip: the same network address within its window. hour: the hourly cap for everyone. captcha: the human check failed';
