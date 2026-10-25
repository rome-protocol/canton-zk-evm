// node --test load/mixed/scripts/refill.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { amountOut, minOutFor, QuoteBook, Ledger, RefillBudget, emptyRefillStats, refillCycle, refillGate, refillLine, planTopUp, readAllOnce, spendKinds, tromeText, WrappedBooks, wtFlows, wtAllowed, wtDelta } from "./refill.mjs";

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // n units of an 18-decimal coin
const U = (n) => BigInt(n) * 1_000_000n;
const TUSD = "0xAa00000000000000000000000000000000000001", WT = "0xbb00000000000000000000000000000000000002";

test("amountOut is Uniswap V2's formula (0.3% fee)", () => {
  assert.equal(amountOut(1000n, 100_000n, 100_000n), 987n); // known value of the V2 formula
  assert.equal(amountOut(0n, 1n, 1n), 0n);
  assert.equal(amountOut(5n, 0n, 100n), 0n);
});

test("the minimum output is the quote less the tolerance", () => {
  assert.equal(minOutFor(10_000n, 3), 9_700n);
  assert.equal(minOutFor(10_000n, 0.5), 9_950n);
  assert.equal(minOutFor(10_000n, 0), 10_000n);
  assert.throws(() => minOutFor(10_000n, 101));
});

test("a swap's minimum comes from a fresh quote; with no fresh quote it is 0 so it cannot fail on price", () => {
  let t = 1_000;
  const q = new QuoteBook(20_000, () => t);
  assert.equal(q.minOut(TUSD, WT, U(20), 3), 0n); // nothing read yet
  q.set(TUSD, U(50_000), WT, E(5_000), t);
  const quote = amountOut(U(20), U(50_000), E(5_000));
  assert.equal(q.quote(TUSD, WT, U(20)), quote);
  assert.equal(q.minOut(TUSD, WT.toUpperCase().replace("0X", "0x"), U(20), 3), (quote * 9_700n) / 10_000n); // address case does not matter
  assert.ok(q.minOut(WT, TUSD, E(0.2), 3) > 0n); // the other direction uses the same pool
  t += 21_000;
  assert.equal(q.minOut(TUSD, WT, U(20), 3), 0n); // the reading is old
  assert.equal(q.isFresh(TUSD, WT), false);
});

test("the kit's own price move from a few swaps stays inside the tolerance (so they do not revert each other)", () => {
  // 20 swaps of 20 tUSD each land after one quote was taken: the last one still gets at least 97% of that quote
  let rIn = U(50_000), rOut = E(5_000);
  const quote = amountOut(U(20), rIn, rOut), min = minOutFor(quote, 3);
  for (let i = 0; i < 20; i++) { const out = amountOut(U(20), rIn, rOut); rIn += U(20); rOut -= out; }
  assert.ok(amountOut(U(20), rIn, rOut) >= min);
});

const mkLedger = () => new Ledger({ trome: E(30), tUSD: U(3000), tETH: E(4) });
const LOW = { trome: E(3), tUSD: U(300), tETH: E(0.4) };
const TOP = { trome: E(30), tUSD: U(3000), tETH: E(4) };

test("the ledger counts what a wallet spends and flags it before it is empty", () => {
  const l = mkLedger();
  assert.deepEqual(l.lowKinds("a", LOW), []);
  l.spend("a", { tUSD: U(2750), trome: E(0.5) });
  assert.deepEqual(l.lowKinds("a", LOW), ["tUSD"]);
  assert.deepEqual(l.suspects(["a", "b"], LOW), ["a"]);
  l.set("a", { tUSD: U(3000) });
  assert.deepEqual(l.lowKinds("a", LOW), []);
});

