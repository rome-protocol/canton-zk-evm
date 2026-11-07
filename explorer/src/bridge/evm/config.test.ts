import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import type { ApiStatus, TwinsOverview } from "../../api.ts";
import { bridgePins } from "../../../bridge-pins.ts";
import { apiDeps, BUILD_PINS, loadBridgeConfig, type BridgePins, type ConfigDeps } from "./config.ts";

const status = { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } } as ApiStatus;
const GATEWAY = "0xa7E0000000000000000000000000000000000000";
const [VAULT, TKA, WTROME, WCC] = ["0xABCDEF" + "0".repeat(34), "0xF" + "1".repeat(39), "0xC" + "2".repeat(39), "0xD" + "3".repeat(39)];
const CODE = ("0x" + "60".repeat(120)) as Hex;
const pins: BridgePins = { gateway: GATEWAY.toLowerCase() as Address, vaultCodeHashes: [keccak256(CODE)], wrapper: WTROME.toLowerCase() as Address };
const word = (v: string | number | bigint) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const line = (token: string, symbol: string) => ({ token, symbol, name: symbol, decimals: 18, supply: "0", vaultBalance: "0", matched: true, locks: 0, releases: 0, through: 5 });
const wrappedLine = (token: string) => ({ token, symbol: "wCC", name: "wCC", decimals: 10, instrumentAdmin: "dso::1220ab", instrumentId: "Amulet", custody: "0", custodyDecimals: 10, holdings: 0, supply: "0", supplyBlock: 5, matched: true, ledgerOffset: 1, readAt: "" });
const overview = (o: Partial<TwinsOverview> = {}): TwinsOverview => ({
  through: 5, registryService: "https://x.example/twin-registry/", vaults: [{ address: VAULT, codeHash: "0x00" }],
  twins: [line(TKA, "TKA"), line(WTROME, "WtROME")],
  canton: [wrappedLine(WCC)],
  legs: [], ...o,
});
/** A chain that answers as the pinned one does, unless a test changes one answer. */
interface Chain { gateway?: string; code?: Hex; decimals?: Record<string, number>; registered?: string[] }
const deps = (o: Partial<TwinsOverview> = {}, chain: Chain = {}): ConfigDeps => ({
  status: async () => status, twins: async () => overview(o),
  code: async () => chain.code ?? CODE,
  call: vi.fn(async (to: string, data: string) => {
    if (data.startsWith(toFunctionSelector("GATEWAY()"))) return word(chain.gateway ?? GATEWAY);
    if (data.startsWith(toFunctionSelector("decimals()"))) return word(chain.decimals?.[to.toLowerCase()] ?? (to.toLowerCase() === WCC.toLowerCase() ? 10 : 18));
    if (data.startsWith(toFunctionSelector("wrapped(address)"))) return word((chain.registered ?? [WCC]).some((a) => data.toLowerCase().endsWith(a.slice(2).toLowerCase())) ? 1 : 0);
    throw new Error("unexpected call");
  }),
});

