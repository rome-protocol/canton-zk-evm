// node --test load/mixed/scripts/refill.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { amountOut, minOutFor, QuoteBook, Ledger, RefillBudget, emptyRefillStats, refillCycle } from "./refill.mjs";

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
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1].sort(), ["a", "b"]);
  assert.equal(stats.toppedUp, 2);
  assert.equal(l.get("a").tUSD, U(200) + U(3000));
  assert.equal(l.get("b").trome, E(2) + E(30));
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
