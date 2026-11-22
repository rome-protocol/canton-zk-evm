import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";
import { BRIDGE_EVENT, BRIDGE_EVENT_TOPIC, isClaimedCall } from "./abi.ts";
import { createAgglayerBridge, agglayerRoutes } from "./bridge.ts";
import { AggkitError, type AggkitReader, type BridgeLeaf } from "./aggkit.ts";
import { SepoliaError, type SepoliaReader } from "./sepolia.ts";
import { agglayerSettings } from "./settings.ts";
import { FIELDS, REST_FIELDS as F } from "../rest/fields.ts";

const OSTIA = "0x53a0ce7242b616fe706b03b464e5c32ed16e0998", SEPOLIA = "0x528e26b25a34a4a5d0dbda1d57d318153d2ed582", WETH = "0x62274f867c1342fa1b66d79e126c2885d18ebdc3";
const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const settings = (extra: Record<string, string> = {}) => agglayerSettings({
  AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/hidden-part-1234", AGGLAYER_OSTIA_BRIDGE: OSTIA, AGGLAYER_SEPOLIA_BRIDGE: SEPOLIA,
  AGGLAYER_TOKENS: JSON.stringify([{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH }]), ...extra,
}, (m) => new Error(m))!;
const leaf = (over: Partial<BridgeLeaf> = {}): BridgeLeaf => ({ depositCount: 7, txHash: H(1), blockTimestamp: 1_700_000_000, leafType: 0, globalIndex: "18446744073709551623", originNetwork: 0, originAddress: A(0), destinationNetwork: 75, destinationAddress: A(0xbeef), amount: "2000000000000000", metadata: "0x", ...over });
const proof = { proofLocal: Array.from({ length: 32 }, (_, i) => H(100 + i)), proofRollup: Array.from({ length: 32 }, (_, i) => H(200 + i)), mainnetExitRoot: H(2), rollupExitRoot: H(3) };

interface World {
  leaf?: BridgeLeaf; index?: number; l1Leaf?: { index: number; timestamp: number }; injected?: { index: number; timestamp: number; injectedAt?: number }; proof?: typeof proof;
  healthy?: boolean; synced?: boolean | null; settlements?: { blockTimestamp: number | null }[]; attached?: boolean | null; claimedOnSepolia?: boolean; ostiaClaimed?: boolean; down?: boolean; sepoliaDown?: boolean;
}
function build(w: World = {}, extra: Record<string, string> = {}, now = { t: 1_700_000_500_000 }) {
  const calls: string[] = [];
  const aggkit = {
    bridge: async (n: number, c: number) => { calls.push(`bridge ${n} ${c}`); if (w.down) throw new AggkitError("the bridge service cannot be reached"); return w.leaf; },
    l1InfoTreeIndex: async () => w.index,
    injectedLeaf: async (n: number) => (n === 0 ? w.l1Leaf && { ...w.l1Leaf, blockNumber: 1, injectedAt: undefined } : w.injected && { ...w.injected, blockNumber: 1, injectedAt: w.injected.injectedAt }),
    claimProof: async () => w.proof,
    settlements: async () => (w.settlements ?? []).map((s, i) => ({ txHash: null, blockNumber: 100 - i, blockTimestamp: s.blockTimestamp })),
    synced: async () => (w.down ? Promise.reject(new AggkitError("x")) : w.synced ?? null),
    healthy: async () => { calls.push("health"); if (w.down) throw new AggkitError("the bridge service cannot be reached"); return w.healthy ?? true; },
    cached: () => 0,
  } as unknown as AggkitReader;
  const sepolia = {
    isClaimed: async () => { if (w.sepoliaDown) throw new SepoliaError("Ethereum Sepolia cannot be reached"); return w.claimedOnSepolia ?? false; },
    attached: async () => (w.attached === undefined ? true : w.attached),
    copyOf: async () => ({ address: A(1), exists: false }),
  } as unknown as SepoliaReader;
  const reth = {
    block: async () => ({ number: 500 }),
    callAt: async (to: string, input: string, block: number) => { calls.push(`ostia ${to} ${input} ${block}`); return "0x" + (w.ostiaClaimed ? "1" : "0").padStart(64, "0"); },
  };
  const bridge = createAgglayerBridge({ settings: settings(extra), chainId: 770101, chainName: "Ostia", aggkit, sepolia, reth: reth as never, now: () => now.t });
  const get = async (path: string, ip = "1.2.3.4") => {
    const [p, qs] = path.split("?");
    const served = bridge.routes(p!.split("/").slice(1), new URLSearchParams(qs), ip);
    return served ? served() : undefined;
  };
  return { bridge, get, calls, now };
}
const body = (a: { body: unknown } | undefined) => a!.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const keys = (o: object) => Object.keys(o).sort();
const same = (o: object, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());

