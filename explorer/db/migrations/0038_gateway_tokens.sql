-- The tokens the gateway registered on Canton (its GatewayToken contracts) and what it holds of each token's instrument, as the indexer last read them while reading as the
-- gateway party (the custody check: GET /api/tokens/{address}). One row per registered token, replaced as a whole by each read. A row holds the instrument (admin and id, public:
-- the token's page shows them) and two numbers; no holding, owner or contract id is kept, so the per-leg Daml details stay private.
create table gateway_tokens (
  evm_token        bytea primary key check (length(evm_token) = 20),
  instrument_admin text not null check (instrument_admin <> ''),
  instrument_id    text not null check (instrument_id <> ''),
  -- The sum of the gateway's holdings of the instrument, in base units of 10 decimals (a Canton amount's own), locked holdings included.
  custody          numeric(40, 0) not null check (custody >= 0),
  holdings         integer not null check (holdings >= 0),
  -- The ledger offset the contracts were read at, and when the read finished.
  ledger_offset    bigint not null check (ledger_offset >= 0),
  read_at          timestamptz not null
);
comment on table gateway_tokens is 'the gateway''s registered tokens and its custody of each, as of one ledger offset; replaced by each read; no holding, owner or contract id';
