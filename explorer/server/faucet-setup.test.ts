import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { loadFaucetKey } from "./faucet.ts";
import { setUpFaucet } from "./faucet-setup.ts";

const REPO = resolve(import.meta.dirname, "../..");
const COIN = 10n ** 18n;
const BASE = { config: { chainId: 770101, londonBlock: 0 }, gasLimit: "0x1c9c380", alloc: { "0x00000961ef480eb55e80d19ad83579a64c007002": { balance: "0x0", code: "0x60" } } };

let dir: string, base: string, state: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "faucet-setup-"));
  base = join(dir, "base.json");
  state = join(dir, "state");
  writeFileSync(base, JSON.stringify(BASE));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as typeof BASE & { alloc: Record<string, { balance: string }> };

describe("the faucet's key and genesis", () => {
  it("makes a key that only its owner can read, and funds its address with 1,000,000 coins in a copy of the genesis", () => {
    const r = setUpFaucet({ stateDir: state, baseGenesis: base });
    expect(r.keyFile).toBe(join(state, "faucet", "key"));
    expect(mode(r.keyFile)).toBe("600");
    expect(mode(join(state, "faucet"))).toBe("700");
    const key = loadFaucetKey(r.keyFile)!;
    expect(r.address).toBe(privateKeyToAccount(key).address.toLowerCase());
    const genesis = read(r.genesisFile);
    expect(BigInt(genesis.alloc[r.address]!.balance)).toBe(1_000_000n * COIN);
  });

  it("changes nothing else: the chain settings and every other account stay as they were, and the base file is untouched", () => {
    const r = setUpFaucet({ stateDir: state, baseGenesis: base });
    const { [r.address]: _funded, ...rest } = read(r.genesisFile).alloc;
    expect(rest).toEqual(BASE.alloc);
    expect(read(r.genesisFile)).toMatchObject({ config: BASE.config, gasLimit: BASE.gasLimit });
    expect(JSON.parse(readFileSync(base, "utf8"))).toEqual(BASE);
  });

  it("makes a fresh key each run, and the new genesis funds only the new key when it starts from the base again", () => {
    const first = setUpFaucet({ stateDir: state, baseGenesis: base });
    const second = setUpFaucet({ stateDir: state, baseGenesis: base });
    expect(second.address).not.toBe(first.address);
    expect(loadFaucetKey(second.keyFile)).not.toBeNull();
    expect(Object.keys(read(second.genesisFile).alloc)).not.toContain(first.address);
    expect(mode(second.keyFile)).toBe("600");
  });

  it("takes the amount from the setting, in whole coins", () => {
    const r = setUpFaucet({ stateDir: state, baseGenesis: base, fundCoins: "25" });
    expect(BigInt(read(r.genesisFile).alloc[r.address]!.balance)).toBe(25n * COIN);
    for (const bad of ["lots", "0", "-1", "1.5", ""]) expect(() => setUpFaucet({ stateDir: state, baseGenesis: base, fundCoins: bad })).toThrow(/FAUCET_FUND/);
  });

  it("stops when the genesis cannot be read or is not a genesis, and leaves no key behind", () => {
    expect(() => setUpFaucet({ stateDir: state, baseGenesis: join(dir, "missing.json") })).toThrow(/genesis/);
    writeFileSync(base, "{}");
    expect(() => setUpFaucet({ stateDir: state, baseGenesis: base })).toThrow(/genesis/);
    expect(() => statSync(join(state, "faucet", "key"))).toThrow();
  });
});

describe("faucet-setup.sh", () => {
  const run = (env: Record<string, string>) => spawnSync("sh", [join(REPO, "explorer/faucet-setup.sh")], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });

  it("runs on the genesis CZE_GENESIS_FILE names, and prints the address and what to do next, but never the key", () => {
    const out = run({ CZE_STATE_DIR: state, CZE_GENESIS_FILE: base });
    expect(out.status).toBe(0);
    const key = readFileSync(join(state, "faucet", "key"), "utf8").trim();
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.stdout + out.stderr).not.toContain(key.slice(2));
    const address = privateKeyToAccount(key as `0x${string}`).address.toLowerCase();
    expect(out.stdout).toContain(address);
    expect(out.stdout).toContain(`CZE_GENESIS_FILE=${join(state, "faucet", "genesis.json")}`);
    expect(out.stdout).toContain(`FAUCET_KEY_FILE=${join(state, "faucet", "key")}`);
    expect(mode(join(state, "faucet", "key"))).toBe("600");
    expect(BigInt(read(join(state, "faucet", "genesis.json")).alloc[address]!.balance)).toBe(1_000_000n * COIN);
  });

  it("starts from network/genesis.json when CZE_GENESIS_FILE is not set, and keeps its chain settings, which make-state.sh checks", () => {
    const out = run({ CZE_STATE_DIR: state });
    expect(out.status).toBe(0);
    const pinned = JSON.parse(readFileSync(join(REPO, "network/genesis.json"), "utf8"));
    expect(read(join(state, "faucet", "genesis.json")).config).toEqual(pinned.config);
  });

  it("stops with a message, and no key in it, when the genesis is missing", () => {
    const out = run({ CZE_STATE_DIR: state, CZE_GENESIS_FILE: join(dir, "nope.json") });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/genesis/);
    expect(out.stdout).toBe("");
  });
});