test("a wallet whose estimate is low but whose real balance is fine is only corrected, not topped up", async () => {
  const l = mkLedger(), stats = emptyRefillStats(), sent = [];
  l.spend("a", { tUSD: U(2800) }); // the estimate says 200 tUSD
  const io = { readBalances: async (as) => new Map(as.map((a) => [a, { trome: E(30), tUSD: U(2500), tETH: E(4) }])), topUp: async (g, as) => { sent.push(as); return true; } };
  await refillCycle({ ledger: l, groups: [{ name: "pool", addrs: ["a"], low: LOW, topUp: TOP }], budget: new RefillBudget({ perMinute: 10, perRun: 100 }), io, readPerCheck: 5, stats });
  assert.equal(sent.length, 0);
  assert.equal(stats.read, 1);
  assert.deepEqual(l.lowKinds("a", LOW), []);
});

test("a wallet whose real balance is low is topped up, and the ledger follows", async () => {
  const l = mkLedger(), stats = emptyRefillStats(), sent = [];
  l.spend("a", { tUSD: U(2800) }); l.spend("b", { trome: E(28) });
  const real = { a: { trome: E(30), tUSD: U(200), tETH: E(4) }, b: { trome: E(2), tUSD: U(3000), tETH: E(4) } };
  const io = { readBalances: async (as) => new Map(as.map((a) => [a, real[a]])), topUp: async (g, as) => { sent.push([g.name, as]); return true; } };
  await refillCycle({ ledger: l, groups: [{ name: "pool", addrs: ["a", "b", "c"], low: LOW, topUp: TOP }], budget: new RefillBudget({ perMinute: 10, perRun: 100 }), io, readPerCheck: 5, stats });
  assert.equal(sent.length, 2); // a is low in tUSD only, b in tROME only: two calls
  assert.equal(stats.toppedUp, 2);
  assert.equal(l.get("a").tUSD, U(200) + U(3000));
  assert.equal(l.get("a").trome, E(30)); // not topped up in what it was not low in
  assert.equal(l.get("b").trome, E(2) + E(30));
  assert.equal(l.get("b").tUSD, U(3000));
});

test("the top-up is bounded per minute and per run, and what is held back is counted", async () => {
  const stats = emptyRefillStats(), sent = [];
  const l = mkLedger(); const addrs = ["a", "b", "c", "d"];
  for (const a of addrs) l.spend(a, { tUSD: U(2900) });
  const io = { readBalances: async (as) => new Map(as.map((a) => [a, { trome: E(30), tUSD: U(100), tETH: E(4) }])), topUp: async (g, as) => { sent.push(as.length); return true; } };
  const budget = new RefillBudget({ perMinute: 2, perRun: 3 });
  await refillCycle({ ledger: l, groups: [{ name: "pool", addrs, low: LOW, topUp: TOP }], budget, io, readPerCheck: 10, stats });
  assert.deepEqual(sent, [2]);
  assert.equal(stats.heldBack, 2);
  assert.equal(budget.take(5), 0); // the minute is used up
});

test("a failed top-up does not stop the loop and gives its places back; a failing read is only counted", async () => {
  const stats = emptyRefillStats(), logs = [];
  const l = mkLedger(); l.spend("a", { tUSD: U(2900) });
  const budget = new RefillBudget({ perMinute: 5, perRun: 5 });
  let fail = true;
  const io = { readBalances: async (as) => { if (fail) throw new Error("rpc down"); return new Map(as.map((a) => [a, { trome: E(30), tUSD: U(100), tETH: E(4) }])); }, topUp: async () => false };
  const g = [{ name: "pool", addrs: ["a"], low: LOW, topUp: TOP }];
  await refillCycle({ ledger: l, groups: g, budget, io, readPerCheck: 5, stats, log: (m) => logs.push(m) });
  assert.equal(stats.failed, 1); assert.match(logs[0], /rpc down/);
  fail = false;
  await refillCycle({ ledger: l, groups: g, budget, io, readPerCheck: 5, stats });
  assert.equal(stats.failed, 2);
  assert.equal(budget.total, 0); // the places came back
  assert.equal(stats.toppedUp, 0);
});