describe("the setup", () => {
  it("answers the chain, the bridge event, the open row with its assets, times and flags, and the other rows as just a name", async () => {
    const { get } = build({});
    const a = await get("/api/agglayer/setup");
    expect(a!.status).toBe(200);
    const b = body(a);
    same(b, F.agglayerSetup);
    expect(b.on).toBe(true);
    same(b.chain, F.agglayerChain);
    expect(b.chain).toEqual({ chainId: 770101, name: "Ostia", networkId: 75, bridge: OSTIA });
    expect(b.bridgeEvent).toEqual({ signature: BRIDGE_EVENT, topic0: BRIDGE_EVENT_TOPIC });
    expect(b.routes).toHaveLength(3);
    same(b.routes[0], F.agglayerRoute);
    expect(b.routes[0]).toEqual({
      id: "sepolia", name: "Ethereum Sepolia", open: true, networkId: 0, chainId: 11155111, bridge: SEPOLIA, available: true,
      assets: [{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH }], times: { in: null, out: null }, claimedForYou: { ostia: false, remote: false },
    });
    for (const closed of b.routes.slice(1)) { same(closed, F.agglayerRouteClosed); expect(closed.open).toBe(false); }
    expect(b.routes.map((r: { name: string }) => r.name)).toEqual(["Ethereum Sepolia", "Hadrian", "Solana devnet"]);
    expect(a!.headers?.["cache-control"]).toBe("public, max-age=3");
  });

  it("never carries the endpoint, an address of the service or anything private", async () => {
    const text = JSON.stringify((await build({}).get("/api/agglayer/setup"))!.body);
    for (const s of ["hidden-part-1234", "sepolia.example", "127.0.0.1", "5578"]) expect(text).not.toContain(s);
  });

  it("carries the measured times from the settings, and a row that is closed carries none", async () => {
    const rows = JSON.stringify([{ id: "sepolia", name: "Ethereum Sepolia", open: true, times: { in: { minSeconds: 240, maxSeconds: 420 } } }, { id: "hadrian", name: "Hadrian", times: { in: { minSeconds: 1, maxSeconds: 2 } } }]);
    const b = body(await build({}, { AGGLAYER_ROUTES: rows }).get("/api/agglayer/setup"));
    expect(b.routes[0].times).toEqual({ in: { minSeconds: 240, maxSeconds: 420 }, out: null });
    expect(b.routes[1]).toEqual({ id: "hadrian", name: "Hadrian", open: false });
  });

  it("says the bridge is not available when the service is down, not healthy, not synced, or Ostia is not attached; an unknown reading is not a reason", async () => {
    const avail = async (w: World) => body(await build(w).get("/api/agglayer/setup")).routes[0].available;
    expect(await avail({ down: true })).toBe(false);
    expect(await avail({ healthy: false })).toBe(false);
    expect(await avail({ synced: false })).toBe(false);
    expect(await avail({ attached: false })).toBe(false);
    expect(await avail({ synced: null, attached: null })).toBe(true);
    expect(await avail({ synced: true, attached: true })).toBe(true);
  });

  it("reads the service once for a few seconds", async () => {
    const { get, now, calls } = build({ synced: true });
    await get("/api/agglayer/setup"); await get("/api/agglayer/setup");
    expect(calls.filter((c) => c === "health")).toHaveLength(1);
    now.t += 6000;
    await get("/api/agglayer/setup");
    expect(calls.filter((c) => c === "health")).toHaveLength(2);
  });
});

