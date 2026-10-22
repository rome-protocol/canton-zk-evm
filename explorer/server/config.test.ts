import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parsePins } from "./config.ts";

const VK = "0x" + "ab".repeat(32);
const ROOT = "0x" + "cd".repeat(32);
const pinsFile = `# stand-in pins\nchain_id=770101\nprogramVK=${VK}\nrootC=${ROOT}\n`;
const load = (env: Record<string, string> = {}, file = pinsFile) => loadConfig({ PINS_FILE: "/run/net/guest.txt", READER_PARTY: "reader::1220ab", ...env }, () => file);

describe("the database for the tracker and the faucet", () => {
  it("is on when it is named, and the faucet then needs the key its client hashes are made with", () => {
    expect(load({ EXPLORER_DATABASE_URL: "postgres://u@h/d" }).database).toEqual({ connectionString: "postgres://u@h/d" });
    expect(load({ EXPLORER_DATABASE_URL: "postgres://u@h/d" }).faucet.clientKeyFile).toBeNull();
    // Loading the settings never refuses it: the indexer loads the same settings with a faucet key in its environment and has no faucet. Opening the storage does (storage.test.ts).
    expect(load({ EXPLORER_DATABASE_URL: "postgres://u@h/d", FAUCET_KEY_FILE: "/k" }).faucet.clientKeyFile).toBeNull();
    const c = load({ EXPLORER_DATABASE_URL: "postgres://u@h/d", FAUCET_KEY_FILE: "/k", FAUCET_CLIENT_KEY_FILE: "/ck" });
    expect(c.faucet.clientKeyFile).toBe("/ck");
    expect(load({ FAUCET_KEY_FILE: "/k" }).database).toBeNull(); // files only: no hash key needed
  });

  it("says in a ConfigError, naming the file, when the password file has no password", () => {
    expect(() => load({ EXPLORER_DB_PASSWORD_FILE: "/run/pw" })).toThrow(ConfigError);
    expect(() => load({ EXPLORER_DB_PASSWORD_FILE: "/run/pw" })).toThrow(/POSTGRES_PASSWORD/);
  });
});

