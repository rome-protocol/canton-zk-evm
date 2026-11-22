import { describe, expect, it } from "vitest";
import { isClaimedCall, proxyAddressCall, rollupIdCall, wrappedAddressCall } from "./abi.ts";
import { Secret } from "./secret.ts";
import { SEPOLIA_MAX_PER_SECOND, SEPOLIA_USER_AGENT, SepoliaBusy, SepoliaError, createSepoliaReader } from "./sepolia.ts";

const KEY_URL = "https://sepolia.example.invalid/v3/hidden-part-one";
const BRIDGE = "0x528e26b25a34a4a5d0dbda1d57d318153d2ed582";
const MANAGER = "0x32d33d5137a7cffb54c5bf8371172bcec5f310ff";
const WRAPPED_ETHER = "0x62274f867c1342fa1b66d79e126c2885d18ebdc3";
const word = (n: bigint | number) => "0x" + BigInt(n).toString(16).padStart(64, "0");

interface Call { url: string; init: RequestInit; body: { method: string; params: [{ to: string; data: string }, string] } }
function fake(answer: (to: string, data: string) => string | Error | Response) {
  const calls: Call[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    calls.push({ url: String(url), init: init!, body });
    const a = answer(body.params[0].to, body.params[0].data);
    if (a instanceof Error) throw a;
    if (a instanceof Response) return a;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: a }));
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const reader = (answer: Parameters<typeof fake>[0], now = { t: 0 }, maxPerSecond?: number) => {
  const f = fake(answer);
  return { ...f, now, api: createSepoliaReader({ url: new Secret(KEY_URL), bridge: BRIDGE, rollupManager: MANAGER, fetch: f.fetcher, now: () => now.t, ...(maxPerSecond === undefined ? {} : { maxPerSecond }) }) };
};