test("holders carry only tROME for gas", async () => {
  const l = new Ledger({ trome: E(5) }), stats = emptyRefillStats(), sent = [];
  l.spend("h1", { trome: E(4.5), tUSD: U(5) }); // a token the group does not carry is ignored
  const io = { readBalances: async (as) => new Map(as.map((a) => [a, { trome: E(0.4) }])), topUp: async (g, as) => { sent.push(as); return true; } };
  await refillCycle({ ledger: l, groups: [{ name: "holders", addrs: ["h1", "h2"], low: { trome: E(1) }, topUp: { trome: E(5) } }], budget: new RefillBudget({ perMinute: 5, perRun: 50 }), io, readPerCheck: 5, stats });
  assert.deepEqual(sent, [["h1"]]);
  assert.equal(l.get("h1").trome, E(5.4));
});

test("at the start of a run every wallet is read once, before the estimate is trusted", async () => {
  const l = mkLedger(), stats = emptyRefillStats(), sent = [];
  l.markUnread(["a", "b", "c"]);
  assert.deepEqual(l.unreadIn(["a", "b", "c", "d"]), ["a", "b", "c"]);
  const real = { a: { trome: E(30), tUSD: U(3000), tETH: E(4) }, b: { trome: E(30), tUSD: U(10), tETH: E(4) }, c: { trome: E(30), tUSD: U(3000), tETH: E(4) } }; // b was drained by an earlier run
  const io = { readBalances: async (as) => new Map(as.map((a) => [a, real[a]])), topUp: async (g, as) => { sent.push(as); return true; } };
  const g = [{ name: "pool", addrs: ["a", "b", "c"], low: LOW, topUp: TOP }];
  const budget = new RefillBudget({ perMinute: 10, perRun: 100 });
  await refillCycle({ ledger: l, groups: g, budget, io, readPerCheck: 2, stats });
  assert.equal(l.unreadIn(["a", "b", "c"]).length, 1);
  await refillCycle({ ledger: l, groups: g, budget, io, readPerCheck: 2, stats });
  assert.equal(l.unreadIn(["a", "b", "c"]).length, 0);
  assert.deepEqual(sent, [["b"]]);
});

test("a wallet low only in tUSD gets no tROME and no tETH; wallets low in the same kinds share one call", async () => {
  const l = mkLedger(), stats = emptyRefillStats(), calls = [];
  for (const a of ["a", "b", "c"]) l.spend(a, { tUSD: U(2900) });
  l.spend("d", { tUSD: U(2900), trome: E(28) });
  const io = { readBalances: async (as) => new Map(as.map((a) => [a, { trome: a === "d" ? E(2) : E(30), tUSD: U(100), tETH: E(4) }])), topUp: async (g, as, kinds) => { calls.push([as, kinds]); return true; } };
  await refillCycle({ ledger: l, groups: [{ name: "pool", addrs: ["a", "b", "c", "d"], low: LOW, topUp: TOP }], budget: new RefillBudget({ perMinute: 10, perRun: 100 }), io, readPerCheck: 10, stats });
  assert.equal(calls.length, 2);
  const only = calls.find(([, k]) => k.length === 1);
  assert.deepEqual(only[1], ["tUSD"]); assert.deepEqual(only[0].sort(), ["a", "b", "c"]);
  assert.deepEqual(calls.find(([, k]) => k.length === 2)[1], ["trome", "tUSD"]);
  assert.equal(l.get("a").trome, E(30)); assert.equal(l.get("a").tETH, E(4)); assert.equal(l.get("a").tUSD, U(3100));
  assert.equal(l.get("d").trome, E(32));
  assert.equal(stats.toppedUp, 4); assert.equal(stats.txs, 2);
});

