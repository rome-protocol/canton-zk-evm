// What keeps the load wallets funded during a run, and what sets a swap's minimum output. Plain code with no imports (and no I/O of its own),
// so a unit test runs it without a chain: the driver passes in how to read balances and how to send a top-up.
//
// The driver keeps an estimate of every wallet's balance (what the wallet was seeded with, less what it sent and the gas it paid). The estimate
// only ever leans low, because what a wallet receives is not counted. When a wallet's estimate drops under the low mark, the driver reads its real
// balances (a few RPC calls, within the shared budget), corrects the estimate, and tops the wallet up only if the real balance is low too.

/** Uniswap V2's getAmountOut: the output of a swap of amountIn against reserves (rIn, rOut), with the 0.3% fee. */
export function amountOut(amountIn, rIn, rOut) {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const inFee = amountIn * 997n;
  return (inFee * rOut) / (rIn * 1000n + inFee);
}

/** A swap's minimum output: the quote less a tolerance in percent (a number such as 3 or 0.5; hundredths of a percent are kept). */
export function minOutFor(quote, tolerancePercent) {
  const bps = BigInt(Math.round(Number(tolerancePercent) * 100));
  if (bps < 0n || bps > 10_000n) throw new Error("the slippage tolerance must be between 0 and 100 percent");
  return (quote * (10_000n - bps)) / 10_000n;
}

/** Pool reserves read from the chain, with the time they were read; a quote is given only from reserves that are fresh. */
export class QuoteBook {
  constructor(maxAgeMs, now = Date.now) { this.maxAgeMs = maxAgeMs; this.now = now; this.pools = new Map(); this.stats = { quoted: 0, stale: 0 }; }
  static key(a, b) { return [a.toLowerCase(), b.toLowerCase()].sort().join(":"); }
  /** reserves of the two tokens of a pool: { [tokenAddress]: reserve } */
  set(tokenA, reserveA, tokenB, reserveB, at = this.now()) {
    this.pools.set(QuoteBook.key(tokenA, tokenB), { at, r: { [tokenA.toLowerCase()]: reserveA, [tokenB.toLowerCase()]: reserveB } });
  }
  isFresh(tokenA, tokenB) { const p = this.pools.get(QuoteBook.key(tokenA, tokenB)); return !!p && this.now() - p.at <= this.maxAgeMs; }
  /** The quoted output of amountIn of tokenIn for tokenOut, or null when there is no fresh reading of that pool. */
  quote(tokenIn, tokenOut, amountIn) {
    const p = this.pools.get(QuoteBook.key(tokenIn, tokenOut));
    if (!p || this.now() - p.at > this.maxAgeMs) { this.stats.stale++; return null; }
    this.stats.quoted++;
    return amountOut(amountIn, p.r[tokenIn.toLowerCase()], p.r[tokenOut.toLowerCase()]);
  }
  /** The minimum output for a swap: from a fresh quote with the tolerance, or 0 when there is no fresh quote (the swap then cannot fail on price). */
  minOut(tokenIn, tokenOut, amountIn, tolerancePercent) {
    const q = this.quote(tokenIn, tokenOut, amountIn);
    return q == null ? 0n : minOutFor(q, tolerancePercent);
  }
}

/** The kit's estimate of each wallet's balance of what it spends: { trome, tUSD, tETH } (smallest units). */
export class Ledger {
  constructor(initial, now = Date.now) { this.initial = initial; this.b = new Map(); this.unread = new Set(); this.readAt = new Map(); this.now = now; }
  /** Wallets whose real balance has not been read yet (the start of a run: what they hold is not known until read). */
  markUnread(addrs) { for (const a of addrs) this.unread.add(a); }
  unreadIn(addrs) { return addrs.filter((a) => this.unread.has(a)); }
  get(addr) { if (!this.b.has(addr)) this.b.set(addr, { ...this.initial }); return this.b.get(addr); }
  /** A transaction left the wallet: spend is { trome?, tUSD?, tETH? }. */
  spend(addr, spend) { const x = this.get(addr); for (const [k, v] of Object.entries(spend ?? {})) if (k in x) x[k] -= v; }
  /** The real balances were read: they replace the estimate. */
  set(addr, real) { this.unread.delete(addr); this.readAt.set(addr, this.now()); this.b.set(addr, { ...this.get(addr), ...real }); }
  credit(addr, add) { const x = this.get(addr); for (const [k, v] of Object.entries(add)) if (k in x) x[k] += v; }
  /** Which of the tracked kinds are under their low mark. */
  lowKinds(addr, low) { const x = this.get(addr); return Object.keys(low).filter((k) => x[k] < low[k]); }
  /**
   * Wallets not read yet come first, then those whose estimate is under a low mark (the lowest first, by how far under, relative to the mark), then those
   * not read for `rereadMs` (so the books of what a wallet holds beyond the estimate, such as wrapped tROME, are corrected from time to time).
   */
  suspects(addrs, low, limit = Infinity, rereadMs = Infinity) {
    const first = this.unreadIn(addrs);
    const gap = (a) => { const x = this.get(a); return Math.min(...Object.keys(low).map((k) => Number(x[k]) / Number(low[k] || 1n))); };
    const lows = addrs.filter((a) => !this.unread.has(a) && this.lowKinds(a, low).length).sort((a, b) => gap(a) - gap(b));
    const t = this.now();
    const stale = addrs.filter((a) => !this.unread.has(a) && !lows.includes(a) && t - (this.readAt.get(a) ?? 0) > rereadMs).sort((a, b) => (this.readAt.get(a) ?? 0) - (this.readAt.get(b) ?? 0));
    return [...first, ...lows, ...stale].slice(0, limit);
  }
}

