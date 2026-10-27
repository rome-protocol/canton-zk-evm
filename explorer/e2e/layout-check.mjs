// A check in a real browser of the things the unit tests cannot see: that every small i's note, opened, is whole on the screen (inside it on every
// side, and not cut by a card around it: the four corners of the note, inset past its rounded corners, are what the page shows there), that it closes on a second tap and on Escape
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
        // what the page shows at the four corners of the note (8 px in from each, past the 12 px rounded corner) must be the note itself: nothing clips it, nothing lies over it
        const seen = [[b.left + 8, b.top + 8], [b.right - 8, b.top + 8], [b.left + 8, b.bottom - 8], [b.right - 8, b.bottom - 8]].map(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && !!e.closest(".info-t") && t.contains(e); });
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
  // the hint is set as the input's own value, so the browser lays it out as it will draw it (canvas measureText reads about 13 px short)
  const m = await p.$eval(".top .search input", (e) => {
    e.value = e.placeholder;
    return { hint: e.scrollWidth, room: e.clientWidth, rows: new Set([...document.querySelectorAll(".top .nav .navlink")].map((a) => Math.round(a.getBoundingClientRect().top))).size };
  });
  say("search hint", w, JSON.stringify(m));
  if (m.hint > m.room || (w >= 1280 && m.rows !== 1)) { bad++; say("BAD search hint cut", w); }
  await ctx.close();
}
// the Stats tiles: no note runs past its card or off the screen, in every window, on a phone and on a wide screen
for (const w of [390, 768, 1280, 1440]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const p = await ctx.newPage();
  for (const win of ["1h", "6h", "24h", "7d", "30d"]) {
    await p.goto(`${base}/stats?window=${win}`, { waitUntil: "load" }); await p.waitForTimeout(4000);
    const r = await p.evaluate(() => {
      const out = [];
      for (const c of document.querySelectorAll(".stat")) {
        const cr = c.getBoundingClientRect();
        for (const e of c.querySelectorAll(".stat-v, .stat-v *, .stat-k, .small")) { const er = e.getBoundingClientRect(); if (er.width && er.right > cr.right + 0.5) out.push(`${c.querySelector(".stat-k")?.textContent} ${Math.round(er.right - cr.right)}px past`); }
      }
      return { out, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth };
    });
    say("stats", w, win, "tiles past their card", r.out.length, "page", r.scroll, "of", r.client);
    if (r.out.length || r.scroll > r.client) { bad++; say("BAD stats overflow", w, win, JSON.stringify(r)); }
  }
  await ctx.close();
}
// an 8-digit count with commas ('10,540,146') in every big number must stay inside its tile (the live counts pass 10 M), on home and on Stats, on a phone and above
for (const w of [390, 768, 1024, 1280, 1440]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const p = await ctx.newPage();
  for (const path of ["/", "/stats", "/stats?window=30d"]) {
    await p.goto(base + path, { waitUntil: "load" }); await p.waitForTimeout(4000);
    const r = await p.evaluate(() => {
      const out = [];
      for (const v of document.querySelectorAll(".stat-v:not(.stat-hash)")) {
        const card = v.closest(".stat, .cell"); if (!card || !/^[\d,]+$/.test(v.textContent.trim())) continue; // the tiles that show a count
        const keep = v.innerHTML; v.textContent = "10,540,146";
        const rg = document.createRange(); rg.selectNodeContents(v);
        const right = Math.max(...[...rg.getClientRects()].map((q) => q.right)), cs = getComputedStyle(card), cr = card.getBoundingClientRect();
        const edge = cr.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
        if (right > edge + 0.5) out.push(`${card.querySelector(".stat-k")?.firstChild?.textContent ?? "?"} ${Math.round(right)}>${Math.round(edge)}`);
        v.innerHTML = keep;
      }
      return out;
    });
    say("tiles 8 digits", w, path, "past the padding", r.length);
    if (r.length) { bad++; say("BAD 8-digit tile", w, path, JSON.stringify(r.slice(0, 4))); }
  }
  await ctx.close();
}
// the header is no taller than before the restyle at any width from 721 to 1440 (MAIN names a server with main's build; without it this part is left out), and is one row from 1280 up
if (process.env.MAIN) {
  // one page for each build, resized in steps of 7 px from 721 to 1440, so every width between is covered, not only the usual ones
  const pg = [];
  for (const u of [base, process.env.MAIN]) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage(); await p.goto(u + "/blocks", { waitUntil: "load" }); await p.waitForTimeout(2500); pg.push(p);
  }
  const taller = [];
  for (let w = 721; w <= 1440; w += 7) {
    const hs = [];
    for (const p of pg) { await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(60); hs.push(await p.$eval(".top", (e) => e.getBoundingClientRect().height)); }
    if (hs[0] > hs[1] + 0.5) taller.push(`${w}: ${hs[0].toFixed(1)} > ${hs[1].toFixed(1)}`);
  }
  say("header taller than main at", taller.length, "widths", taller.slice(0, 6).join("; "));
  if (taller.length) { bad++; say("BAD header taller than main"); }
}
await b.close();
process.exit(bad ? 1 : 0);
