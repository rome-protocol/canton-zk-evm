import { afterEach, describe, expect, it, vi } from "vitest";
import { addressBody, BOOK, cc, CC, forwarded, held, INBOX, movesBody, movesInBody, ME, opened, PARTY, refunded, requested, ROUTER, setupBody, setupInBody, taken } from "./fakes.ts";
import { askAddress, parseMoves, parseRouteSetup, readAddress, readMoves, readRouteSetup } from "./setup.ts";

afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe("the Canton route's setup, as the page reads it", () => {
  it("reads the documented answer, with amounts in base units", () => {
    const s = parseRouteSetup(setupBody({ time: { minSeconds: 480, maxSeconds: 960 } }));
    expect(s).toMatchObject({ on: true, route: "open", available: true, unit: 1n, time: { minSeconds: 480, maxSeconds: 960 }, notTakenSeconds: 600, ownClaimSeconds: 300 });
    expect(s.on && s.assets).toEqual([{ erc20: CC, symbol: "CC", name: "Canton Coin", decimals: 10, open: true, feeOut: cc(0.05), claimFee: cc(0.15), minAmount: cc(1), lockCap: cc(10), lockRoom: cc(10), feeIn: 0n, feeRefund: 0n }]);
  });
  it("reads anything else as off", () => {
    const good = setupBody();
    for (const bad of [null, [], { on: false }, { ...good, on: 1 }, { ...good, route: "maybe" }, { ...good, available: "yes" }, { ...good, assets: {} }, { ...good, destination: { network: 75, unit: "1" } },
      { ...good, destination: { network: 0, unit: "0" } }, { ...good, destination: { network: 0, unit: 1 } }, { ...good, notTakenSeconds: -1 }, { ...good, ownClaimSeconds: "300" }]) {
      expect(parseRouteSetup(bad), JSON.stringify(bad).slice(0, 60)).toEqual({ on: false });
    }
  });
  it("leaves out an asset that does not read, and a time that does not", () => {
    const good = setupBody();
    const s = parseRouteSetup({ ...good, time: { minSeconds: 9, maxSeconds: 3 }, assets: [{ ...good.assets[0], lockRoom: "-1" }, { ...good.assets[0], erc20: "0x12" }, good.assets[0]] });
    expect(s.on && s.assets).toHaveLength(1);
    expect(s.on && s.time).toBeNull();
  });
  it("asks the server, and an off, missing or unreachable server is off", async () => {
    answer(200, setupBody());
    expect((await readRouteSetup()).on).toBe(true);
    answer(404, { error: "Not found." });
    expect(await readRouteSetup()).toEqual({ on: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await readRouteSetup()).toEqual({ on: false });
    answer(200, { on: false });
    expect(await readRouteSetup()).toEqual({ on: false });
  });
});

describe("the moves, as the page reads them", () => {
  it("reads taken moves and requests", () => {
    const m = parseMoves(movesBody([requested(), taken({ id: "0x" + "d2".repeat(32) })]))!;
    expect(m.requestsRead).toBe(true);
    expect(m.moves).toEqual([requested(), taken({ id: "0x" + "d2".repeat(32) })]);
  });
  it("leaves out a move that does not read (a taken one needs its amounts, deposit number and transaction), and refuses a list that is not one", () => {
    const body = movesBody([taken(), taken({ id: "0x" + "d2".repeat(32) })]);
    const broken = { ...body, moves: [{ ...body.moves[0], depositCount: null }, { ...body.moves[1], send: "-1" }, { ...body.moves[1], id: "0x12" }, { ...body.moves[1], destAddress: "nope" }, { ...body.moves[1], state: "lost" }, body.moves[1]] };
    expect(parseMoves(broken)!.moves).toHaveLength(1);
    expect(parseMoves({ moves: {}, requestsRead: true })).toBeNull();
    expect(parseMoves({ moves: [] })).toBeNull();
  });
  it("asks by wallet or by account, with the value encoded, and is null when it cannot read", async () => {
    answer(200, movesBody([]));
    await readMoves("party", "alice::1220ab");
    expect((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toBe("/api/canton-route/moves?party=alice%3A%3A1220ab");
    await readMoves("evm", ME);
    expect((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[1]![0]).toBe(`/api/canton-route/moves?evm=${ME}`);
    answer(503, { error: "x" });
    expect(await readMoves("evm", ME)).toBeNull();
  });
});

describe("the way back, as the page reads it", () => {
  it("reads the setup's way back with the payout, and an asset's way-back fees", () => {
    const s = parseRouteSetup(setupInBody());
    expect(s.on && s.in).toMatchObject({ route: "open", refundWaitSeconds: 259_200, router: ROUTER, book: BOOK, setupSeconds: 900, setupTime: null, claimOstia: { afterSeconds: 600, leftOutSeconds: 1200 }, payout: { paused: false, assets: { [CC]: { left: cc(6.2), renewsAt: "2026-11-22T14:05:00.000Z" } } } });
    expect(s.on && s.assets[0]).toMatchObject({ feeIn: cc(0.1), feeRefund: cc(0.05) });
    expect(parseRouteSetup(setupBody())).toMatchObject({ on: true, in: null });
  });
  it("reads no way back from an answer that does not read, and no payout while Canton could not be read", () => {
    const good = setupInBody();
    for (const bad of [{ ...good.in, route: "x" }, { ...good.in, refundNetwork: 74 }, { ...good.in, router: "0x1" }, { ...good.in, book: undefined }, { ...good.in, setupSeconds: -1 }, "nope"]) {
      expect(parseRouteSetup({ ...good, in: bad }), JSON.stringify(bad).slice(0, 50)).toMatchObject({ on: true, in: null });
    }
    expect(parseRouteSetup({ ...good, in: { ...good.in, payout: null } })).toMatchObject({ in: { payout: null } });
    expect(parseRouteSetup({ ...good, in: { ...good.in, payout: { paused: "no", assets: [] } } })).toMatchObject({ in: { payout: null } });
    expect(parseRouteSetup({ ...good, in: { ...good.in, claimOstia: null } })).toMatchObject({ in: { claimOstia: null } });
  });
  it("reads the router's events and which accounts take withdrawals, and leaves out an event that does not read", () => {
    const m = parseMoves(movesInBody([refunded(), forwarded(), held(), opened()]))!;
    expect(m.back.map((e) => e.kind)).toEqual(["refunded", "forwarded", "held", "opened"]);
    expect(m.back[0]).toMatchObject({ amount: cc(4.6), fee: cc(0.2), depositCount: 9, erc20: CC });
    expect(m.back[3]).toMatchObject({ party: PARTY, refundAddress: ME, refundNetwork: 0 });
    expect(m.accepts).toEqual({ [PARTY]: true });
    const body = movesInBody([held(), forwarded(), opened()]);
    const broken = { ...body, back: [{ ...body.back[0], refundAt: null }, { ...body.back[1], amount: null }, { ...body.back[2], party: null }, { ...body.back[0], kind: "other" }, { ...body.back[0], txHash: "0x1" }] };
    expect(parseMoves(broken)!.back).toEqual([]);
  });
  it("has no events from a server without the way back, and no accounts when Canton could not be read", () => {
    expect(parseMoves(movesBody([]))).toMatchObject({ back: [], accepts: null });
    expect(parseMoves(movesInBody([], null))!.accepts).toBeNull();
  });
  it("reads an account's address, and asks for it to be opened, never reading the address from the ask", async () => {
    answer(200, addressBody({ opened: true, openedAt: "2026-11-22T21:30:00Z", openTx: "0x" + "ab".repeat(32) }));
    expect(await readAddress(PARTY, ME)).toEqual({ party: PARTY, refundAddress: ME, inbox: INBOX, accepts: true, opened: true, openedAt: "2026-11-22T21:30:00Z", openTx: "0x" + "ab".repeat(32) });
    expect((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toBe(`/api/canton-route/address?party=alice%3A%3A1220${"9f".repeat(16)}&refundNetwork=0&refundAddress=${ME}`);
    answer(200, addressBody({ inbox: "0x12" }));
    expect(await readAddress(PARTY, ME)).toBeNull();
    answer(503, { error: "x" });
    expect(await readAddress(PARTY, ME)).toBeNull();
    answer(200, { asked: true });
    expect(await askAddress(PARTY, ME)).toBe(true);
    const call = (fetch as unknown as { mock: { calls: [string, { method: string; body: string }][] } }).mock.calls[0]!;
    expect(call[0]).toBe("/api/canton-route/address");
    expect([call[1].method, JSON.parse(call[1].body)]).toEqual(["POST", { party: PARTY, refundNetwork: 0, refundAddress: ME }]);
    answer(503, { error: "x" });
    expect(await askAddress(PARTY, ME)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await askAddress(PARTY, ME)).toBe(false);
  });
});
