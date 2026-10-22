import type { DeriveShape } from "./indexer.ts";

export interface IndexerSettings { gateway: string; derive: DeriveShape; pollMs: number; rethBehindMs: number; traceTimeoutMs: number; genesisFile: string | null; journalDir: string | null; producerStatusFile: string | null; journalMs: number }

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
  return { gateway, derive, pollMs: whole(env, "INDEX_POLL_MS", 250, 20), rethBehindMs: whole(env, "INDEX_RETH_BEHIND_MS", 10_000, 1), traceTimeoutMs: whole(env, "INDEX_TRACE_TIMEOUT_MS", 60_000, 1000), genesisFile: env.GENESIS_FILE || null,
    journalDir: env.JOURNAL_DIR || null, producerStatusFile: env.PRODUCER_STATUS_FILE || null, journalMs: whole(env, "INDEX_JOURNAL_MS", 1000, 100) };
}
