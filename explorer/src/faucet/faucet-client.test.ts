import { describe, expect, it } from "vitest";
import { createFaucetClient } from "./faucet-client.ts";

const ADDRESS = "0x5a04de5c5ebd085f5e3b3ec791ab5cdc8e2b56f0";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  };
  return { calls, faucet: createFaucetClient(fetchFn as typeof fetch) };
}

describe("info", () => {
  it("reads GET /api/faucet", async () => {
    const body = { on: true, address: "0xcd56", balance: "5", amount: "1", perAddressSeconds: 86400 };
    const { faucet, calls } = client(() => json(200, body));
    expect(await faucet.info()).toEqual(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/faucet");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
  });
  it("throws the server's own message when it cannot answer", async () => {
    const { faucet } = client(() => json(502, { error: "The explorer cannot read the chain." }));
    await expect(faucet.info()).rejects.toThrow("The explorer cannot read the chain.");
  });
  it("throws a plain message when the explorer cannot be reached or does not answer in JSON", async () => {
    await expect(client(() => Promise.reject(new TypeError("fetch failed"))).faucet.info()).rejects.toThrow(/cannot be reached/);
    await expect(client(() => new Response("<html>", { status: 500 })).faucet.info()).rejects.toThrow(/cannot be reached|did not answer/);
  });
});

describe("request", () => {
  it("posts the address as JSON and reads the sent coin", async () => {
    const { faucet, calls } = client(() => json(200, { hash: "0x" + "ab".repeat(32), to: ADDRESS, amount: "1000000000000000000" }));
    expect(await faucet.request(ADDRESS)).toEqual({ kind: "sent", hash: "0x" + "ab".repeat(32), to: ADDRESS, amount: "1000000000000000000" });
    expect(calls[0]?.url).toBe("/api/faucet");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ address: ADDRESS });
  });
  it("tells the address limit from a send under way, and reads the wait from Retry-After", async () => {
    const limit = client(() => json(429, { error: "x", reason: "address" }, { "Retry-After": "85000" }));
    expect(await limit.faucet.request(ADDRESS)).toEqual({ kind: "limit", waitSeconds: 85000 });
    const busy = client(() => json(429, { error: "x", reason: "busy" }, { "Retry-After": "2" }));
    expect(await busy.faucet.request(ADDRESS)).toEqual({ kind: "busy", waitSeconds: 2 });
  });
  it("copes with a 429 that has no usable wait or no reason", async () => {
    expect(await client(() => json(429, { error: "x", reason: "address" }, { "Retry-After": "soon" })).faucet.request(ADDRESS)).toEqual({ kind: "limit", waitSeconds: null });
    expect(await client(() => json(429, { error: "x" })).faucet.request(ADDRESS)).toEqual({ kind: "busy", waitSeconds: null });
  });
  it("hands the server's message on for a bad address, an off or empty faucet, and anything else", async () => {
    for (const status of [400, 503, 502, 413]) {
      const { faucet } = client(() => json(status, { error: `message ${status}` }));
      expect(await faucet.request(ADDRESS)).toEqual({ kind: "problem", message: `message ${status}` });
    }
  });
  it("says so when the explorer cannot be reached", async () => {
    const { faucet } = client(() => Promise.reject(new TypeError("fetch failed")));
    expect(await faucet.request(ADDRESS)).toMatchObject({ kind: "problem", message: expect.stringMatching(/cannot be reached/) });
  });
  it("does not trust a 200 without a transaction hash", async () => {
    const { faucet } = client(() => json(200, { nothing: true }));
    expect((await faucet.request(ADDRESS)).kind).toBe("problem");
  });
});
