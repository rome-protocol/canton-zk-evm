-- Health: one row per check, written by the role that runs it, read by /api/health
create table health_checks (
  check_id   text primary key,                -- 'C1' to 'C10', 'index_lag', 'derive_lag', 'producer_alive',
                                              -- 'producer_state', 'api/<instance>/reth', 'verifier/compilers', ...
  status     text not null,                   -- ok, degraded, down
  value      jsonb,                           -- what was seen
  threshold  jsonb,
  changed_at timestamptz not null,            -- when the status last changed
  checked_at timestamptz not null,
  detail     text
);
