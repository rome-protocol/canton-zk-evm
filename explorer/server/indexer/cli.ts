/**
 * node server/indexer/cli.ts
 * Runs the indexer's write path until a check stops it or it is told to stop. Needs the database up and migrated (node server/db/cli.ts migrate).
 * Reads RETH_RPC_URL, LEDGER_URL, READER_PARTY, CHAIN_ID and PINS_FILE as the explorer does, EXPLORER_DATABASE_URL (or the password-file
 * settings) for the database, and GATEWAY_ADDRESS, INDEX_DERIVE (inline or behind) and INDEX_TRACE_TIMEOUT_MS for itself. It exits 0 when told to stop, and 2 when a
 * check stops it, with the check's row written to health_checks as down.
 */
import { Pool } from "pg";
import { loadConfig } from "../config.ts";
import { connectionConfig } from "../db/connect.ts";
import { createLedger } from "../ledger.ts";
import { createIndexer } from "./indexer.ts";
import { createFinalReads } from "./reads.ts";
import { loadIndexerSettings } from "./settings.ts";

async function main(): Promise<number> {
  const config = loadConfig();
  const settings = loadIndexerSettings();
  const pool = new Pool(connectionConfig());
  pool.on("error", (e) => console.error(`indexer: database connection: ${e.message}`));
  const indexer = createIndexer({
    pool, reads: createFinalReads(config.rethUrl, config.rpcTimeoutMs, settings.traceTimeoutMs), ledger: createLedger(config.ledgerUrl, config.rpcTimeoutMs, config.readerParty),
    pins: config.pins, chainId: config.chainId, gateway: settings.gateway, derive: settings.derive, pollMs: settings.pollMs, rethBehindMs: settings.rethBehindMs,
    log: (line) => console.log(line),
  });
  await indexer.open();
  console.log(`indexer: running, stage 2 ${settings.derive}`);
  let code = 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((ok) => { finish = ok; });
  const halt = await indexer.start((e) => { code = 2; console.error(`indexer: stopped at ${e.check}: ${e.message}`); finish(); });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, finish);
  await done;
  await halt();
  await indexer.close();
  await pool.end();
  return code;
}

main().then((code) => process.exit(code), (e: Error) => {
  console.error(`explorer indexer: ${e.message}`);
  process.exit(1);
});
