import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { agglayerSettings } from "../agglayer/settings.ts";
import { assetsCall, claimFeeCall, decimalsCall, decodeBack, destinationCall, FORWARDED_TOPIC, HELD_TOPIC, inboxOfCall, inOpenCall, INBOX_OPENED_TOPIC, lockRoomCall, nameCall, outOpenCall, partyHash, REFUNDED_TOPIC, refundWaitCall, symbolCall } from "./abi.ts";
import { createCanton, payoutFrom, type Canton, type Payout } from "./canton.ts";
import { createCantonRoute, INTAKE_DOWN, NOT_ACCEPTED } from "./route.ts";
import { routeSettings, type RouteSettings } from "./settings.ts";

const ROUTER = "0x" + "a1".repeat(20), BOOK = "0x" + "b2".repeat(20), CC = "0x" + "cc".repeat(20), ME = "0x" + "e3".repeat(20), INBOX = "0x" + "1b".repeat(20);
const PARTY = "alice::1220" + "9f".repeat(16);
const CC_UNITS = 10n ** 10n;
const fail = (m: string) => new Error(m);
const word = (v: string) => Buffer.from(v.replace(/^0x/, "").padStart(64, "0"), "hex");
const bytes = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");

const ag = agglayerSettings({ AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/key", AGGLAYER_OSTIA_BRIDGE: "0x" + "53".repeat(20), AGGLAYER_SEPOLIA_BRIDGE: "0x" + "52".repeat(20) }, fail);
const good = {
  OSTIA_ROUTE_OUT: "1", OSTIA_ROUTER: ROUTER, OSTIA_BOOK: BOOK, OSTIA_ROUTE_NOT_TAKEN_SECONDS: "600", OSTIA_ROUTE_OWN_CLAIM_SECONDS: "300", GATEWAY_PARTY: "gw::1220ab", GATEWAY_LEDGER_TOKEN_FILE: "/run/t",
  OSTIA_ROUTE_IN: "1", OSTIA_INTAKE_URL: "http://127.0.0.1:7791/open", OSTIA_ROUTE_SETUP_SECONDS: "900", OSTIA_CLAIM_OSTIA: "1", OSTIA_ROUTE_CLAIM_OSTIA_SECONDS: "600", OSTIA_ROUTE_LEFT_OUT_SECONDS: "1200",
};

describe("the way back's settings", () => {
  it("are off with OSTIA_ROUTE_IN off, and then read none of their own", () => {
    const { OSTIA_ROUTE_IN: _a, OSTIA_CLAIM_OSTIA: _b, ...without } = good;
    expect(routeSettings({ ...without, OSTIA_INTAKE_URL: "junk" }, ag, fail)!.in).toBeNull();
    expect(() => routeSettings({ ...good, OSTIA_ROUTE_IN: "yes" }, ag, fail)).toThrow("OSTIA_ROUTE_IN must be 1 or 0");
  });
  it("need the other direction, the gateway party, the intake and the setting-up wait, and read the waits of the person's own claims", () => {
    expect(routeSettings(good, ag, fail)!.in).toEqual({ setupSeconds: 900, setupTime: null, intake: "http://127.0.0.1:7791/open", claimOstia: { afterSeconds: 600, leftOutSeconds: 1200 } });
    expect(() => routeSettings({ ...good, OSTIA_ROUTE_OUT: "0" }, ag, fail)).toThrow("OSTIA_ROUTE_IN needs OSTIA_ROUTE_OUT=1");
    expect(() => routeSettings({ ...good, GATEWAY_PARTY: undefined, GATEWAY_LEDGER_TOKEN_FILE: undefined }, ag, fail)).toThrow("GATEWAY_PARTY");
    for (const v of [undefined, "", "ftp://x", "http://", "not a url"]) expect(() => routeSettings({ ...good, OSTIA_INTAKE_URL: v }, ag, fail), `${v}`).toThrow("OSTIA_INTAKE_URL");
    for (const v of [undefined, "0", "-1", "604801", "x"]) expect(() => routeSettings({ ...good, OSTIA_ROUTE_SETUP_SECONDS: v }, ag, fail), `${v}`).toThrow("OSTIA_ROUTE_SETUP_SECONDS");
  });
  it("leave the person's own claims off with OSTIA_CLAIM_OSTIA off, and refuse them without the way back", () => {
    expect(routeSettings({ ...good, OSTIA_CLAIM_OSTIA: "0", OSTIA_ROUTE_CLAIM_OSTIA_SECONDS: undefined }, ag, fail)!.in!.claimOstia).toBeNull();
    for (const name of ["OSTIA_ROUTE_CLAIM_OSTIA_SECONDS", "OSTIA_ROUTE_LEFT_OUT_SECONDS"]) expect(() => routeSettings({ ...good, [name]: undefined }, ag, fail), name).toThrow(name);
    expect(() => routeSettings({ ...good, OSTIA_ROUTE_IN: "0" }, ag, fail)).toThrow("OSTIA_CLAIM_OSTIA needs OSTIA_ROUTE_IN=1");
    expect(() => routeSettings({ OSTIA_CLAIM_OSTIA: "1" }, ag, fail)).toThrow("OSTIA_CLAIM_OSTIA needs OSTIA_ROUTE_IN=1");
  });
  it("take a measured time of setting up an address, or none", () => {
    expect(routeSettings({ ...good, OSTIA_ROUTE_SETUP_TIME: '{"minSeconds":300,"maxSeconds":600}' }, ag, fail)!.in!.setupTime).toEqual({ minSeconds: 300, maxSeconds: 600 });
    expect(() => routeSettings({ ...good, OSTIA_ROUTE_SETUP_TIME: '{"minSeconds":9,"maxSeconds":3}' }, ag, fail)).toThrow("OSTIA_ROUTE_SETUP_TIME");
  });
});

// What the ledger gives for the three templates: an acceptance, the chain record with its quota and tallies, and a registered token.
const item = (templateId: string, createArgument: Record<string, unknown>) => ({ contractEntry: { JsActiveContract: { createdEvent: { contractId: "00c", templateId: `pkg:Zk.Chain:${templateId}`, createArgument } } } });
const acceptance = (party = PARTY, chainId = "770101") => item("WithdrawalAcceptance", { party, chainId, operator: "o", confirmer: "c", gateway: "g", builder: "b" });
const chain = (over: Record<string, unknown> = {}) => item("ZkChain", { chainId: "770101", pausedUntil: null, withdrawalQuota: "10.0", quotaWindow: { microseconds: "86400000000" }, withdrawn: [], ...over });
const registered = (evm = CC) => item("GatewayToken", { evmToken: evm.slice(2), instrumentId: { admin: "dso::1220", id: "Amulet" }, chainId: "770101", operator: "o", confirmer: "c", gateway: "g", builder: "b" });
const NOW = Date.parse("2026-11-22T12:00:00Z");

describe("what Canton can pay out", () => {
  it("reads the accounts that take withdrawals on this chain, and none of another chain's", () => {
    const p = payoutFrom([acceptance(), acceptance("bob::1220", "5")], [chain()], [registered()], 770101, NOW);
    expect([...p.acceptances]).toEqual([PARTY]);
  });
  it("counts what the quota leaves from the withdrawals still counted, and when the earliest drops out", () => {
    const withdrawn = [
      { tallyToken: "dso::1220/Amulet", countedUntil: "2026-11-22T14:05:00Z", tallyAmount: "2.5" },
      { tallyToken: "dso::1220/Amulet", countedUntil: "2026-11-22T15:00:00Z", tallyAmount: "1.0" },
      { tallyToken: "dso::1220/Amulet", countedUntil: "2026-11-22T11:00:00Z", tallyAmount: "9.0" },   // over: not counted
      { tallyToken: "other::1220/Thing", countedUntil: "2026-11-22T15:00:00Z", tallyAmount: "9.0" },
    ];
    const p = payoutFrom([], [chain({ withdrawn })], [registered()], 770101, NOW);
    expect(p.assets.get(CC)).toEqual({ left: 65n * CC_UNITS / 10n, renewsAt: "2026-11-22T14:05:00.000Z" });
    expect(payoutFrom([], [chain({ withdrawn: [{ tallyToken: "dso::1220/Amulet", countedUntil: "2026-11-22T14:05:00Z", tallyAmount: "12.0" }] })], [registered()], 770101, NOW).assets.get(CC)!.left).toBe(0n);
  });
  it("says no quota is set, and when the legs are paused", () => {
    expect(payoutFrom([], [chain({ withdrawalQuota: null, quotaWindow: null, withdrawn: null })], [registered()], 770101, NOW).assets.get(CC)).toEqual({ left: null, renewsAt: null });
    expect(payoutFrom([], [chain({ pausedUntil: "2026-11-22T12:30:00Z" })], [registered()], 770101, NOW)).toMatchObject({ paused: true, pausedUntil: "2026-11-22T12:30:00.000Z" });
    expect(payoutFrom([], [chain({ pausedUntil: "2026-11-22T11:30:00Z" })], [registered()], 770101, NOW)).toMatchObject({ paused: false, pausedUntil: null });
  });
  it("fails on a chain record that is missing or twice there, and on a quota or tally that does not read", () => {
    expect(() => payoutFrom([], [], [registered()], 770101, NOW)).toThrow("not valid");
    expect(() => payoutFrom([], [chain(), chain()], [registered()], 770101, NOW)).toThrow("not valid");
    expect(() => payoutFrom([], [chain({ withdrawalQuota: "ten" })], [registered()], 770101, NOW)).toThrow("not valid");
    expect(() => payoutFrom([], [chain({ withdrawn: [{ tallyToken: "dso::1220/Amulet", countedUntil: "2026-11-22T14:05:00Z", tallyAmount: "x" }] })], [registered()], 770101, NOW)).toThrow("not valid");
    expect(() => payoutFrom([], [chain({ pausedUntil: "soon" })], [registered()], 770101, NOW)).toThrow("not valid");
  });
  it("is read as the gateway party at the reader's ledger end, from three lists of its own", async () => {
    const calls: { path: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const gateway = { party: "gw::1220", call: async (_m: "GET" | "POST", path: string, body?: any) => { calls.push({ path, body }); const t = JSON.stringify(body); return t.includes("WithdrawalAcceptance") ? [acceptance()] : t.includes("ZkChain") ? [chain()] : [registered()]; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const p = await createCanton({ reader: { ledgerEnd: async () => 42 }, gateway: gateway as never, chainId: 770101, now: () => NOW }).payout();
    expect(p.acceptances.has(PARTY)).toBe(true);
    expect(calls).toHaveLength(3);
    for (const c of calls) { expect(c.path).toBe("/v2/state/active-contracts?limit=500"); expect(c.body.activeAtOffset).toBe(42); expect(Object.keys(c.body.eventFormat.filtersByParty)).toEqual(["gw::1220"]); }
  });
});

const bookAbi = parseAbi(["function assets(address) view returns ((uint8 state, bytes32 instrument, uint256 feeOut, uint256 feeIn, uint256 feeRefund, uint256 minAmount, uint256 lockCap))", "function destinations(uint32) view returns ((bool open, uint256 unit))", "function claimFee(address, uint32) view returns (uint256)", "function outOpen() view returns (bool)", "function inOpen() view returns (bool)", "function refundWait() view returns (uint256)"]);
const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);
const routerAbi = parseAbi(["function lockRoom(address) view returns (uint256)", "function inboxOf(string, uint32, address) view returns (address)"]);
const settings: RouteSettings = routeSettings(good, ag, fail)!;

interface World { inOpen?: boolean; everIn?: boolean; payout?: Payout | null; rows?: Record<string, unknown>[]; opened?: Record<string, unknown>[]; logs?: { txHash: string; block: number }[] | "fail"; intake?: number | "throws"; head?: number }
const pay = (over: Partial<Payout> = {}): Payout => ({ acceptances: new Set([PARTY]), paused: false, pausedUntil: null, assets: new Map([[CC, { left: 62n * CC_UNITS / 10n, renewsAt: "2026-11-22T14:05:00.000Z" }]]), ...over });
function build(w: World = {}) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const asked: { url: string; init: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const logsCalls: unknown[][] = [];
  const reth = {
    block: async () => ({ number: w.head ?? 900 }),
    callAt: async (_to: string, input: string): Promise<string> => {
      if (input === outOpenCall()) return encodeFunctionResult({ abi: bookAbi, functionName: "outOpen", result: true });
      if (input === inOpenCall()) return encodeFunctionResult({ abi: bookAbi, functionName: "inOpen", result: w.inOpen ?? true });
      if (input === refundWaitCall()) return encodeFunctionResult({ abi: bookAbi, functionName: "refundWait", result: 259200n });
      if (input === destinationCall(0)) return encodeFunctionResult({ abi: bookAbi, functionName: "destinations", result: { open: true, unit: 1n } });
      if (input === assetsCall(CC)) return encodeFunctionResult({ abi: bookAbi, functionName: "assets", result: { state: 1, instrument: ("0x" + "11".repeat(32)) as Hex, feeOut: CC_UNITS / 20n, feeIn: CC_UNITS / 10n, feeRefund: CC_UNITS / 20n, minAmount: CC_UNITS, lockCap: 10n * CC_UNITS } });
      if (input === claimFeeCall(CC, 0)) return encodeFunctionResult({ abi: bookAbi, functionName: "claimFee", result: (CC_UNITS * 15n) / 100n });
      if (input === lockRoomCall(CC)) return encodeFunctionResult({ abi: routerAbi, functionName: "lockRoom", result: 10n * CC_UNITS });
      if (input === symbolCall()) return encodeFunctionResult({ abi: erc20, functionName: "symbol", result: "CC" });
      if (input === nameCall()) return encodeFunctionResult({ abi: erc20, functionName: "name", result: "Canton Coin" });
      if (input === decimalsCall()) return encodeFunctionResult({ abi: erc20, functionName: "decimals", result: 10 });
      if (input === inboxOfCall(PARTY, 0, ME)) return encodeFunctionResult({ abi: routerAbi, functionName: "inboxOf", result: INBOX as Hex });
      throw new Error("unexpected call " + input);
    },
    logsSince: async (...args: unknown[]) => { logsCalls.push(args); if (w.logs === "fail") throw new Error("reth is down"); return w.logs ?? []; },
  };
  const pool = {
    async query(sql: string, values: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("l.topic0 = any")) return { rows: (w.rows ?? []) as never[] };
      if (sql.includes("topic1 from logs")) return { rows: [{ topic1: word(CC) }] };
      if (sql.includes("select 1 from logs")) return { rows: w.everIn === false ? [] : [{}] };
      if (sql.includes("l.topic3 = $5")) return { rows: (w.opened ?? []) as never[] };
      return { rows: [] };
    },
  };
  const canton: Canton = { requests: async () => [], payout: async () => { if (w.payout === null) throw new Error("canton is down"); return w.payout ?? pay(); } };
  const now = { t: 1_700_000_000_000 };
  const fetcher = (async (url: string, init: unknown) => {
    asked.push({ url, init });
    if (w.intake === "throws") throw new Error("connection refused");
    return { ok: (w.intake ?? 200) < 400, status: w.intake ?? 200 };
  }) as never;
  const route = createCantonRoute({ settings, agglayer: { ostiaBridge: "0x" + "53".repeat(20) }, bridge: { status: async () => ({ available: true }) as never }, reth: reth as never, pool, canton, fetcher, now: () => now.t });
  const get = async (path: string, q = "", ip = "1.2.3.4") => {
    const run = route.routes(path.split("/").slice(1), new URLSearchParams(q), ip);
    return run ? run() : undefined;
  };
  return { get, post: (body: unknown, ip = "1.2.3.4") => route.intake(typeof body === "string" ? body : JSON.stringify(body), ip), queries, asked, logsCalls, now };
}

const opened = (o: { party?: string; refund?: string; inbox?: string; net?: number; tx?: string; block?: number } = {}) => ({
  topic0: word(INBOX_OPENED_TOPIC), topic1: word(o.inbox ?? INBOX), topic2: word(partyHash(o.party ?? PARTY)), topic3: word(o.refund ?? ME), block_number: o.block ?? 100, ts: 1_700_000_000, hash: bytes((o.tx ?? "ab").repeat(32)),
  data: Buffer.from(encodeAbiParameters([{ type: "string" }, { type: "uint32" }], [o.party ?? PARTY, o.net ?? 0]).slice(2), "hex"),
});
const held = (balance: bigint, at: bigint, block = 120) => ({ topic0: word(HELD_TOPIC), topic1: word(INBOX), topic2: word(CC), topic3: null, block_number: block, ts: 1_700_000_100, hash: bytes("cd".repeat(32)), data: Buffer.from(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [balance, at]).slice(2), "hex") });
const forwarded = (amount: bigint, fee: bigint, block = 130) => ({ topic0: word(FORWARDED_TOPIC), topic1: word(INBOX), topic2: word(CC), topic3: null, block_number: block, ts: 1_700_000_200, hash: bytes("ef".repeat(32)), data: Buffer.from(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amount, fee]).slice(2), "hex") });
const refunded = (amount: bigint, fee: bigint, count: bigint, block = 140) => ({ topic0: word(REFUNDED_TOPIC), topic1: word(INBOX), topic2: word(CC), topic3: null, block_number: block, ts: 1_700_000_300, hash: bytes("fa".repeat(32)), data: Buffer.from(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [amount, fee, count]).slice(2), "hex") });

