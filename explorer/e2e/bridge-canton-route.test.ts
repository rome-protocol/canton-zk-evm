import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../server/csp.ts";
import { ME, OSTIA_ID, SEPOLIA_BRIDGE, SEPOLIA_ID, setupBody as agglayerSetup } from "../src/bridge/other/fakes.ts";
import { cc, claimBody, movesBody, requested, setupBody, taken } from "../src/bridge/route/fakes.ts";
import type { Move } from "../src/bridge/route/setup.ts";

/**
 * The Bridge page's Canton route (Canton to Ethereum Sepolia through Ostia), in a real browser at the width of a phone: the built pages (BRIDGE_E2E_DIST, as for bridge-other-chains.test.ts), a wallet that records
 * what it is asked, and a fake explorer that answers the Canton route's two routes and the AggLayer ones. A move Ostia took is found by the wallet's address, goes through its steps, and the person's own claim is
 * signed on Ethereum Sepolia once the set time has passed; a request Ostia has not taken says "Not taken yet" with its real end; a reload loses nothing. Runs only when BRIDGE_E2E_DIST is set.
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4174, ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: OSTIA_ID, chainName: "Ostia", networkName: "TestNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const hex = (n: bigint | number) => "0x" + n.toString(16);

interface World { on: boolean; route: unknown; moves: Move[]; stage: string; claimed: boolean; chain: number; connected: boolean; sent: { chainId: number; tx: any }[]; signs: string[]; switches: number[] }
const fresh = (): World => ({ on: true, route: setupBody({ notTakenSeconds: 1, ownClaimSeconds: 1 }), moves: [], stage: "sent", claimed: false, chain: OSTIA_ID, connected: false, sent: [], signs: [], switches: [] });

describe.skipIf(!dist)("the Bridge page's Canton route, in a browser", () => {
  let world = fresh();
  let server: Server, browser: any;
  const refused: string[] = [];
  beforeEach(() => { world = fresh(); refused.length = 0; });
  afterEach(() => { expect(refused).toEqual([]); });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, ORIGIN), path = url.pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, { through: 1, registryService: null, vaults: [], twins: [], legs: [], canton: [] });
      if (path === "/api/agglayer/setup") return json(200, world.on ? agglayerSetup() : { on: false });
      if (path === "/api/canton-route/setup") return json(200, world.on ? world.route : { on: false });
      if (path === "/api/canton-route/moves" && world.on) return json(200, movesBody(world.moves));
      if (path === "/api/agglayer/deposit" && world.on) return json(200, { network: 75, count: 7, destinationNetwork: 0, stage: world.stage, sentAt: "2026-11-22T21:41:00Z", confirmedAt: "2026-11-22T21:50:00Z", readyAt: world.stage === "ready" || world.stage === "claimed" ? new Date(Date.now() - 60_000).toISOString() : null, leaf: null });
      if (path === "/api/agglayer/claim" && world.on) return json(200, claimBody({ claimed: world.claimed, data: world.claimed ? null : claimBody().data }));
      if (path === "/rpc") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const call = JSON.parse(Buffer.concat(chunks).toString());
        return json(200, { jsonrpc: "2.0", id: call.id, result: call.method === "eth_getBalance" ? hex(5n * 10n ** 18n) : null });
      }
      if (path.startsWith("/api/") || path.startsWith("/accounts/")) return json(404, { error: "Not found." });
      let file = join(resolve(dist!), path);
      if (!existsSync(file) || !statSync(file).isFile()) file = join(resolve(dist!), "index.html");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...(extname(file) === ".html" ? { "content-security-policy": contentSecurityPolicy() } : {}) });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((done) => server.listen(PORT, "127.0.0.1", done));
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((done) => server?.close(done)); });

  async function open(path: string) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("console", (m: any) => { if (/content security policy/i.test(m.text())) refused.push(m.text()); });
    await page.exposeFunction("__wallet", async (method: string, params: any[]) => {
      if (/sign/i.test(method)) { world.signs.push(method); throw new Error("the wallet was asked to sign"); }
      switch (method) {
        case "eth_requestAccounts": world.connected = true; return [ME];
        case "eth_accounts": return world.connected ? [ME] : [];
        case "eth_chainId": return hex(world.chain);
        case "wallet_switchEthereumChain": world.chain = Number(BigInt(params[0].chainId)); world.switches.push(world.chain); return null;
        case "eth_estimateGas": return "0x30d40";
        case "eth_sendTransaction": world.sent.push({ chainId: world.chain, tx: params[0] }); return "0x" + (0x4000 + world.sent.length).toString(16).padStart(64, "0");
        default: throw new Error(`the wallet was asked ${method}`);
      }
    });
    await page.addInitScript(() => {
      (window as any).ethereum = { request: ({ method, params }: any) => (window as any).__wallet(method, params ?? []), on() {}, removeListener() {} };
    });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return page;
  }
  const until = async (what: string, ok: () => boolean, ms = 40_000) => {
    const end = Date.now() + ms;
    while (!ok()) { if (Date.now() > end) throw new Error(`gave up waiting for ${what}`); await new Promise((r) => setTimeout(r, 200)); }
  };
  const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const toCanton = async (page: any) => {
    await page.getByRole("region", { name: "Route" }).waitFor();
    await page.getByRole("button", { name: /Canton .*Ethereum Sepolia/ }).click();
    await page.getByRole("region", { name: "Canton to Ethereum Sepolia" }).waitFor();
  };

  it("has no Canton row when the route is off, and the AggLayer tab as it was", async () => {
    world.route = { on: false };
    const page = await open("/bridge?tab=other-chains");
    await page.getByRole("region", { name: "Route" }).waitFor();
    await page.waitForTimeout(500);
    expect(await page.getByRole("button", { name: /Canton .*Ethereum Sepolia/ }).count()).toBe(0);
    await page.close();
  });

  it("shows the limits, finds a move by the wallet, and walks it to Arrived with the person's own claim on Ethereum Sepolia", async () => {
    world.route = setupBody({ notTakenSeconds: 1, ownClaimSeconds: 1 }, { lockRoom: cc(2.5) });
    world.moves = [taken({ at: new Date().toISOString() })];   // a move that arrived shows for 5 minutes after it was sent, so it is sent now, not at a fixed time
    const page = await open("/bridge?tab=other-chains");
    await toCanton(page);
    await page.getByText("Up to 10 CC of Canton Coin can be on AggLayer chains at once for now. 7.5 CC is out, so you can send up to 2.5 CC.").waitFor();
    expect(await page.getByRole("button", { name: "Send to Ethereum Sepolia" }).count()).toBe(0);   // no Canton wallet can connect yet
    await page.getByRole("button", { name: "Connect wallet" }).click();
    const row = page.getByRole("listitem", { name: "Sending 5 CC to Ethereum Sepolia" });
    await row.waitFor();
    expect(await row.getByRole("listitem", { name: "Through Ostia: done" }).count()).toBe(1);
    expect(await noSideways(page)).toBe(true);
    world.stage = "ready";
    await row.getByRole("button", { name: "Claim on Ethereum Sepolia" }).waitFor({ timeout: 40_000 });
    expect(await page.getByText("Ready to claim on Ethereum Sepolia. You can claim it now with your wallet.").count()).toBe(1);
    expect(await noSideways(page)).toBe(true);
    await row.getByRole("button", { name: "Claim on Ethereum Sepolia" }).click();
    await until("the claim on Sepolia", () => world.sent.length === 1);
    expect(world.switches).toEqual([SEPOLIA_ID]);
    expect(world.sent[0]).toMatchObject({ chainId: SEPOLIA_ID, tx: { from: ME, to: SEPOLIA_BRIDGE } });
    world.stage = "claimed"; world.claimed = true;
    await page.getByRole("listitem", { name: "Arrived. 4.8 CC is in your wallet on Ethereum Sepolia." }).waitFor({ timeout: 40_000 });
    expect(world.sent).toHaveLength(1);
    expect(world.signs).toEqual([]);
    await page.close();
  }, 180_000);

  it("says Not taken yet, with its real end, for a request Ostia has not taken, and still shows it after a reload", async () => {
    world.moves = [requested({ at: new Date(Date.now() - 120_000).toISOString(), settleBefore: new Date(Date.now() + 3_600_000).toISOString() })];
    const page = await open("/bridge?tab=other-chains");
    await toCanton(page);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByText(/^Not taken yet\. If it is not taken by \d\d:\d\d UTC, your 5 CC is free again in your Canton account\.$/).waitFor({ timeout: 40_000 });
    await page.reload({ waitUntil: "load" });
    await toCanton(page);
    await page.getByText(/^Not taken yet\./).waitFor({ timeout: 40_000 });
    expect(await noSideways(page)).toBe(true);
    expect(world.sent).toHaveLength(0);
    await page.close();
  }, 120_000);
});
