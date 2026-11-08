import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The header in a real browser: the built pages (BRIDGE_E2E_DIST) against a status answer and nothing else, so only the shell is drawn. At 1280, 1440 and 1920 px, on the home page and on a block page,
 * the links sit on one row or are folded into the menu button, never on two; the header's search box is a compact field that opens on focus without moving a link, and Escape or leaving it closes it again;
 * and at 360 px the menu works as before. Runs when BRIDGE_E2E_DIST is set (the `bridge-page` job of .github/workflows/explorer.yml does), with PLAYWRIGHT_CORE naming the playwright-core of explorer/test/l4.
 */
const dist = process.env.BRIDGE_E2E_DIST;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
const STATUS = {
  chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const PAGES = ["/", "/block/5"];

describe.skipIf(!dist)("the header's links, in a browser", () => {
  let server: Server, browser: any, base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url!, "http://127.0.0.1").pathname;
      if (path === "/api/status") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(STATUS)); return; }
      if (path.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found." })); return; }
      let file = join(resolve(dist!), path);
      if (!existsSync(file) || !statSync(file).isFile()) file = join(resolve(dist!), "index.html");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((done) => server?.close(done)); });

  async function open(path: string, width: number) {
    const page = await browser.newPage({ viewport: { width, height: 700 } });
    await page.goto(base + path, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector(".top .name");
    await page.waitForTimeout(150);   // the header measures itself once the fonts are in
    return page;
  }

  /** Where the header's parts are: the tops of the links (and whether the nav is drawn), the menu button, the box. */
  const read = (page: any) => page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".nav")!, menu = document.querySelector<HTMLElement>(".menu")!;
    const links = [...nav.querySelectorAll<HTMLElement>(".navlink")];
    const drawn = getComputedStyle(nav).visibility !== "hidden" && getComputedStyle(nav).display !== "none" && nav.getBoundingClientRect().width > 0;
    const box = document.querySelector<HTMLElement>(".top .search")?.getBoundingClientRect();
    return {
      drawn, tops: [...new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)))], lefts: links.map((a) => Math.round(a.getBoundingClientRect().left)),
      menuShown: getComputedStyle(menu).display !== "none", expanded: menu.getAttribute("aria-expanded"), boxWidth: box ? Math.round(box.width) : null,
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth, headerH: Math.round(document.querySelector(".top")!.getBoundingClientRect().height),
    };
  });

  for (const width of [1280, 1440, 1920]) for (const path of PAGES) {
    it(`keeps every link on one row at ${width} px on ${path}, or folds them into the menu button`, async () => {
      const page = await open(path, width);
      const r = await read(page);
      await page.close();
      if (r.drawn) expect(r.tops, "the links are drawn: one row").toHaveLength(1); else expect(r.menuShown, "the links are folded: the menu button shows").toBe(true);
      // the links fit in the row from 1366 px on, with the search box too (the page's column is 1280 px at most)
      if (width >= 1366) expect(r.drawn).toBe(true);
      expect(r.pageScrolls).toBe(false);
    });
  }

  for (const width of [1280, 1440, 1920]) {
    it(`opens the search box on focus at ${width} px without moving a link, and closes it on Escape and on blur`, async () => {
      const page = await open("/block/5", width);
      const before = await read(page);
      expect(before.boxWidth).toBeGreaterThanOrEqual(200);
      expect(before.boxWidth).toBeLessThanOrEqual(220);
      await page.focus(".top .search input");
      await page.waitForTimeout(400);   // the box opens over 150 ms
      const open_ = await read(page);
      expect(open_.boxWidth).toBe(380);
      expect(open_.lefts).toEqual(before.lefts);
      expect(open_.tops).toEqual(before.tops);
      expect(open_.headerH).toBe(before.headerH);
      expect(open_.drawn).toBe(before.drawn);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      expect((await read(page)).boxWidth).toBe(before.boxWidth);
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
      // the "/" key opens it again, and a click elsewhere closes it
      await page.keyboard.press("/");
      await page.waitForTimeout(400);
      expect((await read(page)).boxWidth).toBe(380);
      await page.mouse.click(5, 400);
      await page.waitForTimeout(400);
      expect((await read(page)).boxWidth).toBe(before.boxWidth);
      await page.close();
    });
  }

  it("folds the links into the menu button where the search box and the links do not both fit (1000 px), still in one row, and the menu shows them", async () => {
    const page = await open("/block/5", 1000);
    const r = await read(page);
    expect(r.drawn).toBe(false);
    expect(r.menuShown).toBe(true);
    const row = r.headerH;
    await page.click(".menu");
    const o = await read(page);
    expect(o.drawn).toBe(true);
    expect(o.expanded).toBe("true");
    expect(o.tops.length).toBe(10);   // a column in the open menu
    await page.keyboard.press("Tab");
    await page.click(".menu");
    expect((await read(page)).drawn).toBe(false);
    expect(row).toBe(r.headerH);
    await page.close();
  });

  it("lets the home page's links stay in the row down to a narrower screen than a page with the search box (no box in the header there)", async () => {
    const home = await open("/", 1000);
    const block = await open("/block/5", 1000);
    const [h, b] = [await read(home), await read(block)];
    await home.close(); await block.close();
    expect(h.drawn).toBe(true);
    expect(h.tops).toHaveLength(1);
    expect(b.drawn).toBe(false);
  });

  for (const path of PAGES) {
    it(`keeps the menu as before at 360 px on ${path}: closed, opened by the button with its aria state, closed by choosing a page`, async () => {
      const page = await open(path, 360);
      const r = await read(page);
      expect(r.menuShown).toBe(true);
      expect(r.drawn).toBe(false);
      expect(r.expanded).toBe("false");
      expect(r.pageScrolls).toBe(false);
      expect(await page.getAttribute(".menu", "aria-controls")).toBe("pages");
      await page.click(".menu");
      const o = await read(page);
      expect(o.drawn).toBe(true);
      expect(o.expanded).toBe("true");
      await page.click('.nav a[href="/stats"]');
      await page.waitForURL(/\/stats$/);
      await page.waitForFunction(() => document.querySelector(".menu")!.getAttribute("aria-expanded") === "false");
      const c = await read(page);
      expect(c.drawn).toBe(false);
      expect(c.expanded).toBe("false");
      await page.close();
    });
  }
});
