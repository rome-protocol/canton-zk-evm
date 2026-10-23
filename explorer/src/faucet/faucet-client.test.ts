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
  it("posts the address as JSON and reads the ticket and the place in line", async () => {
    const { faucet, calls } = client(() => json(202, { ticket: "ab12", position: 7, to: ADDRESS, amount: "1000000000000000000" }));
    expect(await faucet.request(ADDRESS)).toEqual({ kind: "queued", ticket: "ab12", position: 7, to: ADDRESS, amount: "1000000000000000000" });
    expect(calls[0]?.url).toBe("/api/faucet");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ address: ADDRESS });
  });
  it("sends the human check's token with the address when there is one", async () => {
    const { faucet, calls } = client(() => json(202, { ticket: "ab12", position: 1, to: ADDRESS, amount: "1" }));
    await faucet.request(ADDRESS, "tok");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ address: ADDRESS, captcha: "tok" });
  });
  it("tells each limit apart, keeps the server's words, and reads the wait from Retry-After", async () => {
    for (const which of ["address", "ip", "hour", "checks"] as const) {
      const { faucet } = client(() => json(429, { error: `words ${which}`, reason: which }, { "Retry-After": "85000" }));
      expect(await faucet.request(ADDRESS)).toEqual({ kind: "limit", which, waitSeconds: 85000, message: `words ${which}` });
    }
  });
  it("copes with a 429 that has no usable wait or no reason", async () => {
    expect(await client(() => json(429, { error: "x", reason: "address" }, { "Retry-After": "soon" })).faucet.request(ADDRESS)).toMatchObject({ kind: "limit", waitSeconds: null });
    expect(await client(() => json(429, { error: "x" })).faucet.request(ADDRESS)).toMatchObject({ kind: "limit", which: "hour" });
  });
  it("tells a full line from other 503s, and a failed human check from other 403s", async () => {
    expect(await client(() => json(503, { error: "full", reason: "queue" }, { "Retry-After": "30" })).faucet.request(ADDRESS)).toEqual({ kind: "full", waitSeconds: 30, message: "full" });
    expect(await client(() => json(403, { error: "check", reason: "captcha" })).faucet.request(ADDRESS)).toEqual({ kind: "captcha", message: "check" });
    expect(await client(() => json(503, { error: "The faucet is empty.", reason: "empty" })).faucet.request(ADDRESS)).toEqual({ kind: "problem", message: "The faucet is empty." });
  });
  it("hands the server's message on for a bad address, an off faucet, and anything else", async () => {
    for (const status of [400, 503, 502, 413]) {
      const { faucet } = client(() => json(status, { error: `message ${status}` }));
      expect(await faucet.request(ADDRESS)).toEqual({ kind: "problem", message: `message ${status}` });
    }
  });
  it("says so when the explorer cannot be reached", async () => {
    const { faucet } = client(() => Promise.reject(new TypeError("fetch failed")));
    expect(await faucet.request(ADDRESS)).toMatchObject({ kind: "problem", message: expect.stringMatching(/cannot be reached/) });
  });
  it("does not trust a 202 without a ticket", async () => {
    const { faucet } = client(() => json(202, { nothing: true }));
    expect((await faucet.request(ADDRESS)).kind).toBe("problem");
  });
});

describe("ticket", () => {
  const view = { ticket: "ab12", status: "sent", position: null, to: ADDRESS, amount: "1", hash: "0x" + "ab".repeat(32), state: "proving", block: null, reason: null };
  it("reads GET /api/faucet/ticket/<id>", async () => {
    const { faucet, calls } = client(() => json(200, view));
    expect(await faucet.ticket("ab12")).toEqual({ kind: "ticket", ticket: view });
    expect(calls[0]?.url).toBe("/api/faucet/ticket/ab12");
  });
  it("says a 404 is a ticket the explorer does not know, and anything it cannot read is only unreachable, so the page keeps asking", async () => {
    expect(await client(() => json(404, { error: "No such ticket." })).faucet.ticket("zz")).toEqual({ kind: "unknown" });
    expect(await client(() => json(502, { error: "x" })).faucet.ticket("zz")).toEqual({ kind: "unreachable" });
    expect(await client(() => json(200, { status: "weird" })).faucet.ticket("zz")).toEqual({ kind: "unreachable" });
    expect(await client(() => Promise.reject(new TypeError("fetch failed"))).faucet.ticket("zz")).toEqual({ kind: "unreachable" });
  });
});

const FAUCET = "0xCD56aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac6b3";
const tx = (over: Record<string, unknown> = {}) => ({ hash: "0xaa", from: FAUCET.toLowerCase(), to: ADDRESS, block: 19, timestamp: 1000, ...over });

describe("recent", () => {
  it("reads the faucet address's final transactions and keeps only what the faucet sent", async () => {
    const { faucet, calls } = client(() => json(200, { items: [tx(), tx({ hash: "0xbb", from: ADDRESS, to: FAUCET }), tx({ hash: "0xcc", block: 16 })], next: null }));
    expect(await faucet.recent!(FAUCET, 6)).toEqual([
      { hash: "0xaa", to: ADDRESS, block: 19, timestamp: 1000 },
      { hash: "0xcc", to: ADDRESS, block: 16, timestamp: 1000 },
    ]);
    expect(calls[0]?.url).toBe(`/api/addresses/${FAUCET}/txs?direction=sent&limit=6`);
  });
  it("shows at most the number asked for, and skips rows that are not whole", async () => {
    const { faucet } = client(() => json(200, { items: [tx({ to: null }), tx({ hash: "0x1" }), tx({ hash: "0x2" }), tx({ hash: "0x3" })], next: null }));
    expect((await faucet.recent!(FAUCET, 2))!.map((s) => s.hash)).toEqual(["0x1", "0x2"]);
  });
  it("says null, and never throws, when the answer cannot be read", async () => {
    expect(await client(() => json(502, { error: "x" })).faucet.recent!(FAUCET, 6)).toBeNull();
    expect(await client(() => json(200, { nope: 1 })).faucet.recent!(FAUCET, 6)).toBeNull();
    expect(await client(() => { throw new Error("down"); }).faucet.recent!(FAUCET, 6)).toBeNull();
  });
});

