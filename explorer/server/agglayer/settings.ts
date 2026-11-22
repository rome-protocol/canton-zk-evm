/** The settings of the AggLayer bridge routes, read from the environment. With AGGLAYER_BRIDGE off, nothing else is read. */
import { Secret } from "./secret.ts";
import { SEPOLIA_MAX_PER_SECOND } from "./sepolia.ts";

export interface TimeRange { minSeconds: number; maxSeconds: number }
export interface TokenSetting {
  symbol: string;
  name: string;
  decimals: number;
  /** "native" for the coin itself, else the token's address on Ethereum Sepolia. */
  sepolia: string;
  /** The token's address on Ostia. */
  ostia: string;
}
export interface RouteSetting {
  id: string;
  name: string;
  open: boolean;
  /** Measured times, into Ostia and out of it; null until a measurement is put in the setting. */
  times: { in: TimeRange | null; out: TimeRange | null };
  /** True where a worker, not the person, makes the claim there. Nothing sets it yet: a worker is not built. */
  claimedForYou: { ostia: boolean; remote: boolean };
  offered: TokenSetting[];
  /** A route that goes through Solgate (the page hands the person over): the symbols it offers, looked up in Solgate's token list, and each one's measured times. Null for the Ethereum Sepolia route. */
  handoff: { symbols: string[]; assetTimes: Record<string, { in: TimeRange | null; out: TimeRange | null }> } | null;
}
/** The settings of the message routes; `messages` of the settings is null while AGGLAYER_MESSAGES is off. */
export interface MessageSettings {
  /** The longest message the form sends, in bytes. */
  maxBytes: number;
  /** The longest message (and note) the explorer reads; one above it is "too large for this page" and no claim is built. */
  readMaxBytes: number;
  /** The note board (a demo receiver) on each chain, or null where none is set. */
  noteBoards: { ostia: string | null; sepolia: string | null };
}
export interface AgglayerSettings {
  aggkitUrl: string;
  sepoliaRpc: Secret;
  sepoliaChainId: number;
  /** The most calls a second the explorer makes to Ethereum Sepolia, all clients together. */
  sepoliaMaxPerSecond: number;
  ostiaNetworkId: number;
  ostiaBridge: string;
  sepoliaBridge: string;
  rollupManager: string | null;
  routes: RouteSetting[];
  /** Where Solgate is (its page and its API), and Hadrian as the routes through it see it: set when a hand-off route is open. */
  solgate: { url: string } | null;
  hadrian: { rpc: string; chainId: number; networkId: number } | null;
  settlementMaxAgeSeconds: number;
  /** How many blocks AggKit's Ostia syncers may trail Ostia's finalized block before the bridge is "not available". */
  aggkitMaxLagBlocks: number;
  messages: MessageSettings | null;
}

type Env = Record<string, string | undefined>;
type Fail = (message: string) => Error;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_ROUTES = [{ id: "sepolia", name: "Ethereum Sepolia", open: true }, { id: "hadrian", name: "Hadrian" }, { id: "solana-devnet", name: "Solana devnet" }];
/** The routes this build can open: Ethereum Sepolia (moved on this page) and the two that go through Solgate. */
export const OPEN_ROUTE = "sepolia";
export const HANDOFF_ROUTES: readonly string[] = ["hadrian", "solana-devnet"];

