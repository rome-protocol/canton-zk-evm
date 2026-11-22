import { describe, expect, it } from "vitest";
import { createAgglayerBridge } from "./bridge.ts";
import type { AggkitReader } from "./aggkit.ts";
import type { HadrianReader } from "./hadrian.ts";
import type { SepoliaReader } from "./sepolia.ts";
import { agglayerSettings } from "./settings.ts";
import type { SolgateReader, SolgateView } from "./solgate.ts";
import { REST_FIELDS as F } from "../rest/fields.ts";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const OSTIA = A(0x53), SEPOLIA = A(0x52), WETH = A(0x62);
const ROUTES = [
  { id: "sepolia", name: "Ethereum Sepolia", open: true },
  { id: "hadrian", name: "Hadrian", open: true, assets: ["ETH", "SOL"], assetTimes: { SOL: { in: { minSeconds: 240, maxSeconds: 240 }, out: { minSeconds: 570, maxSeconds: 570 } }, ETH: { in: { minSeconds: 360, maxSeconds: 360 }, out: { minSeconds: 360, maxSeconds: 360 } } } },
  { id: "solana-devnet", name: "Solana devnet", open: true, assets: ["SOL", "ETH"], times: { out: { minSeconds: 600, maxSeconds: 900 } } },
];
const view = (over: Partial<SolgateView> = {}): SolgateView => ({
  chains: new Map([[74, { networkId: 74, name: "Rome Hadrian", nativeSymbol: "USDC", chainId: 200010 }], [75, { networkId: 75, name: "Ostia", nativeSymbol: "tROME", chainId: 770101 }]]),
  assets: [
    { symbol: "ETH", name: "Ether (Rome)", decimals: 18, places: 9, evm: { 75: A(0x62) } },
    { symbol: "SOL", name: "Wrapped SOL (Rome)", decimals: 9, places: 9, evm: { 75: A(0xa0) } },
    { symbol: "DAI", name: "DAI (Rome)", decimals: 18, places: 9, evm: {} },
  ], ...over,
});
function build(w: { view?: SolgateView | null; hadrian?: boolean; healthy?: boolean; rows?: unknown[]; reads?: string[] } = {}) {
  const settings = agglayerSettings({
    AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/hidden-part-1234", AGGLAYER_OSTIA_BRIDGE: OSTIA, AGGLAYER_SEPOLIA_BRIDGE: SEPOLIA,
    AGGLAYER_TOKENS: JSON.stringify([{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH }]),
    AGGLAYER_SOLGATE_URL: "https://solgate.example/", AGGLAYER_HADRIAN_RPC_URL: "https://hadrian.example/hidden-rpc-5678", AGGLAYER_ROUTES: JSON.stringify(w.rows ?? ROUTES),
  }, (m) => new Error(m))!;
  const aggkit = { healthy: async () => w.healthy ?? true, syncStatus: async () => null, settlements: async () => [], bridge: async () => undefined } as unknown as AggkitReader;
  const sepolia = { attached: async () => true } as unknown as SepoliaReader;
  const reth = { block: async () => ({ number: 500 }), callAt: async () => "0x" + "0".repeat(64) };
  const solgate: SolgateReader = { read: async () => { w.reads?.push("solgate"); return w.view === undefined ? view() : w.view; } };
  const hadrian: HadrianReader = { reachable: async () => { w.reads?.push("hadrian"); return w.hadrian ?? true; } };
  const bridge = createAgglayerBridge({ settings, chainId: 770101, chainName: "Ostia", aggkit, sepolia, reth: reth as never, solgate, hadrian, now: () => 1_700_000_000_000 });
  return async () => (await bridge.routes(["api", "agglayer", "setup"], new URLSearchParams(), "1.2.3.4")!()).body as { routes: Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const keys = (o: object) => Object.keys(o).sort();
const same = (o: object, f: readonly string[]) => expect(keys(o)).toEqual([...f].sort());

describe("the setup's rows for the routes through Solgate", () => {
  it("gives an open Hadrian row Solgate's address, Hadrian's coin, the tokens it offers in the order of the setting with their addresses on Ostia and their own times", async () => {
    const r = (await build()()).routes[1]!;
    same(r, F.agglayerHandoffRoute);
    expect(r).toEqual({
      id: "hadrian", name: "Hadrian", open: true, via: "solgate", available: true, solgate: "https://solgate.example", coin: "USDC", times: { in: null, out: null },
      assets: [
        { symbol: "ETH", name: "Ether (Rome)", decimals: 18, places: 9, ostia: A(0x62), times: { in: { minSeconds: 360, maxSeconds: 360 }, out: { minSeconds: 360, maxSeconds: 360 } } },
        { symbol: "SOL", name: "Wrapped SOL (Rome)", decimals: 9, places: 9, ostia: A(0xa0), times: { in: { minSeconds: 240, maxSeconds: 240 }, out: { minSeconds: 570, maxSeconds: 570 } } },
      ],
    });
    for (const t of r.assets) { same(t, F.agglayerHandoffToken); same(t.times, F.agglayerTimes); }
  });

  it("gives the Solana row the route's own times, no coin (the claim is in a Solana wallet), the places a token has on Solana and its order from the setting", async () => {
    const r = (await build()()).routes[2]!;
    same(r, F.agglayerHandoffRoute);
    expect(r).toMatchObject({ id: "solana-devnet", via: "solgate", coin: null, times: { in: null, out: { minSeconds: 600, maxSeconds: 900 } }, available: true });
    expect(r.assets.map((t: { symbol: string; places: number; times: unknown }) => [t.symbol, t.places, t.times])).toEqual([["SOL", 9, { in: null, out: null }], ["ETH", 9, { in: null, out: null }]]);
  });

  it("leaves the Ethereum Sepolia row as it was, and a route that is not open as just a name", async () => {
    const { routes } = await build({ rows: [ROUTES[0], { id: "hadrian", name: "Hadrian", assets: ["ETH"] }] })();
    same(routes[0]!, F.agglayerRoute);
    expect(routes[0]).toMatchObject({ id: "sepolia", networkId: 0, bridge: SEPOLIA, assets: [{ symbol: "ETH", sepolia: "native", ostia: WETH }] });
    expect(routes[1]).toEqual({ id: "hadrian", name: "Hadrian", open: false });
  });

  it("offers only the tokens of the setting that have an address on Ostia in Solgate's list, and the route is not available with none", async () => {
    const some = (await build({ view: view({ assets: view().assets.filter((t) => t.symbol !== "SOL") }) })()).routes[1]!;
    expect(some.assets.map((t: { symbol: string }) => t.symbol)).toEqual(["ETH"]);
    expect(some.available).toBe(true);
    const none = (await build({ rows: [{ id: "hadrian", name: "Hadrian", open: true, assets: ["DAI", "WBTC"] }] })()).routes[0]!;
    expect(none.assets).toEqual([]);
    expect(none.available).toBe(false);
  });

  it("is not available while Solgate cannot be read, does not list Ostia or Hadrian, lists Hadrian under another chain id, or Hadrian does not answer; or while the bridge itself is down", async () => {
    const avail = async (w: Parameters<typeof build>[0]) => (await build(w)()).routes[1]!.available;
    expect(await avail({})).toBe(true);
    expect(await avail({ view: null })).toBe(false);
    expect(await avail({ view: view({ chains: new Map([[74, view().chains.get(74)!]]) }) })).toBe(false);
    expect(await avail({ view: view({ chains: new Map([[75, view().chains.get(75)!]]) }) })).toBe(false);
    expect(await avail({ view: view({ chains: new Map([...view().chains, [74, { networkId: 74, name: "Rome Hadrian", nativeSymbol: "USDC", chainId: 7 }]]) }) })).toBe(false);
    expect(await avail({ hadrian: false })).toBe(false);
    expect(await avail({ healthy: false })).toBe(false);
    const down = (await build({ view: null })()).routes[1]!;
    expect(down).toMatchObject({ coin: null, assets: [] });
  });

  it("reads Solgate and Hadrian only for a route through Solgate that is open, and never puts an endpoint or a key in the answer", async () => {
    const reads: string[] = [];
    await build({ rows: [ROUTES[0], { id: "hadrian", name: "Hadrian", assets: ["ETH"] }], reads })();
    expect(reads).toEqual([]);
    const text = JSON.stringify(await build()());
    for (const s of ["hidden-part-1234", "hidden-rpc-5678", "hadrian.example", "127.0.0.1", "5578"]) expect(text).not.toContain(s);
  });
});