/** How many wallets may be topped up: at most `perMinute` in any minute and `perRun` in the whole run. */
export class RefillBudget {
  constructor({ perMinute, perRun }, now = Date.now) { this.perMinute = perMinute; this.perRun = perRun; this.now = now; this.stamps = []; this.total = 0; }
  take(n) {
    const t = this.now();
    while (this.stamps.length && t - this.stamps[0] > 60_000) this.stamps.shift();
    const k = Math.max(0, Math.min(n, this.perMinute - this.stamps.length, this.perRun - this.total));
    for (let i = 0; i < k; i++) this.stamps.push(t);
    this.total += k;
    return k;
  }
  /** a top-up that was not sent hands its places back */
  give(n) { for (let i = 0; i < n && this.stamps.length; i++) this.stamps.pop(); this.total = Math.max(0, this.total - n); }
}

export const emptyRefillStats = () => ({ checks: 0, read: 0, low: 0, toppedUp: 0, txs: 0, minted: 0, funded: 0, failed: 0, heldBack: 0, distributorShort: 0, budgetWaits: 0 });

export const refillLine = (s) => `refills: ${s.toppedUp} wallets topped up in ${s.txs} txs` + (s.failed ? `, ${s.failed} top-ups failed` : "") + (s.heldBack ? `, ${s.heldBack} held back by the bound` : "")
  + (s.distributorShort ? `, DISTRIBUTOR SHORT of tROME ${s.distributorShort} times (wallets wait)` : "") + (s.budgetWaits ? `, refill waited for RPC budget ${s.budgetWaits} times` : "");

/**
 * Whether the refill check runs now. It runs when the RPC budget has room for it next to the sends (`left >= need`); and when no check has run for twice its
 * period it runs anyway ("forced") and waits for the budget in the RPC queue, so near the RPC limit the refill is slowed but never starved.
 */
export function refillGate({ left, need, sinceLastCheckMs, checkMs }) {
  if (left >= need) return "run";
  return sinceLastCheckMs >= 2 * checkMs ? "forced" : "wait";
}

const KINDS = ["trome", "tUSD", "tETH"];
/**
 * What the refill key needs from the distributor before it can send one top-up call. The refill key is its own sender (the distributor may be busy with other
 * load), funded in bundles: when it is short of a kind it is brought up to `fundTopUps` full top-ups of that kind (tokens are minted straight to it by the
 * distributor, which owns them; tROME is sent), and never beyond what the distributor can spare (it keeps `minTrome`).
 * each: per-wallet amounts of this call ({trome,tUSD,tETH}, 0n for a kind not sent); full: the group's full top-up; n: wallets; mine: the refill key's balances.
 * @returns {{ fund: {trome?: bigint, tUSD?: bigint, tETH?: bigint}, short: boolean }}  short: the distributor cannot cover the tROME the call needs
 */
export function planTopUp({ each, full, n, mine, distributorTrome, fundTopUps, minTrome, gasMargin }) {
  const fund = {}; let short = false;
  for (const k of KINDS) {
    const need = (each[k] ?? 0n) * n + (k === "trome" ? gasMargin : 0n);
    if (mine[k] >= need) continue;
    const target = (full[k] ?? 0n) * BigInt(fundTopUps) + (k === "trome" ? gasMargin : 0n);
    let amount = (target > need ? target : need) - mine[k];
    if (k === "trome") {
      const spare = distributorTrome - minTrome;
      if (spare < need - mine[k]) { short = true; continue; }
      if (amount > spare) amount = spare;
    }
    fund[k] = amount;
  }
  return { fund, short };
}

