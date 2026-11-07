import { describe, expect, it, vi } from "vitest";
import { keccak256, toFunctionSelector, type Hex } from "viem";
import type { ApiStatus, TwinsOverview } from "../../api.ts";
import { bridgePins } from "../../../bridge-pins.ts";
import { BUILD_PINS, loadBridgeConfig, type BridgePins, type ConfigDeps } from "./config.ts";

const status = { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } } as ApiStatus;
const GATEWAY = "0xa7E0000000000000000000000000000000000000";
const [VAULT, TKA, WTROME, WCC] = ["0xABCDEF" + "0".repeat(34), "0xF" + "1".repeat(39), "0xC" + "2".repeat(39), "0xD" + "3".repeat(39)];
const CODE = ("0x" + "60".repeat(120)) as Hex;
const pins: BridgePins = { gateway: GATEWAY.toLowerCase() as Hex, vaultCodeHash: keccak256(CODE) };
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
  it("M7: the build puts in the gateway from PINS and the hash of gateway/Vault.bin-runtime", () => {
    const built = bridgePins();
    expect(JSON.parse(built.__BRIDGE_GATEWAY__!)).toBe(BUILD_PINS.gateway);
    expect(BUILD_PINS.gateway).toMatch(/^0x[0-9a-f]{40}$/);
    expect(BUILD_PINS.vaultCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.parse(built.__VAULT_CODE_HASH__!)).toBe(BUILD_PINS.vaultCodeHash);
  });
});
