/**
 * node server/indexer/cli.ts [reset --yes | reader-moved <participant id> | clear-check C10]
 * With no argument: the indexer's write path, until a check stops it or it is told to stop. Needs the database up and migrated (node server/db/cli.ts migrate).
 * Reads RETH_RPC_URL, LEDGER_URL, READER_PARTY, CHAIN_ID and PINS_FILE as the explorer does, EXPLORER_DATABASE_URL (or the password-file
 * settings) for the database, and GATEWAY_ADDRESS, INDEX_DERIVE (inline or behind) and INDEX_TRACE_TIMEOUT_MS for itself. It exits 0 when told to stop, and 2 when a
 * check stops it, with the check's row written to health_checks as down.
 * `reset --yes` wipes the explorer's own tables for a new chain (keeping the migrations); it never runs by itself. `reader-moved <participant id>`
 * records that the reader party is now hosted by that participant (design section 4.4). Neither runs while an indexer holds the database, and reset
 * also refuses while an API instance holds the tracker or faucet lock. `clear-check C10` sets the leg hash row back to ok once a person has looked, and
 * keeps the name of who cleared it (the login user). Through npm the arguments follow `--`: `npm run explorer -- reset --yes`.
 */
import { userInfo } from "node:os";
import { Pool } from "pg";
import { loadConfig } from "../config.ts";
import { connectionConfig } from "../db/connect.ts";
import { createLedger } from "../ledger.ts";
import { clearCheck, readerMoved, resetChain } from "./admin.ts";
import { IndexerStop } from "./errors.ts";
import { createIndexer } from "./indexer.ts";
import { createFinalReads } from "./reads.ts";
import { loadIndexerSettings } from "./settings.ts";

async function admin(args: string[]): Promise<number> {
  if (args[0] === "reset" && !args.includes("--yes")) throw new Error("reset wipes every table of the explorer for a new chain; run it again with --yes to do it");
  if (args[0] === "reader-moved" && !args[1]) throw new Error("usage: reader-moved <participant id>");
  if (args[0] === "clear-check" && !args[1]) throw new Error("usage: clear-check C10");
  if (!["reset", "reader-moved", "clear-check"].includes(args[0] as string)) throw new Error("usage: node server/indexer/cli.ts [reset --yes | reader-moved <participant id> | clear-check C10]");
  const pool = new Pool(connectionConfig());
  try {
    if (args[0] === "reset") {
      const r = await resetChain(pool);
      console.log(`reset: emptied ${r.tables} tables; the next start writes the pins again`);
    } else if (args[0] === "clear-check") {
      const by = userInfo().username;
      await clearCheck(pool, args[1] as string, by);
      console.log(`clear-check: ${args[1]} is ok again, cleared by ${by}`);
    } else {
      const m = await readerMoved(pool, args[1] as string);
      console.log(`reader-moved: the reader is now on ${m.to} (was ${m.from}, last offset ${m.lastOffset}, block head ${m.head}); the indexer reads the new participant from its start`);
    }
  } finally {
    await pool.end();
  }
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.length > 2) return admin(process.argv.slice(2));
  const config = loadConfig();
  const settings = loadIndexerSettings();
  const pool = new Pool(connectionConfig());
  pool.on("error", (e) => console.error(`indexer: database connection: ${e.message}`));
  const indexer = createIndexer({
    pool, reads: createFinalReads(config.rethUrl, config.rpcTimeoutMs, settings.traceTimeoutMs), ledger: createLedger(config.ledgerUrl, config.rpcTimeoutMs, config.readerParty),
    pins: config.pins, chainId: config.chainId, gateway: settings.gateway, derive: settings.derive, pollMs: settings.pollMs, rethBehindMs: settings.rethBehindMs,
    log: (line) => console.log(line),
  });
  try {
    await indexer.open();
  } catch (e) {
    await indexer.close();
    await pool.end();
    if (e instanceof IndexerStop) { console.error(`indexer: stopped at ${e.check}: ${e.message}`); return 2; }
    throw e;
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
  await pool.end();
  return code;
}

main().then((code) => process.exit(code), (e: Error) => {
  console.error(`explorer indexer: ${e.message}`);
  process.exit(1);
});