describe("settings", () => {
  it("has working defaults, and the chain's coin is tROME", () => {
    const c = load();
    expect(c).toMatchObject({
      host: "127.0.0.1", port: 8088, chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 },
      rethUrl: "http://127.0.0.1:8545", ledgerUrl: "http://127.0.0.1:7577", readerParty: "reader::1220ab", ledgerTokenFile: null, pollMs: 2000,
    });
    expect(c.database).toBeNull();
    expect(c.faucet).toEqual({ keyFile: null, clientKeyFile: null, amountWei: 10n ** 18n, perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 5000, batch: 100, queueMax: 5000, stateFile: null });
    expect(c.captcha).toBeNull();
  });

  it("names no network until NETWORK_NAME says which one this is", () => {
    expect(load().networkName).toBeNull();
    expect(load({ NETWORK_NAME: "DevNet" }).networkName).toBe("DevNet");
    expect(load({ NETWORK_NAME: "  " }).networkName).toBeNull();
  });

  it("keeps the public RPC off unless PUBLIC_RPC is 1, and has defaults for its limits and the tracker", () => {
    expect(load().publicRpc).toEqual({ on: false, ratePerMinute: 300, trustedIpHeader: null });
    expect(load().tracker).toEqual({ file: null, max: 10000, maxBytes: 16 * 1024 * 1024, perSender: 64, maxPendingMinutes: 60 });
    for (const off of ["", "0"]) expect(load({ PUBLIC_RPC: off }).publicRpc.on).toBe(false);
    expect(load({ PUBLIC_RPC: "1" }).publicRpc.on).toBe(true);
  });

  it("takes the public RPC's settings and the tracker's from the environment, and names a wrong one", () => {
    const c = load({ PUBLIC_RPC: "1", RPC_RATE_PER_MINUTE: "60", TRUSTED_IP_HEADER: "X-Real-IP", TRACKER_FILE: "/data/tracker.json", TRACKER_MAX: "50", TRACKER_MAX_BYTES: "4096", TRACKER_PER_SENDER: "3", TRACKER_MAX_PENDING_MINUTES: "15" });
    expect(c.publicRpc).toEqual({ on: true, ratePerMinute: 60, trustedIpHeader: "x-real-ip" });
    expect(c.tracker).toEqual({ file: "/data/tracker.json", max: 50, maxBytes: 4096, perSender: 3, maxPendingMinutes: 15 });
    expect(() => load({ PUBLIC_RPC: "yes" })).toThrow(/PUBLIC_RPC/);
    expect(() => load({ RPC_RATE_PER_MINUTE: "0" })).toThrow(/RPC_RATE_PER_MINUTE/);
    expect(() => load({ TRUSTED_IP_HEADER: "bad header" })).toThrow(/TRUSTED_IP_HEADER/);
    expect(() => load({ TRACKER_MAX: "2" })).toThrow(/TRACKER_MAX/);
    expect(() => load({ TRACKER_MAX_BYTES: "10" })).toThrow(/TRACKER_MAX_BYTES/);
    expect(() => load({ TRACKER_PER_SENDER: "0" })).toThrow(/TRACKER_PER_SENDER/);
  });

  it("takes every setting from the environment", () => {
    const c = load({ EXPLORER_PORT: "9000", RETH_RPC_URL: "http://reth:8545/", FAUCET_KEY_FILE: "/run/faucet/key", FAUCET_AMOUNT: "0.5", READER_PARTY: "reader::1220ab", COIN_SYMBOL: "TEST" });
    expect(c).toMatchObject({ port: 9000, rethUrl: "http://reth:8545", readerParty: "reader::1220ab", coin: { symbol: "TEST" } });
    expect(c.faucet).toMatchObject({ keyFile: "/run/faucet/key", amountWei: 5n * 10n ** 17n });
  });

  it("takes the faucet's limits, batch, line and state file from the environment", () => {
    const c = load({ FAUCET_PER_IP_SECONDS: "60", FAUCET_MAX_PER_HOUR: "100", FAUCET_BATCH: "10", FAUCET_QUEUE_MAX: "20", FAUCET_STATE_FILE: "/data/faucet.json" });
    expect(c.faucet).toMatchObject({ perIpSeconds: 60, maxPerHour: 100, batch: 10, queueMax: 20, stateFile: "/data/faucet.json" });
    for (const name of ["FAUCET_PER_IP_SECONDS", "FAUCET_MAX_PER_HOUR", "FAUCET_BATCH", "FAUCET_QUEUE_MAX"]) {
      expect(() => load({ [name]: "0" })).toThrow(name);
      expect(() => load({ [name]: "many" })).toThrow(name);
    }
  });

  it("turns the human check on only with all five settings, and names the one that is missing", () => {
    const all = { CAPTCHA_SECRET: "s", CAPTCHA_VERIFY_URL: "https://check.example/verify", CAPTCHA_SCRIPT_URL: "https://check.example/api.js", CAPTCHA_SITE_KEY: "key", CAPTCHA_WIDGET_CLASS: "human-check" };
    expect(load(all).captcha).toEqual({ secret: "s", verifyUrl: "https://check.example/verify", scriptUrl: "https://check.example/api.js", siteKey: "key", widgetClass: "human-check" });
    for (const name of Object.keys(all).filter((n) => n !== "CAPTCHA_SECRET")) expect(() => load({ ...all, [name]: "" })).toThrow(name);
    expect(() => load({ ...all, CAPTCHA_VERIFY_URL: "check.example" })).toThrow(/CAPTCHA_VERIFY_URL/);
    expect(() => load({ ...all, CAPTCHA_WIDGET_CLASS: "two classes" })).toThrow(/CAPTCHA_WIDGET_CLASS/);
    expect(load({ ...all, CAPTCHA_SECRET: "" }).captcha).toBeNull();
  });

  it("takes the Ledger API token file from LEDGER_TOKEN_FILE, and none when it is not set", () => {
    expect(load({ LEDGER_TOKEN_FILE: "/run/explorer/ledger-token" }).ledgerTokenFile).toBe("/run/explorer/ledger-token");
    expect(load({ LEDGER_TOKEN_FILE: "" }).ledgerTokenFile).toBeNull();
  });

  it("names the setting that is wrong", () => {
    expect(() => load({ EXPLORER_PORT: "eighty" })).toThrow(/EXPLORER_PORT/);
    expect(() => load({ RETH_RPC_URL: "127.0.0.1:8545" })).toThrow(/RETH_RPC_URL/);
    expect(() => load({ LEDGER_URL: "ftp://x" })).toThrow(/LEDGER_URL/);
    expect(() => load({ FAUCET_AMOUNT: "lots" })).toThrow(/FAUCET_AMOUNT/);
    expect(() => load({ POLL_MS: "5" })).toThrow(ConfigError);
  });

  it("stops at start, naming READER_PARTY, when the reader party is not set", () => {
    expect(() => load({ READER_PARTY: "" })).toThrow(ConfigError);
    expect(() => load({ READER_PARTY: "" })).toThrow(/READER_PARTY/);
    expect(() => loadConfig({ PINS_FILE: "guest.txt" }, () => pinsFile)).toThrow(/READER_PARTY/);
  });
});

describe("pins", () => {
  it("reads programVK and rootC from the file named by PINS_FILE, and names the file", () => {
    expect(load().pins).toEqual({ programVK: VK, rootC: ROOT, file: "guest.txt" });
  });

  it("reads the recorded session's published pins by default", () => {
    const c = loadConfig({ READER_PARTY: "reader::1220ab" }, (p) => (p.endsWith("prover/fixtures/session.txt") ? pinsFile : (() => { throw new Error(p); })()));
    expect(c.pins.file).toBe("session.txt");
  });

  it("reads the real published file when nothing else is given", () => {
    const c = loadConfig({ READER_PARTY: "reader::1220ab" });
    expect(c.pins).toEqual({
      programVK: "0xdb79251d9e962ee45fbc28cc6431a7fb894106f06d6664e623189f28c24f6d3f",
      rootC: "0xc3f12b9f8707c6a1e96df2bf6702c2ebdfbafedabeac654644a380befe091ac4",
      file: "session.txt",
    });
  });

  it("refuses a file with a missing or malformed pin, or one that cannot be read", () => {
    expect(() => parsePins(`programVK=${VK}\n`, "x.txt")).toThrow(/rootC/);
    expect(() => parsePins(`programVK=${VK}\nrootC=0x12\n`, "x.txt")).toThrow(/rootC/);
    expect(() => loadConfig({ PINS_FILE: "/nope" }, () => { throw new Error("ENOENT"); })).toThrow(/PINS_FILE/);
  });
});
