import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../server/csp.ts";
import { OSTIA_ID, setupBody } from "../src/bridge/other/fakes.ts";

/**
 * The Bridge as its own site, in a real browser: the built pages of the default build (BRIDGE_E2E_DIST, no VITE_BRIDGE_ORIGIN, so the app is the file /bridge.html), a fake explorer API, and a wallet
 * that is never asked anything. The app has its own header and none of the explorer's frame, shows both tabs and keeps the tab in the address, and has no sideways scroll at the width of a phone; the
 * explorer's own /bridge is the page as it was. Runs only when BRIDGE_E2E_DIST is set (the `bridge-page` job of .github/workflows/explorer.yml, with the build of bridge-off.test.ts).
 */
const dist = process.env.BRIDGE_E2E_DIST;
const PORT = 4173, ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: OSTIA_ID, chainName: "Ostia", networkName: "TestNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};

describe.skipIf(!dist)("the Bridge as its own site, in a browser", () => {
  let server: Server, browser: any;
  const refused: string[] = [];
  beforeEach(() => { refused.length = 0; });
  afterEach(() => { expect(refused).toEqual([]); });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url!, ORIGIN).pathname;
      const json = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
      if (path === "/api/status") return json(200, STATUS);
      if (path === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
      if (path === "/api/twins") return json(200, { through: 1, registryService: null, vaults: [], twins: [], legs: [], canton: [] });
      if (path === "/api/agglayer/setup") return json(200, setupBody());
      if (path.startsWith("/api/") || path.startsWith("/accounts/") || path === "/rpc") return json(404, { error: "Not found." });
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

  async function open(path: string, width = 390) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on("console", (m: any) => { if (/content security policy/i.test(m.text())) refused.push(m.text()); });
    await page.addInitScript(() => { (window as any).ethereum = { request: async () => { throw new Error("the wallet was asked"); }, on() {}, removeListener() {} }; });
    await page.goto(ORIGIN + path, { waitUntil: "load" });
    return page;
  }
  const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  it("has its own header and none of the explorer's frame, with one h1", async () => {
    const page = await open("/bridge.html");
    await page.getByRole("heading", { level: 1, name: "Ostia Bridge" }).waitFor();
    await page.getByRole("banner").getByText("TestNet").waitFor();
    const explorer = page.getByRole("banner").getByRole("link", { name: "Explorer" });
    expect(await explorer.getAttribute("target")).toBe("_blank");
    expect(await explorer.getAttribute("href")).toMatch(/^https?:\/\/[^/]+\/$/);
    expect((await explorer.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    expect(await page.getByRole("navigation", { name: "Pages" }).count()).toBe(0);
    expect(await page.getByRole("searchbox").count()).toBe(0);
    expect(await page.title()).toMatch(/^Ostia Bridge · \S+$/);
    await page.close();
  });

  it("shows both tabs, keeps the tab in the address, and does not scroll sideways at 320, 390 and 1280 px", async () => {
    for (const width of [320, 390, 1280]) {
      const page = await open("/bridge.html", width);
      await page.getByRole("tab", { name: "Canton" }).waitFor();
      await page.getByRole("tab", { name: "AggLayer Bridge" }).click();
      await page.getByRole("region", { name: "Route" }).waitFor();
      expect(new URL(page.url()).searchParams.get("tab")).toBe("other-chains");
      expect(await noSideways(page), `${width}`).toBe(true);
      await page.getByRole("tab", { name: "Canton" }).click();
      expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
      await page.close();
    }
  });

  it("opens on the tab its address names", async () => {
    const page = await open("/bridge.html?tab=other-chains");
    await page.getByRole("region", { name: "Route" }).waitFor();
    expect(await page.getByRole("tab", { name: "AggLayer Bridge" }).getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  it("leaves the explorer's own /bridge as the page was, with the explorer's header and a Bridge link that stays in the explorer", async () => {
    const page = await open("/bridge", 1280);
    await page.getByRole("heading", { level: 1, name: "Bridge" }).waitFor();
    const link = page.locator('nav[aria-label="Pages"] a[href="/bridge"]');
    await link.waitFor({ state: "attached" });
    expect(await link.getAttribute("target")).toBeNull();
    expect(await page.getByRole("searchbox").count()).toBe(1);
    expect(page.url()).toBe(`${ORIGIN}/bridge`);
    await page.close();
  });
});