// ---- wrapped tROME (WtROME): the kit's own books of it, which must lean low (a wallet never spends what the books say it does not have)
const wt = (hundredths) => BigInt(hundredths) * 10n ** 16n;
/** What each mix kind that touches WtROME needs, and what it books. A swap into WtROME books only what its quote guarantees (the minimum output), and a removal books nothing. */
export const wtFlows = {
  wrap: { allowed: (b) => b <= wt(800), delta: () => wt(50) },
  unwrap: { allowed: (b) => b >= wt(20), delta: () => -wt(20) },
  swapUsdToTrome: { allowed: () => true, delta: (minOut) => minOut },
  swapTromeToUsd: { allowed: (b) => b >= wt(30), delta: () => -wt(20) },
  addLiquidity: { allowed: (b) => b >= wt(60), delta: () => -wt(50) },
  removeLiquidity: { allowed: () => true, delta: () => 0n },
};
export const wtAllowed = (kind, books) => wtFlows[kind].allowed(books);
export const wtDelta = (kind, minOut = 0n) => wtFlows[kind].delta(minOut);

/** The books of each wallet's WtROME. A booking is made when an action is planned and settled when its transaction is final (kept) or failed or refused (taken back). */
export class WrappedBooks {
  constructor() { this.b = new Map(); this.spending = new Map(); }
  get(a) { return this.b.get(a) ?? 0n; }
  book(a, v) { this.b.set(a, this.get(a) + v); if (v < 0n) this.spending.set(a, (this.spending.get(a) ?? 0n) + v); }
  settle(a, v, ok) { if (v < 0n) this.spending.set(a, (this.spending.get(a) ?? 0n) - v); if (!ok) this.b.set(a, this.get(a) - v); }
  /** The real balance was read: the books become it, less what is still being spent (what is still coming in is not counted: it may already be in the real balance). */
  correct(a, real) { const b = real + (this.spending.get(a) ?? 0n); this.b.set(a, b < 0n ? 0n : b); }
}

/**
 * One pass of the refill loop. groups: [{ name, addrs, low, topUp, rereadMs? }] (low and topUp: { trome, tUSD?, tETH? } in smallest units; a kind a group does not carry is left out).
 * io: { readBalances(addrs) -> Map(addr -> real balances), topUp(group, addrs, kinds) -> Promise<boolean> }. A wallet is topped up only in the kinds it is low in:
 * wallets low in the same kinds go in one call. It never throws: a failing read or send is counted and logged, and the run goes on.
 */
export async function refillCycle({ ledger, groups, budget, io, readPerCheck, stats, log = () => {} }) {
  stats.checks++;
  for (const g of groups) {
    try {
      const cand = ledger.suspects(g.addrs, g.low, readPerCheck, g.rereadMs);
      if (!cand.length) continue;
      const real = await io.readBalances(cand);
      stats.read += cand.length;
      const needy = [];
      for (const a of cand) {
        const r = real.get(a);
        if (!r) continue;
        ledger.set(a, r);
        if (ledger.lowKinds(a, g.low).length) needy.push(a);
      }
      stats.low += needy.length;
      if (!needy.length) continue;
      const k = budget.take(needy.length);
      if (k < needy.length) { stats.heldBack += needy.length - k; log(`refill: ${needy.length - k} ${g.name} wallets wait (the per-minute or per-run bound)`); }
      const byKinds = new Map();
      for (const a of needy.slice(0, k)) { const kinds = ledger.lowKinds(a, g.low); const key = kinds.join(","); if (!byKinds.has(key)) byKinds.set(key, { kinds, addrs: [] }); byKinds.get(key).addrs.push(a); }
      for (const { kinds, addrs } of byKinds.values()) {
        try {
          const ok = await io.topUp(g, addrs, kinds);
          if (ok) { for (const a of addrs) ledger.credit(a, Object.fromEntries(kinds.map((x) => [x, g.topUp[x]]))); stats.toppedUp += addrs.length; stats.txs++; }
          else { budget.give(addrs.length); stats.failed++; }
        } catch (e) {
          budget.give(addrs.length); stats.failed++;
          log(`refill ${g.name}: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
    } catch (e) {
      stats.failed++;
      log(`refill ${g.name}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
}
