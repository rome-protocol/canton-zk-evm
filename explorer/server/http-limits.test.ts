import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "./http.ts";
import { MAX_VERIFY_BODY, createLimits } from "./limits.ts";

let dir: string, server: ReturnType<typeof createHttpServer>, calls: { method: string; target: string; body?: string }[];
let time = 1_000_000;
const clock = { now: () => time, advance: (ms: number) => void (time += ms) };

async function start(ipHeader: string | null = null) {
  dir = mkdtempSync(join(tmpdir(), "explorer-limits-"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<html>home</html>");
  calls = [];
  const api = async (method: string, target: string, body?: string) => { calls.push({ method, target, body }); return { status: 200, body: { ok: true } }; };
  server = createHttpServer(api, join(dir, "dist"), undefined, ipHeader, undefined, createLimits(clock.now));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
}
beforeEach(() => { time = 1_000_000; });
afterEach(async () => { await new Promise((ok) => server.close(ok)); rmSync(dir, { recursive: true, force: true }); });
const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);

describe("the REST routes' limit: 20 a second, bursts of 60", () => {
  it("answers 429 with Retry-After once a client is over, and serves it again as the bucket refills", async () => {
    await start();
    for (let i = 0; i < 60; i++) expect((await at("/api/status")).status).toBe(200);
    const over = await at("/api/block/1");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("1");
    expect(over.headers.get("cache-control")).toBe("no-store");
    expect((await over.json()).error).toMatch(/Too many requests/);
    expect(calls).toHaveLength(60); // the refused request never reached the API
    clock.advance(1000);
    expect((await at("/api/status")).status).toBe(200);
  });

  it("counts /healthz in the same rate as /api/status, which it answers the same as, and leaves the faucet and the pages to their own rules", async () => {
    await start();
    for (let i = 0; i < 61; i++) await at("/api/status");
    expect((await at("/api/status")).status).toBe(429);
    const probe = await at("/healthz");
    expect(probe.status).toBe(429);
    expect(probe.headers.get("retry-after")).toBe("1");
    const before = calls.length;
    for (let i = 0; i < 20; i++) await at("/healthz");
    expect(calls).toHaveLength(before); // a limited client does not reach the API through the probe route
    clock.advance(1000);
    expect((await at("/healthz")).status).toBe(200);
    expect((await at("/api/faucet", { method: "POST", body: "{}" })).status).toBe(200);
    expect(await (await at("/some/page")).text()).toContain("home");
  });

  it("counts GET /api/faucet and the ticket route in the REST rate (they call reth), and leaves POST /api/faucet to the faucet's own rules", async () => {
    await start();
    for (let i = 0; i < 60; i++) expect((await at("/api/status")).status).toBe(200);
    const before = calls.length;
    for (const path of ["/api/faucet", "/api/faucet/ticket/abc"]) {
      const over = await at(path);
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBe("1");
      expect((await over.json()).error).toMatch(/Too many requests/);
    }
    expect(calls).toHaveLength(before); // neither reached the API, so reth saw no call
    const post = await at("/api/faucet", { method: "POST", body: "{}" });
    expect(post.status).toBe(200);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)).toMatchObject({ method: "POST", target: "/api/faucet" });
    clock.advance(1000);
    expect((await at("/api/faucet")).status).toBe(200);
    expect((await at("/api/faucet/ticket/abc")).status).toBe(200);
  });

  it("tells clients apart by the trusted header when there is one, the last address in it, and ignores the header when none is named", async () => {
    await start("x-real-ip");
    const as = (ip: string) => ({ headers: { "x-real-ip": `10.9.9.9, ${ip}` } });
    for (let i = 0; i < 60; i++) await at("/api/status", as("198.51.100.1"));
    expect((await at("/api/status", as("198.51.100.1"))).status).toBe(429);
    expect((await at("/api/status", as("198.51.100.2"))).status).toBe(200);
    expect((await at("/api/status", as("2001:db8:0:1::5"))).status).toBe(200);
    for (let i = 0; i < 60; i++) await at("/api/status", as("2001:db8:0:1::5"));
    expect((await at("/api/status", as("2001:db8:0:1:ffff::9"))).status).toBe(429); // the same /64
    await new Promise((ok) => server.close(ok)); rmSync(dir, { recursive: true, force: true });
    await start(null);
    for (let i = 0; i < 60; i++) await at("/api/status", { headers: { "x-real-ip": `198.51.100.${i}` } });
    expect((await at("/api/status", { headers: { "x-real-ip": "198.51.100.200" } })).status).toBe(429);
  });
});

