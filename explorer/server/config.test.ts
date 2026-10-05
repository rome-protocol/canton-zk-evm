import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parsePins } from "./config.ts";

const VK = "0x" + "ab".repeat(32);
const ROOT = "0x" + "cd".repeat(32);
const pinsFile = `# stand-in pins\nchain_id=770101\nprogramVK=${VK}\nrootC=${ROOT}\n`;
const load = (env: Record<string, string> = {}, file = pinsFile) => loadConfig({ PINS_FILE: "/run/net/guest.txt", READER_PARTY: "reader::1220ab", ...env }, () => file);

describe("settings", () => {
  it("has working defaults, and the chain's coin is tROME", () => {
    const c = load();
    expect(c).toMatchObject({
      host: "127.0.0.1", port: 8088, chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 },
      rethUrl: "http://127.0.0.1:8545", ledgerUrl: "http://127.0.0.1:7577", readerParty: "reader::1220ab", pollMs: 2000,
    });
    expect(c.faucet).toEqual({ keyFile: null, amountWei: 10n ** 18n, perAddressSeconds: 86400, minIntervalMs: 2000 });
  });

  it("takes every setting from the environment", () => {
    const c = load({ EXPLORER_PORT: "9000", RETH_RPC_URL: "http://reth:8545/", FAUCET_KEY_FILE: "/run/faucet/key", FAUCET_AMOUNT: "0.5", READER_PARTY: "reader::1220ab", COIN_SYMBOL: "TEST" });
    expect(c).toMatchObject({ port: 9000, rethUrl: "http://reth:8545", readerParty: "reader::1220ab", coin: { symbol: "TEST" } });
    expect(c.faucet).toMatchObject({ keyFile: "/run/faucet/key", amountWei: 5n * 10n ** 17n });
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
