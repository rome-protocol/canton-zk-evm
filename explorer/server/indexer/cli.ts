/**
 * node server/indexer/cli.ts [run | reindex <from> [<to>] | reindex --records <file> | export-records <file>]
 * `run` (the default) runs the indexer's write path until a check stops it or it is told to stop. Needs the database up and migrated (node server/db/cli.ts migrate).
 * Reads RETH_RPC_URL, LEDGER_URL, READER_PARTY, CHAIN_ID and PINS_FILE as the explorer does, EXPLORER_DATABASE_URL (or the password-file
 * settings) for the database, and GATEWAY_ADDRESS, GENESIS_FILE, INDEX_DERIVE (inline or behind) and INDEX_TRACE_TIMEOUT_MS for itself. It exits 0 when told to stop, and 2 when a
 * check stops it, with the check's row written to health_checks as down.
 * `reindex <from> [<to>]` works the stage 1 tables out again for a range from the stored records and reth (it can run beside the indexer, which waits while it does);
 * `export-records <file>` writes the stored records to a file; `reindex --records <file>` builds a database from such a file (the indexer must not be running).
 * The last two of these need no Canton. Exit codes: 0 done, 1 refused or failed, 2 a check stopped the work.
 */
import { Pool } from "pg";
import { loadConfig } from "../config.ts";
import { connectionConfig } from "../db/connect.ts";
import { createLedger } from "../ledger.ts";
import { parseCommand, UsageError, type Command } from "./commands.ts";
import { IndexerStop } from "./errors.ts";
import { createIndexer } from "./indexer.ts";
import { createFinalReads } from "./reads.ts";
import { readRecords, exportRecordsToFile } from "./records.ts";
import { reindexRange } from "./reindex.ts";
import { loadIndexerSettings } from "./settings.ts";

async function main(command: Command): Promise<number> {
  const config = loadConfig();
  const settings = loadIndexerSettings();
  const pool = new Pool(connectionConfig());
  pool.on("error", (e) => console.error(`indexer: database connection: ${e.message}`));
  try {
    return await dispatch(command, config, settings, pool);
  } finally {
    await pool.end();
  }
}

async function dispatch(command: Command, config: ReturnType<typeof loadConfig>, settings: ReturnType<typeof loadIndexerSettings>, pool: Pool): Promise<number> {
  const reads = createFinalReads(config.rethUrl, config.rpcTimeoutMs, settings.traceTimeoutMs);
  const log = (line: string) => console.log(line);
  if (command.kind === "export-records") {
    console.log(`export-records: wrote ${await exportRecordsToFile(pool, command.file)} records to ${command.file}`);
    return 0;
  }
  if (command.kind === "reindex") {
    const done = await reindexRange({ pool, reads, gateway: settings.gateway, log }, command.from, command.to);
    console.log(`reindex: ${done.blocks} blocks, ${done.from} to ${done.to}; stage 2 will work them out again`);
    return 0;
  }
  const indexer = createIndexer({
    pool, reads, ledger: createLedger(config.ledgerUrl, config.rpcTimeoutMs, config.readerParty),
    pins: config.pins, chainId: config.chainId, gateway: settings.gateway, genesisFile: settings.genesisFile, derive: settings.derive, pollMs: settings.pollMs, rethBehindMs: settings.rethBehindMs,
    log,
  });
  if (!settings.genesisFile) throw new Error("GENESIS_FILE must name the chain's genesis.json: its contracts are seeded at first start");
  try {
    await indexer.open();
  } catch (e) {
    await indexer.close(); // gives back the lock a failed start may hold, so that the pool can end
    throw e;
  }
  if (command.kind === "rebuild") {
    try {
      console.log(`reindex: built ${await indexer.rebuild(readRecords(command.records))} blocks from ${command.records}`);
      return 0;
    } catch (e) {
      if (e instanceof IndexerStop) { console.error(`reindex: stopped at ${e.check}: ${e.message}`); return 2; }
      throw e;
    } finally {
      await indexer.close();
    }
  }
  console.log(`indexer: running, stage 2 ${settings.derive}`);
  let code = 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((ok) => { finish = ok; });
  const halt = await indexer.start((e) => { code = 2; console.error(`indexer: stopped at ${e.check}: ${e.message}`); finish(); });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, finish);
  await done;
  await halt();
  await indexer.close();
  return code;
}

let command: Command;
try {
  command = parseCommand(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof UsageError ? e.message : `explorer indexer: ${(e as Error).message}`);
  process.exit(1);
}
main(command).then((code) => process.exit(code), (e: Error) => {
  console.error(`explorer indexer: ${e.message}`);
  process.exit(1);
});