describe("the Etherscan door's limit: 10 a second, 600 a minute", () => {
  it("answers as Etherscan does: HTTP 200, status 0, Max rate limit reached, and a Retry-After", async () => {
    await start();
    for (let i = 0; i < 10; i++) expect((await (await at("/api?module=stats&action=ethsupply")).json())).toEqual({ ok: true });
    const over = await at("/api?module=stats&action=ethsupply");
    expect(over.status).toBe(200);
    expect(over.headers.get("retry-after")).toBe("1");
    expect(await over.json()).toEqual({ status: "0", message: "NOTOK", result: "Max rate limit reached" });
    expect(calls).toHaveLength(10);
  });

  it("is a rate of its own: the REST routes' bucket does not count it, and it does not count against theirs", async () => {
    await start();
    for (let i = 0; i < 10; i++) await at("/api?module=stats&action=ethsupply");
    expect((await at("/api/status")).status).toBe(200);
    for (let i = 0; i < 60; i++) await at("/api/block/1");
    expect((await (await at("/api?module=stats&action=ethsupply")).json()).status).toBe("0");
  });

  it("holds a client to 600 in a minute", async () => {
    await start();
    let served = 0;
    for (let s = 0; s < 60; s++) {
      for (let i = 0; i < 12; i++) if ((await (await at("/api?module=stats")).json()).ok) served++;
      clock.advance(1000);
    }
    expect(served).toBe(600);
  });
});

describe("the verification limit: 30 an hour, 500 KB a request", () => {
  const verify = (extra = "") => at("/api?module=contract&action=verifysourcecode", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `contractaddress=0x1&sourceCode=contract+A{}${extra}` });

  it("answers NOTOK with the reason after 30, and a Retry-After in seconds", async () => {
    await start();
    for (let i = 0; i < 30; i++) {
      expect(await (await verify()).json()).toEqual({ ok: true });
      clock.advance(150); // under the Etherscan door's 10 a second
    }
    const over = await verify();
    expect(over.status).toBe(200);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(60);
    const body = await over.json();
    expect(body).toMatchObject({ status: "0", message: "NOTOK" });
    expect(body.result).toMatch(/30 requests an hour/);
    expect(calls).toHaveLength(30);
  });

  it("finds the action in the form, and does not count a read of the same route", async () => {
    await start();
    for (let i = 0; i < 40; i++) {
      await at("/api", { method: "POST", body: "module=contract&action=verifyproxycontract&address=0x1" });
      clock.advance(150);
    }
    expect(calls).toHaveLength(30);
    clock.advance(1000);
    expect(await (await at("/api?module=contract&action=getabi&address=0x1")).json()).toEqual({ ok: true });
  });

  it("takes a verification of 500 KB, and refuses 500 KB and a byte, without calling the API", async () => {
    await start();
    const head = "module=contract&action=verifysourcecode&sourceCode=";
    const ok = await at("/api", { method: "POST", body: head + "a".repeat(MAX_VERIFY_BODY - head.length) });
    expect(await ok.json()).toEqual({ ok: true });
    const big = await at("/api", { method: "POST", body: head + "a".repeat(MAX_VERIFY_BODY - head.length + 1) });
    expect(await big.json()).toMatchObject({ status: "0", message: "NOTOK", result: expect.stringMatching(/at most 500 KB/) });
    expect(calls).toHaveLength(1);
  });

  it("holds anything that is not a verification to the small body of the other routes", async () => {
    await start();
    const res = await at("/api", { method: "POST", body: "module=stats&action=ethsupply&junk=" + "a".repeat(9000) });
    expect(await res.json()).toMatchObject({ status: "0", message: "NOTOK" });
    expect(calls).toHaveLength(0);
  });
});
