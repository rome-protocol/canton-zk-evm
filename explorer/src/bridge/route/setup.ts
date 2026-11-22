// What the Canton route's two routes say, checked field by field: the setup (what the book and the router allow now) and the moves of one wallet or one Canton account. Anything that is not exactly the
// documented answer reads as "off" (setup) or as no moves, so a server without the routes leaves the page as it was.
import type { Range } from "../other/setup.ts";

export interface RouteAsset { erc20: string; symbol: string; name: string; decimals: number; feeOut: bigint; claimFee: bigint; minAmount: bigint; lockCap: bigint; lockRoom: bigint }
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
export interface Moves { moves: Move[]; requestsRead: boolean }

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
  return { erc20: a.erc20.toLowerCase(), symbol: a.symbol, name: a.name, decimals: a.decimals, feeOut: feeOut!, claimFee: claimFee!, minAmount: minAmount!, lockCap: lockCap!, lockRoom: lockRoom! };
}

export function parseRouteSetup(body: unknown): RouteSetup {
  const b = obj(body);
  if (!b || b.on !== true || (b.route !== "closed" && b.route !== "open" && b.route !== "stopped") || typeof b.available !== "boolean" || !Array.isArray(b.assets)) return ROUTE_OFF;
  const dest = obj(b.destination), unit = units(dest?.unit), t = obj(b.time);
  if (!dest || dest.network !== 0 || unit === null || unit === 0n || !whole(b.notTakenSeconds) || !whole(b.ownClaimSeconds)) return ROUTE_OFF;
  const time = t && whole(t.minSeconds) && whole(t.maxSeconds) && t.minSeconds <= t.maxSeconds ? { minSeconds: t.minSeconds, maxSeconds: t.maxSeconds } : null;
  return { on: true, route: b.route, available: b.available, unit, assets: b.assets.map(asset).filter((a): a is RouteAsset => a !== null), time, notTakenSeconds: b.notTakenSeconds, ownClaimSeconds: b.ownClaimSeconds };
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

export function parseMoves(body: unknown): Moves | null {
  const b = obj(body);
  if (!b || !Array.isArray(b.moves) || typeof b.requestsRead !== "boolean") return null;
  return { moves: b.moves.map(move).filter((m): m is Move => m !== null), requestsRead: b.requestsRead };
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
