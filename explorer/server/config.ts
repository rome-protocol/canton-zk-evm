import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther } from "viem";

/** The settings are plain environment variables. A wrong one stops the server at start with a message that names it. */
export class ConfigError extends Error {}

/** The two facts the confirmers pin: which program may prove blocks, and which ZisK release made the proof. */
export interface Pins {
  programVK: string;
  rootC: string;
  /** The name of the file they came from, which the block page shows next to them. */
  file: string;
}

export interface Config {
  host: string;
  port: number;
  chainId: number;
  chainName: string;
  /** The chain's native coin, shown everywhere an amount is shown. */
  coin: { symbol: string; decimals: number };
  rethUrl: string;
  rpcTimeoutMs: number;
  ledgerUrl: string;
  /** Canton's party id for the reader. The explorer reads Canton as this party only, so it has no default. */
  readerParty: string;
  pollMs: number;
  pins: Pins;
  faucet: {
    /** Null turns the faucet off. */
    keyFile: string | null;
    amountWei: bigint;
    perAddressSeconds: number;
    minIntervalMs: number;
  };
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

// explorer/server/ -> the repository root, where the recorded session's pins are.
const DEFAULT_PINS_FILE = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../prover/fixtures/session.txt");
const HEX32 = /^0x[0-9a-f]{64}$/;

function whole(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new ConfigError(`${name} must be a whole number of at least ${min}, not "${raw}"`);
  return Number(raw);
}

function url(env: Env, name: string, fallback: string): string {
  const raw = env[name] || fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    throw new ConfigError(`${name} must be an http or https address, not "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
}

/** Reads `key=value` lines, ignoring blank lines and lines that start with #, and returns the two pins. */
export function parsePins(text: string, file: string): Pins {
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) kv.set(m[1]!, m[2]!.trim());
  }
  const pick = (key: string): string => {
    const v = kv.get(key)?.toLowerCase();
    if (!v || !HEX32.test(v)) throw new ConfigError(`${file} has no ${key}= line of 0x and 64 hex digits`);
    return v;
  };
  return { programVK: pick("programVK"), rootC: pick("rootC"), file };
}

export function loadConfig(env: Env = process.env, readFile: ReadFile = (p) => readFileSync(p, "utf8")): Config {
  const pinsPath = env.PINS_FILE || DEFAULT_PINS_FILE;
  let pinsText: string;
  try {
    pinsText = readFile(pinsPath);
  } catch {
    throw new ConfigError(`PINS_FILE ${pinsPath} cannot be read`);
  }
  let amountWei: bigint;
  try {
    amountWei = parseEther(env.FAUCET_AMOUNT || "1");
  } catch {
    throw new ConfigError(`FAUCET_AMOUNT must be a number of coins such as 1 or 0.5, not "${env.FAUCET_AMOUNT}"`);
  }
  if (!env.READER_PARTY) throw new ConfigError("READER_PARTY must be set to the Canton party id of the reader: the explorer reads Canton as that party only");
  return {
    host: env.EXPLORER_HOST || "127.0.0.1",
    port: whole(env, "EXPLORER_PORT", 8088, 1),
    chainId: whole(env, "CHAIN_ID", 770101, 1),
    chainName: env.CHAIN_NAME || "Ostia",
    coin: { symbol: env.COIN_SYMBOL || "tROME", decimals: 18 },
    rethUrl: url(env, "RETH_RPC_URL", "http://127.0.0.1:8545"),
    rpcTimeoutMs: whole(env, "RPC_TIMEOUT_MS", 5000, 1),
    ledgerUrl: url(env, "LEDGER_URL", "http://127.0.0.1:7577"),
    readerParty: env.READER_PARTY,
    pollMs: whole(env, "POLL_MS", 2000, 100),
    pins: parsePins(pinsText, basename(pinsPath)),
    faucet: {
      keyFile: env.FAUCET_KEY_FILE || null,
      amountWei,
      perAddressSeconds: whole(env, "FAUCET_PER_ADDRESS_SECONDS", 86400, 1),
      minIntervalMs: whole(env, "FAUCET_MIN_INTERVAL_MS", 2000, 0),
    },
  };
}
