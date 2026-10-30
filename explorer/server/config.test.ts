import { describe, expect, it } from "vitest";
import { ConfigError, keyFor, loadConfig, parsePins } from "./config.ts";

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

  it("names no twin registry service until TWIN_REGISTRY_URL gives its address", () => {
    expect(load().twinRegistryUrl).toBeNull();
    expect(load({ TWIN_REGISTRY_URL: "  " }).twinRegistryUrl).toBeNull();
    expect(load({ TWIN_REGISTRY_URL: "https://twins.example.org/" }).twinRegistryUrl).toBe("https://twins.example.org");
    expect(() => load({ TWIN_REGISTRY_URL: "twins.example.org" })).toThrow(/TWIN_REGISTRY_URL must be an http or https address/);
  });

  it("keeps the public RPC off unless PUBLIC_RPC is 1, and has defaults for its limits and the tracker", () => {
    expect(load().publicRpc).toEqual({ on: false, ratePerMinute: 300, heavyConcurrency: 8, heavyQueue: 16, trustedIpHeader: null });
    expect(load().tracker).toEqual({ file: null, max: 10000, maxBytes: 16 * 1024 * 1024, perSender: 64, maxPendingMinutes: 60 });
    for (const off of ["", "0"]) expect(load({ PUBLIC_RPC: off }).publicRpc.on).toBe(false);
    expect(load({ PUBLIC_RPC: "1" }).publicRpc.on).toBe(true);
  });

  it("takes the public RPC's settings and the tracker's from the environment, and names a wrong one", () => {
    const c = load({ PUBLIC_RPC: "1", RPC_RATE_PER_MINUTE: "60", TRUSTED_IP_HEADER: "X-Real-IP", TRACKER_FILE: "/data/tracker.json", TRACKER_MAX: "50", TRACKER_MAX_BYTES: "4096", TRACKER_PER_SENDER: "3", TRACKER_MAX_PENDING_MINUTES: "15" });
    expect(c.publicRpc).toEqual({ on: true, ratePerMinute: 60, heavyConcurrency: 8, heavyQueue: 16, trustedIpHeader: "x-real-ip" });
    expect(c.tracker).toEqual({ file: "/data/tracker.json", max: 50, maxBytes: 4096, perSender: 3, maxPendingMinutes: 15 });
    expect(() => load({ PUBLIC_RPC: "yes" })).toThrow(/PUBLIC_RPC/);
    expect(() => load({ RPC_RATE_PER_MINUTE: "0" })).toThrow(/RPC_RATE_PER_MINUTE/);
    expect(load({ RPC_HEAVY_CONCURRENCY: "4", RPC_HEAVY_QUEUE: "0" }).publicRpc).toMatchObject({ heavyConcurrency: 4, heavyQueue: 0 });
    expect(() => load({ RPC_HEAVY_CONCURRENCY: "0" })).toThrow(/RPC_HEAVY_CONCURRENCY/);
    // Heavy calls hold request places (64 at once); concurrency + queue past half of them would starve light calls.
    expect(load({ RPC_HEAVY_CONCURRENCY: "8", RPC_HEAVY_QUEUE: "24" }).publicRpc).toMatchObject({ heavyConcurrency: 8, heavyQueue: 24 });
    expect(() => load({ RPC_HEAVY_CONCURRENCY: "8", RPC_HEAVY_QUEUE: "25" })).toThrow(/at most 32/);
    expect(() => load({ RPC_HEAVY_QUEUE: "60" })).toThrow(/RPC_HEAVY_QUEUE/);
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
    expect(load().pins).toEqual({ programVK: VK, rootC: ROOT, file: "guest.txt", keys: [{ fromBlock: 0, programVK: VK, rootC: ROOT, zisk: "1.3.1" }] });
  });

  it("reads the recorded session's published pins by default", () => {
    const c = loadConfig({ READER_PARTY: "reader::1220ab" }, (p) => (p.endsWith("prover/fixtures/session.txt") ? pinsFile : (() => { throw new Error(p); })()));
    expect(c.pins.file).toBe("session.txt");
  });

  it("reads the real published file when nothing else is given", () => {
    const c = loadConfig({ READER_PARTY: "reader::1220ab" });
    expect(c.pins).toEqual({
      programVK: "0x0a01bac665147bb69d8fae02c549f18dc73540f2e6734d8b38e1fb9f5074daed",
      rootC: "0x6b2490fba336fb00f0c8719a961de309a8db6f43a9bfb7575ca5f014d609b265",
      file: "session.txt",
      keys: [{
        fromBlock: 0,
        programVK: "0x0a01bac665147bb69d8fae02c549f18dc73540f2e6734d8b38e1fb9f5074daed",
        rootC: "0x6b2490fba336fb00f0c8719a961de309a8db6f43a9bfb7575ca5f014d609b265",
        // The recorded session names the release it was made with, `zisk=1.3.2-alpha`.
        zisk: "1.3.2",
      }],
    });
  });

  it("refuses a file with a missing or malformed pin, or one that cannot be read", () => {
    expect(() => parsePins(`programVK=${VK}\n`, "x.txt")).toThrow(/rootC/);
    expect(() => parsePins(`programVK=${VK}\nrootC=0x12\n`, "x.txt")).toThrow(/rootC/);
    expect(() => loadConfig({ PINS_FILE: "/nope" }, () => { throw new Error("ENOENT"); })).toThrow(/PINS_FILE/);
  });
});