describe("loadBridgeConfig", () => {
  it("takes the registry and the tokens' names from the explorer's API, and checks the vault, the gateway, the wrapped tokens and every decimals value on the chain", async () => {
    const d = deps();
    const c = await loadBridgeConfig(d, pins);
    expect(d.call).toHaveBeenCalledWith(VAULT.toLowerCase(), expect.stringMatching(/^0x[0-9a-f]{8}$/));
    expect(c.gateway).toBe(GATEWAY.toLowerCase());
    expect(c.vault).toBe(VAULT.toLowerCase());
    expect(c.vaults).toEqual([VAULT.toLowerCase()]);
    expect(c.registryUrl).toBe("https://x.example/twin-registry");
    expect(c.twins.map((t) => [t.symbol, t.decimals])).toEqual([["TKA", 18], ["WtROME", 18]]);
    expect(c.wrapper).toBe(WTROME.toLowerCase());
    expect(c.wrapped).toEqual([{ address: WCC.toLowerCase(), symbol: "wCC", decimals: 10, instrument: { admin: "dso::1220ab", id: "Amulet" } }]);
    expect(c.chain.chainId).toBe(770101);
  });
  it("says so when the deployment has no registry service or no vault", async () => {
    await expect(loadBridgeConfig(deps({ registryService: null }), pins)).rejects.toThrow("no twin registry");
    await expect(loadBridgeConfig(deps({ vaults: [] }), pins)).rejects.toThrow("no registered vault");
  });
  it("M7: a vault whose GATEWAY() is not the pinned gateway is refused", async () => {
    await expect(loadBridgeConfig(deps({}, { gateway: "0x" + "99".repeat(20) }), pins)).rejects.toThrow("no vault that matches");
  });
  it("M7: a vault whose code is not the pinned code is refused", async () => {
    await expect(loadBridgeConfig(deps({}, { code: ("0x" + "61".repeat(120)) as Hex }), pins)).rejects.toThrow("no vault that matches");
  });
  it("M7: a wrapped token the gateway did not register is left out, and so is one that is not 10 decimals", async () => {
    const other = "0xE" + "4".repeat(39), odd = "0xF" + "5".repeat(39);
    const o = { canton: [wrappedLine(WCC), wrappedLine(other), wrappedLine(odd)] };
    const c = await loadBridgeConfig(deps(o, { registered: [WCC, odd], decimals: { [other.toLowerCase()]: 10, [odd.toLowerCase()]: 18 } }), pins);
    expect(c.wrapped.map((t) => t.address)).toEqual([WCC.toLowerCase()]);
  });
  it("M7: decimals come from the chain, not from the API", async () => {
    const c = await loadBridgeConfig(deps({}, { decimals: { [TKA.toLowerCase()]: 6 } }), pins);
    expect(c.twins.find((t) => t.symbol === "TKA")!.decimals).toBe(6);
  });
  it("L8: the build pins the literal values: the gateway of PINS and the hash of gateway/Vault.bin-runtime", () => {
    expect(BUILD_PINS.gateway).toBe("0xa7e0000000000000000000000000000000000000");
    expect(BUILD_PINS.vaultCodeHashes).toEqual(["0x2fbcf33083dd26a360690a0d8d24cd333997b3c7000d950aa5e564e01460d4da"]);
    const built = bridgePins();
    expect(JSON.parse(built.__BRIDGE_GATEWAY__!)).toBe(BUILD_PINS.gateway);
    expect(JSON.parse(built.__VAULT_CODE_HASHES__!)).toEqual(BUILD_PINS.vaultCodeHashes);
  });
  it("M8: a vault whose code is any one of the reviewed hashes is accepted", async () => {
    const c = await loadBridgeConfig(deps(), { ...pins, vaultCodeHashes: [keccak256("0x00"), keccak256(CODE)] });
    expect(c.vaults).toEqual([VAULT.toLowerCase()]);
  });
  it("M8: the wrapped coin is the address pinned for the deployment, never the contract the API calls WtROME", async () => {
    const pinned = await loadBridgeConfig(deps(), pins);
    expect(pinned.wrapper).toBe(WTROME.toLowerCase());
    // The API names TKA "WtROME" too, and a twin by that symbol is not the wrapper: only the pinned address is.
    const lying = overview({ twins: [line(TKA, "WtROME"), line(WTROME, "WtROME2")] });
    const d = { ...deps(), twins: async () => lying };
    expect((await loadBridgeConfig(d, { ...pins, wrapper: TKA.toLowerCase() as Address })).wrapper).toBe(TKA.toLowerCase());
    expect((await loadBridgeConfig(d, { ...pins, wrapper: WTROME.toLowerCase() as Address })).wrapper).toBe(WTROME.toLowerCase());
  });
  it("M8: with no wrapper pinned, no twin is the wrapper, whatever its symbol", async () => {
    expect((await loadBridgeConfig(deps(), { ...pins, wrapper: null })).wrapper).toBeNull();
  });
  it("M8: a pinned wrapper that is not a twin, or has no code on the chain, is not used", async () => {
    expect((await loadBridgeConfig(deps(), { ...pins, wrapper: ("0x" + "77".repeat(20)) as Address })).wrapper).toBeNull();
    const d = deps();
    d.code = async (a) => (a.toLowerCase() === WTROME.toLowerCase() ? "0x" : CODE);
    expect((await loadBridgeConfig(d, pins)).wrapper).toBeNull();
  });
  it("M8: the build reads the wrapper from BRIDGE_WTROME_ADDRESS, and refuses a value that is not an address", () => {
    expect(JSON.parse(bridgePins(undefined, { BRIDGE_WTROME_ADDRESS: "0x" + "AB".repeat(20) }).__WTROME_ADDRESS__!)).toBe("0x" + "ab".repeat(20));
    expect(JSON.parse(bridgePins(undefined, {}).__WTROME_ADDRESS__!)).toBe("");
    expect(() => bridgePins(undefined, { BRIDGE_WTROME_ADDRESS: "0x12" })).toThrow("not an address");
  });
});

describe("the bridge's own reads", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("carry a timeout: the status, the twins, and the RPC reads of the vault, the tokens and the code", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ chainId: 1, result: "0x" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await apiDeps.status();
    await apiDeps.twins();
    await apiDeps.call("0xab", "0x");
    await apiDeps.code("0xab");
    expect(f).toHaveBeenCalledTimes(4);
    for (const c of f.mock.calls as unknown as [string, RequestInit][]) expect(c[1].signal).toBeInstanceOf(AbortSignal);
  });
});
