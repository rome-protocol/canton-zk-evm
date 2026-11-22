// What GET /api/agglayer/setup says, checked field by field. The Bridge page asks it first (the "AggLayer Bridge" tab shows only when it says on); this file carries nothing else, so that
// asking costs the Canton page no more than a small request. Anything that is not exactly the documented answer reads as "off".

export interface Range { minSeconds: number; maxSeconds: number }
export interface Asset { symbol: string; name: string; decimals: number; /** "native" or the token's address on the other chain. */ sepolia: string; /** The token's address on Ostia. */ ostia: string }
export interface OpenRow {
  id: string; name: string; open: true;
  /** The other chain's AggLayer network id (Ethereum is 0), its chain id (what the wallet switches to), and its bridge. */
  networkId: number; chainId: number; bridge: string;
  /** False while the bridge cannot be used right now: the page then offers no send. */
  available: boolean;
  assets: Asset[];
  /** The measured time into Ostia (`in`) and out of it (`out`); null until one is set, and the page then shows no time. */
  times: { in: Range | null; out: Range | null };
  /** True where a worker, not the person, makes the claim there. */
  claimedForYou: { ostia: boolean; remote: boolean };
}
export interface ClosedRow { id: string; name: string; open: false }
/** A token a route through Solgate offers: its places on Ostia and on Solana, its address on Ostia and its own measured times (`in` is into Ostia, `out` out of it). */
export interface HandoffToken { symbol: string; name: string; decimals: number; places: number; ostia: string; times: { in: Range | null; out: Range | null } }
/** A route through Solgate: the page hands the person over, and every step of the route is made there. */
export interface HandoffRow {
  id: string; name: string; open: true; via: "solgate";
  /** False while the bridge, Solgate or Hadrian cannot be used right now. */
  available: boolean;
  /** Solgate's address (https). */
  solgate: string;
  /** The coin of the claim on Hadrian; null for Solana, where the claim is paid in SOL. */
  coin: string | null;
  assets: HandoffToken[];
  /** The route's own measured times, for a token that has none. */
  times: { in: Range | null; out: Range | null };
}
export type Row = OpenRow | HandoffRow | ClosedRow;
/** A route the page moves tokens on itself (Ethereum Sepolia), as against one it hands over to Solgate. */
export const isMoved = (r: Row): r is OpenRow => r.open && !("via" in r);
export const isHandoff = (r: Row): r is HandoffRow => r.open && "via" in r;
export interface OstiaChain { chainId: number; name: string; networkId: number; bridge: string }
export type Setup = { on: false } | { on: true; chain: OstiaChain; bridgeEvent: { signature: string; topic0: string }; routes: Row[] };

export const OFF: Setup = { on: false };

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const address = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

function range(v: unknown): Range | null {
  const r = obj(v);
  return r && whole(r.minSeconds) && whole(r.maxSeconds) && r.minSeconds <= r.maxSeconds ? { minSeconds: r.minSeconds, maxSeconds: r.maxSeconds } : null;
}
function asset(v: unknown): Asset | null {
  const a = obj(v);
  if (!a || !str(a.symbol) || !str(a.name) || !whole(a.decimals) || a.decimals > 36 || !address(a.ostia)) return null;
  if (a.sepolia !== "native" && !address(a.sepolia)) return null;
  return { symbol: a.symbol, name: a.name, decimals: a.decimals, sepolia: a.sepolia as string, ostia: a.ostia };
}
const https = (v: unknown): v is string => {
  if (!str(v)) return false;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
};
function token(v: unknown): HandoffToken | null {
  const t = obj(v), times = obj(t?.times);
  if (!t || !str(t.symbol) || !str(t.name) || !whole(t.decimals) || t.decimals > 36 || !whole(t.places) || t.places > 36 || !address(t.ostia)) return null;
  return { symbol: t.symbol, name: t.name, decimals: t.decimals, places: t.places, ostia: t.ostia, times: { in: range(times?.in), out: range(times?.out) } };
}
function handoff(r: Record<string, unknown>, id: string, name: string): HandoffRow | null {
  const times = obj(r.times);
  if (typeof r.available !== "boolean" || !https(r.solgate) || !Array.isArray(r.assets) || (r.coin !== null && !str(r.coin))) return null;
  const assets = r.assets.map(token).filter((t): t is HandoffToken => t !== null);
  return { id, name, open: true, via: "solgate", available: r.available, solgate: r.solgate.replace(/\/+$/, ""), coin: r.coin, assets, times: { in: range(times?.in), out: range(times?.out) } };
}
function row(v: unknown): Row | null {
  const r = obj(v);
  if (!r || !str(r.id) || !str(r.name)) return null;
  if (r.open !== true) return { id: r.id, name: r.name, open: false };
  if (r.via === "solgate") return handoff(r, r.id, r.name);
  if (r.via !== undefined) return null;
  const times = obj(r.times), gives = obj(r.claimedForYou);
  if (!whole(r.networkId) || !whole(r.chainId) || !address(r.bridge) || typeof r.available !== "boolean" || !Array.isArray(r.assets)) return null;
  return {
    id: r.id, name: r.name, open: true, networkId: r.networkId, chainId: r.chainId, bridge: r.bridge, available: r.available,
    assets: r.assets.map(asset).filter((a): a is Asset => a !== null),
    times: { in: range(times?.in), out: range(times?.out) },
    claimedForYou: { ostia: gives?.ostia === true, remote: gives?.remote === true },
  };
}

/** The setup as the page uses it, or off when the answer is anything else. A row that does not read is left out, and a row that is not open carries only its name. */
export function parseSetup(body: unknown): Setup {
  const b = obj(body);
  if (!b || b.on !== true) return OFF;
  const chain = obj(b.chain), event = obj(b.bridgeEvent);
  if (!chain || !whole(chain.chainId) || !str(chain.name) || !whole(chain.networkId) || !address(chain.bridge)) return OFF;
  if (!event || !str(event.signature) || typeof event.topic0 !== "string" || !/^0x[0-9a-f]{64}$/.test(event.topic0) || !Array.isArray(b.routes)) return OFF;
  return {
    on: true, chain: { chainId: chain.chainId, name: chain.name, networkId: chain.networkId, bridge: chain.bridge },
    bridgeEvent: { signature: event.signature, topic0: event.topic0 }, routes: b.routes.map(row).filter((r): r is Row => r !== null),
  };
}

/** Asks the server for the setup. A server without the routes, one that is off, one that cannot be reached and one that answers anything else are all "off": the page is then the Canton page alone. */
export async function readSetup(signal?: AbortSignal): Promise<Setup> {
  try {
    const res = await fetch("/api/agglayer/setup", { headers: { accept: "application/json" }, signal });
    return res.status === 200 ? parseSetup(await res.json().catch(() => null)) : OFF;
  } catch {
    return OFF;
  }
}
