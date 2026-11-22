import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../server/csp.ts";
import { claimData, eventLog, ME, OSTIA_BRIDGE, OSTIA_ID, SEPOLIA_BRIDGE, SEPOLIA_ID, setupBody as agglayerSetup } from "../src/bridge/other/fakes.ts";
import { addressBody, BOOK, cc, CC, held, INBOX, movesInBody, opened, PARTY, ROUTER, setupInBody } from "../src/bridge/route/fakes.ts";
import type { BackEvent } from "../src/bridge/route/setup.ts";

/**
 * The Bridge page's way back to Canton (Ethereum Sepolia to Canton through Ostia), in a real browser at the width of a phone: the built pages (BRIDGE_E2E_DIST, as for bridge-canton-route.test.ts), a wallet that
 * records what it is asked, and a fake explorer. The Canton account's Ostia address is set up and shown only once a final block opened it, the send goes from the wallet to that address on Ethereum Sepolia, the
 * person's own claim is signed on Ostia once the set time has passed, and a held coin offers its own steps. Runs only when BRIDGE_E2E_DIST is set.
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4175, ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: OSTIA_ID, chainName: "Ostia", networkName: "TestNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const hex = (n: bigint | number) => "0x" + n.toString(16);
const COPY = "0x" + "5e".repeat(20), SEND_HASH = "0x" + "70".repeat(32);
const proof = Array.from({ length: 32 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const ARGS = { smtProofLocalExitRoot: proof, smtProofRollupExitRoot: proof, globalIndex: "7", mainnetExitRoot: "0x" + "aa".repeat(32), rollupExitRoot: "0x" + "bb".repeat(32), originNetwork: 75, originTokenAddress: CC, destinationNetwork: 75, destinationAddress: INBOX, amount: cc(4.8).toString(), metadata: "0x" };

interface World { address: Record<string, unknown>; events: BackEvent[]; stage: string; connected: boolean; chain: number; posts: unknown[]; sent: { chainId: number; tx: any }[]; signs: string[] }
const fresh = (): World => ({ address: addressBody(), events: [], stage: "sent", connected: false, chain: OSTIA_ID, posts: [], sent: [], signs: [] });

describe.skipIf(!dist)("the Bridge page's way back to Canton, in a browser", () => {
  let world = fresh();
  let server: Server, browser: any;
  const refused: string[] = [];
  beforeEach(() => { world = fresh(); refused.length = 0; });
  afterEach(() => { expect(refused).toEqual([]); });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, ORIGIN), path = url.pathname;
      const body = async () => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks).toString(); };
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, { through: 1, registryService: null, vaults: [], twins: [], legs: [], canton: [] });
      if (path === "/api/agglayer/setup") return json(200, agglayerSetup({ assets: [{ symbol: "CC", name: "Canton Coin", decimals: 10, sepolia: COPY, ostia: CC }] }));
      if (path === "/api/canton-route/setup") return json(200, setupInBody());
      if (path === "/api/canton-route/moves") return json(200, movesInBody(world.events));
      if (path === "/api/canton-route/address" && req.method === "POST") { world.posts.push(JSON.parse(await body())); return json(200, { asked: true }); }
      if (path === "/api/canton-route/address") return json(200, world.address);
      if (path === "/api/agglayer/deposit") return json(200, { network: 0, count: 7, destinationNetwork: 75, stage: world.stage, sentAt: "2026-11-22T21:41:00Z", confirmedAt: "2026-11-22T21:50:00Z", readyAt: world.stage === "ready" ? new Date(Date.now() - 20 * 60_000).toISOString() : null, leaf: null });
      if (path === "/api/agglayer/claim") return json(200, { network: 0, count: 7, claimed: false, destinationNetwork: 75, chainId: OSTIA_ID, to: OSTIA_BRIDGE, l1InfoTreeIndex: 1, data: claimData(75, INBOX, cc(4.8), 7), args: ARGS });
      if (path === "/rpc") {
        const call = JSON.parse(await body());
        const result = (r: unknown) => json(200, { jsonrpc: "2.0", id: call.id, result: r });
        if (call.method === "eth_blockNumber") return result("0x64");
        if (call.method === "eth_getBalance") return result(hex(5n * 10n ** 18n));
        if (call.method === "eth_call") return result(call.params[0].to === ROUTER ? "0x" + "00".repeat(12) + "1b".repeat(20) : call.params[0].to === BOOK ? "0x" : null);
        return result(null);
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
        case "wallet_switchEthereumChain": world.chain = Number(BigInt(params[0].chainId)); return null;
        case "eth_getTransactionCount": return "0x4";
        case "eth_call": return "0x" + cc(10).toString(16).padStart(64, "0");
        case "eth_estimateGas": return "0x30d40";
        case "eth_sendTransaction": world.sent.push({ chainId: world.chain, tx: params[0] }); return world.sent.length === 1 ? SEND_HASH : "0x" + (0x70 + world.sent.length).toString(16).repeat(32);
        case "eth_getTransactionReceipt": return params[0] === SEND_HASH ? { status: "0x1", logs: [eventLog({ bridge: SEPOLIA_BRIDGE, dest: 75, to: INBOX, amount: cc(4.8), count: 7 })] } : null;
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
    await page.getByRole("region", { name: "Ethereum Sepolia to Canton" }).waitFor();
  };

  it("sets up the account's Ostia address, sends from the wallet to it on Ethereum Sepolia, and signs the person's own claim on Ostia", async () => {
    const page = await open("/bridge?tab=other-chains");
    await toCanton(page);
    await page.getByRole("button", { name: "Connect wallet" }).first().click();
    const card = page.getByRole("region", { name: "Ethereum Sepolia to Canton" });
    await card.getByLabel("Canton account").fill(PARTY);
    await card.getByText("Setting up this Canton account's Ostia address").waitFor({ timeout: 20_000 });
    await until("the ask for the address", () => world.posts.length === 1);
    expect(await card.getByText("0x1b1b…1b1b").count()).toBe(0);   // shown only once a final block opened it
    expect(await noSideways(page)).toBe(true);
    world.address = addressBody({ opened: true, openedAt: new Date().toISOString(), openTx: "0x" + "ab".repeat(32) });
    await card.getByText("Takes transfers from Ostia: yes").waitFor({ timeout: 20_000 });
    await card.getByText("0x1b1b…1b1b").waitFor();
    await card.getByLabel("Amount of CC").fill("4.8");
    await card.getByText("Fee 0.1000000000 CC, taken from the amount. It covers the cost on Ostia.").waitFor();
    await card.getByText("The account gets 4.7000000000 CC").waitFor();
    expect(await noSideways(page)).toBe(true);
    await card.getByRole("button", { name: "Send to Canton" }).click();
    await until("the send on Sepolia", () => world.sent.length === 1);
    expect(world.sent[0]).toMatchObject({ chainId: SEPOLIA_ID, tx: { from: ME, to: SEPOLIA_BRIDGE } });
    expect(world.sent[0]!.tx.data.toLowerCase()).toContain(INBOX.slice(2));
    const row = page.getByRole("listitem", { name: "Sending 4.8 CC to Canton" });
    await row.waitFor({ timeout: 20_000 });
    world.stage = "ready";
    await row.getByRole("button", { name: "Claim on Ostia" }).waitFor({ timeout: 40_000 });
    expect(await noSideways(page)).toBe(true);
    await row.getByRole("button", { name: "Claim on Ostia" }).click();
    await until("the claim on Ostia", () => world.sent.length === 2);
    expect(world.sent[1]).toMatchObject({ chainId: OSTIA_ID, tx: { from: ME, to: ROUTER } });
    expect(world.signs).toEqual([]);
    await page.close();
  }, 180_000);

  it("shows a held coin with its own steps, found by the wallet, and after a reload", async () => {
    world.events = [held({ at: new Date(Date.now() - 1_800_000).toISOString(), refundAt: new Date(Date.now() - 60_000).toISOString() }), opened()];
    const page = await open("/bridge?tab=other-chains");
    await toCanton(page);
    await page.getByRole("button", { name: "Connect wallet" }).first().click();
    await page.getByRole("button", { name: "Send back to Ethereum Sepolia" }).waitFor({ timeout: 40_000 });
    await page.getByRole("button", { name: "Send on to Canton" }).waitFor();
    expect(await noSideways(page)).toBe(true);
    await page.reload({ waitUntil: "load" });
    await toCanton(page);
    await page.getByRole("button", { name: "Send back to Ethereum Sepolia" }).waitFor({ timeout: 40_000 });
    expect(world.sent).toHaveLength(0);
    await page.close();
  }, 120_000);
});
