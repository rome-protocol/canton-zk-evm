import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Makes the faucet's key for this run and a copy of the run's genesis that also funds it, both in `<state>/faucet/`. The key is
 * made here, written readable by its owner only, and never returned or printed. Run this before the network starts, so that reth
 * starts from the funded copy (`CZE_GENESIS_FILE`). Nothing mints coins later, and the next run makes a new key.
 */
export interface SetUp {
  stateDir: string;
  /** The genesis to copy: the one `CZE_GENESIS_FILE` names, or `network/genesis.json`. */
  baseGenesis: string;
  /** Whole coins to fund the faucet with. */
  fundCoins?: string;
}

export interface Made { keyFile: string; genesisFile: string; address: string }

const COIN = 10n ** 18n;

export function setUpFaucet({ stateDir, baseGenesis, fundCoins = "1000000" }: SetUp): Made {
  if (!/^[1-9]\d*$/.test(fundCoins)) throw new Error(`FAUCET_FUND must be a whole number of coins, not "${fundCoins}"`);
  let base: { config?: unknown; alloc?: unknown };
  try {
    base = JSON.parse(readFileSync(baseGenesis, "utf8"));
  } catch {
    throw new Error(`the genesis ${baseGenesis} cannot be read as JSON`);
  }
  if (typeof base.config !== "object" || base.config === null || typeof base.alloc !== "object" || base.alloc === null) {
    throw new Error(`the genesis ${baseGenesis} is not a genesis: it has no config and alloc`);
  }

  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address.toLowerCase();
  const folder = join(stateDir, "faucet"), keyFile = join(folder, "key"), genesisFile = join(folder, "genesis.json");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  rmSync(keyFile, { force: true });
  writeFileSync(keyFile, key + "\n", { flag: "wx", mode: 0o600 });
  const funded = { ...base, alloc: { ...base.alloc, [address]: { balance: "0x" + (BigInt(fundCoins) * COIN).toString(16) } } };
  writeFileSync(genesisFile, JSON.stringify(funded, null, 2) + "\n");
  return { keyFile, genesisFile, address };
}

// Run as `node server/faucet-setup.ts` (explorer/faucet-setup.sh does this).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "../..");
  const env = process.env;
  try {
    const made = setUpFaucet({
      stateDir: env.CZE_STATE_DIR || join(root, "state"), baseGenesis: env.CZE_GENESIS_FILE || join(root, "network/genesis.json"), fundCoins: env.FAUCET_FUND || undefined,
    });
    console.log(`The faucet's address is ${made.address}. Its genesis funds it with ${env.FAUCET_FUND || "1000000"} ${env.COIN_SYMBOL || "tROME"}.`);
    console.log(`Start the network from that genesis:   CZE_GENESIS_FILE=${made.genesisFile} network/up.sh`);
    console.log(`Start the explorer with the key:       FAUCET_KEY_FILE=${made.keyFile}`);
  } catch (e) {
    console.error(`faucet-setup: ${(e as Error).message}`);
    process.exit(1);
  }
}
