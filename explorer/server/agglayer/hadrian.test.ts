import { describe, expect, it } from "vitest";
import { createHadrianReader, HADRIAN_CACHE_MS, HADRIAN_FAILED_MS } from "./hadrian.ts";

function make(answer: () => Response | Promise<Response>, chainId = 200010) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  let t = 0;
  const fetcher = (async (url: unknown, init?: RequestInit) => { seen.push({ url: String(url), init }); return answer(); }) as unknown as typeof fetch;
  return { seen, advance: (ms: number) => (t += ms), api: createHadrianReader({ url: "https://hadrian.example/", chainId, fetch: fetcher, now: () => t }) };
}
const result = (r: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: r }), { status });

describe("the reader of Hadrian's public endpoint", () => {
  it("sends one eth_chainId, with no redirect, a timeout and the project's User-Agent, and is reachable when the chain id is the one set", async () => {
    const r = make(() => result("0x30d4a"));   // 200010
    expect(await r.api.reachable()).toBe(true);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.url).toBe("https://hadrian.example/");
    expect(r.seen[0]!.init).toMatchObject({ method: "POST", redirect: "error", headers: { "user-agent": "Rome Protocol rome@romeprotocol.com" } });
    expect(JSON.parse(String(r.seen[0]!.init!.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    expect(r.seen[0]!.init!.signal).toBeDefined();
  });

  it("is not reachable for another chain, a refusal, a bad answer, one that is too long or an endpoint that is down", async () => {
    for (const a of [() => result("0x1"), () => result("200010"), () => result(null), () => result("0x30d4a", 500), () => new Response("nope"), () => new Response("x".repeat(10_000)), () => { throw new Error("down"); }]) {
      expect(await make(a as () => Response).api.reachable()).toBe(false);
    }
  });

  it("keeps an answer for 10 s and a failure for 3 s", async () => {
    expect(HADRIAN_CACHE_MS).toBe(10_000);
    const r = make(() => result("0x30d4a"));
    await Promise.all([r.api.reachable(), r.api.reachable()]);
    expect(r.seen).toHaveLength(1);
    r.advance(HADRIAN_CACHE_MS - 1); await r.api.reachable();
    expect(r.seen).toHaveLength(1);
    r.advance(2); await r.api.reachable();
    expect(r.seen).toHaveLength(2);
    const f = make(() => result("0x1"));
    await f.api.reachable(); f.advance(HADRIAN_FAILED_MS - 1); await f.api.reachable();
    expect(f.seen).toHaveLength(1);
    f.advance(2); await f.api.reachable();
    expect(f.seen).toHaveLength(2);
  });
});
