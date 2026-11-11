import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The look-alike warning, in a real browser, at the width of a phone and of a desktop: the page's own stylesheets (styles.css, token.css) around the markup of the token list's row
 * (Tokens.tsx), of an address cell (AddressCell.tsx) in the latest-transfers table, and of the contract page's Token tracker row (Contract.tsx). At 360 and 390 px the warning must stay inside its table cell
 * (it wraps under the name and never paints over the next column), and an address cell with no warning must stay on one line, as it was before the warning existed, at every width.
 * Runs when PLAYWRIGHT_CORE names a playwright-core (the `bridge-page` job of .github/workflows/explorer.yml sets it), and with a Chromium it can drive.
 */
const core = process.env.PLAYWRIGHT_CORE;
const src = join(import.meta.dirname, "..", "src"), pub = join(import.meta.dirname, "..", "public");
const WARNING = "Not Rome's WtROME twin";
const ic = (name: string) => `<svg class="ic" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">${name === "warn" ? '<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.6v3.2M8 11.6v.1"/>' : '<path d="M3 8.5l3 3 7-7"/>'}</svg>`;
const warn = `<span class="chip chip-warn" role="note">${ic("warn")}${WARNING}</span>`;
const tick = `<span class="verified" role="img" aria-label="Verified">${ic("check")}</span>`;
const hash = (a: string) => `<span class="hl"><a class="hx" href="#"><span class="mono">${a}</span></a></span>`;
const acell = (name: string, warned: boolean) => `<span class="acell${warned ? " acell-warn" : ""}"><a class="hx" href="#"><span class="aname"><bdi>${name}</bdi></span></a>${tick}${warned ? warn : ""}</span>`;

const tokenRow = (warned: boolean, n: number) => `<tr><td class="muted">${n}</td><td><div class="tok-cell"><span class="tok-av" style="background:#3b6">W</span><div class="tok-id"><div class="tok-name"><a href="#">Wrapped tROME</a><span class="muted tok-sym">WtROME</span>${tick}${warned ? warn : ""}</div>${hash("0xdbcdf63c…ef25147bb5")}</div></div></td><td><span class="chip chip-kind">ERC-20</span></td><td class="r">1,000</td><td class="r"><span class="num">2</span></td><td class="r"><span class="num">3</span></td><td><a class="num" href="#">Block 123</a></td><td>${hash("0x3403…0562")}</td></tr>`;
const tokens = `<section class="card panel" aria-label="Tokens"><div class="scroll"><table class="tbl" id="tokens"><thead><tr><th>#</th><th>Token</th><th>Standard</th><th class="r">Total supply</th><th class="r">Holders</th><th class="r">Transfers</th><th>Created</th><th>Creator</th></tr></thead><tbody>${tokenRow(true, 1)}${tokenRow(false, 2)}</tbody></table></div></section>`;
const transferRow = (warned: boolean) => `<tr><td>${hash("0xabc123…9f")}</td><td><span class="tag">transfer</span></td><td>Block 12</td><td>3m</td><td>${hash("0x1111…2222")}</td><td></td><td>${hash("0x3333…4444")}</td><td class="r">100</td><td>${acell("Wrapped tROME (WtROME)", warned)}</td><td>Final</td></tr>`;
const transfers = `<section class="card panel" aria-label="Latest token transfers"><div class="scroll"><table class="tbl" id="transfers"><thead><tr><th>Transaction</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th></th><th>To</th><th class="r">Amount</th><th>Token</th><th>Stage</th></tr></thead><tbody>${transferRow(false)}${transferRow(true)}</tbody></table></div></section>`;
const tracker = `<section class="card" aria-label="Overview"><dl class="kv" id="tracker"><dt class="kv-k">Token tracker</dt><dd class="kv-v">${acell("Wrapped tROME (WtROME)", false)}<span class="muted small"> · 3 holders</span> ${warn}</dd></dl></section>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${readFileSync(join(src, "styles.css"), "utf8")}</style><style>${readFileSync(join(src, "pages", "token.css"), "utf8")}</style></head>
<body><div class="page"><div class="main">${tokens}${transfers}${tracker}</div></div></body></html>`;