test("a top-up that throws gives its places back to the bound", async () => {
  const stats = emptyRefillStats(), logs = [];
  const l = mkLedger(); l.spend("a", { tUSD: U(2900) });
  const budget = new RefillBudget({ perMinute: 5, perRun: 5 });
  const io = { readBalances: async (as) => new Map(as.map((a) => [a, { trome: E(30), tUSD: U(100), tETH: E(4) }])), topUp: async () => { throw new Error("no receipt in 75 s"); } };
  for (let i = 0; i < 8; i++) await refillCycle({ ledger: l, groups: [{ name: "pool", addrs: ["a"], low: LOW, topUp: TOP }], budget, io, readPerCheck: 5, stats, log: (m) => logs.push(m) });
  assert.equal(stats.failed, 8); // every try went out: the bound (5) was not used up by failures
  assert.equal(budget.total, 0);
  assert.match(logs[0], /no receipt/);
});

test("wallets not read for a while are read again (so the wrapped books are corrected)", () => {
  let t = 0;
  const l = new Ledger({ trome: E(30), tUSD: U(3000), tETH: E(4) }, () => t);
  l.set("a", {}); t = 10 * 60_000; l.set("b", {});
  t = 40 * 60_000;
  assert.deepEqual(l.suspects(["a", "b"], LOW, 5, Infinity), []);
  assert.deepEqual(l.suspects(["a", "b"], LOW, 5, 35 * 60_000), ["a"]);
  assert.deepEqual(l.suspects(["a", "b"], LOW, 5, 20 * 60_000), ["a", "b"]); // the one read longest ago first
});

test("the refill check always gets a slot: it runs on budget, and is forced after twice its period", () => {
  const g = (left, since) => refillGate({ left, need: 100, sinceLastCheckMs: since, checkMs: 15_000 });
  assert.equal(g(150, 0), "run");
  assert.equal(g(20, 10_000), "wait");
  assert.equal(g(20, 29_999), "wait");
  assert.equal(g(20, 30_000), "forced"); // above about 3.3 tx/s `left` never reaches the mark: the check still runs, waiting in the RPC queue
  assert.equal(g(0, 120_000), "forced");
});

test("the per-minute line says plainly when the distributor is short and when the refill waited for the RPC budget", () => {
  const s = emptyRefillStats();
  assert.equal(refillLine(s), "refills: 0 wallets topped up in 0 txs");
  s.distributorShort = 2; s.budgetWaits = 3; s.failed = 1;
  const line = refillLine(s);
  assert.match(line, /DISTRIBUTOR SHORT of tROME 2 times/); assert.match(line, /waited for RPC budget 3 times/); assert.match(line, /1 top-ups failed/);
});

const PLAN = { full: TOP, fundTopUps: 20, minTrome: E(200), gasMargin: E(1) };
test("planTopUp: a call for tUSD only asks the distributor for tUSD (minted straight to the refill key), never tROME", () => {
  const r = planTopUp({ ...PLAN, each: { trome: 0n, tUSD: U(3000), tETH: 0n }, n: 5n, mine: { trome: E(5), tUSD: U(2000), tETH: 0n }, distributorTrome: E(2500) });
  assert.deepEqual(Object.keys(r.fund), ["tUSD"]);
  assert.equal(r.fund.tUSD, U(3000 * 20) - U(2000)); // brought up to a bundle of 20 top-ups
  assert.equal(r.short, false);
});

test("planTopUp: nothing is asked when the refill key already holds enough", () => {
  const r = planTopUp({ ...PLAN, each: TOP, n: 2n, mine: { trome: E(600), tUSD: U(60_000), tETH: E(80) }, distributorTrome: E(2500) });
  assert.deepEqual(r.fund, {}); assert.equal(r.short, false);
});

test("planTopUp: tROME is asked in a bundle but never beyond what the distributor can spare; short when it cannot cover the call", () => {
  const base = { ...PLAN, each: { trome: E(30), tUSD: 0n, tETH: 0n }, n: 10n, mine: { trome: E(2), tUSD: 0n, tETH: 0n } };
  const a = planTopUp({ ...base, distributorTrome: E(2468) });
  assert.equal(a.fund.trome, E(599)); // a bundle: 20 x 30 + 1 margin - 2 held; the distributor can spare 2,268
  const small = planTopUp({ ...base, distributorTrome: E(500) });
  assert.equal(small.short, false); assert.equal(small.fund.trome, E(300)); // only what it can spare (500 - 200 kept)
  const b = planTopUp({ ...base, distributorTrome: E(400) });
  assert.equal(b.short, true); assert.equal(b.fund.trome, undefined); // 200 spare < the 299 this call needs
  const c = planTopUp({ ...base, distributorTrome: E(1000) });
  assert.equal(c.short, false); assert.equal(c.fund.trome, E(599)); // the bundle: 20 x 30 + 1 margin - 2 held
});

