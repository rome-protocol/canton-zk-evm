import { afterEach, describe, expect, it, vi } from "vitest";
import { isHandoff, isMoved, parseSetup, readSetup } from "./setup.ts";
import { ostia, setupBody, SIGNATURE, TOPIC, WETH } from "./fakes.ts";

afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

describe("the setup answer", () => {
  it("is read as the server documents it", () => {
    const s = parseSetup(setupBody({ times: { in: { minSeconds: 240, maxSeconds: 420 }, out: null } }));
    expect(s).toMatchObject({ on: true, chain: ostia, bridgeEvent: { signature: SIGNATURE, topic0: TOPIC } });
    if (!s.on) throw new Error("off");
    expect(s.routes.map((r) => [r.id, r.name, r.open])).toEqual([["sepolia", "Ethereum Sepolia", true], ["hadrian", "Hadrian", false], ["solana-devnet", "Solana devnet", false]]);
    const open = s.routes[0]!;
    expect(isMoved(open) && open.times).toEqual({ in: { minSeconds: 240, maxSeconds: 420 }, out: null });
    expect(isMoved(open) && open.assets).toEqual([{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH }]);
    expect(s.routes[1]).toEqual({ id: "hadrian", name: "Hadrian", open: false });
  });
  it("is off for an answer that says so, and for anything that is not the documented answer", () => {
    for (const body of [{ on: false }, null, "on", [], { on: true }, { on: "true" }, { ...setupBody(), chain: null }, { ...setupBody(), chain: { ...ostia, bridge: "0x12" } }, { ...setupBody(), bridgeEvent: { signature: "x", topic0: "0x12" } }, { ...setupBody(), routes: "all" }]) {
      expect(parseSetup(body)).toEqual({ on: false });
    }
  });
  it("leaves out a row that does not read, and a token that does not, and keeps the rest", () => {
    const body = setupBody();
    body.routes[0].assets.push({ symbol: "BAD", name: "Bad", decimals: 18, sepolia: "nothing", ostia: WETH }, { symbol: "BAD2", name: "Bad", decimals: 99, sepolia: "native", ostia: WETH }, null);
    body.routes.push({ id: "open-but-wrong", name: "Wrong", open: true }, { id: 5 }, "row");
    const s = parseSetup(body);
    if (!s.on) throw new Error("off");
    expect(s.routes.map((r) => r.id)).toEqual(["sepolia", "hadrian", "solana-devnet"]);
    expect(isMoved(s.routes[0]!) && (s.routes[0] as { assets: { symbol: string }[] }).assets.map((a) => a.symbol)).toEqual(["ETH"]);
  });
  it("takes a time only as a whole range, and a worker's setting only when it is true", () => {
    const body = setupBody();
    body.routes[0].times = { in: { minSeconds: 500, maxSeconds: 100 }, out: { minSeconds: "1", maxSeconds: 2 } };
    body.routes[0].claimedForYou = { ostia: "yes", remote: true };
    const s = parseSetup(body);
    const r = s.on ? s.routes[0] : undefined;
    if (!r || !isMoved(r)) throw new Error("off");
    expect(r.times).toEqual({ in: null, out: null });
    expect(r.claimedForYou).toEqual({ ostia: false, remote: true });
  });
});

describe("a route through Solgate", () => {
  const handoffRow = (over: Record<string, unknown> = {}) => ({
    id: "hadrian", name: "Hadrian", open: true, via: "solgate", available: true, solgate: "https://solgate.example/", coin: "USDC", times: { in: null, out: { minSeconds: 600, maxSeconds: 900 } },
    assets: [{ symbol: "ETH", name: "Ether (Rome)", decimals: 18, places: 9, ostia: WETH, times: { in: { minSeconds: 360, maxSeconds: 360 }, out: null } }], ...over,
  });
  const read = (r: unknown) => { const b = setupBody(); b.routes[1] = r; const s = parseSetup(b); if (!s.on) throw new Error("off"); return s.routes; };

  it("is read as the server documents it, with Solgate's address without its trailing slash", () => {
    const r = read(handoffRow())[1]!;
    expect(isHandoff(r)).toBe(true);
    expect(isMoved(r)).toBe(false);
    expect(r).toEqual({
      id: "hadrian", name: "Hadrian", open: true, via: "solgate", available: true, solgate: "https://solgate.example", coin: "USDC", times: { in: null, out: { minSeconds: 600, maxSeconds: 900 } },
      assets: [{ symbol: "ETH", name: "Ether (Rome)", decimals: 18, places: 9, ostia: WETH, times: { in: { minSeconds: 360, maxSeconds: 360 }, out: null } }],
    });
    expect(isMoved(read(handoffRow())[0]!)).toBe(true);
  });
  it("takes no coin for Solana, leaves out a token that does not read, and a time only as a whole range", () => {
    const r = read(handoffRow({ id: "solana-devnet", coin: null, assets: [handoffRow().assets[0], { symbol: "BAD", name: "x", decimals: 99, places: 9, ostia: WETH }, { symbol: "BAD2", name: "x", decimals: 9, places: 9, ostia: "0x1" }, null, { ...handoffRow().assets[0], symbol: "T2", times: { in: { minSeconds: 9, maxSeconds: 1 }, out: "x" } }] }))[1]!;
    if (!isHandoff(r)) throw new Error("not a hand-off");
    expect(r.coin).toBeNull();
    expect(r.assets.map((t) => t.symbol)).toEqual(["ETH", "T2"]);
    expect(r.assets[1]!.times).toEqual({ in: null, out: null });
  });
  it("leaves out a row that is not the documented shape: no Solgate address over https, no availability, tokens that are not a list, another coin type, a via that is not known", () => {
    for (const bad of [handoffRow({ solgate: "http://solgate.example" }), handoffRow({ solgate: "https://user@solgate.example" }), handoffRow({ solgate: "javascript:alert(1)" }), handoffRow({ solgate: undefined }), handoffRow({ available: "yes" }), handoffRow({ assets: "ETH" }), handoffRow({ coin: 5 }), handoffRow({ via: "elsewhere" })]) {
      expect(read(bad).map((r) => r.id), JSON.stringify(bad)).toEqual(["sepolia", "solana-devnet"]);
    }
  });
});

describe("asking for it", () => {
  it("returns the setup when the server answers", async () => {
    answer(200, setupBody());
    expect((await readSetup()).on).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/agglayer/setup", expect.objectContaining({ headers: { accept: "application/json" } }));
  });
  it("is off when the server is off, has no such route, answers with an error, or cannot be reached", async () => {
    answer(200, { on: false });
    expect(await readSetup()).toEqual({ on: false });
    answer(404, { error: "Not found." });
    expect(await readSetup()).toEqual({ on: false });
    answer(503, setupBody());
    expect(await readSetup()).toEqual({ on: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await readSetup()).toEqual({ on: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    expect(await readSetup()).toEqual({ on: false });
  });
});
