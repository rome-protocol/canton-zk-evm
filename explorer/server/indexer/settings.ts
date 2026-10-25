import type { DeriveShape } from "./indexer.ts";

export interface IndexerSettings { gateway: string; derive: DeriveShape; pollMs: number; rethBehindMs: number; traceTimeoutMs: number; readCallGas: number; genesisFile: string | null; journalDir: string | null; producerStatusFile: string | null; journalMs: number; custody: { party: string; tokenFile: string; ms: number; limit: number } | null }

export class IndexerSettingsError extends Error {}

type Env = Record<string, string | undefined>;

function whole(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new IndexerSettingsError(`${name} must be a whole number of at least ${min}, not "${raw}"`);
  return Number(raw);
}

/**
 * The indexer's own settings, beside the explorer's (config.ts: RETH_RPC_URL, LEDGER_URL, READER_PARTY, CHAIN_ID, PINS_FILE) and the database's
 * (EXPLORER_DATABASE_URL). `JOURNAL_DIR` is the producer's journal folder and `PRODUCER_STATUS_FILE` its status.json (both read-only; without them the health says there is no lifecycle). `GENESIS_FILE` is the chain's genesis.json (the one reth reads, with the gateway in it), whose contracts are seeded at first start. `INDEX_DERIVE` is `behind` unless it says `inline`: the default follows W1's measurement (design section 4.3).
 */
export function loadIndexerSettings(env: Env = process.env): IndexerSettings {
  const gateway = (env.GATEWAY_ADDRESS ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(gateway)) throw new IndexerSettingsError("GATEWAY_ADDRESS must be the gateway contract's address, 0x and 40 hex digits");
  const derive = env.INDEX_DERIVE || "behind";
  if (derive !== "inline" && derive !== "behind") throw new IndexerSettingsError(`INDEX_DERIVE must be inline or behind, not "${derive}"`);
  // The custody read (the registered tokens and what the gateway holds of each) reads Canton as the gateway party, with a token of its own: both or neither.
  // CUSTODY_LIMIT is how many contracts it asks for: it must be at or below the participant's list maximum (Canton's default is 200), or a cut list would pass for a whole one.
  const party = env.GATEWAY_PARTY || "", tokenFile = env.GATEWAY_LEDGER_TOKEN_FILE || "";
  if ((party === "") !== (tokenFile === "")) throw new IndexerSettingsError("GATEWAY_PARTY and GATEWAY_LEDGER_TOKEN_FILE must be set together: the custody read is made as the gateway party, with a token for it only");
  const custody = party ? { party, tokenFile, ms: whole(env, "CUSTODY_MS", 30_000, 1000), limit: whole(env, "CUSTODY_LIMIT", 200, 1) } : null;
  return { gateway, derive, pollMs: whole(env, "INDEX_POLL_MS", 250, 20), rethBehindMs: whole(env, "INDEX_RETH_BEHIND_MS", 10_000, 1), traceTimeoutMs: whole(env, "INDEX_TRACE_TIMEOUT_MS", 60_000, 1000), readCallGas: whole(env, "READ_CALL_GAS", 100_000, 21_000), genesisFile: env.GENESIS_FILE || null,
    journalDir: env.JOURNAL_DIR || null, producerStatusFile: env.PRODUCER_STATUS_FILE || null, journalMs: whole(env, "INDEX_JOURNAL_MS", 1000, 100), custody };
}