// ---- wrapped tROME: the books lean low, so a kind never sends what the wallet does not hold
test("a booking settles: a final success keeps it, a failure takes it back, and a read of the real balance corrects the books", () => {
  const b = new WrappedBooks();
  b.book("w", E(0.5)); b.book("w", -E(0.2));
  assert.equal(b.get("w"), E(0.3));
  b.settle("w", E(0.5), true); b.settle("w", -E(0.2), false); // the second failed: its booking comes back
  assert.equal(b.get("w"), E(0.5));
  b.book("w", -E(0.2)); // in flight
  b.correct("w", E(3)); // real balance 3 read: less the 0.2 still being spent
  assert.equal(b.get("w"), E(2.8));
  b.book("w", E(0.5)); b.correct("w", E(3)); // an adding booking in flight is not counted (it may already be in the real balance)
  assert.equal(b.get("w"), E(2.8));
  b.correct("x", 0n); b.book("x", -E(1)); b.correct("x", E(0.4)); assert.equal(b.get("x"), 0n); // never below zero
});

test("a swap into WtROME books only what its quote guarantees; with no fresh quote, nothing", () => {
  assert.equal(wtDelta("swapUsdToTrome", E(0.17)), E(0.17));
  assert.equal(wtDelta("swapUsdToTrome"), 0n);
  assert.equal(wtDelta("removeLiquidity"), 0n);
  assert.equal(wtAllowed("unwrap", E(0.19)), false); assert.equal(wtAllowed("unwrap", E(0.2)), true);
  assert.equal(wtAllowed("wrap", E(8.1)), false); assert.equal(wtAllowed("wrap", E(0)), true);
});

