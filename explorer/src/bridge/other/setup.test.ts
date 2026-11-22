import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSetup, readSetup } from "./setup.ts";
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
    expect(open.open && open.times).toEqual({ in: { minSeconds: 240, maxSeconds: 420 }, out: null });
    expect(open.open && open.assets).toEqual([{ symbol: "ETH", name: "Ether", decimals: 18, sepolia: "native", ostia: WETH }]);
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
    expect(s.routes[0]!.open && s.routes[0]!.assets.map((a) => a.symbol)).toEqual(["ETH"]);
  });
  it("takes a time only as a whole range, and a worker's setting only when it is true", () => {
    const body = setupBody();
    body.routes[0].times = { in: { minSeconds: 500, maxSeconds: 100 }, out: { minSeconds: "1", maxSeconds: 2 } };
    body.routes[0].claimedForYou = { ostia: "yes", remote: true };
    const s = parseSetup(body);
    const r = s.on ? s.routes[0] : undefined;
    if (!r?.open) throw new Error("off");
    expect(r.times).toEqual({ in: null, out: null });
    expect(r.claimedForYou).toEqual({ ostia: false, remote: true });
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
