import { ConfigError, type Config } from "./config.ts";
import { createLedger, readLedgerToken } from "./ledger.ts";

type LedgerConfig = Pick<Config, "ledgerUrl" | "rpcTimeoutMs" | "readerParty" | "ledgerTokenFile">;

/**
 * The one place the explorer server and the indexer build their Ledger API client from the settings, so both carry LEDGER_TOKEN_FILE.
 * A token file that is missing, open to others or malformed stops the process here, at start, with a message that names LEDGER_TOKEN_FILE;
 * the file is still read again on every call, so a token that a refresh job rewrites is picked up.
 */
export function ledgerFromConfig(config: LedgerConfig, pageSize?: number) {
  if (config.ledgerTokenFile) {
    try {
      readLedgerToken(config.ledgerTokenFile);
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
  }
  return createLedger(config.ledgerUrl, config.rpcTimeoutMs, config.readerParty, pageSize, config.ledgerTokenFile);
}
