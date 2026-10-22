-- Verification (design sections 5.2 and 6.3): how the creation code matched, and checks on the values the verifier writes.
alter table verified_sources add column creation_match text;  -- full or partial; null when there was no creation code to compare (a genesis contract)
alter table verified_sources add constraint verified_sources_match_type check (match_type in ('full', 'partial'));
alter table verified_sources add constraint verified_sources_creation_match check (creation_match in ('full', 'partial'));
alter table verified_sources add constraint verified_sources_code_format check (code_format in ('solidity-single-file', 'solidity-standard-json-input'));
alter table contracts add constraint contracts_match_type check (match_type in ('full', 'partial', 'similar'));
alter table contracts add constraint contracts_verified_source_fk foreign key (verified_source) references verified_sources (id);
alter table verification_jobs add constraint verification_jobs_kind check (kind in ('source', 'proxy'));
alter table verification_jobs add constraint verification_jobs_status check (status in ('pending', 'running', 'pass', 'fail', 'already'));