describe.skipIf(!core)("the look-alike warning, in a browser", () => {
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

  const open = async (width: number) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(base, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    return page;
  };

  it.each([360, 390, 1280])("keeps the warning of the token list inside its cell, and off the next column, at %i px", async (width) => {
    const page = await open(width);
    const r = await page.evaluate(() => {
      const chip = document.querySelector("#tokens .chip-warn")!.getBoundingClientRect();
      const td = document.querySelector("#tokens .chip-warn")!.closest("td")!, next = td.nextElementSibling!.getBoundingClientRect(), cell = td.getBoundingClientRect();
      const link = document.querySelector("#tokens .tok-name a")!.getBoundingClientRect();
      return { chipLeft: chip.left, chipRight: chip.right, chipTop: chip.top, cellLeft: cell.left, cellRight: cell.right, nextLeft: next.left, linkBottom: link.bottom, linkTop: link.top };
    });
    await page.close();
    expect(r.chipLeft).toBeGreaterThanOrEqual(r.cellLeft - 0.5);
    expect(r.chipRight).toBeLessThanOrEqual(r.cellRight + 0.5);
    expect(r.chipRight).toBeLessThanOrEqual(r.nextLeft + 0.5);
    if (width < 500) expect(r.chipTop).toBeGreaterThanOrEqual(r.linkBottom - 1);   // on a phone it drops under the name
  });

  it.each([360, 390, 1280])("keeps the warning of an address cell inside its cell at %i px", async (width) => {
    const page = await open(width);
    const r = await page.evaluate(() => {
      const chip = document.querySelectorAll("#transfers .chip-warn")[0]!.getBoundingClientRect();
      const td = document.querySelector("#transfers .chip-warn")!.closest("td")!, cell = td.getBoundingClientRect(), next = td.nextElementSibling!.getBoundingClientRect();
      return { chipLeft: chip.left, chipRight: chip.right, cellLeft: cell.left, cellRight: cell.right, nextLeft: next.left };
    });
    await page.close();
    expect(r.chipLeft).toBeGreaterThanOrEqual(r.cellLeft - 0.5);
    expect(r.chipRight).toBeLessThanOrEqual(r.cellRight + 0.5);
    expect(r.chipRight).toBeLessThanOrEqual(r.nextLeft + 0.5);
  });

  it.each([360, 390, 1280])("leaves an address cell with no warning on one line, the tick beside the name, at %i px", async (width) => {
    const page = await open(width);
    const r = await page.evaluate(() => {
      const cell = document.querySelector("#transfers tbody tr:first-child .acell")!;
      const link = cell.querySelector("a")!.getBoundingClientRect(), t = cell.querySelector(".verified")!.getBoundingClientRect();
      return { linkMid: (link.top + link.bottom) / 2, tickMid: (t.top + t.bottom) / 2, tickLeft: t.left, linkRight: link.right, height: cell.getBoundingClientRect().height };
    });
    await page.close();
    expect(Math.abs(r.linkMid - r.tickMid)).toBeLessThan(3);
    expect(r.tickLeft).toBeGreaterThanOrEqual(r.linkRight - 0.5);
    expect(r.height).toBeLessThan(30);
  });

  it.each([360, 390])("keeps the count of holders on the line of the name, and the warning inside the card, at %i px", async (width) => {
    const page = await open(width);
    const r = await page.evaluate(() => {
      const v = document.querySelector("#tracker .kv-v")!.getBoundingClientRect(), name = document.querySelector("#tracker a")!.getBoundingClientRect();
      const holders = document.querySelector("#tracker .small")!.getBoundingClientRect(), chip = document.querySelector("#tracker .chip-warn")!.getBoundingClientRect();
      return { right: v.right, chipRight: chip.right, nameTop: name.top, holdersTop: holders.top, pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    await page.close();
    expect(Math.abs(r.holdersTop - r.nameTop)).toBeLessThan(6);   // no dot of the count alone on a line of its own
    expect(r.chipRight).toBeLessThanOrEqual(r.right + 0.5);
  });
});
