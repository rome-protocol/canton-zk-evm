import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther } from "viem";
import type { PoolConfig } from "pg";
import { connectionConfig } from "./db/connect.ts";

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
  /** Which Canton network the chain runs on, as the header names it ("DevNet"); null when not set, and then no network is named. */
  networkName: string | null;
  /** The chain's native coin, shown everywhere an amount is shown. */
  coin: { symbol: string; decimals: number };
  rethUrl: string;
  rpcTimeoutMs: number;
  ledgerUrl: string;
  /** A file holding the bearer token for a participant that needs one (mode 0600, read on every call); null reads Canton without a token. */
  ledgerTokenFile: string | null;
  /** Canton's party id for the reader. The explorer reads Canton as this party only, so it has no default. */
  readerParty: string;
  pollMs: number;
  pins: Pins;
  publicRpc: {
    /** The public RPC at POST /rpc. Off unless PUBLIC_RPC=1. */
    on: boolean;
    /** Calls per client address per minute. A batch counts each of its calls. */
    ratePerMinute: number;
    /** The most heavy calls (eth_call, eth_estimateGas, eth_getLogs) running at one time, all clients together. */
    heavyConcurrency: number;
    /** The most heavy calls waiting for a slot; one past that is refused at once. */
    heavyQueue: number;
    /** The request header that carries the client's address, set only behind a proxy that is trusted to write it. Lower case; null means the socket's address. */
    trustedIpHeader: string | null;
  };
  /** The explorer's database, or null when none is set. With one, the tracker and the faucet keep their state in it, and TRACKER_FILE and FAUCET_STATE_FILE are only read once, to be imported. */
  database: PoolConfig | null;
  tracker: {
    /** Without a database: where the tracker keeps its list, or null for memory only. With one: the old file to import once. */
    file: string | null;
    /** The most entries it holds. */
    max: number;
    /** The most characters of signed transactions it holds for open entries. */
    maxBytes: number;
    /** The most open entries one sender may have. */
    perSender: number;
    maxPendingMinutes: number;
  };
  faucet: {
    /** Null turns the faucet off. */
    keyFile: string | null;
    /** The key that client addresses are hashed with before they are stored. Required with a database and a faucet: a file that only its owner can read. */
    clientKeyFile: string | null;
    amountWei: bigint;
    perAddressSeconds: number;
    /** One request per client address in this many seconds. */
    perIpSeconds: number;
    /** The most requests accepted in any hour, from everyone. */
    maxPerHour: number;
    /** The most transfers sent to reth in one batch. */
    batch: number;
    /** The most requests waiting for a batch. A request past it is turned away. */
    queueMax: number;
    /** Where the limits and the waiting requests are kept across restarts. Null keeps them in memory only. */
    stateFile: string | null;
  };
  /** The optional human check. Null when CAPTCHA_SECRET is not set. */
  captcha: {
    secret: string;
    verifyUrl: string;
    scriptUrl: string;
    siteKey: string;
    /** The class name the check's script looks for, to put its widget in. */
    widgetClass: string;
  } | null;
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

/** 1 turns a switch on; empty, unset or 0 leaves it off. */
function flag(env: Env, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new ConfigError(`${name} must be 1 or 0, not "${raw}"`);
}

function header(env: Env, name: string): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9-]+$/.test(raw)) throw new ConfigError(`${name} must be a header name such as X-Real-IP, not "${raw}"`);
  return raw.toLowerCase();
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

/** The human check is on when CAPTCHA_SECRET is set, and then its other four settings must be too. */
function captcha(env: Env): Config["captcha"] {
  if (!env.CAPTCHA_SECRET) return null;
  for (const name of ["CAPTCHA_VERIFY_URL", "CAPTCHA_SCRIPT_URL", "CAPTCHA_SITE_KEY", "CAPTCHA_WIDGET_CLASS"]) {
    if (!env[name]) throw new ConfigError(`${name} must be set when CAPTCHA_SECRET is set`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(env.CAPTCHA_WIDGET_CLASS!)) throw new ConfigError(`CAPTCHA_WIDGET_CLASS must be one class name, not "${env.CAPTCHA_WIDGET_CLASS}"`);
  return {
    secret: env.CAPTCHA_SECRET, verifyUrl: url(env, "CAPTCHA_VERIFY_URL", ""), scriptUrl: url(env, "CAPTCHA_SCRIPT_URL", ""),
    siteKey: env.CAPTCHA_SITE_KEY!, widgetClass: env.CAPTCHA_WIDGET_CLASS!,
  };
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

/** The database is on when it is named: EXPLORER_DATABASE_URL, or the password file of the one network/explorer-db.sh starts. */
function databaseSettings(env: Env, readFile: ReadFile): PoolConfig | null {
  if (!env.EXPLORER_DATABASE_URL && !env.EXPLORER_DB_PASSWORD_FILE) return null;
  try {
    return connectionConfig(env, readFile);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
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
    networkName: env.NETWORK_NAME?.trim() || null,
    coin: { symbol: env.COIN_SYMBOL || "tROME", decimals: 18 },
    rethUrl: url(env, "RETH_RPC_URL", "http://127.0.0.1:8545"),
    rpcTimeoutMs: whole(env, "RPC_TIMEOUT_MS", 5000, 1),
    ledgerUrl: url(env, "LEDGER_URL", "http://127.0.0.1:7577"),
    ledgerTokenFile: env.LEDGER_TOKEN_FILE || null,
    readerParty: env.READER_PARTY,
    pollMs: whole(env, "POLL_MS", 2000, 100),
    pins: parsePins(pinsText, basename(pinsPath)),
    publicRpc: {
      on: flag(env, "PUBLIC_RPC"),
      ratePerMinute: whole(env, "RPC_RATE_PER_MINUTE", 300, 1),
      heavyConcurrency: whole(env, "RPC_HEAVY_CONCURRENCY", 8, 1),
      heavyQueue: whole(env, "RPC_HEAVY_QUEUE", 16, 0),
      trustedIpHeader: header(env, "TRUSTED_IP_HEADER"),
    },
    database: databaseSettings(env, readFile),
    tracker: {
      file: env.TRACKER_FILE || null,
      max: whole(env, "TRACKER_MAX", 10000, 10),
      maxBytes: whole(env, "TRACKER_MAX_BYTES", 16 * 1024 * 1024, 1024),
      perSender: whole(env, "TRACKER_PER_SENDER", 64, 1),
      maxPendingMinutes: whole(env, "TRACKER_MAX_PENDING_MINUTES", 60, 1),
    },
    faucet: {
      keyFile: env.FAUCET_KEY_FILE || null,
      clientKeyFile: env.FAUCET_CLIENT_KEY_FILE || null,
      amountWei,
      perAddressSeconds: whole(env, "FAUCET_PER_ADDRESS_SECONDS", 86400, 1),
      perIpSeconds: whole(env, "FAUCET_PER_IP_SECONDS", 600, 1),
      maxPerHour: whole(env, "FAUCET_MAX_PER_HOUR", 5000, 1),
      batch: whole(env, "FAUCET_BATCH", 100, 1),
      queueMax: whole(env, "FAUCET_QUEUE_MAX", 5000, 1),
      stateFile: env.FAUCET_STATE_FILE || null,
    },
    captcha: captcha(env),
  };
}
