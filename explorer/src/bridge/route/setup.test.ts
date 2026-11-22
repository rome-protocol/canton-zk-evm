import { afterEach, describe, expect, it, vi } from "vitest";
import { cc, CC, movesBody, ME, requested, setupBody, taken } from "./fakes.ts";
import { parseMoves, parseRouteSetup, readMoves, readRouteSetup } from "./setup.ts";

afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe("the Canton route's setup, as the page reads it", () => {
  it("reads the documented answer, with amounts in base units", () => {
    const s = parseRouteSetup(setupBody({ time: { minSeconds: 480, maxSeconds: 960 } }));
    expect(s).toMatchObject({ on: true, route: "open", available: true, unit: 1n, time: { minSeconds: 480, maxSeconds: 960 }, notTakenSeconds: 600, ownClaimSeconds: 300 });
    expect(s.on && s.assets).toEqual([{ erc20: CC, symbol: "CC", name: "Canton Coin", decimals: 10, feeOut: cc(0.05), claimFee: cc(0.15), minAmount: cc(1), lockCap: cc(10), lockRoom: cc(10) }]);
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
