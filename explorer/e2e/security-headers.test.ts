import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../server/http.ts";
import type { Api } from "../server/api.ts";

/**
 * The security headers in a real browser: the built pages (BRIDGE_E2E_DIST) served by the explorer's own HTTP server, so the policy and the headers are the ones it sends. Every page route
 * opens and draws under them with no refusal by the policy, the search form (the page's only form besides the faucet's) still takes the person to the result, and a page of another site that
 * frames the explorer gets no explorer in its frame. The faucet's GitHub sign-in, which is a link, is held by faucet-builder.test.ts on the same server. Runs when BRIDGE_E2E_DIST is set (the
 * `bridge-page` job of .github/workflows/explorer.yml does), with PLAYWRIGHT_CORE naming the playwright-core of explorer/test/l4.
 */
const dist = process.env.BRIDGE_E2E_DIST;
const STATUS = {
  chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1,
};
const PAGES = ["/", "/blocks", "/bridge", "/faucet", "/swaps", "/addresses", "/contracts", "/tokens", "/twins", "/legs", "/txs", "/canton", "/stats", "/about", "/docs/api", "/nothing-here"];

describe.skipIf(!dist)("the security headers, in a browser", () => {
  let explorer: Server, outside: Server, browser: any, base = "", outsideBase = "";
  beforeAll(async () => {
    const api: Api = async (_method, target) => (new URL(target, "http://x").pathname === "/api/status" ? { status: 200, body: STATUS } : { status: 404, body: { error: "Not found." } });
    explorer = createHttpServer(api, dist!);
    await new Promise<void>((done) => explorer.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(explorer.address() as { port: number }).port}`;
    // Another origin (another port): a page that puts the explorer in a frame.
    outside = createServer((req, res) => {
      const path = new URL(req.url!, "http://x").pathname;
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>outside</title><iframe id="f" src="${base}${path}" width="600" height="400"></iframe>`);
    });
    await new Promise<void>((done) => outside.listen(0, "127.0.0.1", done));
    outsideBase = `http://127.0.0.1:${(outside.address() as { port: number }).port}`;
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((done) => explorer?.close(done)); await new Promise((done) => outside?.close(done)); });

  const policyRefusal = (m: any) => /content security policy|refused to (frame|display|send form data)/i.test(m.text());

  it("opens and draws every page route under them, with the headers on the answer and no refusal by the policy", async () => {
    for (const path of PAGES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const refused: string[] = [];
      page.on("console", (m: any) => { if (policyRefusal(m)) refused.push(m.text()); });
      const res = await page.goto(base + path, { waitUntil: "load" });
      const h = res.headers();
      expect(h["content-security-policy"], path).toMatch(/frame-ancestors 'none'; form-action 'self'$/);
      expect(h["x-frame-options"], path).toBe("DENY");
      expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
      expect(h["strict-transport-security"], path).toBe("max-age=31536000");
      await page.waitForSelector("#root *", { timeout: 15_000 });
      await page.waitForTimeout(700);   // the page polls, so it is never idle: a moment for its first requests and any refusal
      expect(refused, path).toEqual([]);
      await page.close();
    }
  }, 120_000);

  it("takes a search to the search page: the form is the page's own, and its submit is not stopped", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const refused: string[] = [];
    page.on("console", (m: any) => { if (policyRefusal(m)) refused.push(m.text()); });
    await page.goto(base + "/", { waitUntil: "load" });
    await page.fill(".hero-search input", "12");
    await page.press(".hero-search input", "Enter");
    await page.waitForURL(/\/search\?q=12/);
    expect(refused).toEqual([]);
    await page.close();
  });

  it("gives a page of another site that frames it no explorer: the frame is refused", async () => {
    for (const path of ["/", "/bridge", "/faucet"]) {
      const page = await browser.newPage();
      const refused: string[] = [];
      page.on("console", (m: any) => { if (policyRefusal(m)) refused.push(m.text()); });
      await page.goto(outsideBase + path, { waitUntil: "load" });
      await page.waitForTimeout(1500);
      const frame = page.frames().find((f: any) => f !== page.mainFrame());
      expect(frame, path).toBeTruthy();
      expect(frame.url().startsWith(base), `${path}: ${frame.url()}`).toBe(false);   // the browser's own error page (chrome-error://), not the explorer
      expect(await frame.locator("#root").count()).toBe(0);
      expect(refused.some((t) => /frame/i.test(t)), path).toBe(true);
      await page.close();
    }
  });
});
