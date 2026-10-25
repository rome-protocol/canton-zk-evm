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
  constructor(initial) { this.initial = initial; this.b = new Map(); this.unread = new Set(); }
  /** Wallets whose real balance has not been read yet (the start of a run: what they hold is not known until read). */
  markUnread(addrs) { for (const a of addrs) this.unread.add(a); }
  unreadIn(addrs) { return addrs.filter((a) => this.unread.has(a)); }
  get(addr) { if (!this.b.has(addr)) this.b.set(addr, { ...this.initial }); return this.b.get(addr); }
  /** A transaction left the wallet: spend is { trome?, tUSD?, tETH? }. */
  spend(addr, spend) { const x = this.get(addr); for (const [k, v] of Object.entries(spend ?? {})) if (k in x) x[k] -= v; }
  /** The real balances were read: they replace the estimate. */
  set(addr, real) { this.unread.delete(addr); this.b.set(addr, { ...this.get(addr), ...real }); }
  credit(addr, add) { const x = this.get(addr); for (const [k, v] of Object.entries(add)) if (k in x) x[k] += v; }
  /** Which of the tracked kinds are under their low mark. */
  lowKinds(addr, low) { const x = this.get(addr); return Object.keys(low).filter((k) => x[k] < low[k]); }
  /** Wallets not read yet come first, then those whose estimate is under a low mark, the lowest first (by how far under, relative to the mark). */
  suspects(addrs, low, limit = Infinity) {
    const first = this.unreadIn(addrs);
    const gap = (a) => { const x = this.get(a); return Math.min(...Object.keys(low).map((k) => Number(x[k]) / Number(low[k] || 1n))); };
    const lows = addrs.filter((a) => !this.unread.has(a) && this.lowKinds(a, low).length).sort((a, b) => gap(a) - gap(b));
    return [...first, ...lows].slice(0, limit);
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

export const emptyRefillStats = () => ({ checks: 0, read: 0, low: 0, toppedUp: 0, txs: 0, minted: 0, failed: 0, heldBack: 0, distributorShort: 0 });

export const refillLine = (s) => `refills: ${s.toppedUp} wallets topped up in ${s.txs} txs` + (s.failed ? `, ${s.failed} top-ups failed` : "") + (s.heldBack ? `, ${s.heldBack} held back by the bound` : "");

/**
 * One pass of the refill loop. groups: [{ name, addrs, low, topUp }] (low and topUp: { trome, tUSD?, tETH? } in smallest units; a kind a group does not carry is left out).
 * io: { readBalances(addrs) -> Map(addr -> real balances), topUp(group, addrs) -> Promise<boolean> }. It never throws: a failing read or send is counted and logged,
 * and the run goes on.
 */
export async function refillCycle({ ledger, groups, budget, io, readPerCheck, stats, log = () => {} }) {
  stats.checks++;
  for (const g of groups) {
    try {
      const cand = ledger.suspects(g.addrs, g.low, readPerCheck);
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
      const chosen = needy.slice(0, k);
      if (!chosen.length) continue;
      const ok = await io.topUp(g, chosen);
      if (ok) { for (const a of chosen) ledger.credit(a, g.topUp); stats.toppedUp += chosen.length; stats.txs++; }
      else { budget.give(chosen.length); stats.failed++; }
    } catch (e) {
      stats.failed++;
      log(`refill ${g.name}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
}