describe("the reader of Ethereum Sepolia", () => {
  it("sends only eth_call to the two fixed contracts, with the project's User-Agent, no redirect and a timeout", async () => {
    const r = reader(() => word(1));
    await r.api.isClaimed(7, 0);
    await r.api.attached(770101);
    expect(r.calls.map((c) => [c.body.method, c.body.params[0].to, c.body.params[1]])).toEqual([["eth_call", BRIDGE, "latest"], ["eth_call", MANAGER, "latest"]]);
    expect(r.calls[0]!.url).toBe(KEY_URL);
    expect(r.calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", headers: { "user-agent": SEPOLIA_USER_AGENT, "content-type": "application/json" } });
    expect(r.calls[0]!.init.signal).toBeDefined();
    expect(SEPOLIA_USER_AGENT).toBe("Rome Protocol rome@romeprotocol.com");
    expect(r.calls[0]!.body.params[0].data).toBe(isClaimedCall(7, 0));
    expect(r.calls[1]!.body.params[0].data).toBe(rollupIdCall(770101));
  });

  it("says whether a deposit was claimed, and keeps a claim for a minute and a not-yet for a few seconds", async () => {
    let claimed = false;
    const r = reader(() => word(claimed ? 1 : 0));
    expect(await r.api.isClaimed(7, 0)).toBe(false);
    claimed = true;
    expect(await r.api.isClaimed(7, 0)).toBe(false);
    r.now.t += 6000;
    expect(await r.api.isClaimed(7, 0)).toBe(true);
    claimed = false;
    r.now.t += 30_000;
    expect(await r.api.isClaimed(7, 0)).toBe(true);
    expect(r.calls).toHaveLength(2);
  });

  it("reads the address of the copy a token has, or will have, on Sepolia", async () => {
    const copy = "0x" + "ab".repeat(20);
    const r = reader((_to, data) => (data === proxyAddressCall(75, WRAPPED_ETHER) ? word(BigInt(copy)) : data === wrappedAddressCall(75, WRAPPED_ETHER) ? word(0) : "0x"));
    expect(await r.api.copyOf(75, WRAPPED_ETHER)).toEqual({ address: copy, exists: false });
    const made = reader((_to, data) => word(BigInt(data === proxyAddressCall(75, WRAPPED_ETHER) ? copy : copy)));
    expect(await made.api.copyOf(75, WRAPPED_ETHER)).toEqual({ address: copy, exists: true });
    await expect(r.api.copyOf(75, "0x12")).rejects.toThrow(TypeError);
  });

  it("says whether Ostia is still attached: a rollup number above zero", async () => {
    expect(await reader(() => word(75)).api.attached(770101)).toBe(true);
    expect(await reader(() => word(0)).api.attached(770101)).toBe(false);
    const none = createSepoliaReader({ url: new Secret(KEY_URL), bridge: BRIDGE, rollupManager: null, fetch: fake(() => word(1)).fetcher });
    expect(await none.attached(770101)).toBeNull();
  });

  it("refuses a number that does not fit the bridge's uint32", async () => {
    const r = reader(() => word(0));
    for (const n of [-1, 1.5, 2 ** 32]) await expect(r.api.isClaimed(n, 0)).rejects.toThrow(TypeError);
    expect(r.calls).toHaveLength(0);
  });

  it("never lets the endpoint's address into an error, a log line or a printed object", async () => {
    const failures: Parameters<typeof fake>[0][] = [
      () => new TypeError(`fetch failed ${KEY_URL}`),
      () => new Response(`bad ${KEY_URL}`, { status: 429 }),
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `rate limited at ${KEY_URL}` } })),
      () => new Response(`not json ${KEY_URL}`),
      () => "0x12",
    ];
    for (const f of failures) {
      const e = await reader(f).api.isClaimed(1, 0).catch((x: unknown) => x as Error);
      expect(e).toBeInstanceOf(SepoliaError);
      expect(String((e as Error).message) + String((e as Error).stack) + JSON.stringify(e) + String((e as Error).cause ?? "")).not.toContain("hidden-part-one");
    }
    expect(String(new Secret(KEY_URL))).toBe("[hidden]");
    expect(JSON.stringify({ u: new Secret(KEY_URL) })).toBe('{"u":"[hidden]"}');
    expect(`${new Secret(KEY_URL)}`).not.toContain("secret");
  });

  it("reads the words of a failure, not the endpoint's text", async () => {
    const said = async (answer: Parameters<typeof fake>[0]) => ((await reader(answer).api.isClaimed(1, 0).catch((e: unknown) => e)) as Error).message;
    expect(await said(() => new Response("x", { status: 429 }))).toBe("Ethereum Sepolia answered HTTP 429");
    expect(await said(() => new TypeError("x"))).toBe("Ethereum Sepolia cannot be reached");
    expect(await said(() => new Response(JSON.stringify({ error: { message: "x" } })))).toBe("Ethereum Sepolia refused the call");
  });

  it("stops reading an answer past 64 KiB instead of holding it, and says so in words", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(120);
    const long = () => new Response(new ReadableStream({ pull(c) { pulled += chunk.length; c.enqueue(chunk); } }));
    const e = (await reader(long).api.isClaimed(1, 0).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(SepoliaError);
    expect(e.message).toBe("Ethereum Sepolia did not answer with JSON");
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * chunk.length);
  });

  describe("the cap on all calls to Sepolia", () => {
    const outcomes = (ps: Promise<unknown>[]) => Promise.allSettled(ps);
    const busy = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "rejected" && r.reason instanceof SepoliaBusy);

    it("lets a burst from many clients make at most the cap's calls in a second; the rest are told to wait, with no call made", async () => {
      const r = reader(() => word(0), { t: 0 }, 5);
      const rs = await outcomes(Array.from({ length: 60 }, (_, i) => r.api.isClaimed(i, 0)));
      expect(r.calls).toHaveLength(5);
      expect(rs.filter((x) => x.status === "fulfilled")).toHaveLength(5);
      expect(busy(rs)).toHaveLength(55);
      const e = (busy(rs)[0] as PromiseRejectedResult).reason as SepoliaBusy;
      expect(e).toBeInstanceOf(SepoliaError);
      expect(e.retryAfterSeconds).toBe(1);
      expect(e.message).not.toContain("hidden-part-one");
    });

    it("never goes over the cap in any second, however the calls are spread, and gives the room back as the second passes", async () => {
      const r = reader(() => word(0), { t: 0 }, 5);
      let n = 0;
      const times: number[] = [];
      for (let t = 0; t < 10_000; t += 100) {
        r.now.t = t;
        const before = r.calls.length;
        await outcomes(Array.from({ length: 4 }, () => r.api.isClaimed(n++, 0)));
        for (let k = before; k < r.calls.length; k++) times.push(t);
      }
      for (const start of times) expect(times.filter((x) => x >= start && x < start + 1000).length).toBeLessThanOrEqual(5);
      expect(times.length).toBeGreaterThanOrEqual(45);
    });

    it("counts only real calls: a repeat from the cache, and a call already on its way, cost nothing", async () => {
      const r = reader(() => word(0), { t: 0 }, 2);
      await Promise.all(Array.from({ length: 30 }, () => r.api.isClaimed(1, 0)));
      expect(r.calls).toHaveLength(1);
      for (let i = 0; i < 40; i++) await r.api.isClaimed(1, 0);
      expect(r.calls).toHaveLength(1);
      await r.api.isClaimed(2, 0);
      expect(r.calls).toHaveLength(2);
      expect((await r.api.isClaimed(1, 0))).toBe(false);
      await expect(r.api.isClaimed(3, 0)).rejects.toBeInstanceOf(SepoliaBusy);
      expect(r.calls).toHaveLength(2);
    });

    it("counts a call that fails, since it reached Sepolia, but not a refusal, and does not keep a refusal", async () => {
      let fail = true;
      const r = reader(() => (fail ? new TypeError("x") : word(1)), { t: 0 }, 1);
      await expect(r.api.isClaimed(1, 0)).rejects.toThrow("Ethereum Sepolia cannot be reached");
      await expect(r.api.isClaimed(1, 0)).rejects.toBeInstanceOf(SepoliaBusy);
      expect(r.calls).toHaveLength(1);
      fail = false;
      r.now.t += 1000;
      expect(await r.api.isClaimed(1, 0)).toBe(true);
      expect(r.calls).toHaveLength(2);
    });

    it("says how many seconds until a call is possible, from the oldest call in the second", async () => {
      const r = reader(() => word(0), { t: 0 }, 2);
      await r.api.isClaimed(1, 0);
      r.now.t = 400;
      await r.api.isClaimed(2, 0);
      r.now.t = 500;
      const e = (await r.api.isClaimed(3, 0).catch((x: unknown) => x)) as SepoliaBusy;
      expect(e.retryAfterSeconds).toBe(1);
      r.now.t = 1000;
      await r.api.isClaimed(3, 0);
      expect(r.calls).toHaveLength(3);
    });

    it("asks for a copy's two reads as two calls, and a refusal on the second leaves the first kept", async () => {
      const r = reader(() => word(0), { t: 0 }, 1);
      await expect(r.api.copyOf(75, WRAPPED_ETHER)).rejects.toBeInstanceOf(SepoliaBusy);
      expect(r.calls).toHaveLength(1);
    });

    it("has a default of 5 a second", () => {
      expect(SEPOLIA_MAX_PER_SECOND).toBe(5);
    });
  });
});