export function agglayerSettings(env: Env, fail: Fail): AgglayerSettings | null {
  const raw = env.AGGLAYER_BRIDGE;
  if (raw === undefined || raw === "" || raw === "0") {
    if (env.AGGLAYER_MESSAGES === "1") throw fail("AGGLAYER_MESSAGES needs AGGLAYER_BRIDGE=1");
    return null;
  }
  if (raw !== "1") throw fail(`AGGLAYER_BRIDGE must be 1 or 0, not "${raw}"`);

  const whole = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw fail(`${name} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ""}, not "${v.slice(0, 40)}"`);
    return Number(v);
  };
  const address = (name: string, required: boolean): string | null => {
    const v = env[name]?.trim();
    if (!v) { if (required) throw fail(`${name} must be set to a contract address (0x and 40 hex digits) when AGGLAYER_BRIDGE is on`); return null; }
    if (!ADDRESS.test(v)) throw fail(`${name} must be 0x and 40 hex digits, not "${v.slice(0, 50)}"`);
    return v.toLowerCase();
  };
  /** AggKit's bridge service answers only on this machine, so only a loopback address over http is taken. */
  const loopbackUrl = (name: string, fallback: string): string => {
    const v = env[name]?.trim() || fallback;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)) throw new Error();
    } catch {
      throw fail(`${name} must be an http address on this machine (127.0.0.1, [::1] or localhost), not "${v.slice(0, 60)}"`);
    }
    return v.replace(/\/+$/, "");
  };
  /** A public address of another service: https, no login, no query. A trailing slash is dropped. */
  const publicUrl = (name: string): string | null => {
    const v = env[name]?.trim();
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error();
      return (u.origin + u.pathname).replace(/\/+$/, "");
    } catch {
      throw fail(`${name} must be an https address with no login and no query, not "${v.slice(0, 60)}"`);
    }
  };
  const json = (name: string, text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw fail(`${name} must be JSON`);
    }
  };
  const object = (name: string, v: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw fail(`${name} has an entry that is not an object`);
    for (const k of Object.keys(v)) if (!keys.includes(k)) throw fail(`${name} has an entry with "${k.slice(0, 30)}", which it does not know`);
    return v as Record<string, unknown>;
  };

  // The endpoint carries a key, so it is never repeated in a message.
  const rpc = env.AGGLAYER_SEPOLIA_RPC_URL?.trim();
  if (!rpc) throw fail("AGGLAYER_SEPOLIA_RPC_URL must be set when AGGLAYER_BRIDGE is on (it is a secret: it is never shown)");
  try {
    const u = new URL(rpc);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) throw new Error();
  } catch {
    throw fail("AGGLAYER_SEPOLIA_RPC_URL must be an https address (http only for localhost); it is a secret, so its value is not shown");
  }

  const tokens = ((): TokenSetting[] => {
    const text = env.AGGLAYER_TOKENS?.trim();
    if (!text) return [];
    const list = json("AGGLAYER_TOKENS", text);
    if (!Array.isArray(list)) throw fail("AGGLAYER_TOKENS must be a list");
    return list.map((v) => {
      const t = object("AGGLAYER_TOKENS", v, ["symbol", "name", "decimals", "sepolia", "ostia"]);
      const ok = typeof t.symbol === "string" && /^[A-Za-z0-9._-]{1,12}$/.test(t.symbol) && typeof t.name === "string" && t.name.length >= 1 && t.name.length <= 40
        && typeof t.decimals === "number" && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36
        && typeof t.sepolia === "string" && (t.sepolia === "native" || ADDRESS.test(t.sepolia)) && typeof t.ostia === "string" && ADDRESS.test(t.ostia);
      if (!ok) throw fail('AGGLAYER_TOKENS needs, for each token, a symbol, a name, decimals (0 to 36), "sepolia" ("native" or an address) and "ostia" (an address)');
      return { symbol: t.symbol as string, name: t.name as string, decimals: t.decimals as number, sepolia: (t.sepolia as string).toLowerCase(), ostia: (t.ostia as string).toLowerCase() };
    });
  })();

  const range = (v: unknown): TimeRange | null => {
    if (v === undefined || v === null) return null;
    const r = object("AGGLAYER_ROUTES", v, ["minSeconds", "maxSeconds"]);
    const a = r.minSeconds, b = r.maxSeconds;
    if (typeof a !== "number" || typeof b !== "number" || !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > 86_400) throw fail("AGGLAYER_ROUTES: a time is minSeconds and maxSeconds, whole numbers from 1 to 86400, with the first not above the second");
    return { minSeconds: a, maxSeconds: b };
  };
  const flagIn = (v: unknown): boolean => {
    if (v === undefined) return false;
    if (typeof v !== "boolean") throw fail("AGGLAYER_ROUTES: open and claimedForYou take true or false");
    return v;
  };
  const rowsText = env.AGGLAYER_ROUTES?.trim();
  const rows = rowsText ? json("AGGLAYER_ROUTES", rowsText) : DEFAULT_ROUTES;
  if (!Array.isArray(rows) || rows.length === 0) throw fail("AGGLAYER_ROUTES must be a list with at least one row");
  const seen = new Set<string>();
  const routes = rows.map((v): RouteSetting => {
    const r = object("AGGLAYER_ROUTES", v, ["id", "name", "open", "times", "claimedForYou", "assets", "assetTimes"]);
    if (typeof r.id !== "string" || !/^[a-z0-9-]{1,30}$/.test(r.id)) throw fail("AGGLAYER_ROUTES: a row's id is lowercase letters, digits and hyphens");
    if (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 60) throw fail("AGGLAYER_ROUTES: a row's name is 1 to 60 characters");
    if (seen.has(r.id)) throw fail(`AGGLAYER_ROUTES: the id "${r.id}" is given twice`);
    seen.add(r.id);
    const open = flagIn(r.open);
    if (open && r.id !== OPEN_ROUTE && !HANDOFF_ROUTES.includes(r.id)) throw fail(`AGGLAYER_ROUTES: only ${[OPEN_ROUTE, ...HANDOFF_ROUTES].join(", ")} can be open in this build`);
    const handoff = HANDOFF_ROUTES.includes(r.id);
    if (!handoff && (r.assets !== undefined || r.assetTimes !== undefined)) throw fail(`AGGLAYER_ROUTES: assets and assetTimes are for the routes through Solgate (${HANDOFF_ROUTES.join(", ")}); ${OPEN_ROUTE} takes its tokens from AGGLAYER_TOKENS`);
    const symbols = r.assets === undefined ? [] : r.assets;
    if (!Array.isArray(symbols) || symbols.length > 20 || !symbols.every((x) => typeof x === "string" && /^[A-Za-z0-9._-]{1,12}$/.test(x)) || new Set(symbols).size !== symbols.length) throw fail("AGGLAYER_ROUTES: assets is a list of up to 20 different token symbols");
    const tt = r.assetTimes === undefined ? {} : r.assetTimes;
    if (!tt || typeof tt !== "object" || Array.isArray(tt)) throw fail("AGGLAYER_ROUTES: assetTimes is an object from a token symbol to its times");
    const assetTimes: Record<string, { in: TimeRange | null; out: TimeRange | null }> = {};
    for (const [sym, v] of Object.entries(tt)) {
      if (!symbols.includes(sym)) throw fail(`AGGLAYER_ROUTES: assetTimes names ${sym.slice(0, 12)}, which is not in assets`);
      const x = object("AGGLAYER_ROUTES", v, ["in", "out"]);
      assetTimes[sym] = { in: range(x.in), out: range(x.out) };
    }
    const t = r.times === undefined ? {} : object("AGGLAYER_ROUTES", r.times, ["in", "out"]);
    const c = r.claimedForYou === undefined ? {} : object("AGGLAYER_ROUTES", r.claimedForYou, ["ostia", "remote"]);
    return { id: r.id, name: r.name, open, times: { in: range(t.in), out: range(t.out) }, claimedForYou: { ostia: flagIn(c.ostia), remote: flagIn(c.remote) }, handoff: handoff ? { symbols: symbols as string[], assetTimes } : null, offered: r.id === OPEN_ROUTE ? tokens : [] };
  });

  const messages = ((): MessageSettings | null => {
    const on = env.AGGLAYER_MESSAGES;
    if (on === undefined || on === "" || on === "0") return null;
    if (on !== "1") throw fail(`AGGLAYER_MESSAGES must be 1 or 0, not "${on.slice(0, 40)}"`);
    const boards = env.AGGLAYER_NOTE_BOARDS?.trim() ? object("AGGLAYER_NOTE_BOARDS", json("AGGLAYER_NOTE_BOARDS", env.AGGLAYER_NOTE_BOARDS), ["ostia", "sepolia"]) : {};
    const board = (k: string): string | null => {
      const v = boards[k];
      if (v === undefined) return null;
      if (typeof v !== "string" || !ADDRESS.test(v)) throw fail(`AGGLAYER_NOTE_BOARDS: "${k}" must be 0x and 40 hex digits`);
      return v.toLowerCase();
    };
    const maxBytes = whole("AGGLAYER_MESSAGE_MAX_BYTES", 280, 1, 16384), readMaxBytes = whole("AGGLAYER_MESSAGE_READ_MAX_BYTES", 4096, 1, 16384);
    if (maxBytes > readMaxBytes) throw fail("AGGLAYER_MESSAGE_MAX_BYTES must not be above AGGLAYER_MESSAGE_READ_MAX_BYTES: a message the form sends must be one the page can read");
    return { maxBytes, readMaxBytes, noteBoards: { ostia: board("ostia"), sepolia: board("sepolia") } };
  })();

  const anyHandoff = routes.some((r) => r.open && r.handoff);
  const solgateUrl = publicUrl("AGGLAYER_SOLGATE_URL");
  const hadrianRpc = publicUrl("AGGLAYER_HADRIAN_RPC_URL");
  if (anyHandoff && (!solgateUrl || !hadrianRpc)) throw fail("AGGLAYER_SOLGATE_URL and AGGLAYER_HADRIAN_RPC_URL must be set (https, public) when a route through Solgate is open");

  return {
    aggkitUrl: loopbackUrl("AGGKIT_BRIDGE_URL", "http://127.0.0.1:5578"),
    sepoliaRpc: new Secret(rpc),
    sepoliaChainId: whole("AGGLAYER_SEPOLIA_CHAIN_ID", 11155111, 1),
    sepoliaMaxPerSecond: whole("AGGLAYER_SEPOLIA_MAX_PER_SECOND", SEPOLIA_MAX_PER_SECOND, 1, 100),
    ostiaNetworkId: whole("AGGLAYER_OSTIA_NETWORK_ID", 75, 1, 2 ** 32 - 1),
    ostiaBridge: address("AGGLAYER_OSTIA_BRIDGE", true)!,
    sepoliaBridge: address("AGGLAYER_SEPOLIA_BRIDGE", true)!,
    rollupManager: address("AGGLAYER_ROLLUP_MANAGER", false),
    routes,
    solgate: anyHandoff ? { url: solgateUrl! } : null,
    hadrian: anyHandoff ? { rpc: hadrianRpc!, chainId: whole("AGGLAYER_HADRIAN_CHAIN_ID", 200010, 1), networkId: whole("AGGLAYER_HADRIAN_NETWORK_ID", 74, 1, 2 ** 32 - 1) } : null,
    settlementMaxAgeSeconds: whole("AGGLAYER_SETTLEMENT_MAX_AGE_SECONDS", 1800, 1),
    aggkitMaxLagBlocks: whole("AGGLAYER_AGGKIT_MAX_LAG_BLOCKS", 30, 1),
    messages,
  };
}
