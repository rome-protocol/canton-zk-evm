import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../server/csp.ts";
import { claimData, eventLog, ME, OSTIA_BRIDGE, OSTIA_ID, SEPOLIA_BRIDGE, SEPOLIA_ID, setupBody, stage } from "../src/bridge/other/fakes.ts";

/**
 * The Bridge page's "Other chains" tab, in a real browser at the width of a phone: the built pages (BRIDGE_E2E_DIST, the TestNet shape as for bridge-off.test.ts), a wallet that records what it is asked, and a fake
 * explorer with a fake bridge service behind it (the three /api/agglayer routes) and a fake Ethereum Sepolia (the wallet's own chain: it answers only while the wallet is on it). Both ways are walked: a deposit on
 * Sepolia, the wait, the claim on Ostia; a send on Ostia, the wait, the claim on Sepolia. A reload in the middle carries on and signs nothing again, and with the server's switch off there is no tab. Runs only when
 * BRIDGE_E2E_DIST is set (the `bridge-page` job of .github/workflows/explorer.yml does, with the build of bridge-off.test.ts).
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4173, ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: OSTIA_ID, chainName: "Ostia", networkName: "TestNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const AMOUNT = 2_000_000_000_000_000n;   // 0.002
const hex = (n: bigint | number) => "0x" + n.toString(16);

interface World {
  /** The server's switch. */
  on: boolean;
  /** The deposit's stage and number, as the bridge service shows them. */
  stage: string; count: number; claimed: boolean;
  /** The wallet: its chain, whether it shared the account, what it sent, and what it was asked that is a signature. */
  chain: number; connected: boolean; sent: { chainId: number; tx: any; hash: string }[]; signs: string[]; switches: number[];
  /** Receipts of the transactions in blocks (Ostia's are read through the explorer, Sepolia's through the wallet). */
  receipts: Map<string, unknown>;
  setupReads: number;
}
const fresh = (): World => ({ on: true, stage: "unknown", count: 7, claimed: false, chain: SEPOLIA_ID, connected: false, sent: [], signs: [], switches: [], receipts: new Map(), setupReads: 0 });

