import { describe, expect, it } from "vitest";
import { createSolgateReader, SOLGATE_CACHE_MS, SOLGATE_FAILED_MS, SOLGATE_PATHS } from "./solgate.ts";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const chains = { chains: [
  { networkId: 74, name: "Rome Hadrian", nativeSymbol: "USDC", chainId: 200010 }, { networkId: 75, name: "Ostia", nativeSymbol: "tROME", chainId: 770101 }, { networkId: "x", name: "Bad" }, { networkId: 9, name: "", nativeSymbol: "E" },
] };
const tokens = { tokens: [
  { symbol: "SOL", name: "Wrapped SOL (Rome)", decimals: 9, evm: { "75": A(1), "0": A(2) } },
  { symbol: "ETH", name: "Ether (Rome)", decimals: 18, splDecimals: 9, evm: { "75": A(3), "32": null } },
  { symbol: "bad symbol!", name: "x", decimals: 1, evm: {} }, { symbol: "BIG", name: "x", decimals: 99, evm: {} }, { symbol: "NOADDR", name: "x", decimals: 6, evm: { "75": "nope" } },
] };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
function make(over: { chains?: () => Response; tokens?: () => Response } = {}) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  let t = 0;
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    return path === SOLGATE_PATHS.chains ? (over.chains ?? (() => json(chains)))() : path === SOLGATE_PATHS.assets ? (over.tokens ?? (() => json(tokens)))() : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { seen, advance: (ms: number) => (t += ms), api: createSolgateReader({ baseUrl: "https://solgate.example/", fetch: fetcher, now: () => t }) };
}

describe("the reader of Solgate's API", () => {
  it("asks only /v1/chains and /v1/tokens, with a GET, no redirect, a timeout and the project's User-Agent", async () => {
    const r = make();
    await r.api.read();
    expect(r.seen.map((s) => s.url).sort()).toEqual(["https://solgate.example/v1/chains", "https://solgate.example/v1/tokens"]);
    for (const s of r.seen) expect(s.init).toMatchObject({ redirect: "error", headers: { "user-agent": "Rome Protocol rome@romeprotocol.com" } });
    expect(r.seen.every((s) => s.init?.method === undefined && s.init?.signal !== undefined)).toBe(true);
  });

  it("reads the chains and tokens it understands, and leaves out an entry that is not what it should be", async () => {
    const v = (await make().api.read())!;
    expect([...v.chains.keys()]).toEqual([74, 75]);
    expect(v.chains.get(74)).toEqual({ networkId: 74, name: "Rome Hadrian", nativeSymbol: "USDC", chainId: 200010 });
    expect(v.assets.map((t) => t.symbol)).toEqual(["SOL", "ETH", "NOADDR"]);
    expect(v.assets[0]).toEqual({ symbol: "SOL", name: "Wrapped SOL (Rome)", decimals: 9, places: 9, evm: { 75: A(1), 0: A(2) } });
    expect(v.assets[1]).toMatchObject({ decimals: 18, places: 9, evm: { 75: A(3) } });
    expect(v.assets[2]!.evm).toEqual({});
  });

  it("is unknown (null) when either answer is refused, unreadable, the wrong shape or too long, and never throws", async () => {
    for (const over of [{ chains: () => json({}, 500) }, { tokens: () => new Response("not json") }, { chains: () => json({ nope: 1 }) }, { tokens: () => json({ tokens: "x" }) }, { tokens: () => new Response("x".repeat(600 * 1024)) }]) {
      expect(await make(over).api.read()).toBeNull();
    }
    const dead = createSolgateReader({ baseUrl: "https://solgate.example", fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    expect(await dead.read()).toBeNull();
  });

  it("keeps an answer for half a minute and a failure for a few seconds, and makes one request pair for readers that arrive together", async () => {
    expect(SOLGATE_CACHE_MS).toBe(30_000);
    const r = make();
    await Promise.all([r.api.read(), r.api.read()]);
    expect(r.seen).toHaveLength(2);
    r.advance(SOLGATE_CACHE_MS - 1); await r.api.read();
    expect(r.seen).toHaveLength(2);
    r.advance(2); await r.api.read();
    expect(r.seen).toHaveLength(4);
    const f = make({ chains: () => json({}, 503) });
    await f.api.read(); await f.api.read();
    expect(f.seen).toHaveLength(2);
    f.advance(SOLGATE_FAILED_MS + 1); await f.api.read();
    expect(f.seen).toHaveLength(4);
  });
});