describe("pin key ranges", () => {
  const VK2 = "0x" + "a2".repeat(32), ROOT2 = "0x" + "b3".repeat(32), VK3 = "0x" + "a3".repeat(32), ROOT3 = "0x" + "b4".repeat(32);
  const base = `programVK=${VK}\nrootC=${ROOT}\n`;
  const two = `${base}programVK@100=${VK2}\nrootC@100=${ROOT2}\n`;

  it("reads the old two-line file as one range from block 0", () => {
    const p = parsePins(base, "x.txt");
    expect(p.keys).toEqual([{ fromBlock: 0, programVK: VK, rootC: ROOT, zisk: "1.3.1" }]);
    expect(keyFor(p, 0)).toBe(p.keys[0]);
    expect(keyFor(p, 5_000_000)).toBe(p.keys[0]);
  });

  it("reads later ranges, and the current key is the last one", () => {
    const p = parsePins(`# a switch\n${two}programVK@250 = ${VK3}\nrootC@250=${ROOT3.toUpperCase().replace("0X", "0x")}\n`, "x.txt");
    expect(p.keys).toEqual([{ fromBlock: 0, programVK: VK, rootC: ROOT, zisk: "1.3.1" }, { fromBlock: 100, programVK: VK2, rootC: ROOT2, zisk: "1.3.1" }, { fromBlock: 250, programVK: VK3, rootC: ROOT3, zisk: "1.3.1" }]);
    expect(p).toMatchObject({ programVK: VK3, rootC: ROOT3, file: "x.txt" });
  });

  it("gives a block the last range that starts at or before it", () => {
    const p = parsePins(two, "x.txt");
    expect(keyFor(p, 0).programVK).toBe(VK);
    expect(keyFor(p, 99).programVK).toBe(VK);
    expect(keyFor(p, 100)).toEqual({ fromBlock: 100, programVK: VK2, rootC: ROOT2, zisk: "1.3.1" });
    expect(keyFor(p, 101).rootC).toBe(ROOT2);
  });

  it("refuses a range with only one of the pair, bad hex, a repeated or out-of-order block", () => {
    const bad = (extra: string, re: RegExp) => expect(() => parsePins(base + extra, "x.txt"), extra).toThrow(re);
    bad(`programVK@100=${VK2}\n`, /needs both programVK@100= and rootC@100=/);
    bad(`rootC@100=${ROOT2}\n`, /needs both programVK@100= and rootC@100=/);
    bad(`programVK@100=${VK2}\nrootC@100=0x12\n`, /rootC@100= line of 0x and 64 hex/);
    bad(`programVK@100=${VK2}\nrootC@100=${ROOT2.slice(0, -1)}g\n`, /rootC@100=/);
    bad(`programVK@100=\nrootC@100=${ROOT2}\n`, /programVK@100=/);
    bad(`programVK@100=${VK2}\nprogramVK@100=${VK3}\nrootC@100=${ROOT2}\n`, /programVK@100= is given twice/);
    bad(`programVK@0=${VK2}\nrootC@0=${ROOT2}\n`, /block number above 0/);
    bad(`programVK@abc=${VK2}\nrootC@abc=${ROOT2}\n`, /block number above 0/);
    bad(`programVK@-5=${VK2}\nrootC@-5=${ROOT2}\n`, /block number above 0/);
    bad(`programVK@007=${VK2}\nrootC@007=${ROOT2}\n`, /block number above 0/);
    bad(`programVK @100=${VK2}\nrootC@100=${ROOT2}\n`, /not a key line/);
    bad(`programvk@100=${VK2}\nrootc@100=${ROOT2}\n`, /not a key line/);
    bad(`programVK@ 100=${VK2}\nrootC@100=${ROOT2}\n`, /not a key line/);
    bad(`programVK@100 =${VK2}\nrootC@100=${ROOT2}\nfoo@1=2\n`, /not a key line/);
    for (const z of ["zisk =1.3.2", "zisk = 1.3.2", "Zisk=1.3.2"]) bad(`${z}\n`, /not a key line/);
    bad(`programVK=${VK2}\n`, /programVK= is given twice/);
    bad(`rootC=${ROOT2}\n`, /rootC= is given twice/);
    bad(`programVK@9007199254740992=${VK2}\nrootC@9007199254740993=${ROOT2}\n`, /block number above 0/);
    bad(`programVK@1234567890123456=${VK2}\nrootC@1234567890123456=${ROOT2}\n`, /block number above 0/);
    bad(`programVK@200=${VK2}\nrootC@200=${ROOT2}\nprogramVK@100=${VK3}\nrootC@100=${ROOT3}\n`, /increasing order/);
  });

  it("names the ZisK release of each range: zisk= for the first and zisk@<block>= for a later one", () => {
    const p = parsePins(`zisk=1.3.1\n${two}zisk@100=1.3.2\n`, "x.txt");
    expect(p.keys.map((k) => [k.fromBlock, k.zisk])).toEqual([[0, "1.3.1"], [100, "1.3.2"]]);
    expect(keyFor(p, 99).zisk).toBe("1.3.1");
    expect(keyFor(p, 100).zisk).toBe("1.3.2");
    expect(keyFor(p, 9_999).zisk).toBe("1.3.2");
  });

  it("reads a two-range file, 1.3.1 and then 1.3.2, with the release at the block where it changes", () => {
    const p = parsePins(`zisk=1.3.1-alpha\n${base}zisk@100 = 1.3.2-alpha\nprogramVK@100=${VK2}\nrootC@100=${ROOT2}\n`, "x.txt");
    expect(p.keys).toEqual([{ fromBlock: 0, programVK: VK, rootC: ROOT, zisk: "1.3.1" }, { fromBlock: 100, programVK: VK2, rootC: ROOT2, zisk: "1.3.2" }]);
    expect(keyFor(p, 99)).toMatchObject({ programVK: VK, zisk: "1.3.1" });
    expect(keyFor(p, 100)).toMatchObject({ programVK: VK2, zisk: "1.3.2" });
  });

  it("puts a file that names no release on 1.3.1, a later range too, and a first range on 1.3.2 when it says so", () => {
    expect(parsePins(`${base}zisk@100=1.3.2\nprogramVK@100=${VK2}\nrootC@100=${ROOT2}\nprogramVK@200=${VK3}\nrootC@200=${ROOT3}\n`, "x.txt").keys.map((k) => k.zisk)).toEqual(["1.3.1", "1.3.2", "1.3.1"]);
    expect(parsePins(`zisk=1.3.2\n${base}`, "x.txt").keys[0]!.zisk).toBe("1.3.2");
  });

  it("refuses a release it does not know, a release given twice, and a release for a range that has no key", () => {
    const bad = (extra: string, re: RegExp) => expect(() => parsePins(base + extra, "x.txt"), extra).toThrow(re);
    bad("zisk=1.2.0\n", /zisk= is "1.2.0", which is not a ZisK release/);
    bad("zisk=\n", /zisk= is ""/);
    bad("zisk=1.3.2\nzisk=1.3.1\n", /zisk= is given twice/);
    bad(`zisk@100=1.4.0\nprogramVK@100=${VK2}\nrootC@100=${ROOT2}\n`, /zisk@100= is "1.4.0"/);
    bad(`zisk@100=1.3.2\nzisk@100=1.3.2\nprogramVK@100=${VK2}\nrootC@100=${ROOT2}\n`, /zisk@100= is given twice/);
    bad("zisk@100=1.3.2\n", /needs both programVK@100= and rootC@100=/);
    bad(`zisk@0=1.3.2\n`, /block number above 0/);
    bad(`zisk @100=1.3.2\n`, /not a key line/);
  });

  it("refuses at startup, naming the file", () => {
    expect(() => load({}, `${base}programVK@100=${VK2}\n`)).toThrow(ConfigError);
    expect(load({}, two).pins.keys).toHaveLength(2);
  });
});
