import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { assetsCall, claimFeeCall, decimalsCall, destinationCall, LISTED_TOPIC, lockRoomCall, nameCall, outOpenCall, partyHash, ROUTED_OUT_TOPIC, SWITCH_TOPIC, symbolCall } from "./abi.ts";
import type { Canton, OpenRequest } from "./canton.ts";
import { cantonRouteRoutes, createCantonRoute, ROUTE_PATHS } from "./route.ts";
import type { RouteSettings } from "./settings.ts";

const ROUTER = "0x" + "a1".repeat(20), BOOK = "0x" + "b2".repeat(20), CC = "0x" + "cc".repeat(20), ME = "0x" + "e3".repeat(20), OTHER = "0x" + "e4".repeat(20);
const PARTY = "alice::1220" + "9f".repeat(16);
const settings: RouteSettings = { router: ROUTER, book: BOOK, notTakenSeconds: 600, ownClaimSeconds: 300, time: { minSeconds: 480, maxSeconds: 960 }, gateway: null };
const bookAbi = parseAbi(["function assets(address) view returns ((uint8 state, bytes32 instrument, uint256 feeOut, uint256 feeIn, uint256 feeRefund, uint256 minAmount, uint256 lockCap))", "function destinations(uint32) view returns ((bool open, uint256 unit))", "function claimFee(address, uint32) view returns (uint256)", "function outOpen() view returns (bool)"]);
const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);
const router = parseAbi(["function lockRoom(address) view returns (uint256)"]);
const word = (v: string) => Buffer.from(v.replace(/^0x/, "").padStart(64, "0"), "hex");
const CC_UNITS = 10n ** 10n;

interface World { outOpen?: boolean; destOpen?: boolean; state?: number; room?: bigint; listed?: string[]; everOpened?: boolean; rows?: Record<string, unknown>[]; requests?: OpenRequest[] | null; head?: number | null; fail?: boolean; available?: boolean }
function build(w: World = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const reads: string[] = [];
  const reth = {
    block: async () => (w.head === null ? null : { number: w.head ?? 900 }),
    callAt: async (_to: string, input: string): Promise<string> => {
      reads.push(input);
      if (w.fail) throw new Error("reth is down");
      if (input === outOpenCall()) return encodeFunctionResult({ abi: bookAbi, functionName: "outOpen", result: w.outOpen ?? true });
      if (input === destinationCall(0)) return encodeFunctionResult({ abi: bookAbi, functionName: "destinations", result: { open: w.destOpen ?? true, unit: 1n } });
      if (input === assetsCall(CC)) return encodeFunctionResult({ abi: bookAbi, functionName: "assets", result: { state: w.state ?? 1, instrument: ("0x" + "11".repeat(32)) as Hex, feeOut: CC_UNITS / 20n, feeIn: 0n, feeRefund: 0n, minAmount: CC_UNITS, lockCap: 10n * CC_UNITS } });
      if (input === claimFeeCall(CC, 0)) return encodeFunctionResult({ abi: bookAbi, functionName: "claimFee", result: (CC_UNITS * 15n) / 100n });
      if (input === lockRoomCall(CC)) return encodeFunctionResult({ abi: router, functionName: "lockRoom", result: w.room ?? 10n * CC_UNITS });
      if (input === symbolCall()) return encodeFunctionResult({ abi: erc20, functionName: "symbol", result: "CC" });
      if (input === nameCall()) return encodeFunctionResult({ abi: erc20, functionName: "name", result: "Canton Coin" });
      if (input === decimalsCall()) return encodeFunctionResult({ abi: erc20, functionName: "decimals", result: 10 });
      throw new Error("unexpected call " + input);
    },
  };
  const pool = {
    async query(sql: string, values: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("topic1 from logs")) return { rows: (w.listed ?? [CC]).map((t) => ({ topic1: word(t) })) };
      if (sql.includes("select 1 from logs")) return { rows: w.everOpened === false ? [] : [{}] };
      return { rows: (w.rows ?? []) as never[] };
    },
  };
  const canton: Canton | null = w.requests === undefined ? null : { requests: async () => { if (w.requests === null) throw new Error("canton is down"); return w.requests!; } };
  const now = { t: 1_700_000_000_000 };
  const route = createCantonRoute({ settings, agglayer: { ostiaBridge: "0x" + "53".repeat(20) }, bridge: { status: async () => ({ available: w.available ?? true }) as never }, reth: reth as never, pool, canton, now: () => now.t });
  const get = async (path: string, q = "", ip = "1.2.3.4") => {
    const parts = path.split("/").slice(1);
    const run = route.routes(parts, new URLSearchParams(q), ip);
    return run ? run() : undefined;
  };
  return { get, queries, reads, now };
}