describe("the stage of a deposit", () => {
  const stage = async (w: World, path = "/api/agglayer/deposit?network=0&count=7") => body(await build(w).get(path));

  it("is unknown while the bridge service has not indexed the deposit", async () => {
    const b = await stage({});
    same(b, F.agglayerDeposit);
    expect(b).toEqual({ network: 0, count: 7, stage: "unknown", destinationNetwork: null, sentAt: null, confirmedAt: null, readyAt: null, leaf: null });
  });

  it("is sent once indexed, confirmed once it is in the L1 info tree, ready once the destination took the root in and the proof exists, and claimed once the destination paid it", async () => {
    const sent = await stage({ leaf: leaf() });
    same(sent.leaf, F.agglayerLeaf);
    expect(sent).toMatchObject({ stage: "sent", destinationNetwork: 75, sentAt: "2023-11-14T22:13:20.000Z", confirmedAt: null, readyAt: null });
    expect(sent.leaf).toEqual({ txHash: H(1), originNetwork: 0, originTokenAddress: A(0), destinationNetwork: 75, destinationAddress: A(0xbeef), amount: "2000000000000000" });
    const confirmed = await stage({ leaf: leaf(), index: 41, l1Leaf: { index: 41, timestamp: 1_700_000_100 } });
    expect(confirmed).toMatchObject({ stage: "confirmed", confirmedAt: "2023-11-14T22:15:00.000Z", readyAt: null });
    const waiting = await stage({ leaf: leaf(), index: 41, l1Leaf: { index: 41, timestamp: 1_700_000_100 }, injected: { index: 42, timestamp: 1, injectedAt: 1_700_000_200 } });
    expect(waiting.stage).toBe("confirmed");
    const ready = await stage({ leaf: leaf(), index: 41, l1Leaf: { index: 41, timestamp: 1_700_000_100 }, injected: { index: 42, timestamp: 1, injectedAt: 1_700_000_200 }, proof });
    expect(ready).toMatchObject({ stage: "ready", readyAt: "2023-11-14T22:16:40.000Z" });
    const claimed = await stage({ leaf: leaf(), index: 41, l1Leaf: { index: 41, timestamp: 1_700_000_100 }, injected: { index: 42, timestamp: 1, injectedAt: 1_700_000_200 }, proof, ostiaClaimed: true });
    expect(claimed.stage).toBe("claimed");
  });

  it("asks Ostia's bridge at the finalized block for a deposit into Ostia, and Sepolia's for a deposit out of Ostia", async () => {
    const into = build({ leaf: leaf(), index: 1, l1Leaf: { index: 1, timestamp: 5 }, injected: { index: 1, timestamp: 5, injectedAt: 6 }, proof, ostiaClaimed: true });
    await into.get("/api/agglayer/deposit?network=0&count=7");
    expect(into.calls).toContain(`ostia ${OSTIA} ${isClaimedCall(7, 0)} 500`);
    const out = build({ leaf: leaf({ originNetwork: 75, destinationNetwork: 0 }), index: 1, l1Leaf: { index: 1, timestamp: 5 }, injected: { index: 1, timestamp: 5 }, proof, claimedOnSepolia: true });
    const b = body(await out.get("/api/agglayer/deposit?network=75&count=7"));
    expect(b).toMatchObject({ stage: "claimed", destinationNetwork: 0, readyAt: "1970-01-01T00:00:05.000Z" });
    expect(out.calls.some((c) => c.startsWith("ostia"))).toBe(false);
  });

  it("stays ready when the read of whether it was claimed fails", async () => {
    const b = await stage({ leaf: leaf({ originNetwork: 75, destinationNetwork: 0 }), index: 1, l1Leaf: { index: 1, timestamp: 5 }, injected: { index: 1, timestamp: 5 }, proof, sepoliaDown: true }, "/api/agglayer/deposit?network=75&count=7");
    expect(b.stage).toBe("ready");
  });

  it("answers 404 for a deposit that is not on a route this page serves: another destination, or a message", async () => {
    for (const odd of [leaf({ destinationNetwork: 9 }), leaf({ destinationNetwork: 0 }), leaf({ leafType: 1 })]) {
      const a = await build({ leaf: odd }).get("/api/agglayer/deposit?network=0&count=7");
      expect([a!.status, body(a).error]).toEqual([404, "That deposit is not on a route this page serves."]);
    }
  });

  it("refuses a network that is not Ethereum's or Ostia's, and a count that is not a whole number below 2^32, with 400", async () => {
    for (const q of ["network=9&count=1", "network=0", "count=1", "network=0&count=-1", "network=0&count=1.5", "network=0&count=4294967296", "network=x&count=1", "network=0&count=1e3"]) {
      const a = await build({ leaf: leaf() }).get(`/api/agglayer/deposit?${q}`);
      expect(a!.status, q).toBe(400);
    }
  });

  it("answers 503 in words when the service cannot be read, and logs the cause without the endpoint", async () => {
    const a = await build({ down: true }).get("/api/agglayer/deposit?network=0&count=7");
    expect([a!.status, body(a).error]).toEqual([503, "The bridge cannot be read right now."]);
  });

  it("limits each client: ten at once, then a refusal with the seconds to wait; another client is not held back", async () => {
    const { get } = build({ leaf: leaf() });
    for (let i = 0; i < 10; i++) expect((await get("/api/agglayer/deposit?network=0&count=7", "9.9.9.9"))!.status).toBe(200);
    const refused = await get("/api/agglayer/deposit?network=0&count=7", "9.9.9.9");
    expect(refused!.status).toBe(429);
    expect(refused!.headers?.["retry-after"]).toMatch(/^\d+$/);
    expect((await get("/api/agglayer/deposit?network=0&count=7", "8.8.8.8"))!.status).toBe(200);
    expect((await get("/api/agglayer/claim?network=0&count=7", "9.9.9.9"))!.status).toBe(429);
  });
});

