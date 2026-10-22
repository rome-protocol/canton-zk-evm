/**
 * L4 of the explorer's load test (design section 9, B5): the pages in a real browser, cold, on a slow link.
 *
 * Home, Block, Transaction, Address and Contract are each opened L4_REPEAT times (5), every time in a fresh browser context (nothing cached), with Chrome's
 * network throttled through the DevTools protocol to 10 Mbit/s each way and a 100 ms round trip. Each run records the first and the largest contentful paint, the
 * gzipped size of every script the page loaded, and the API calls made before the first paint. judge.ts holds the budgets; this file only measures.
 *
 * Runs inside the pinned browser image (EXPLORER_BROWSER_IMAGE in PINS) after `npm ci` of this directory, so playwright-core and the browsers are one exact version.
 *
 *   node driver.mjs        reads EXPLORER (the explorer's URL), L4_TX (the hash of a transaction in the chain), L4_CONTRACT (the address of a contract), L4_OUT (the results file),
 *                          L4_REPEAT (default 5). The block and the account are the transaction's own. Exits 1 when a budget is broken.
 *
 * What the pages are today: the explorer has no Contract page yet (E11a), so Contract opens the Address page of the contract, and says so in its results; the Address
 * page is a small stub. Both are reported and not held, so the numbers will move when the pages land. They are not a pass.
 */
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { judge, summarize } from "./judge.ts";

const BASE = (process.env.EXPLORER ?? "").replace(/\/$/, "");
const TX = process.env.L4_TX ?? "";
const CONTRACT = process.env.L4_CONTRACT ?? "";
const OUT = process.env.L4_OUT ?? "l4.json";
const REPEAT = Number(process.env.L4_REPEAT ?? 5);
// 10 Mbit/s in bytes a second, and a 100 ms round trip
const LINK = { offline: false, downloadThroughput: (10 * 1000 * 1000) / 8, uploadThroughput: (10 * 1000 * 1000) / 8, latency: 100 };
const SETTLE_MS = 1500;
const GIVE_UP_MS = 45_000;
const UA = "Rome Protocol rome@romeprotocol.com";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
if (!BASE || !/^0x[0-9a-fA-F]{64}$/.test(TX) || !/^0x[0-9a-fA-F]{40}$/.test(CONTRACT) || !(REPEAT >= 1)) fail("EXPLORER, L4_TX, L4_CONTRACT and L4_REPEAT must be set");

// The pages' paths come from the chain: the transaction's block and sender.
const res = await fetch(`${BASE}/api/tx/${TX}`, { headers: { "user-agent": UA } });
if (!res.ok) fail(`/api/tx/${TX} answered ${res.status}`);
const tx = await res.json();
if (!tx.block || typeof tx.block.number !== "number" || !tx.from) fail("the transaction is not in a block the explorer has");
const PAGES = [
  { name: "home", path: "/" },
  { name: "block", path: `/block/${tx.block.number}` },
  { name: "transaction", path: `/tx/${TX}` },
  { name: "address", path: `/address/${tx.from}`, note: "the Address page is a stub today; reported, not held" },
  { name: "contract", path: `/address/${CONTRACT}`, note: "there is no Contract page yet (E11a not landed): this is the Address page of a contract; reported, not held" },
];

// In the page, before anything of its own: what the browser's performance timeline says, in one timebase (milliseconds since the navigation began).
const OBSERVE = `
  performance.setResourceTimingBufferSize(2000);
  window.__l4 = { fcp: null, lcp: null };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__l4.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__l4.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
`;

const isApi = (url) => {
  const p = new URL(url).pathname;
  // the live stream is one request that stays open for good; it is not a call the first paint waits for
  return p.startsWith("/api/") && p !== "/api/stream";
};

async function once(browser, path) {
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript(OBSERVE);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", LINK);
    const scripts = [];
    const pending = [];
    page.on("response", (r) => {
      if (r.request().resourceType() !== "script") return;
      pending.push(
        r.body().then((b) => scripts.push({ gzip: gzipSync(b).length, wire: Number(r.headers()["content-length"] ?? 0) || gzipSync(b).length })).catch(() => {}),
      );
    });
    await page.goto(BASE + path, { waitUntil: "load", timeout: GIVE_UP_MS });
    // a paint can come after the load event; wait for one, then let the largest settle
    await page.waitForFunction(() => window.__l4.lcp !== null, null, { timeout: GIVE_UP_MS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    await Promise.all(pending);
    const t = await page.evaluate(() => ({
      fcp: window.__l4.fcp,
      lcp: window.__l4.lcp,
      api: performance.getEntriesByType("resource").filter((e) => e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest").map((e) => ({ url: e.name, at: e.startTime })),
    }));
    const api = t.api.filter((e) => isApi(e.url));
    return {
      lcpMs: t.lcp,
      fcpMs: t.fcp,
      scriptGzipBytes: scripts.reduce((s, x) => s + x.gzip, 0),
      scriptWireBytes: scripts.reduce((s, x) => s + x.wire, 0),
      apiBeforeFcp: t.fcp === null ? api.length : api.filter((e) => e.at < t.fcp).length,
      apiBeforeLcp: t.lcp === null ? api.length : api.filter((e) => e.at < t.lcp).length,
      apiTotal: api.length,
    };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const browserVersion = browser.version();
const pages = [];
try {
  for (const p of PAGES) {
    const runs = [];
    for (let i = 0; i < REPEAT; i++) runs.push(await once(browser, p.path));
    const r = summarize(p.name, p.path, runs, p.note);
    pages.push(r);
    console.log(`L4 ${p.name} ${p.path}: LCP ${r.median.lcpMs === null ? "none" : Math.round(r.median.lcpMs)} ms (worst ${r.worst.lcpMs === null ? "none" : Math.round(r.worst.lcpMs)}), ` +
      `script ${Math.round((r.median.scriptGzipBytes ?? 0) / 1024)} KB gzipped, ${r.median.apiBeforeFcp} API calls before the first paint${r.held ? "" : " (not held)"}`);
  }
} finally {
  await browser.close();
}
const failures = judge(pages);
const out = { link: LINK, repeat: REPEAT, browser: browserVersion, pages, failures, passed: failures.length === 0 };
writeFileSync(OUT, JSON.stringify(out, null, 2));
for (const f of failures) console.error(`L4 FAIL: ${f}`);
process.exit(failures.length ? 1 : 0);
