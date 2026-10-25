-- The tokens the gateway registered on Canton (its GatewayToken contracts) and what it holds of each token's instrument, as the indexer last read them while reading as the
-- gateway party (the custody check: GET /api/tokens/{address}). One row per registered token, replaced as a whole by each read. A row holds the instrument (admin and id, public:
-- the token's page shows them) and its numbers; no holding, owner or contract id is kept, so the per-leg Daml details stay private.
-- The custody and the wrapped supply are read for the SAME block: the newest indexed block B, the custody at the ledger offset of B's Canton record (the record and the
-- legs of B are one Canton update) and the token's totalSupply() at B, so the two numbers can be set against each other with nothing between them.
create table gateway_tokens (
  evm_token        bytea primary key check (length(evm_token) = 20),
  instrument_admin text not null check (instrument_admin <> ''),
  instrument_id    text not null check (instrument_id <> ''),
  -- The sum of the gateway's holdings of the instrument, in base units of 10 decimals (a Canton amount's own), locked holdings included.
  custody          numeric(40, 0) not null check (custody >= 0),
  holdings         integer not null check (holdings >= 0),
  -- The wrapped token's totalSupply() at supply_block, in the token's own base units; null when the token did not answer at that block.
  supply           numeric(78, 0) check (supply >= 0),
  -- The block both numbers are read at: the newest indexed one, whose Canton record sits at ledger_offset.
  supply_block     bigint not null check (supply_block >= 0),
  -- The ledger offset the contracts were read at, on the participant at LEDGER_URL (offsets are local to a participant), and when the read finished.
  ledger_offset    bigint not null check (ledger_offset >= 0),
  read_at          timestamptz not null
);
comment on table gateway_tokens is 'the gateway''s registered tokens and its custody of each, as of one block and the ledger offset of its record; replaced by each read; no holding, owner or contract id';