describe("the claim receipt", () => {
  const ready: World = { leaf: leaf({ amount: "2000000000000000", metadata: "0x" }), index: 41, l1Leaf: { index: 41, timestamp: 1_700_000_100 }, injected: { index: 42, timestamp: 1, injectedAt: 1_700_000_200 }, proof };

  it("hands over what the wallet needs: where to send, the calldata, and the arguments it is made of", async () => {
    const a = await build(ready).get("/api/agglayer/claim?network=0&count=7");
    expect(a!.status).toBe(200);
    const b = body(a);
    same(b, F.agglayerClaim);
    same(b.args, F.agglayerClaimArgs);
    expect(b).toMatchObject({ network: 0, count: 7, claimed: false, destinationNetwork: 75, chainId: 770101, to: OSTIA, l1InfoTreeIndex: 42 });
    expect(b.args).toMatchObject({ globalIndex: "18446744073709551623", mainnetExitRoot: H(2), rollupExitRoot: H(3), originNetwork: 0, originTokenAddress: A(0), destinationNetwork: 75, destinationAddress: A(0xbeef), amount: "2000000000000000", metadata: "0x" });
    expect(b.args.smtProofLocalExitRoot).toHaveLength(32);
    const decoded = decodeFunctionData({ abi: parseAbi(["function claimAsset(bytes32[32],bytes32[32],uint256,bytes32,bytes32,uint32,address,uint32,address,uint256,bytes)"]), data: b.data });
    expect(decoded.functionName).toBe("claimAsset");
    expect(decoded.args![2]).toBe(18446744073709551623n);
    expect(decoded.args![9]).toBe(2000000000000000n);
    expect((decoded.args![6] as string).toLowerCase()).toBe(A(0));
    expect((decoded.args![8] as string).toLowerCase()).toBe(A(0xbeef));
  });

  it("points a claim of a deposit out of Ostia at Sepolia's bridge and chain", async () => {
    const b = body(await build({ ...ready, leaf: leaf({ originNetwork: 75, destinationNetwork: 0 }), injected: { index: 42, timestamp: 1 } }).get("/api/agglayer/claim?network=75&count=7"));
    expect(b).toMatchObject({ destinationNetwork: 0, chainId: 11155111, to: SEPOLIA });
  });

  it("is already claimed: says so and gives no calldata, so nothing is sent twice", async () => {
    const b = body(await build({ ...ready, ostiaClaimed: true }).get("/api/agglayer/claim?network=0&count=7"));
    expect(b).toMatchObject({ claimed: true, data: null, args: null });
  });

  it("is 404 until the deposit is ready, and for a deposit that is not served", async () => {
    for (const w of [{}, { leaf: leaf() }, { leaf: leaf(), index: 1, l1Leaf: { index: 1, timestamp: 5 } }]) {
      const a = await build(w).get("/api/agglayer/claim?network=0&count=7");
      expect([a!.status, body(a).error]).toEqual([404, "That deposit is not ready to claim yet."]);
    }
    expect((await build({ leaf: leaf({ destinationNetwork: 9 }) }).get("/api/agglayer/claim?network=0&count=7"))!.status).toBe(404);
  });
});