describe.skipIf(!dist)("the Bridge page's Other chains tab, in a browser", () => {
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
      if (path === "/api/agglayer/setup") { world.setupReads++; return json(200, world.on ? setupBody() : { on: false }); }
      if (path === "/api/agglayer/deposit" && world.on) {
        const network = Number(url.searchParams.get("network"));
        return json(200, { network, count: world.count, destinationNetwork: network === 0 ? 75 : 0, ...stage(world.stage as never) });
      }
      if (path === "/api/agglayer/claim" && world.on) {
        const network = Number(url.searchParams.get("network")), out = network === 75;
        return json(200, { network, count: world.count, claimed: world.claimed, destinationNetwork: out ? 0 : 75, chainId: out ? SEPOLIA_ID : OSTIA_ID, to: out ? SEPOLIA_BRIDGE : OSTIA_BRIDGE, l1InfoTreeIndex: 1, data: world.claimed ? null : claimData(out ? 0 : 75, ME, AMOUNT), args: null });
      }
      if (path === "/rpc") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const call = JSON.parse(Buffer.concat(chunks).toString());
        const result = call.method === "eth_getBalance" ? hex(5n * 10n ** 18n)
          : call.method === "eth_call" ? "0x" + (3n * 10n ** 15n).toString(16).padStart(64, "0")
          : call.method === "eth_estimateGas" ? "0x30d40"
          : call.method === "eth_getTransactionReceipt" ? world.receipts.get(call.params[0]) ?? null : null;
        return json(200, { jsonrpc: "2.0", id: call.id, result });
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

  /** A page at the width of a phone, with a wallet on Ethereum Sepolia that turns down nothing and signs no message. */
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
        case "eth_getBalance": return hex(5n * 10n ** 18n);
        case "eth_getTransactionCount": return hex((world.chain === SEPOLIA_ID ? 4 : 7) + (params[1] === "pending" ? world.sent.filter((s) => s.chainId === world.chain).length : 0));
        case "eth_estimateGas": return "0x30d40";
        case "eth_sendTransaction": {
          const hash = "0x" + (0x3000 + world.sent.length).toString(16).padStart(64, "0");
          world.sent.push({ chainId: world.chain, tx: params[0], hash });
          return hash;
        }
        case "eth_getTransactionReceipt": return world.receipts.get(params[0]) ?? null;
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
  /** The send at `index` is in a block, and made its deposit number. */
  const mined = (index: number, bridge: string, dest: number) => world.receipts.set(world.sent[index]!.hash, { status: "0x1", logs: [eventLog({ bridge, dest, amount: AMOUNT, count: world.count })] });
  const toOtherChains = async (page: any) => {
    await page.getByRole("tab", { name: "Other chains" }).click();
    await page.getByRole("region", { name: "Route" }).waitFor();
  };

  it("has no tab and the Canton page as it was when the server's switch is off", async () => {
    world.on = false;
    const page = await open("/bridge");
    await page.getByRole("heading", { level: 1, name: "Bridge" }).waitFor();
    await page.getByRole("tab", { name: "Move" }).waitFor();   // the Canton page's own tabs: the build has the Canton settings
    await until("the setup to be read", () => world.setupReads > 0);
    await page.waitForTimeout(500);
    expect(await page.getByRole("tab", { name: "Other chains" }).count()).toBe(0);
    expect(await page.getByRole("heading", { level: 1, name: "Bridge" }).count()).toBe(1);
    await page.close();
  });

  it("shows the routes, and sends ETH from Sepolia to Ostia: deposit, wait, claim on Ostia by the person, arrived", async () => {
    const page = await open("/bridge");
    await toOtherChains(page);
    const routes = page.getByRole("region", { name: "Route" });
    expect(await routes.getByText("Not yet open").count()).toBe(2);   // Hadrian and Solana devnet
    expect(await routes.getByRole("button", { name: /Ethereum Sepolia/ }).getAttribute("aria-pressed")).toBe("true");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    expect(await page.getByText(/Bring your own Sepolia ETH/).count()).toBe(1);   // said before the Sepolia pop-up
    await page.getByRole("textbox", { name: "Amount to move" }).fill("0.002");
    expect(await page.getByRole("textbox", { name: "Amount you get" }).inputValue()).toBe("0.002");
    await page.getByRole("button", { name: "Send to Ostia" }).click();
    await until("the deposit on Sepolia", () => world.sent.length === 1);
    expect(world.chain).toBe(SEPOLIA_ID);
    expect(world.sent[0]!.tx).toMatchObject({ from: ME, to: SEPOLIA_BRIDGE, value: hex(AMOUNT) });
    await page.getByRole("listitem", { name: "Sending 0.002 ETH to Ostia" }).waitFor();
    expect(await noSideways(page)).toBe(true);
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "confirmed";
    await page.getByRole("listitem", { name: "Sent on Ethereum Sepolia: done" }).waitFor({ timeout: 40_000 });
    expect(await page.getByText("Confirming…").count()).toBeGreaterThan(0);
    expect(await page.getByRole("button", { name: "Claim on Ostia" }).count()).toBe(0);
    world.stage = "ready";
    await page.getByRole("button", { name: "Claim on Ostia" }).waitFor({ timeout: 40_000 });
    expect(await noSideways(page)).toBe(true);
    await page.getByRole("button", { name: "Claim on Ostia" }).click();
    await until("the claim on Ostia", () => world.sent.length === 2);
    expect(world.sent[1]!.chainId).toBe(OSTIA_ID);
    expect(world.sent[1]!.tx).toMatchObject({ from: ME, to: OSTIA_BRIDGE });
    world.receipts.set(world.sent[1]!.hash, { status: "0x1", logs: [] });
    await page.getByRole("listitem", { name: "Arrived. 0.002 WETH is in your wallet." }).waitFor({ timeout: 40_000 });
    expect(world.sent).toHaveLength(2);
    expect(world.signs).toEqual([]);
    await page.close();
  }, 180_000);

  it("carries on after a reload with the claim waiting, and signs nothing on its own", async () => {
    const page = await open("/bridge");
    await toOtherChains(page);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("textbox", { name: "Amount to move" }).fill("0.002");
    await page.getByRole("button", { name: "Send to Ostia" }).click();
    await until("the deposit on Sepolia", () => world.sent.length === 1);
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "ready";
    await page.getByRole("button", { name: "Claim on Ostia" }).waitFor({ timeout: 40_000 });
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: "Claim on Ostia" }).waitFor({ timeout: 40_000 });
    expect(await page.getByRole("listitem", { name: "Sent on Ethereum Sepolia: done" }).count()).toBe(1);
    await page.waitForTimeout(1_000);
    expect(world.sent).toHaveLength(1);
    expect(world.signs).toEqual([]);
    await page.close();
  }, 180_000);

  it("sends ETH from Ostia to Sepolia: send on Ostia, the three marks, the wait, claim on Sepolia by the person", async () => {
    const page = await open("/bridge?tab=other-chains");
    await page.getByRole("region", { name: "Route" }).waitFor();
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("button", { name: "Swap direction" }).click();
    await page.getByRole("textbox", { name: "Amount to move" }).fill("0.002");
    await page.getByRole("button", { name: "Send to Ethereum Sepolia" }).click();
    await until("the send on Ostia", () => world.sent.length === 1);
    expect(world.switches).toEqual([OSTIA_ID]);
    expect(world.sent[0]!.tx).toMatchObject({ from: ME, to: OSTIA_BRIDGE, value: "0x0" });
    const row = page.getByRole("listitem", { name: "Sending 0.002 ETH to Ethereum Sepolia" });
    await row.waitFor();
    expect(await row.getByRole("list", { name: "How far the move has got" }).count()).toBe(1);   // Sent, Proven, Final
    expect(await noSideways(page)).toBe(true);
    mined(0, OSTIA_BRIDGE, 0);
    world.stage = "confirmed";
    await row.getByRole("listitem", { name: "Confirmed on Ethereum Sepolia: done" }).waitFor({ timeout: 40_000 });
    world.stage = "ready";
    await row.getByRole("button", { name: "Claim on Ethereum Sepolia" }).waitFor({ timeout: 40_000 });
    expect(await row.getByText("Your wallet switches to Ethereum Sepolia. Its fee is paid in Sepolia ETH.").count()).toBe(1);
    await row.getByRole("button", { name: "Claim on Ethereum Sepolia" }).click();
    await until("the claim on Sepolia", () => world.sent.length === 2);
    expect(world.sent[1]!.chainId).toBe(SEPOLIA_ID);
    expect(world.sent[1]!.tx.to).toBe(SEPOLIA_BRIDGE);
    world.stage = "claimed";
    await page.getByRole("listitem", { name: "Arrived. 0.002 ETH is in your wallet on Ethereum Sepolia." }).waitFor({ timeout: 40_000 });
    expect(world.signs).toEqual([]);
    await page.close();
  }, 180_000);
});
