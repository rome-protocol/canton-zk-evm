import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The notice of planned work, in a real browser: the page's own stylesheet (styles.css) around the markup of NoticeBanner (components/Notice.tsx) and the top bar below it, in both states, with the longest text
 * a notice may have and a range over two days, at the width of a phone (360 and 390 px) and of a desktop, in the light and the dark theme. The banner must stay inside the width (the page never scrolls sideways), keep its
 * text readable (every text colour at least 4.5:1 against what is behind it, the dark theme's translucent tint laid over the page colour), and in progress look different from planned.
 * Runs when PLAYWRIGHT_CORE names a playwright-core (the `bridge-page` job of .github/workflows/explorer.yml sets it), and with a Chromium it can drive.
 */
const core = process.env.PLAYWRIGHT_CORE;
const src = join(import.meta.dirname, "..", "src"), pub = join(import.meta.dirname, "..", "public");
const LONG = "Upgrading the DevNet validator database and the explorer's index at the same time. ".repeat(3).trim() + " Transactions, the bridge and the faucet resume afterwards, with nothing to do on your side.";
const warn = '<svg class="ic" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.6v3.2M8 11.6v.1"/></svg>';
const notice = (state: "planned" | "now", label: string, text: string, when: string) =>
  `<div class="notice ${state}" role="status" id="${state}">${warn}<p><b>${label}</b> ${text} <span class="notice-when">${when}</span></p></div>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>${readFileSync(join(src, "styles.css"), "utf8")}</style></head>
<body><div class="page">${notice("planned", "Planned maintenance:", LONG, "Nov 14, 10:00 PM – Nov 15, 01:30 AM GMT+1")}
<section class="topbar" aria-label="Chain at a glance"><span class="sd ok"><i></i><b>All 16 checks ok</b></span><span>Final block <b>12</b></span></section>
${notice("now", "Maintenance in progress:", "Upgrading the DevNet validator database.", "until 10:45 AM GMT+1")}
<div class="main">x</div></div></body></html>`;

describe.skipIf(!core)("the notice of planned work, in a browser", () => {
  let browser: any, server: Server, base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const font = /^\/fonts\/([A-Za-z0-9-]+\.woff2)(\?.*)?$/.exec(req.url ?? "");   // a font the stylesheet names, nothing else from the disk
      if (font) {
        try { res.writeHead(200, { "content-type": "font/woff2" }).end(readFileSync(join(pub, "fonts", font[1]!))); } catch { res.writeHead(404).end(); }
      } else res.writeHead(200, { "content-type": "text/html" }).end(html);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const { chromium } = createRequire(import.meta.url)(core!);
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((done) => server?.close(done)); });

  const open = async (width: number, colorScheme: "light" | "dark") => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    await page.goto(base, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    return page;
  };

  // The contrast of each text colour in the banner against what is behind it: the banner's background laid over the page's (the dark theme's tint is translucent), WCAG 2's formula.
  const contrasts = (page: any, id: string) => page.evaluate((id: string) => {
    const rgba = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0]!, g: m[1]!, b: m[2]!, a: m[3] ?? 1 }; };
    const over = (top: ReturnType<typeof rgba>, under: ReturnType<typeof rgba>) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
    const el = document.getElementById(id)!;
    const page = rgba(getComputedStyle(document.querySelector(".page")!).backgroundColor);
    const back = over(rgba(getComputedStyle(el).backgroundColor), page);
    const out: Record<string, number> = {};
    for (const [name, node] of [["text", el.querySelector("p")!], ["label", el.querySelector("b")!], ["when", el.querySelector(".notice-when")!]] as const) out[name] = ratio(over(rgba(getComputedStyle(node).color), back), back);
    out.icon = ratio(over(rgba(getComputedStyle(el.querySelector(".ic")!).color), back), back);
    return out;
  }, id);

  it.each([360, 390, 1280])("stays inside the width, wraps its text and does not scroll the page sideways, at %i px", async (width) => {
    for (const scheme of ["light", "dark"] as const) {
      const page = await open(width, scheme);
      const r = await page.evaluate(() => {
        const rects = ["planned", "now"].map((id) => { const e = document.getElementById(id)!; const b = e.getBoundingClientRect(), p = e.querySelector("p")!.getBoundingClientRect(); return { left: b.left, right: b.right, height: b.height, pRight: p.right, pLeft: p.left }; });
        return { rects, scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth, width: document.documentElement.clientWidth, topFirst: document.querySelector(".page")!.firstElementChild!.id };
      });
      await page.close();
      expect(r.scrolls, `${scheme} ${width}`).toBe(false);
      expect(r.topFirst).toBe("planned");
      for (const b of r.rects) {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(r.width + 0.5);
        expect(b.pLeft).toBeGreaterThanOrEqual(0);
        expect(b.pRight).toBeLessThanOrEqual(r.width - (width <= 720 ? 16 : 32) + 0.5);
      }
      // the long text takes several lines on a phone, and the short one stays one line wide
      if (width < 500) expect(r.rects[0]!.height).toBeGreaterThan(r.rects[1]!.height * 2);
    }
  });

  it.each([360, 1280])("keeps every text colour at 4.5:1 or more against its background, and the icon at 3:1, in both themes, at %i px", async (width) => {
    for (const scheme of ["light", "dark"] as const) {
      const page = await open(width, scheme);
      for (const id of ["planned", "now"]) {
        const c = await contrasts(page, id);
        for (const k of ["text", "label", "when"]) expect(c[k], `${scheme} ${id} ${k}`).toBeGreaterThanOrEqual(4.5);
        expect(c.icon, `${scheme} ${id} icon`).toBeGreaterThanOrEqual(3);
      }
      await page.close();
    }
  });

  it("marks work in progress with the heavier edge and leaves planned work without it", async () => {
    const page = await open(360, "light");
    const r = await page.evaluate(() => ({ now: getComputedStyle(document.getElementById("now")!).boxShadow, planned: getComputedStyle(document.getElementById("planned")!).boxShadow }));
    await page.close();
    expect(r.planned).toBe("none");
    expect(r.now).not.toBe("none");
  });
});