describe("the health row", () => {
  const row = async (w: World, now = { t: 1_700_000_500_000 }) => build(w, {}, now).bridge.healthRow();
  it("is ok when the service is healthy, synced, Ostia is attached and the last settlement is recent", async () => {
    const r = await row({ synced: true, settlements: [{ blockTimestamp: 1_700_000_400 }] });
    expect(r).toMatchObject({ id: "agglayer", status: "ok", value: { aggkit: "ok", synced: true, attached: true, lastSettlementAgeSeconds: 100 }, threshold: { settlementMaxAgeSeconds: 1800 }, detail: null });
  });
  it("is ok before any settlement, which is no fault", async () => {
    expect(await row({})).toMatchObject({ status: "ok", value: { lastSettlementAgeSeconds: null } });
  });
  it("is degraded, never down, and says why in words", async () => {
    expect(await row({ down: true })).toMatchObject({ status: "degraded", detail: "the bridge service cannot be read or says it is not healthy" });
    expect(await row({ synced: false })).toMatchObject({ status: "degraded", detail: "the bridge service says it is not synced" });
    expect(await row({ attached: false })).toMatchObject({ status: "degraded", detail: "Ostia is not attached to AggLayer" });
    const old = await row({ settlements: [{ blockTimestamp: 1_700_000_500 - 3600 }] });
    expect(old).toMatchObject({ status: "degraded", detail: "the last settlement is 3600 s old (limit 1800 s)" });
    expect((await row({ down: true, synced: false, attached: false })).status).toBe("degraded");
  });
});

describe("the switch", () => {
  it("answers {on: false} for the setup and 404 for the others when the bridge is off", async () => {
    const off = agglayerRoutes(null);
    const run = (p: string) => off(p.split("/").slice(1), new URLSearchParams(), "1.1.1.1")!();
    const s = await run("/api/agglayer/setup");
    expect([s.status, s.body]).toEqual([200, { on: false }]);
    for (const p of ["/api/agglayer/deposit", "/api/agglayer/claim"]) {
      const a = await run(p);
      expect([a.status, body(a).error]).toEqual([404, "The AggLayer bridge is off on this explorer."]);
    }
    expect(off(["api", "agglayer", "other"], new URLSearchParams(), "1.1.1.1")).toBeUndefined();
    expect(off(["api", "status"], new URLSearchParams(), "1.1.1.1")).toBeUndefined();
    expect(FIELDS).toBeDefined();
  });
});
