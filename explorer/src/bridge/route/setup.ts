// What the Canton route's two routes say, checked field by field: the setup (what the book and the router allow now) and the moves of one wallet or one Canton account. Anything that is not exactly the
// documented answer reads as "off" (setup) or as no moves, so a server without the routes leaves the page as it was.
import type { Range } from "../other/setup.ts";

/** `feeIn` and `feeRefund` are what the way back to Canton takes (zero where the server's answer has none). */
export interface RouteAsset { erc20: string; symbol: string; name: string; decimals: number; feeOut: bigint; claimFee: bigint; minAmount: bigint; lockCap: bigint; lockRoom: bigint; feeIn: bigint; feeRefund: bigint }
/** What Canton can pay out now, by asset: `left` in the asset's base units (null: no quota) and when some of it comes back. */
export interface Payout { paused: boolean; pausedUntil: string | null; assets: Record<string, { left: bigint | null; renewsAt: string | null }> }
/** The way back to Canton (flow C), when the server has it on. */
export interface RouteIn {
  route: "closed" | "open" | "stopped";
  /** How long a held coin waits before it can go back. */
  refundWaitSeconds: number;
  router: string;
  /** The book, whose `checkIn` says whether the router takes a claim-and-pay now. */
  book: string;
  setupSeconds: number;
  setupTime: Range | null;
  /** The person's own claims: the wait at "Ready on Ostia" (and while held) before they are offered, and how long one may be in no block before the row says so; null while they are off. */
  claimOstia: { afterSeconds: number; leftOutSeconds: number } | null;
  /** Null while Canton cannot be read. */
  payout: Payout | null;
}
export interface RouteOn {
  on: true;
  /** `closed`: never opened ("Not yet open"). `stopped`: was open, is not now ("not available right now"). */
  route: "closed" | "open" | "stopped";
  /** False while the AggLayer bridge cannot be used right now. */
  available: boolean;
  /** Ethereum Sepolia's unit: a move sends a multiple of it. */
  unit: bigint;
  assets: RouteAsset[];
  time: Range | null;
  /** The waits, in seconds, after which a move shows "Not taken yet" and the person's own claim is offered. */
  notTakenSeconds: number;
  ownClaimSeconds: number;
  in: RouteIn | null;
}
export type RouteSetup = { on: false } | RouteOn;
export const ROUTE_OFF: RouteSetup = { on: false };

export interface Move {
  id: string;
  /** `taken`: Ostia took it (the router's event). `requested`: signed on Canton, not taken yet. */
  state: "taken" | "requested";
  party: string;
  destAddress: string;
  /** Null for a request: it names no token until Ostia takes it. */
  erc20: string | null;
  /** The whole amount taken from the Canton account; null when a request's amount is not known. */
  amount: bigint | null;
  send: bigint | null;
  fee: bigint | null;
  depositCount: number | null;
  txHash: string | null;
  /** Ostia's block that took it. */
  block: number | null;
  /** When it was requested (a request) or Ostia's block was made (a taken move). */
  at: string | null;
  /** A request's real end: after it the coin is free again in the Canton account. */
  settleBefore: string | null;
}
/** One event of the way back for an inbox (an account's Ostia address): its opening, a coin held in it, paid on to Canton, or sent back. */
export interface BackEvent {
  kind: "opened" | "held" | "forwarded" | "refunded";
  inbox: string; erc20: string | null;
  /** On `opened`: the Canton account and the way back. */
  party: string | null; refundNetwork: number | null; refundAddress: string | null;
  balance: bigint | null; refundAt: string | null; amount: bigint | null; fee: bigint | null; depositCount: number | null;
  txHash: string; block: number; at: string;
}
export interface Moves { moves: Move[]; requestsRead: boolean; back: BackEvent[]; /** Whether each account in the events takes withdrawals now; null when that is not known. */ accepts: Record<string, boolean> | null }

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 400;
const address = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const units = (v: unknown): bigint | null => (typeof v === "string" && /^\d{1,78}$/.test(v) ? BigInt(v) : null);
const time = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