test("hours of the weighted mix against a constant-product pool: no kind sends WtROME the wallet does not hold, and the wraps never stop", () => {
  // a seeded generator keeps the run the same every time
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const TUSD2 = "0xcc00000000000000000000000000000000000003";
  let rUsd = U(50_000), rWt = E(5_000); // opens at 10 tUSD per WtROME
  const quotes = new QuoteBook(30_000, () => step * 333); // one step is a third of a second (3 tx/s)
  let step = 0;
  const books = new WrappedBooks(), real = new Map(), W = 20;
  for (let i = 0; i < W; i++) real.set("w" + i, E(10));
  for (const [a, v] of real) books.correct(a, v);
  const kinds = ["wrap", "wrap", "unwrap", "swapUsdToTrome", "swapUsdToTrome", "swapUsdToTrome", "swapTromeToUsd", "addLiquidity", "removeLiquidity"];
  const counts = {}, stats = { wraps: 0, priceReverts: 0 };
  const send = { wrap: E(0.5) * 0n, unwrap: E(0.2), swapTromeToUsd: E(0.2), addLiquidity: E(0.5) }; // WtROME each kind sends
  const hours = 12, steps = hours * 3600 * 3;
  for (step = 0; step < steps; step++) {
    if (step % 30 === 0) quotes.set(TUSD2, rUsd, WT, rWt, step * 333); // the quote loop: a fresh reading every 10 s
    const kind = kinds[Math.floor(rnd() * kinds.length)], a = "w" + Math.floor(rnd() * W);
    if (!wtAllowed(kind, books.get(a))) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
    const minOut = kind === "swapUsdToTrome" ? quotes.minOut(TUSD2, WT, U(20), 5) : 0n;
    const delta = wtDelta(kind, minOut);
    assert.ok((real.get(a) ?? 0n) >= (send[kind] ?? 0n), `step ${step}: ${kind} would send ${send[kind]} but the wallet holds ${real.get(a)} (books ${books.get(a)})`);
    books.book(a, delta);
    let ok = true;
    if (kind === "wrap") { real.set(a, real.get(a) + E(0.5)); stats.wraps++; }
    else if (kind === "unwrap") real.set(a, real.get(a) - E(0.2));
    else if (kind === "swapUsdToTrome") {
      const out = amountOut(U(20), rUsd, rWt);
      if (out < minOut) { ok = false; stats.priceReverts++; } else { rUsd += U(20); rWt -= out; real.set(a, real.get(a) + out); }
    } else if (kind === "swapTromeToUsd") {
      const out = amountOut(E(0.2), rWt, rUsd);
      rWt += E(0.2); rUsd -= out; real.set(a, real.get(a) - E(0.2));
    } else if (kind === "addLiquidity") {
      const used = (U(5) * rWt) / rUsd; const wtUsed = used < E(0.5) ? used : E(0.5); // the pool takes what its ratio asks, at most 0.5
      rWt += wtUsed; rUsd += (wtUsed * rUsd) / rWt; real.set(a, real.get(a) - wtUsed);
    } // removeLiquidity returns a negligible amount (1e9 LP wei)
    books.settle(a, delta, ok);
    assert.ok(books.get(a) <= real.get(a), `step ${step}: the books (${books.get(a)}) are above the real balance (${real.get(a)}) for ${kind}`);
    if (step % 3000 === 0 && rnd() < 0.5) books.correct(a, real.get(a)); // a read of the real balance now and then
  }
  assert.ok(rUsd > U(50_000) * 2n, "the price moved far, as it does on the soak (the old fixed booking would have run dry here)");
  assert.ok(stats.wraps > steps / 20, "wraps did not stop: " + stats.wraps);
  assert.ok(stats.priceReverts < steps / 100, "price reverts from a fresh quote stay rare: " + stats.priceReverts);
});

// ---- a wallet sends only what it is known to hold
const mk3 = (real) => ({ readBalances: async (as) => new Map(as.map((a) => [a, real[a]]).filter(([, r]) => r)), topUp: async () => true });
const G = (addrs) => [{ name: "pool", addrs, low: LOW, topUp: TOP }];

test("a wallet that has not been read yet sends nothing", () => {
  const l = mkLedger(); l.markUnread(["a"]);
  assert.equal(l.canSpend("a", ["trome"]), false);
  l.set("a", { trome: E(30), tUSD: U(3000), tETH: E(4) });
  assert.equal(l.canSpend("a", ["trome", "tUSD"]), true);
});

test("a wallet read low and not topped up (held back, distributor short, or failed) sends nothing that spends the kind it is short in", async () => {
  const l = mkLedger(), stats = emptyRefillStats(); l.markUnread(["a", "b"]);
  const real = { a: { trome: E(30), tUSD: U(10), tETH: E(4) }, b: { trome: E(30), tUSD: U(3000), tETH: E(4) } };
  const budget = new RefillBudget({ perMinute: 0, perRun: 100 }); // nothing may be topped up: a is held back
  await refillCycle({ ledger: l, groups: G(["a", "b"]), budget, io: mk3(real), readPerCheck: 5, stats });
  assert.equal(stats.heldBack, 1);
  assert.equal(l.canSpend("a", spendKinds("swapUsdToEth")), false); // short of tUSD: no swap of tUSD
  assert.equal(l.canSpend("a", spendKinds("swapEthToUsd")), true); // but tETH and gas are fine
  assert.equal(l.canSpend("a", spendKinds("addLiquidity")), false);
  assert.equal(l.canSpend("a", spendKinds("erc721Mint")), true);
  assert.equal(l.canSpend("b", spendKinds("addLiquidity")), true);
});