const routedOut = (o: { id?: string; party?: string; dest?: string; send?: bigint; fee?: bigint; count?: number; net?: number; tx?: string; block?: number }) => ({
  block_number: o.block ?? 100, topic1: word(o.id ?? "0x" + "d1".repeat(32)), topic3: word(o.dest ?? ME), ts: 1_700_000_000, hash: Buffer.from((o.tx ?? "ab").repeat(32), "hex"),
  data: Buffer.from(encodeAbiParameters([{ type: "string" }, { type: "uint32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [o.party ?? PARTY, o.net ?? 0, CC as `0x${string}`, o.send ?? 48n * CC_UNITS / 10n, o.fee ?? CC_UNITS / 5n, BigInt(o.count ?? 7)]).slice(2), "hex"),
});
const label = (dest: string = ME, maxFee = "2000000000", nonce = "17") => `r1:0:${dest}:${maxFee}:${nonce}`;
const request = (over: Partial<OpenRequest> = {}): OpenRequest => ({ depositId: "d2".repeat(32), party: PARTY, label: label(), amount: 5n * CC_UNITS, requestedAt: "2023-11-14T21:40:00Z", settleBefore: "2023-11-14T23:40:00Z", ...over });

describe("the Canton route's setup", () => {
  it("says what the book allows: the assets with fees, minimum, cap and room, and the waits", async () => {
    const { get } = build({ room: 25n * CC_UNITS / 10n });
    const a = (await get("/api/canton-route/setup"))!;
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      on: true, route: "open", available: true, destination: { network: 0, unit: "1" },
      assets: [{ erc20: CC, symbol: "CC", name: "Canton Coin", decimals: 10, feeOut: "500000000", claimFee: "1500000000", minAmount: "10000000000", lockCap: "100000000000", lockRoom: "25000000000" }],
      time: { minSeconds: 480, maxSeconds: 960 }, notTakenSeconds: 600, ownClaimSeconds: 300,
    });
    expect(a.headers?.["cache-control"]).toBe("public, max-age=3");
  });
  it("is closed while the route has never been turned on, and stopped once it was and is not now", async () => {
    const closed = (await build({ outOpen: false, everOpened: false }).get("/api/canton-route/setup"))!.body as { route: string; assets: unknown[] };
    expect(closed.route).toBe("closed");
    expect(closed.assets).toEqual([]);
    expect(((await build({ outOpen: false }).get("/api/canton-route/setup"))!.body as { route: string }).route).toBe("stopped");
    expect(((await build({ destOpen: false }).get("/api/canton-route/setup"))!.body as { route: string }).route).toBe("stopped");
  });
  it("leaves out an asset whose route is stopped, and reads no asset while the direction is closed", async () => {
    expect(((await build({ state: 2 }).get("/api/canton-route/setup"))!.body as { assets: unknown[]; route: string })).toMatchObject({ assets: [], route: "stopped" });
    const w = build({ outOpen: false });
    await w.get("/api/canton-route/setup");
    expect(w.reads).not.toContain(assetsCall(CC));
  });
  it("passes on that the bridge is not available, and answers 503 without any address when Ostia cannot be read", async () => {
    expect(((await build({ available: false }).get("/api/canton-route/setup"))!.body as { available: boolean }).available).toBe(false);
    const a = (await build({ fail: true }).get("/api/canton-route/setup"))!;
    expect(a).toMatchObject({ status: 503, body: { error: "The route cannot be read right now." } });
    expect(JSON.stringify(a)).not.toContain("reth");
    expect((await build({ head: null }).get("/api/canton-route/setup"))!.status).toBe(503);
  });
  it("reads the listed assets from the book's own events, and the switch's history from its own log", async () => {
    const w = build();
    await w.get("/api/canton-route/setup");
    const bytes = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
    expect(w.queries.find((q) => q.sql.includes("topic1 from logs"))!.values.slice(0, 2)).toEqual([bytes(BOOK), bytes(LISTED_TOPIC)]);
    expect(w.queries.find((q) => q.sql.includes("select 1 from logs"))!.values.slice(0, 2)).toEqual([bytes(BOOK), bytes(SWITCH_TOPIC)]);
  });
});

describe("the Canton route's moves", () => {
  it("lists what Ostia took, found by the destination wallet, with the deposit number and the transaction", async () => {
    const w = build({ rows: [routedOut({})], requests: [] });
    const a = (await w.get("/api/canton-route/moves", `evm=${ME.toUpperCase().replace("0X", "0x")}`))!;
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ requestsRead: true, moves: [{
      id: "0x" + "d1".repeat(32), state: "taken", party: PARTY, destAddress: ME, erc20: CC, amount: "50000000000", send: "48000000000", fee: "2000000000", depositCount: 7,
      txHash: "0x" + "ab".repeat(32), block: 100, at: "2023-11-14T22:13:20.000Z", maxFee: null, settleBefore: null,
    }] });
    const q = w.queries[0]!;
    expect(q.sql).toContain("l.topic3 = $3");
    expect(q.values[2]).toEqual(Buffer.concat([Buffer.alloc(12), Buffer.from(ME.slice(2), "hex")]));
  });
  it("finds a move by the Canton account through the hash of its party id", async () => {
    const w = build({ rows: [routedOut({})], requests: [] });
    await w.get("/api/canton-route/moves", `party=${PARTY}`);
    expect(w.queries[0]!.sql).toContain("l.topic2 = $3");
    expect(w.queries[0]!.values[2]).toEqual(Buffer.from(partyHash(PARTY).slice(2), "hex"));
    expect(w.queries[0]!.values[1]).toEqual(Buffer.from(ROUTED_OUT_TOPIC.slice(2), "hex"));
  });
  it("lists a request Ostia has not taken, with its real end, found by the label's destination", async () => {
    const a = (await build({ requests: [request(), request({ depositId: "d3".repeat(32), label: label(OTHER) })] }).get("/api/canton-route/moves", `evm=${ME}`))!;
    expect(a.body).toEqual({ requestsRead: true, moves: [{
      id: "0x" + "d2".repeat(32), state: "requested", party: PARTY, destAddress: ME, erc20: null, amount: "50000000000", send: null, fee: null, depositCount: null, txHash: null, block: null, at: "2023-11-14T21:40:00.000Z", maxFee: "2000000000", settleBefore: "2023-11-14T23:40:00.000Z",
    }] });
  });
  it("lists a request of the account when asked by party, and leaves out another account's", async () => {
    const mine = request(), theirs = request({ depositId: "d4".repeat(32), party: "bob::1220" + "aa".repeat(16) });
    const a = (await build({ requests: [mine, theirs] }).get("/api/canton-route/moves", `party=${PARTY}`))!;
    expect((a.body as { moves: { id: string }[] }).moves.map((m) => m.id)).toEqual(["0x" + "d2".repeat(32)]);
  });
  it("shows a move once, as taken, when its request is still on the list", async () => {
    const id = "d1".repeat(32);
    const a = (await build({ rows: [routedOut({ id: "0x" + id })], requests: [request({ depositId: id })] }).get("/api/canton-route/moves", `evm=${ME}`))!;
    expect((a.body as { moves: { state: string }[] }).moves.map((m) => m.state)).toEqual(["taken"]);
  });
  it("leaves out requests and events for other destinations, and labels that are not exact", async () => {
    const other = request({ depositId: "d5".repeat(32), label: `r1:75:${ME}:1:1` });
    const bad = request({ depositId: "d6".repeat(32), label: `r1:0:${ME.toUpperCase().replace("0X", "0x")}:1:1` });
    const a = (await build({ rows: [routedOut({ net: 74 })], requests: [other, bad] }).get("/api/canton-route/moves", `evm=${ME}`))!;
    expect((a.body as { moves: unknown[] }).moves).toEqual([]);
  });
  it("still lists what Ostia took when Canton cannot be read, and says the requests were not read", async () => {
    const a = (await build({ rows: [routedOut({})], requests: null }).get("/api/canton-route/moves", `evm=${ME}`))!;
    expect(a.body).toMatchObject({ requestsRead: false });
    expect((a.body as { moves: unknown[] }).moves).toHaveLength(1);
    expect(((await build({ rows: [] }).get("/api/canton-route/moves", `evm=${ME}`))!.body as { requestsRead: boolean }).requestsRead).toBe(false);
  });
  it("reads Canton once for a few seconds, however many ask", async () => {
    let n = 0;
    const w = build({ requests: [] });
    const canton = { requests: async () => { n++; return []; } };
    const route = createCantonRoute({ settings, agglayer: { ostiaBridge: "0x" }, bridge: { status: async () => ({}) as never }, reth: { block: async () => ({ number: 1 }) as never, callAt: async () => "0x" }, pool: { query: async () => ({ rows: [] }) }, canton, now: () => w.now.t });
    const ask = () => route.routes(["api", "canton-route", "moves"], new URLSearchParams(`evm=${ME}`), "9.9.9.9")!();
    await Promise.all([ask(), ask(), ask()]);
    expect(n).toBe(1);
    w.now.t += 4000;
    await ask();
    expect(n).toBe(2);
  });
  it("refuses a request that is not exactly one of party and evm, or is not what it says", async () => {
    const w = build({ requests: [] });
    for (const q of ["", `party=${PARTY}&evm=${ME}`, "evm=0x12", `evm=${ME}00`, "party=a%20b", `party=${"a".repeat(301)}`]) expect((await w.get("/api/canton-route/moves", q))!.status, q).toBe(400);
    expect(w.queries).toEqual([]);
  });
  it("limits each client to 30 a minute in bursts of 10, with Retry-After", async () => {
    const w = build({ requests: [] });
    for (let i = 0; i < 10; i++) expect((await w.get("/api/canton-route/moves", `evm=${ME}`, "5.5.5.5"))!.status).toBe(200);
    const refused = (await w.get("/api/canton-route/moves", `evm=${ME}`, "5.5.5.5"))!;
    expect(refused.status).toBe(429);
    expect(refused.headers?.["retry-after"]).toBeDefined();
    expect((await w.get("/api/canton-route/moves", `evm=${ME}`, "6.6.6.6"))!.status).toBe(200);
  });
  it("answers 503 without detail when the database cannot be read", async () => {
    const route = createCantonRoute({ settings, agglayer: { ostiaBridge: "0x" }, bridge: { status: async () => ({}) as never }, reth: { block: async () => null, callAt: async () => "0x" }, pool: { query: async () => { throw new Error("password authentication failed for user x"); } }, canton: null });
    const a = await route.routes(["api", "canton-route", "moves"], new URLSearchParams(`evm=${ME}`), "1.1.1.1")!();
    expect(a).toMatchObject({ status: 503, body: { error: "The route cannot be read right now." } });
  });
});

describe("the routes while the switch is off", () => {
  const off = cantonRouteRoutes(null);
  it("answers {on: false} for the setup and 404 for the moves, and nothing for other paths", async () => {
    expect(await off(["api", "canton-route", "setup"], new URLSearchParams(), undefined)!()).toEqual({ status: 200, body: { on: false } });
    expect(await off(["api", "canton-route", "moves"], new URLSearchParams(), undefined)!()).toEqual({ status: 404, body: { error: "The Canton route is off on this explorer." } });
    expect(off(["api", "canton-route", "other"], new URLSearchParams(), undefined)).toBeUndefined();
    expect(off(["api", "agglayer", "setup"], new URLSearchParams(), undefined)).toBeUndefined();
  });
  it("names its two paths for the API description", () => expect(ROUTE_PATHS).toEqual(["/api/canton-route/setup", "/api/canton-route/moves"]));
});