describe("txTimes", () => {
  const body = { hash: "0xaa", nonce: 1004, lifecycle: { acceptedAt: "2026-10-23T17:57:31.428Z", includedAt: "2026-10-23T17:57:31.600Z", proofStartedAt: "2026-10-23T17:57:31.832Z", finalAt: null, state: "proving" } };
  it("reads the transaction's nonce and the times of its lifecycle", async () => {
    const { faucet, calls } = client(() => json(200, body));
    expect(await faucet.txTimes!("0xaa")).toEqual({ nonce: 1004, acceptedAt: "2026-10-23T17:57:31.428Z", proofStartedAt: "2026-10-23T17:57:31.832Z", finalAt: null });
    expect(calls[0]?.url).toBe("/api/txs/0xaa");
  });
  it("says null for a time it is not given, and null when the transaction cannot be read", async () => {
    expect(await client(() => json(200, { nonce: 7, lifecycle: null })).faucet.txTimes!("0xaa")).toEqual({ nonce: 7, acceptedAt: null, proofStartedAt: null, finalAt: null });
    expect(await client(() => json(200, { nonce: "x", lifecycle: { acceptedAt: 5, proofStartedAt: "soon" } })).faucet.txTimes!("0xaa")).toEqual({ nonce: null, acceptedAt: null, proofStartedAt: null, finalAt: null });
    expect(await client(() => json(404, { error: "x" })).faucet.txTimes!("0xaa")).toBeNull();
    expect(await client(() => { throw new Error("down"); }).faucet.txTimes!("0xaa")).toBeNull();
  });
});

describe("usualProof", () => {
  const block = (n: number, proofSeconds: number | null) => ({ number: n, proofSeconds });
  it("reads the proof time the newest blocks usually take", async () => {
    const { faucet, calls } = client(() => json(200, { items: [7, 7.2, 7.4, 7.7, 7.1].map((s, i) => block(i, s)) }));
    expect(await faucet.usualProof!()).toEqual({ lowMs: 7000, highMs: 7700 });
    expect(calls[0]?.url).toBe("/api/blocks?limit=10");
  });
  it("says null when fewer than three blocks have a proof time, or the blocks cannot be read", async () => {
    expect(await client(() => json(200, { items: [block(1, 7), block(2, null)] })).faucet.usualProof!()).toBeNull();
    expect(await client(() => json(500, {})).faucet.usualProof!()).toBeNull();
    expect(await client(() => { throw new Error("down"); }).faucet.usualProof!()).toBeNull();
  });
});

describe("baseFee", () => {
  it("reads the newest block's base fee", async () => {
    const { faucet, calls } = client(() => json(200, { items: [{ number: 21, baseFee: "67300000" }], next: null }));
    expect(await faucet.baseFee!()).toBe("67300000");
    expect(calls[0]?.url).toBe("/api/blocks?limit=1");
  });
  it("says null when there is no block, or the fee is not a number, or it cannot be read", async () => {
    expect(await client(() => json(200, { items: [], next: null })).faucet.baseFee!()).toBeNull();
    expect(await client(() => json(200, { items: [{ baseFee: "lots" }] })).faucet.baseFee!()).toBeNull();
    expect(await client(() => json(500, {})).faucet.baseFee!()).toBeNull();
  });
});

describe("usualCommitMs", () => {
  it("reads the median commit time of the last hour's stats summary, in ms", async () => {
    const { faucet, calls } = client(() => json(200, { commitTime: { median: 5.4, p95: 9, samples: 40, capped: false } }));
    expect(await faucet.usualCommitMs!()).toBe(5400);
    expect(calls[0]?.url).toBe("/api/stats/summary?window=1h");
  });
  it("reads the day's median when the last hour has none", async () => {
    let n = 0;
    const { faucet, calls } = client(() => json(200, n++ === 0 ? { commitTime: null } : { commitTime: { median: 6.27 } }));
    expect(await faucet.usualCommitMs!()).toBe(6270);
    expect(calls.map((c) => c.url)).toEqual(["/api/stats/summary?window=1h", "/api/stats/summary?window=24h"]);
  });
  it("says null when the summary has no commit time, a bad one, or cannot be read", async () => {
    expect(await client(() => json(200, { commitTime: null })).faucet.usualCommitMs!()).toBeNull();
    expect(await client(() => json(200, {})).faucet.usualCommitMs!()).toBeNull();
    expect(await client(() => json(200, { commitTime: { median: "5" } })).faucet.usualCommitMs!()).toBeNull();
    expect(await client(() => json(500, {})).faucet.usualCommitMs!()).toBeNull();
    expect(await client(() => { throw new Error("down"); }).faucet.usualCommitMs!()).toBeNull();
  });
});
