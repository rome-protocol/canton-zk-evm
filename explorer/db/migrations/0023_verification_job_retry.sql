-- A job the verifier could not run yet (the contract is not in the index, the compiler is not there) waits until `not_before` before it is taken again,
-- and is failed after a number of attempts, so one such job never stands in front of the others.
alter table verification_jobs add column attempts integer not null default 0;
alter table verification_jobs add column not_before timestamptz;
