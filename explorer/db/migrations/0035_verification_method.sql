-- How a verification came in: through the Etherscan-compatible API or POST /api/verify, and the tool the submitter named when it named one. The job records it at the
-- submission, the verified source keeps it (a job is pruned after 30 days). Sources verified before this stay null: the explorer does not know.
alter table verification_jobs add column method text check (method in ('etherscan', 'api')), add column tool text check (tool in ('forge', 'hardhat', 'remix', 'unknown'));
alter table verified_sources add column method text check (method in ('etherscan', 'api')), add column tool text check (tool in ('forge', 'hardhat', 'remix', 'unknown'));
-- The contract list's count of verified contracts, read from this index alone (the count of all of them is the primary key's).
create index contracts_verified_idx on contracts (address) where verified_source is not null;
