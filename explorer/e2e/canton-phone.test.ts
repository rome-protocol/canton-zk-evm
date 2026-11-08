import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Linked to Canton tab row at the width of a phone, in a real browser: the page's own stylesheets (styles.css, canton.css) around the markup of the row (the
 * same classes as Canton.tsx and Seg.tsx). The last tab must be reachable: the tab group stays inside the row, and scrolls sideways when its tabs need more than the row has,
 * so that no tab is cut where it cannot be scrolled to. The page itself must not scroll sideways. Runs when PLAYWRIGHT_CORE names a playwright-core (the `bridge-page`
 * job of .github/workflows/explorer.yml sets it), and with a Chromium it can drive.
 */
const core = process.env.PLAYWRIGHT_CORE;
const src = join(import.meta.dirname, "..", "src"), pub = join(import.meta.dirname, "..", "public");
const TABS = ["All", "First attempt", "Retried", "Refused", "With legs"];
const html = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${readFileSync(join(src, "styles.css"), "utf8")}</style><style>${readFileSync(join(src, "pages", "canton.css"), "utf8")}</style></head>
<body><div class="page"><div class="main">
  <div class="list-h canton-tools">
    <div class="seg" role="group" aria-label="Show blocks">${TABS.map((t, i) => `<button type="button" aria-pressed="${i === 0}">${t}</button>`).join("")}</div>
    <span class="grow"></span>
    <div class="seg" role="group" aria-label="Order"><button type="button" aria-pressed="true">Newest</button><button type="button" aria-pressed="false">Oldest</button></div>
    <a class="small" href="#">CSV</a>
  </div>
</div></div></body></html>`;

describe.skipIf(!core)("the Linked to Canton tab row, on a phone", () => {
  let browser: any, server: Server, base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const font = /^\/fonts\/([A-Za-z0-9-]+\.woff2)(\?.*)?$/.exec(req.url ?? "");   // a font the stylesheet names, nothing else from the disk
      if (font) {
        try { res.writeHead(200, { "content-type": "font/woff2" }).end(readFileSync(join(pub, "fonts", font[1]!))); } catch { res.writeHead(404).end(); }
      } else res.writeHead(200, { "content-type": "text/html" }).end(html());
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const { chromium } = createRequire(import.meta.url)(core!);
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((done) => server?.close(done)); });

  const measure = async (width: number) => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(base, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(() => {
      const row = document.querySelector(".canton-tools")!, seg = document.querySelector(".canton-tools .seg")!, last = seg.querySelector("button:last-child")!;
      const rowB = row.getBoundingClientRect(), segB = seg.getBoundingClientRect(), s = getComputedStyle(seg);
      const out = { overflowX: s.overflowX, minWidth: s.minWidth, rowRight: rowB.right, segRight: segB.right, scrollable: seg.scrollWidth > seg.clientWidth, pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth, lastRightAtRest: last.getBoundingClientRect().right, lastRightScrolled: 0, segRightScrolled: 0 };
      seg.scrollLeft = seg.scrollWidth;
      out.lastRightScrolled = last.getBoundingClientRect().right;
      out.segRightScrolled = seg.getBoundingClientRect().right;
      return out;
    });
    await page.close();
    return r;
  };

  it("keeps the tab group inside the row at 360 px, with every tab reachable by scrolling it, and the page not scrolling sideways", async () => {
    const r = await measure(360);
    expect(r.segRight).toBeLessThanOrEqual(r.rowRight + 0.5);
    expect(r.overflowX).toBe("auto");
    expect(r.minWidth).toBe("0px");
    expect(r.pageScrolls).toBe(false);
    // scrolled to its end, the last tab's right edge is inside the group (within its 1 px border): nothing is cut where it cannot be reached
    expect(r.lastRightScrolled).toBeLessThanOrEqual(r.segRightScrolled + 1);
  });

  it("does not scroll the tab group on a screen wide enough for it", async () => {
    const r = await measure(1280);
    expect(r.scrollable).toBe(false);
    expect(r.pageScrolls).toBe(false);
  });
});
