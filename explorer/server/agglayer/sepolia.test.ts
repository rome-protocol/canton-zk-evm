import { describe, expect, it } from "vitest";
import { isClaimedCall, proxyAddressCall, rollupIdCall, wrappedAddressCall } from "./abi.ts";
import { Secret } from "./secret.ts";
import { SEPOLIA_USER_AGENT, SepoliaError, createSepoliaReader } from "./sepolia.ts";

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
const reader = (answer: Parameters<typeof fake>[0], now = { t: 0 }) => {
  const f = fake(answer);
  return { ...f, now, api: createSepoliaReader({ url: new Secret(KEY_URL), bridge: BRIDGE, rollupManager: MANAGER, fetch: f.fetcher, now: () => now.t }) };
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
});