function asset(v: unknown): RouteAsset | null {
  const a = obj(v);
  if (!a || !address(a.erc20) || !text(a.symbol) || !text(a.name) || !whole(a.decimals) || a.decimals > 36) return null;
  const [feeOut, claimFee, minAmount, lockCap, lockRoom] = [a.feeOut, a.claimFee, a.minAmount, a.lockCap, a.lockRoom].map(units);
  if (feeOut === null || claimFee === null || minAmount === null || lockCap === null || lockRoom === null) return null;
  const [feeIn, feeRefund] = [a.feeIn, a.feeRefund].map((v) => (v === undefined || v === null ? 0n : units(v)));
  if (feeIn === null || feeRefund === null) return null;
  return { erc20: a.erc20.toLowerCase(), symbol: a.symbol, name: a.name, decimals: a.decimals, feeOut: feeOut!, claimFee: claimFee!, minAmount: minAmount!, lockCap: lockCap!, lockRoom: lockRoom!, feeIn: feeIn!, feeRefund: feeRefund! };
}

function payout(v: unknown): Payout | null {
  const p = obj(v);
  if (!p || typeof p.paused !== "boolean" || !Array.isArray(p.assets)) return null;
  const assets: Payout["assets"] = {};
  for (const t of p.assets.map(obj)) {
    if (!t || !address(t.erc20)) return null;
    const left = t.left === null ? null : units(t.left);
    if (t.left !== null && left === null) return null;
    assets[t.erc20.toLowerCase()] = { left, renewsAt: time(t.renewsAt) };
  }
  return { paused: p.paused, pausedUntil: time(p.pausedUntil), assets };
}
/** The way back, or null when the server's answer has none or it does not read: the page then offers no way back. */
function routeIn(v: unknown): RouteIn | null {
  const b = obj(v);
  if (!b || (b.route !== "closed" && b.route !== "open" && b.route !== "stopped") || b.refundNetwork !== 0 || !whole(b.refundWaitSeconds) || !address(b.router) || !address(b.book) || !whole(b.setupSeconds)) return null;
  const t = obj(b.setupTime), c = obj(b.claimOstia);
  const claimOstia = c && whole(c.afterSeconds) && whole(c.leftOutSeconds) ? { afterSeconds: c.afterSeconds, leftOutSeconds: c.leftOutSeconds } : null;
  return {
    route: b.route, refundWaitSeconds: b.refundWaitSeconds, router: b.router.toLowerCase(), book: b.book.toLowerCase(), setupSeconds: b.setupSeconds,
    setupTime: t && whole(t.minSeconds) && whole(t.maxSeconds) && t.minSeconds <= t.maxSeconds ? { minSeconds: t.minSeconds, maxSeconds: t.maxSeconds } : null, claimOstia, payout: b.payout === null ? null : payout(b.payout),
  };
}

export function parseRouteSetup(body: unknown): RouteSetup {
  const b = obj(body);
  if (!b || b.on !== true || (b.route !== "closed" && b.route !== "open" && b.route !== "stopped") || typeof b.available !== "boolean" || !Array.isArray(b.assets)) return ROUTE_OFF;
  const dest = obj(b.destination), unit = units(dest?.unit), t = obj(b.time);
  if (!dest || dest.network !== 0 || unit === null || unit === 0n || !whole(b.notTakenSeconds) || !whole(b.ownClaimSeconds)) return ROUTE_OFF;
  const time = t && whole(t.minSeconds) && whole(t.maxSeconds) && t.minSeconds <= t.maxSeconds ? { minSeconds: t.minSeconds, maxSeconds: t.maxSeconds } : null;
  return { on: true, route: b.route, available: b.available, unit, assets: b.assets.map(asset).filter((a): a is RouteAsset => a !== null), time, notTakenSeconds: b.notTakenSeconds, ownClaimSeconds: b.ownClaimSeconds, in: b.in === undefined ? null : routeIn(b.in) };
}

function move(v: unknown): Move | null {
  const m = obj(v);
  if (!m || !/^0x[0-9a-f]{64}$/.test(String(m.id)) || (m.state !== "taken" && m.state !== "requested") || !text(m.party) || !address(m.destAddress)) return null;
  const taken = m.state === "taken";
  const [amount = null, send = null, fee = null] = [m.amount, m.send, m.fee].map(units);
  if (taken && (amount === null || send === null || fee === null || !whole(m.depositCount) || !/^0x[0-9a-f]{64}$/.test(String(m.txHash)))) return null;
  return {
    id: m.id as string, state: m.state, party: m.party, destAddress: m.destAddress.toLowerCase(), erc20: address(m.erc20) ? m.erc20.toLowerCase() : null, amount, send, fee,
    depositCount: taken ? (m.depositCount as number) : null, txHash: taken ? (m.txHash as string) : null, block: taken && whole(m.block) ? m.block : null, at: time(m.at), settleBefore: time(m.settleBefore),
  };
}

