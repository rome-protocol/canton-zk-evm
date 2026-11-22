import { describe, expect, it } from "vitest";
import { agglayerSettings } from "./settings.ts";
import { loadConfig } from "../config.ts";
import { PINS } from "../../test/synthetic-chain.ts";

const fail = (m: string) => new Error(m);
const OSTIA = "0x53a0ce7242b616fe706b03b464e5c32ed16e0998", SEPOLIA = "0x528e26b25a34a4a5d0dbda1d57d318153d2ed582", WETH = "0x62274f867c1342fa1b66d79e126c2885d18ebdc3";
const base = { AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/hidden-part-1234", AGGLAYER_OSTIA_BRIDGE: OSTIA, AGGLAYER_SEPOLIA_BRIDGE: SEPOLIA };
const read = (env: Record<string, string | undefined>) => agglayerSettings(env, fail);
const why = (env: Record<string, string | undefined>) => { try { read(env); return null; } catch (e) { return (e as Error).message; } };

describe("the AggLayer bridge's settings", () => {
  it("is off by default, and when off reads nothing else, so a wrong value there stops no one", () => {
    expect(read({})).toBeNull();
    expect(read({ AGGLAYER_BRIDGE: "0", AGGLAYER_ROUTES: "not json" })).toBeNull();
    expect(read({ AGGLAYER_BRIDGE: "" })).toBeNull();
    expect(why({ AGGLAYER_BRIDGE: "yes" })).toBe('AGGLAYER_BRIDGE must be 1 or 0, not "yes"');
  });

  it("has defaults for the service's address, the networks, the three rows (only Ethereum Sepolia open) and no times and no tokens", () => {
    const s = read(base)!;
    expect(s).toMatchObject({ aggkitUrl: "http://127.0.0.1:5578", ostiaNetworkId: 75, sepoliaChainId: 11155111, ostiaBridge: OSTIA, sepoliaBridge: SEPOLIA, rollupManager: null, settlementMaxAgeSeconds: 1800 });
    expect(s.routes.map((r) => [r.id, r.name, r.open])).toEqual([["sepolia", "Ethereum Sepolia", true], ["hadrian", "Hadrian", false], ["solana-devnet", "Solana devnet", false]]);
    expect(s.routes[0]).toMatchObject({ times: { in: null, out: null }, claimedForYou: { ostia: false, remote: false }, offered: [] });
    expect(s.sepoliaRpc.reveal()).toBe(base.AGGLAYER_SEPOLIA_RPC_URL);
  });

  it("takes the endpoint as a secret that no text or JSON of the settings shows", () => {
    const s = read(base)!;
    expect(JSON.stringify(s)).not.toContain("hidden-part-1234");
    expect(String(s.sepoliaRpc)).toBe("[hidden]");
    const config = loadConfig({ READER_PARTY: "r::1", PINS_FILE: "p", ...base }, () => `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`);
    expect(config.agglayer).not.toBeNull();
    expect(JSON.stringify(config.agglayer)).not.toContain("hidden-part-1234");
  });

  it("requires the endpoint and the two bridges when on, and never repeats the endpoint in a message", () => {
    expect(why({ ...base, AGGLAYER_SEPOLIA_RPC_URL: undefined })).toContain("AGGLAYER_SEPOLIA_RPC_URL must be set");
    for (const url of ["ftp://x.invalid/hidden-part-1234", "not a url", "http://sepolia.example.invalid/hidden-part-1234"]) {
      const m = why({ ...base, AGGLAYER_SEPOLIA_RPC_URL: url })!;
      expect(m).toContain("AGGLAYER_SEPOLIA_RPC_URL");
      expect(m).not.toContain("hidden-part-1234");
      expect(m).not.toContain(url);
    }
    expect(read({ ...base, AGGLAYER_SEPOLIA_RPC_URL: "http://127.0.0.1:18545" })).not.toBeNull();
    expect(why({ ...base, AGGLAYER_OSTIA_BRIDGE: undefined })).toContain("AGGLAYER_OSTIA_BRIDGE");
    expect(why({ ...base, AGGLAYER_SEPOLIA_BRIDGE: "0x12" })).toContain("AGGLAYER_SEPOLIA_BRIDGE");
    expect(why({ ...base, AGGLAYER_ROLLUP_MANAGER: "nope" })).toContain("AGGLAYER_ROLLUP_MANAGER");
    expect(why({ ...base, AGGLAYER_OSTIA_NETWORK_ID: "0" })).toContain("AGGLAYER_OSTIA_NETWORK_ID");
    expect(why({ ...base, AGGKIT_BRIDGE_URL: "tcp://x" })).toContain("AGGKIT_BRIDGE_URL");
  });

  it("lowercases the addresses and takes the tokens from a list", () => {
    const s = read({ ...base, AGGLAYER_OSTIA_BRIDGE: OSTIA.toUpperCase().replace("0X", "0x"), AGGLAYER_ROLLUP_MANAGER: "0x32d33D5137a7cFFb54c5Bf8371172bcEc5f310ff", AGGLAYER_TOKENS: JSON.stringify([{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH }]) })!;
    expect(s.ostiaBridge).toBe(OSTIA);
    expect(s.rollupManager).toBe("0x32d33d5137a7cffb54c5bf8371172bcec5f310ff");
    expect(s.routes[0]!.offered).toEqual([{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH }]);
    for (const bad of [{}, [{ symbol: "ETH" }], [{ symbol: "", name: "x", decimals: 18, sepolia: "native", ostia: WETH }], [{ symbol: "ETH", name: "Ether", decimals: 99, sepolia: "native", ostia: WETH }], [{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "0x1", ostia: WETH }], [{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH, extra: 1 }]]) {
      expect(why({ ...base, AGGLAYER_TOKENS: JSON.stringify(bad) }), JSON.stringify(bad)).toContain("AGGLAYER_TOKENS");
    }
    expect(why({ ...base, AGGLAYER_TOKENS: "{" })).toContain("AGGLAYER_TOKENS");
  });

  it("takes the rows, the open flags, the measured times and the claimed-for-you flags from one list", () => {
    const rows = [
      { id: "sepolia", name: "Ethereum Sepolia", open: true, times: { in: { minSeconds: 240, maxSeconds: 420 }, out: { minSeconds: 480, maxSeconds: 960 } }, claimedForYou: { ostia: true } },
      { id: "hadrian", name: "Hadrian" },
    ];
    const s = read({ ...base, AGGLAYER_ROUTES: JSON.stringify(rows) })!;
    expect(s.routes[0]).toMatchObject({ open: true, times: { in: { minSeconds: 240, maxSeconds: 420 }, out: { minSeconds: 480, maxSeconds: 960 } }, claimedForYou: { ostia: true, remote: false } });
    expect(s.routes[1]).toMatchObject({ id: "hadrian", open: false, times: { in: null, out: null } });
    expect(s.routes).toHaveLength(2);
  });

  it("refuses a list of rows that is wrong, and opening a row that is not built yet", () => {
    const rows = (r: unknown) => ({ ...base, AGGLAYER_ROUTES: JSON.stringify(r) });
    for (const bad of [[], {}, [{ id: "Bad Id", name: "x" }], [{ id: "a", name: "" }], [{ id: "a", name: "x" }, { id: "a", name: "y" }], [{ id: "a", name: "x", other: 1 }],
      [{ id: "sepolia", name: "x", times: { in: { minSeconds: 10, maxSeconds: 5 }, out: null } }], [{ id: "sepolia", name: "x", times: { in: { minSeconds: 0, maxSeconds: 5 } } }], [{ id: "sepolia", name: "x", times: { in: { minSeconds: 1, maxSeconds: 999999 } } }],
      [{ id: "sepolia", name: "x", times: { sideways: null } }], [{ id: "sepolia", name: "x", open: "yes" }], [{ id: "sepolia", name: "x", claimedForYou: { ostia: "yes" } }]]) {
      expect(why(rows(bad)), JSON.stringify(bad)).toContain("AGGLAYER_ROUTES");
    }
    expect(why(rows([{ id: "hadrian", name: "Hadrian", open: true }]))).toContain("only sepolia");
    expect(why(rows([{ id: "sepolia", name: "Sepolia", open: false }]))).toBeNull();
  });

  it("takes whole numbers for the rest", () => {
    expect(read({ ...base, AGGLAYER_SETTLEMENT_MAX_AGE_SECONDS: "60", AGGLAYER_OSTIA_NETWORK_ID: "76", AGGLAYER_SEPOLIA_CHAIN_ID: "5" })).toMatchObject({ settlementMaxAgeSeconds: 60, ostiaNetworkId: 76, sepoliaChainId: 5 });
    expect(why({ ...base, AGGLAYER_SETTLEMENT_MAX_AGE_SECONDS: "0" })).toContain("AGGLAYER_SETTLEMENT_MAX_AGE_SECONDS");
  });
});
