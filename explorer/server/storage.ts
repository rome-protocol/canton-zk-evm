import { existsSync, renameSync } from "node:fs";
import pg from "pg";
import { ConfigError, type Config } from "./config.ts";
import { createChainDb, type ChainDb } from "./chain-db.ts";
import { createChainRest, type ChainRest } from "./rest/chain-rest.ts";
import { createAccountRest, type AccountRest } from "./rest/account-rest.ts";
import { createEtherscanRest, type EtherscanRest } from "./rest/etherscan-rest.ts";
import { createStatsRest, type StatsRest } from "./rest/stats-rest.ts";
import { migrate } from "./db/migrate.ts";
import { TICKETS_MAX, type FaucetOptions } from "./faucet.ts";
import { clientHasher, databaseFaucetStore, fileFaucetStore, loadClientKey, type FaucetStore } from "./faucet-store.ts";
import { advisoryLeader, alwaysLeader, FAUCET_LOCK, TRACKER_LOCK, type Leader } from "./leader.ts";
import type { TrackerOptions } from "./tracker.ts";
import { databaseTrackerStore, fileTrackerStore, type TrackerStore } from "./tracker-store.ts";

/**
 * Where the tracker and the faucet keep their state. With no database set it is what it always was: the two files (or memory), one
 * instance. With one, both go to the database; only the instance that holds each loop's advisory lock runs that loop; client
 * addresses are stored only as keyed hashes; and the old files are imported once and renamed, so today's deployment moves over by
 * setting the database and the hash key.
 */
export interface Storage {
  /** Spread into createTracker's options. Empty without a database: the tracker then uses `file` as before. */
  tracker: Pick<TrackerOptions, "store" | "leader">;
  /** Spread into createFaucet's options. */
  faucet: Pick<FaucetOptions, "store" | "leader" | "clientKeyHash">;
  /** The final blocks and transactions the indexer has written, which the block and transaction routes read. Null without a database. */
  chain: ChainDb | null;
  /** The reads behind the REST routes, on the same database. */
  chainRest: ChainRest | null;
  accountRest: AccountRest | null;
  /** The reads behind the Etherscan-compatible `/api`. */
  etherscanRest: EtherscanRest | null;
  statsRest: StatsRest | null;
  /** The database's pool, for the live stream's reads. Null without a database. */
  pool: pg.Pool | null;
  /** A small pool of its own for the health route's reads and this instance's health writes, so that they never queue behind the pages' queries. Null without a database. */
  healthPool: pg.Pool | null;
  /** What was imported from the old files at open, for the log and for tests. */
  imported: { tracker: number; faucet: number };
  /** Gives up what it holds: closes the database. The leads are given up by the tracker's and the faucet's own close. */
  close(): Promise<void>;
}

const noStorage: Storage = { tracker: {}, faucet: {}, chain: null, chainRest: null, accountRest: null, statsRest: null, etherscanRest: null, pool: null, healthPool: null, imported: { tracker: 0, faucet: 0 }, close: async () => undefined };

/** The old file, once its contents are in the database: renamed, so that it is not read again and is still there to look at. */
function retire(file: string): void {
  try {
    renameSync(file, `${file}.imported`);
  } catch (e) {
    // Another instance took it a moment ago, and that is as good.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`explorer: ${file} is imported, but cannot be renamed: ${(e as Error).message}`);
  }
}

export interface OpenOptions {
  /** Runs the migrations first. A caller that has the schema already (a test) turns it off. */
  migrate?: boolean;
  now?: () => number;
}

export async function openStorage(config: Config, opts: OpenOptions = {}): Promise<Storage> {
  if (!config.database) return noStorage;
  // Checked here, where the faucet's store is opened, and not in loadConfig: the indexer reads the same settings and never opens a faucet store.
  if (config.faucet.keyFile && !config.faucet.clientKeyFile) {
    throw new ConfigError("FAUCET_CLIENT_KEY_FILE must be set when the faucet keeps its state in the database: client addresses are stored only as hashes made with that key (64 hex digits, a file only its owner can read)");
  }
  const pool = new pg.Pool({ ...config.database, max: 10 });
  pool.on("error", (e) => console.error(`explorer: the database connection failed: ${e.message}`));
  const healthPool = new pg.Pool({ ...config.database, max: 2 });
  healthPool.on("error", (e) => console.error(`explorer: the database connection failed: ${e.message}`));
  try {
    if (opts.migrate !== false) await migrate(pool);
    const trackerStore: TrackerStore = databaseTrackerStore(pool, config.tracker.max);
    const imported = { tracker: 0, faucet: 0 };

    const tf = config.tracker.file;
    if (tf && existsSync(tf)) {
      const entries = await fileTrackerStore(tf).load();
      imported.tracker = (await trackerStore.importEntries?.(entries)) ?? 0;
      retire(tf);
      console.log(`explorer: imported ${imported.tracker} tracked transactions from ${tf} into the database`);
    }

    let faucetStore: FaucetStore | undefined, clientKeyHash: ((c: string) => string) | undefined;
    if (config.faucet.keyFile) {
      clientKeyHash = clientHasher(loadClientKey(config.faucet.clientKeyFile!));
      faucetStore = databaseFaucetStore(pool, config.faucet.amountWei, opts.now);
      const sf = config.faucet.stateFile;
      if (sf && existsSync(sf)) {
        const state = await fileFaucetStore(sf).load({ now: (opts.now ?? Date.now)(), addressMs: config.faucet.perAddressSeconds * 1000, ipMs: config.faucet.perIpSeconds * 1000, max: TICKETS_MAX });
        imported.faucet = (await faucetStore.importState?.(state, clientKeyHash)) ?? 0;
        retire(sf);
        console.log(`explorer: imported ${imported.faucet} faucet requests from ${sf} into the database, their client addresses as hashes`);
      }
    }

    const leaders = (which: number): Leader => advisoryLeader(config.database as pg.ClientConfig, which);
    return {
      tracker: { store: trackerStore, leader: leaders(TRACKER_LOCK) },
      faucet: { store: faucetStore, leader: faucetStore ? leaders(FAUCET_LOCK) : alwaysLeader, clientKeyHash },
      chain: createChainDb(pool, healthPool),
      chainRest: createChainRest(pool),
      accountRest: createAccountRest(pool),
      etherscanRest: createEtherscanRest(pool),
      statsRest: createStatsRest(pool),
      pool,
      healthPool,
      imported,
      close: async () => { await Promise.all([pool.end(), healthPool.end()]); },
    };
  } catch (e) {
    await Promise.all([pool.end(), healthPool.end()]).catch(() => undefined);
    throw e;
  }
}