const topicAddress = (v: unknown): v is string => address(v);
function backEvent(v: unknown): BackEvent | null {
  const e = obj(v);
  if (!e || (e.kind !== "opened" && e.kind !== "held" && e.kind !== "forwarded" && e.kind !== "refunded") || !topicAddress(e.inbox) || !/^0x[0-9a-f]{64}$/.test(String(e.txHash)) || !whole(e.block) || time(e.at) === null) return null;
  const opened = e.kind === "opened";
  if (opened ? !text(e.party) || !address(e.refundAddress) || !whole(e.refundNetwork) : !address(e.erc20)) return null;
  const [balance = null, amount = null, fee = null] = [e.balance, e.amount, e.fee].map(units);
  if ((e.kind === "held" && (balance === null || time(e.refundAt) === null)) || ((e.kind === "forwarded" || e.kind === "refunded") && (amount === null || fee === null)) || (e.kind === "refunded" && !whole(e.depositCount))) return null;
  return {
    kind: e.kind, inbox: e.inbox.toLowerCase(), erc20: opened ? null : (e.erc20 as string).toLowerCase(), party: opened ? (e.party as string) : null, refundNetwork: opened ? (e.refundNetwork as number) : null,
    refundAddress: opened ? (e.refundAddress as string).toLowerCase() : null, balance, refundAt: time(e.refundAt), amount, fee, depositCount: e.kind === "refunded" ? (e.depositCount as number) : null, txHash: e.txHash as string, block: e.block, at: e.at as string,
  };
}

export function parseMoves(body: unknown): Moves | null {
  const b = obj(body);
  if (!b || !Array.isArray(b.moves) || typeof b.requestsRead !== "boolean") return null;
  const accepts = Array.isArray(b.accepts) ? Object.fromEntries(b.accepts.map(obj).filter((a) => a !== null && typeof a.party === "string" && typeof a.accepts === "boolean").map((a) => [a!.party as string, a!.accepts as boolean])) : null;
  return { moves: b.moves.map(move).filter((m): m is Move => m !== null), requestsRead: b.requestsRead, back: Array.isArray(b.back) ? b.back.map(backEvent).filter((e): e is BackEvent => e !== null) : [], accepts };
}

/** An account's Ostia address as the server works it out, and where its opening stands. */
export interface AddressRead { inbox: string; accepts: boolean | null; opened: boolean; openedAt: string | null; openTx: string | null }
export function parseAddress(body: unknown): AddressRead | null {
  const b = obj(body);
  if (!b || !address(b.inbox) || typeof b.opened !== "boolean" || (b.accepts !== null && typeof b.accepts !== "boolean")) return null;
  return { inbox: b.inbox.toLowerCase(), accepts: b.accepts, opened: b.opened, openedAt: time(b.openedAt), openTx: /^0x[0-9a-f]{64}$/.test(String(b.openTx)) ? (b.openTx as string) : null };
}

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const res = await fetch(path, { headers: { accept: "application/json" }, signal });
    return res.status === 200 ? await res.json().catch(() => null) : null;
  } catch { return null; }
}
/** The setup, or off when the server has no such route, is off or cannot be reached. */
export async function readRouteSetup(signal?: AbortSignal): Promise<RouteSetup> { return parseRouteSetup(await get("/api/canton-route/setup", signal)); }
/** The moves of a wallet (`evm`) or of a Canton account (`party`); null when they cannot be read, so that the page keeps what it showed. */
export async function readMoves(by: "evm" | "party", value: string, signal?: AbortSignal): Promise<Moves | null> {
  return parseMoves(await get(`/api/canton-route/moves?${by}=${encodeURIComponent(value)}`, signal));
}

const wayBack = (party: string, refundAddress: string) => ({ party, refundNetwork: 0, refundAddress });
/** The account's Ostia address; null when it cannot be read (the page then offers no send). */
export async function readAddress(party: string, refundAddress: string, signal?: AbortSignal): Promise<AddressRead | null> {
  const w = wayBack(party, refundAddress);
  return parseAddress(await get(`/api/canton-route/address?party=${encodeURIComponent(w.party)}&refundNetwork=0&refundAddress=${w.refundAddress}`, signal));
}
/** Asks for the account's Ostia address to be opened; true when the server passed the ask on. The address is never taken from this answer. */
export async function askAddress(party: string, refundAddress: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/canton-route/address", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(wayBack(party, refundAddress)), signal });
    return res.status === 200;
  } catch { return false; }
}
