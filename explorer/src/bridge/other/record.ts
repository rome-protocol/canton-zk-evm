// The record this browser keeps of a transfer to or from another chain, so that a reload carries on where the transfer was and signs nothing twice. It holds no key and nothing private, only the
// account, the amount and the two transactions. It is written before the wallet is asked for a step (with the nonce the send would take) and again when the wallet gives the hash.
import type { Hex } from "viem";
import { MAX_AGE_MS, moveStore, type StoreLike } from "../moves/state.ts";

export { moveStore as transferStore };

/** `in` is Ethereum Sepolia to Ostia (send there, claim on Ostia); `out` is Ostia to Ethereum Sepolia. */
export type Dir = "in" | "out";

/** One step the wallet is asked for: the exact call, the chain, the nonce it would take (null when the wallet did not say), and the transaction once the wallet has given its hash. */
export interface Attempt { chainId: number; to: string; data: Hex; value: string; nonce: number | null; tx: Hex | null }

export interface Transfer {
  /** Random; at most 64 characters. */
  id: string;
  /** The wallet account (lower case), the time it was started (ms), and the route's id. */
  account: string; at: number; route: string; dir: Dir;
  symbol: string; decimals: number;
  /** True for the other chain's own ether: it is sent as the call's value, and it is WETH on Ostia. */
  native: boolean;
  /** The amount in base units, as a decimal string. */
  amount: string;
  /** The send, once the wallet has been asked for it. */
  send: Attempt | null;
  /** The deposit number the bridge gave the send, once its transaction is in a block. */
  count: number | null;
  /** The claim, once the wallet has been asked for it. */
  claim: Attempt | null;
  /** The send did not go through (its transaction failed), or its deposit could not be read from it. */
  lost?: "failed" | "unreadable";
  /** The claim's transaction failed: the claim may be made again. */
  claimFailed?: boolean;
  /** When the transfer arrived (ms). */
  done?: number;
}

const KEY = "agglayer-transfer:", INDEX = "agglayer-transfers";
/** At most this many finished transfers are kept. */
export const KEEP_FINISHED = 50;

const hex = (v: unknown, bytes?: number): v is Hex => typeof v === "string" && (bytes === undefined ? /^0x[0-9a-fA-F]*$/ : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)).test(v);
function attempt(v: unknown): v is Attempt {
  const a = v as Attempt | null;
  return typeof a === "object" && a !== null && Number.isSafeInteger(a.chainId) && typeof a.to === "string" && hex(a.data) && typeof a.value === "string" && /^\d{1,80}$/.test(a.value) && (a.nonce === null || Number.isSafeInteger(a.nonce)) && (a.tx === null || hex(a.tx, 32));
}
const valid = (t: unknown): t is Transfer => {
  const r = t as Transfer | null;
  return typeof r === "object" && r !== null && typeof r.id === "string" && r.id.length > 0 && r.id.length <= 64 && typeof r.account === "string" && Number.isFinite(r.at) && typeof r.route === "string" && (r.dir === "in" || r.dir === "out")
    && typeof r.symbol === "string" && Number.isSafeInteger(r.decimals) && typeof r.native === "boolean" && typeof r.amount === "string" && /^\d{1,80}$/.test(r.amount)
    && (r.send === null || attempt(r.send)) && (r.count === null || Number.isSafeInteger(r.count)) && (r.claim === null || attempt(r.claim));
};

function ids(store: StoreLike | null): string[] {
  try { const l = JSON.parse(store?.getItem(INDEX) ?? "[]") as unknown; return Array.isArray(l) ? l.filter((r): r is string => typeof r === "string") : []; } catch { return []; }
}
export function saveTransfer(store: StoreLike | null, t: Transfer): void {
  try {
    store?.setItem(KEY + t.id, JSON.stringify(t));
    if (!ids(store).includes(t.id)) store?.setItem(INDEX, JSON.stringify([...ids(store), t.id]));
  } catch { /* the transfer still runs; it just cannot be picked up after a reload */ }
}
/** Whether this browser keeps a record: one is written, read back and removed. False where the store is missing, blocked or full. */
export function storeWorks(store: StoreLike | null): boolean {
  if (!store) return false;
  try {
    const key = "agglayer-probe", value = String(Math.random());
    store.setItem(key, value);
    const ok = store.getItem(key) === value;
    store.removeItem(key);
    return ok;
  } catch { return false; }
}
export function removeTransfer(store: StoreLike | null, id: string): void {
  try { store?.removeItem(KEY + id); store?.setItem(INDEX, JSON.stringify(ids(store).filter((r) => r !== id))); } catch { /* nothing to remove */ }
}
export function loadTransfer(store: StoreLike | null, id: string): Transfer | null {
  try { const t = JSON.parse(store?.getItem(KEY + id) ?? "null") as unknown; return valid(t) ? t : null; } catch { return null; }
}

/**
 * The transfers of `account` kept in this browser, newest first. A transfer that is over (it arrived, or its send did not go through) or that never got a deposit number is dropped after 30 days,
 * and so are the oldest finished ones past the 50 kept. A deposit that is not yet claimed is kept until it arrives or the person gives it up: the page has no other way to its claim.
 */
export function keptTransfers(store: StoreLike | null, account: string, now: number = Date.now()): Transfer[] {
  const all = ids(store).reverse().map((id) => loadTransfer(store, id)).filter((t): t is Transfer => t !== null);
  const stale = (t: Transfer) => now - t.at > MAX_AGE_MS && (t.done !== undefined || t.lost !== undefined || t.count === null);
  for (const t of all) if (stale(t)) removeTransfer(store, t.id);
  const fresh = all.filter((t) => !stale(t));
  const extra = new Set(fresh.filter((t) => t.done !== undefined).slice(KEEP_FINISHED));
  for (const t of extra) removeTransfer(store, t.id);
  const mine = account.toLowerCase();
  return fresh.filter((t) => t.account === mine && !extra.has(t));
}