test("a failed top-up leaves the wallet unfunded; a later top-up frees it", async () => {
  const l = mkLedger(), stats = emptyRefillStats(); l.markUnread(["a"]);
  const real = { a: { trome: E(0), tUSD: U(3000), tETH: E(4) } };
  let ok = false; const io = { readBalances: mk3(real).readBalances, topUp: async () => ok };
  const budget = new RefillBudget({ perMinute: 10, perRun: 100 });
  await refillCycle({ ledger: l, groups: G(["a"]), budget, io, readPerCheck: 5, stats });
  assert.equal(l.canSpend("a", ["trome"]), false);
  ok = true;
  await refillCycle({ ledger: l, groups: G(["a"]), budget, io, readPerCheck: 5, stats });
  assert.equal(l.canSpend("a", ["trome"]), true);
});

test("a distributor that is short leaves the low wallets unfunded, and they send nothing until it is not", async () => {
  const l = mkLedger(), stats = emptyRefillStats(); l.markUnread(["a"]);
  const real = { a: { trome: E(1), tUSD: U(3000), tETH: E(4) } };
  let short = true; const io = { readBalances: mk3(real).readBalances, topUp: async () => !short };
  const budget = new RefillBudget({ perMinute: 10, perRun: 100 });
  await refillCycle({ ledger: l, groups: G(["a"]), budget, io, readPerCheck: 5, stats });
  assert.equal(l.canSpend("a", ["trome"]), false);
  short = false; real.a = { trome: E(1), tUSD: U(3000), tETH: E(4) };
  await refillCycle({ ledger: l, groups: G(["a"]), budget, io, readPerCheck: 5, stats });
  assert.equal(l.canSpend("a", ["trome"]), true);
});

test("the run starts only after every wallet has been read once", async () => {
  const l = mkLedger(), stats = emptyRefillStats(), addrs = Array.from({ length: 25 }, (_, i) => `w${i}`);
  l.markUnread(addrs);
  const real = Object.fromEntries(addrs.map((a) => [a, { trome: E(30), tUSD: U(3000), tETH: E(4) }]));
  const budget = new RefillBudget({ perMinute: 10, perRun: 100 });
  const left = await readAllOnce({ ledger: l, groups: G(addrs), budget, io: mk3(real), readPerCheck: 6, stats });
  assert.deepEqual(left, []);
  assert.ok(addrs.every((a) => l.canSpend(a, ["trome", "tUSD", "tETH"])));
  assert.equal(stats.checks, 5); // 25 wallets, 6 a check
});

test("when some wallets can not be read the start reports them (and gives up after the bound) instead of sending from them", async () => {
  const l = mkLedger(), stats = emptyRefillStats(); l.markUnread(["a", "b"]);
  const real = { a: { trome: E(30), tUSD: U(3000), tETH: E(4) } }; // b never answers
  const left = await readAllOnce({ ledger: l, groups: G(["a", "b"]), budget: new RefillBudget({ perMinute: 10, perRun: 100 }), io: mk3(real), readPerCheck: 6, stats, maxChecks: 5 });
  assert.deepEqual(left, ["b"]);
  assert.equal(l.canSpend("b", ["trome"]), false);
});

test("spendKinds: gas always, plus the tokens a kind moves", () => {
  assert.deepEqual(spendKinds("erc721Mint"), ["trome"]);
  assert.deepEqual(spendKinds("swapUsdToTrome"), ["trome", "tUSD"]);
  assert.deepEqual(spendKinds("swapEthToUsd"), ["trome", "tETH"]);
  assert.deepEqual(spendKinds("addLiquidity"), ["trome", "tUSD", "tETH"]);
});

test("the per-minute line shows what the refill key took from the distributor", () => {
  const s = emptyRefillStats();
  assert.doesNotMatch(refillLine(s), /took/);
  s.funded = 2; s.tromeTaken = E(12) + E("0.5");
  assert.match(refillLine(s), /the refill key took 12\.50 tROME from the distributor in 2 sends/);
  assert.equal(tromeText(0n), "0.00"); assert.equal(tromeText(E(3)), "3.00");
});