describe("the way back in the setup", () => {
  it("says the state of the direction, the waits, the router and what Canton can pay out, and gives each asset its way-back fees", async () => {
    const a = (await build().get("/api/canton-route/setup"))!;
    expect(a.status).toBe(200);
    const body = a.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.in).toEqual({
      route: "open", refundNetwork: 0, refundWaitSeconds: 259200, router: ROUTER, book: BOOK, setupSeconds: 900, setupTime: null, claimOstia: { afterSeconds: 600, leftOutSeconds: 1200 },
      payout: { paused: false, pausedUntil: null, assets: [{ erc20: CC, left: "62000000000", renewsAt: "2026-11-22T14:05:00.000Z" }] },
    });
    expect(body.assets[0]).toMatchObject({ erc20: CC, feeIn: "1000000000", feeRefund: "500000000", claimFee: "1500000000" });
  });
  it("is closed until its switch was ever turned on, and stopped once it was and is not now", async () => {
    expect(((await build({ inOpen: false, everIn: false }).get("/api/canton-route/setup"))!.body as any).in.route).toBe("closed"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(((await build({ inOpen: false }).get("/api/canton-route/setup"))!.body as any).in.route).toBe("stopped"); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  it("gives no payout while Canton cannot be read, and the rest as it is", async () => {
    const body = (await build({ payout: null }).get("/api/canton-route/setup"))!.body as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.in.payout).toBeNull();
    expect(body.in.route).toBe("open");
  });
  it("reads the way back's switch history from the book's own log, by the direction", async () => {
    const w = build();
    await w.get("/api/canton-route/setup");
    const reads = w.queries.filter((q) => q.sql.includes("select 1 from logs"));
    expect(reads.map((q) => q.values[2])).toEqual([word("0x01"), Buffer.alloc(32)]);
  });
});

describe("an account's Ostia address", () => {
  const q = (over: Record<string, string> = {}) => new URLSearchParams({ party: PARTY, refundNetwork: "0", refundAddress: ME.toUpperCase().replace("0X", "0x"), ...over }).toString();
  it("gives the address the router works out, whether the account takes withdrawals, and that it is not opened yet", async () => {
    const a = (await build().get("/api/canton-route/address", q()))!;
    expect(a.body).toEqual({ party: PARTY, refundNetwork: 0, refundAddress: ME, inbox: INBOX, accepts: true, opened: false, openedAt: null, openTx: null });
  });
  it("says opened, with the transaction and time, only when a final event names this address with this party and this way back", async () => {
    const a = (await build({ opened: [opened()] }).get("/api/canton-route/address", q()))!;
    expect(a.body).toMatchObject({ opened: true, openedAt: "2023-11-14T22:13:20.000Z", openTx: "0x" + "ab".repeat(32) });
    for (const wrong of [opened({ party: "mallory::1220" }), opened({ net: 74 })]) expect(((await build({ opened: [wrong] }).get("/api/canton-route/address", q()))!.body as { opened: boolean }).opened).toBe(false);
  });
  it("asks the final log with the inbox, the hash of the party and the way back, as topics", async () => {
    const w = build();
    await w.get("/api/canton-route/address", q());
    const s = w.queries.find((x) => x.sql.includes("l.topic3 = $5"))!;
    expect(s.values.slice(0, 5)).toEqual([bytes(ROUTER), bytes(INBOX_OPENED_TOPIC), word(INBOX).subarray(0), bytes(partyHash(PARTY)), word(ME)].map((v, i) => (i === 2 || i === 4 ? Buffer.concat([Buffer.alloc(12), v.subarray(12)]) : v)));
  });
  it("gives, while it is not final, the opening transaction found in the newest blocks, from 500 blocks back", async () => {
    const w = build({ logs: [{ txHash: "0x" + "77".repeat(32), block: 899 }], head: 900 });
    expect(((await w.get("/api/canton-route/address", q()))!.body as { openTx: string }).openTx).toBe("0x" + "77".repeat(32));
    expect(w.logsCalls).toEqual([[ROUTER, [INBOX_OPENED_TOPIC, "0x" + "00".repeat(12) + "1b".repeat(20)], 400]]);
    expect(((await build({ logs: "fail" }).get("/api/canton-route/address", q()))!.body as { openTx: unknown }).openTx).toBeNull();
  });
  it("says accepts null while Canton cannot be read, and false for an account that has no acceptance", async () => {
    expect(((await build({ payout: null }).get("/api/canton-route/address", q()))!.body as { accepts: unknown }).accepts).toBeNull();
    expect(((await build({ payout: pay({ acceptances: new Set() }) }).get("/api/canton-route/address", q()))!.body as { accepts: unknown }).accepts).toBe(false);
  });
  it("refuses a party, a network or an address that is not what it says, before any read", async () => {
    const w = build();
    for (const bad of [{ party: "a b" }, { party: "a".repeat(301) }, { refundNetwork: "74" }, { refundNetwork: "x" }, { refundAddress: "0x12" }] as Record<string, string>[]) expect((await w.get("/api/canton-route/address", q(bad)))!.status, JSON.stringify(bad)).toBe(400);
    expect(w.queries).toEqual([]);
  });
});

describe("the way back's events", () => {
  it("lists what happened to the inboxes of a wallet's way back, newest first, with the fields of each kind", async () => {
    const w = build({ rows: [refunded(4n * CC_UNITS, CC_UNITS / 10n, 9n), forwarded(47n * CC_UNITS / 10n, CC_UNITS / 10n), held(5n * CC_UNITS, 1_700_259_000n), opened()] });
    const a = (await w.get("/api/canton-route/moves", `evm=${ME}`))!;
    const body = a.body as { back: Record<string, unknown>[]; accepts: unknown };
    expect(body.back.map((e) => e.kind)).toEqual(["refunded", "forwarded", "held", "opened"]);
    expect(body.back[0]).toMatchObject({ inbox: INBOX, erc20: CC, amount: "40000000000", fee: "1000000000", depositCount: 9, txHash: "0x" + "fa".repeat(32), block: 140, at: "2023-11-14T22:18:20.000Z", party: null, balance: null });
    expect(body.back[2]).toMatchObject({ balance: "50000000000", refundAt: new Date(1_700_259_000_000).toISOString() });
    expect(body.back[3]).toMatchObject({ inbox: INBOX, party: PARTY, refundNetwork: 0, refundAddress: ME, erc20: null });
    expect(body.accepts).toEqual([{ party: PARTY, accepts: true }]);
    const s = w.queries.find((x) => x.sql.includes("l.topic0 = any"))!;
    expect(s.sql).toContain("o.topic3 = $4");
    expect(s.values[3]).toEqual(Buffer.concat([Buffer.alloc(12), bytes(ME)]));
  });
  it("finds the inboxes by the hash of the party, or by an inbox's own address, and reads no moves out for the address", async () => {
    const byParty = build({ rows: [opened()] });
    await byParty.get("/api/canton-route/moves", `party=${PARTY}`);
    const s = byParty.queries.find((x) => x.sql.includes("l.topic0 = any"))!;
    expect(s.sql).toContain("o.topic2 = $4");
    expect(s.values[3]).toEqual(bytes(partyHash(PARTY)));
    const byInbox = build({ rows: [opened()] });
    const a = (await byInbox.get("/api/canton-route/moves", `ostia=${INBOX}`))!;
    expect(byInbox.queries.find((x) => x.sql.includes("l.topic0 = any"))!.sql).toContain("o.topic1 = $4");
    expect(byInbox.queries.some((x) => x.sql.includes("l.topic0 = $2"))).toBe(false);
    expect(a.body).toMatchObject({ moves: [], requestsRead: true });
  });
  it("leaves an event that does not decode out, and says accepts null while Canton cannot be read", async () => {
    const broken = { ...held(1n, 1n), data: Buffer.from("00", "hex") };
    const a = (await build({ rows: [broken, opened()], payout: null }).get("/api/canton-route/moves", `evm=${ME}`))!;
    const body = a.body as { back: { kind: string }[]; accepts: unknown };
    expect(body.back.map((e) => e.kind)).toEqual(["opened"]);
    expect(body.accepts).toBeNull();
  });
  it("accepts ostia only with the way back on, and refuses it with none of the others", async () => {
    expect((await build().get("/api/canton-route/moves", `ostia=${INBOX}`))!.status).toBe(200);
    expect((await build().get("/api/canton-route/moves", `ostia=0x12`))!.status).toBe(400);
    expect((await build().get("/api/canton-route/moves", `ostia=${INBOX}&evm=${ME}`))!.status).toBe(400);
  });
  it("decodes the router's four events", () => {
    expect(decodeBack(HELD_TOPIC, held(7n, 8n).data.toString("hex").replace(/^/, "0x"))).toEqual({ kind: "held", balance: 7n, refundAt: 8n });
    expect(decodeBack("0x" + "00".repeat(32), "0x")).toBeNull();
  });
});

describe("asking the intake", () => {
  const body = { party: PARTY, refundNetwork: 0, refundAddress: ME };
  it("passes the party and the way back on to the intake, with the project's contact, and answers only that it asked", async () => {
    const w = build();
    const a = await w.post(body);
    expect(a).toEqual({ status: 200, body: { asked: true } });
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]!.url).toBe("http://127.0.0.1:7791/open");
    expect(JSON.parse(w.asked[0]!.init.body)).toEqual(body);
    expect(w.asked[0]!.init.headers["user-agent"]).toBe("Rome Protocol rome@romeprotocol.com");
  });
  it("refuses an account with no acceptance, and a request that is not what it says, without asking the intake", async () => {
    const w = build({ payout: pay({ acceptances: new Set() }) });
    expect(await w.post(body)).toMatchObject({ status: 400, body: { error: NOT_ACCEPTED } });
    for (const bad of ["not json", "[]", { ...body, party: "a b" }, { ...body, refundNetwork: 74 }, { ...body, refundAddress: "0x1" }]) expect((await w.post(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(w.asked).toEqual([]);
  });
  it("asks even when Canton cannot be read: the intake checks the acceptance itself", async () => {
    const w = build({ payout: null });
    expect((await w.post(body)).status).toBe(200);
  });
  it("says it is not available, with nothing about why, when the intake does not answer well", async () => {
    for (const intake of [500, "throws"] as const) {
      const a = await build({ intake }).post(body);
      expect(a).toEqual({ status: 503, body: { error: INTAKE_DOWN } });
    }
  });
  it("lets a client ask three times at once, then once in 20 seconds, with Retry-After", async () => {
    const w = build();
    for (let i = 0; i < 3; i++) expect((await w.post(body, "7.7.7.7")).status).toBe(200);
    const refused = await w.post(body, "7.7.7.7");
    expect(refused.status).toBe(429);
    expect(refused.headers?.["retry-after"]).toBeDefined();
    expect((await w.post(body, "8.8.8.8")).status).toBe(200);
    w.now.t += 21_000;
    expect((await w.post(body, "7.7.7.7")).status).toBe(200);
  });
});
