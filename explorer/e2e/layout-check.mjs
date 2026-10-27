// A check in a real browser of the things the unit tests cannot see: that every small i's note, opened, is whole on the screen (inside it on every
// side, and not cut by a card around it: the four corners of the note are what the page shows there), that it closes on a second tap and on Escape
// (also when only the pointer is on the i), that the header's nine links and the search share one row, and that the search box shows its whole hint. Run it against a built explorer (the server, or `vite preview` with /api passed on):
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
      const r = await p.evaluate((i) => {
        const t = document.querySelectorAll(".info-t")[i], b = t.getBoundingClientRect(), s = getComputedStyle(t).display;
        const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
        // what the page shows at the four corners of the note (3 px in from each) must be the note itself: nothing clips it, nothing lies over it
        const seen = [[b.left + 3, b.top + 3], [b.right - 3, b.top + 3], [b.left + 3, b.bottom - 3], [b.right - 3, b.bottom - 3]].map(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && !!e.closest(".info-t") && t.contains(e); });
        return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w, h, s, seen, label: document.querySelectorAll(".info-b")[i].getAttribute("aria-label") };
      }, i);
      if (r.s === "none" || r.l < 0 || r.r > r.w || r.t < 0 || r.b > r.h || r.seen.includes(false)) { bad++; say("BAD open", w, path, JSON.stringify(r)); }
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
      if (!touch && i % 4 === 0) {
        // opened by the pointer alone: the focus is elsewhere, and Escape still closes it
        await p.mouse.move(0, 0); await btn.hover();
        await p.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
        await p.keyboard.press("Escape");
        const gone = await p.evaluate((i) => getComputedStyle(document.querySelectorAll(".info-t")[i]).display === "none", i);
        if (!gone) { bad++; say("BAD not closed by Escape after hover", w, path, i); }
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
// the header search shows its whole hint, from a tablet to a wide screen
for (const w of [768, 800, 1024, 1280, 1366, 1440]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(base + "/blocks", { waitUntil: "load" }); await p.waitForTimeout(2500);
  const m = await p.$eval(".top .search input", (e) => {
    const c = document.createElement("canvas").getContext("2d"), cs = getComputedStyle(e);
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return { hint: Math.ceil(c.measureText(e.placeholder).width), room: e.clientWidth, rows: new Set([...document.querySelectorAll(".top .nav .navlink")].map((a) => Math.round(a.getBoundingClientRect().top))).size };
  });
  say("search hint", w, JSON.stringify(m));
  if (m.hint > m.room) { bad++; say("BAD search hint cut", w); }
  await ctx.close();
}
await b.close();
process.exit(bad ? 1 : 0);
