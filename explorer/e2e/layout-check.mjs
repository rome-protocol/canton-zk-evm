// A check in a real browser of the two things the unit tests cannot see: that every small i's note sits inside the screen and can be closed,
// and that the header's nine links and the search share one row. Run it against a built explorer (the server, or `vite preview` with /api passed on):
//   BASE=http://127.0.0.1:8088 node e2e/layout-check.mjs      (needs `playwright-core` and a Chromium)
// BLOCK, TX and TOKEN name a block number, a transaction hash and a token address the chain holds; without them those pages are left out.
import { chromium } from "playwright-core";
const base = process.env.BASE ?? "http://127.0.0.1:8088";
const pages = ["/", "/stats", "/blocks", "/txs", "/tokens", "/canton", "/about"];
if (process.env.BLOCK) pages.push(`/block/${process.env.BLOCK}`);
if (process.env.TX) pages.push(`/tx/${process.env.TX}`);
if (process.env.TOKEN) pages.push(`/token/${process.env.TOKEN}`);
const b = await chromium.launch();
let bad = 0, total = 0;
const say = (...a) => console.log(...a);
for (const [w, h, touch] of [[390, 844, true], [1280, 800, false], [1440, 900, false]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
  for (const path of pages) {
    const p = await ctx.newPage();
    await p.goto(base + path, { waitUntil: "load" });
    await p.waitForTimeout(5000);
    const n = await p.locator(".info-b").count();
    for (let i = 0; i < n; i++) {
      const btn = p.locator(".info-b").nth(i);
      await btn.scrollIntoViewIfNeeded();
      if (touch) await btn.tap(); else await btn.hover();
      total++;
      const r = await p.evaluate((i) => { const t = document.querySelectorAll(".info-t")[i], b = t.getBoundingClientRect(), s = getComputedStyle(t).display; return { l: Math.round(b.left), r: Math.round(b.right), w: document.documentElement.clientWidth, s, label: document.querySelectorAll(".info-b")[i].getAttribute("aria-label") }; }, i);
      if (r.s === "none" || r.l < 0 || r.r > r.w) { bad++; say("BAD open", w, path, JSON.stringify(r)); }
      // a second tap or click, and Escape, close it though the button has focus
      if (i < 3 || touch === false && i % 5 === 0) {
        if (touch) { await btn.tap(); } else { await btn.click(); await btn.click(); }
        const closed = await p.evaluate((i) => getComputedStyle(document.querySelectorAll(".info-t")[i]).display === "none", i);
        if (!closed) { bad++; say("BAD not closed by second tap/click", w, path, i); }
        await p.keyboard.press("Tab"); await p.keyboard.press("Shift+Tab");
        const shown = await p.evaluate((i) => getComputedStyle(document.querySelectorAll(".info-t")[i]).display !== "none", i);
        await p.keyboard.press("Escape");
        const closed2 = await p.evaluate((i) => getComputedStyle(document.querySelectorAll(".info-t")[i]).display === "none", i);
        if (shown && !closed2) { bad++; say("BAD not closed by Escape", w, path, i); }
      }
      await p.mouse.move(0, 0); if (touch) await p.touchscreen.tap(2, 2);
    }
    say(w, path, "infos", n);
    await p.close();
  }
  await ctx.close();
}
say("checked", total, "bad", bad);
// header: one row
for (const w of [1280, 1366, 1440]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const p = await ctx.newPage();
  for (const path of ["/blocks", "/"]) {
    await p.goto(base + path, { waitUntil: "load" }); await p.waitForTimeout(2500);
    const rows = await p.$$eval(".top .nav .navlink", (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
    const hh = await p.$eval(".top", (e) => Math.round(e.getBoundingClientRect().height));
    say("nav", w, path, "rows", rows, "header h", hh);
    if (rows !== 1) bad++;
  }
  await ctx.close();
}
await b.close();
process.exit(bad ? 1 : 0);
