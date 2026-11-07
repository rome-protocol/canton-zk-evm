import { describe, expect, it, vi } from "vitest";
import type { ApiStatus, TwinsOverview } from "../../api.ts";
import { loadBridgeConfig, type ConfigDeps } from "./config.ts";

const status = { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } } as ApiStatus;
const GATEWAY = "0xa7E0000000000000000000000000000000000000";
const [VAULT, TKA, WTROME, WCC] = ["0xABCDEF" + "0".repeat(34), "0xF" + "1".repeat(39), "0xC" + "2".repeat(39), "0xD" + "3".repeat(39)];
const line = (token: string, symbol: string) => ({ token, symbol, name: symbol, decimals: 18, supply: "0", vaultBalance: "0", matched: true, locks: 0, releases: 0, through: 5 });
const wrappedLine = (token: string) => ({ token, symbol: "wCC", name: "wCC", decimals: 10, instrumentAdmin: "dso::1220ab", instrumentId: "Amulet", custody: "0", custodyDecimals: 10, holdings: 0, supply: "0", supplyBlock: 5, matched: true, ledgerOffset: 1, readAt: "" });
const overview = (o: Partial<TwinsOverview> = {}): TwinsOverview => ({
  through: 5, registryService: "https://x.example/twin-registry/", vaults: [{ address: VAULT, codeHash: "0x00" }],
  twins: [
    line(TKA, "TKA"),
    line(WTROME, "WtROME"),
  ],
  canton: [wrappedLine(WCC)],
  legs: [], ...o,
});
const deps = (o: Partial<TwinsOverview> = {}): ConfigDeps => ({
  status: async () => status, twins: async () => overview(o),
  call: vi.fn(async () => "0x" + "00".repeat(12) + GATEWAY.slice(2)),
});

describe("loadBridgeConfig", () => {
  it("takes the registry, vault, twins and wrapped tokens from the explorer's API and the gateway from the vault", async () => {
    const d = deps();
    const c = await loadBridgeConfig(d);
    expect(d.call).toHaveBeenCalledWith(VAULT, expect.stringMatching(/^0x[0-9a-f]{8}$/));
    expect(c.gateway).toBe(GATEWAY.toLowerCase());
    expect(c.vault).toBe(VAULT.toLowerCase());
    expect(c.registryUrl).toBe("https://x.example/twin-registry");
    expect(c.twins.map((t) => [t.symbol, t.decimals])).toEqual([["TKA", 18], ["WtROME", 18]]);
    expect(c.wrapper).toBe(WTROME.toLowerCase());
    expect(c.wrapped).toEqual([{ address: WCC.toLowerCase(), symbol: "wCC", decimals: 10, instrument: { admin: "dso::1220ab", id: "Amulet" } }]);
    expect(c.chain.chainId).toBe(770101);
  });
  it("says so when the deployment has no registry service or no vault", async () => {
    await expect(loadBridgeConfig(deps({ registryService: null }))).rejects.toThrow("no twin registry");
    await expect(loadBridgeConfig(deps({ vaults: [] }))).rejects.toThrow("no registered vault");
  });
});
