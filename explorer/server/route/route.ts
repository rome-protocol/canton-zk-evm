/**
 * The routes of the Bridge page's moves from Canton to Ethereum Sepolia through Ostia's router: the setup (what the book and the router allow now) and the moves of one account or one wallet. The server reads
 * and the person's wallet signs: nothing here claims, sends or holds a key. The book and the router are read with fixed `eth_call`s, the moves are the router's own `RoutedOut` events from the explorer's log table,
 * and the requests that Ostia has not taken yet come from Canton. The move's later steps (confirmed, ready, arrived) and the claim are the AggLayer routes', by the deposit number the event carries.
 */
import type { Answer } from "../api.ts";
import { createLimiter, REST_REFUSED, retryAfter } from "../limits.ts";
import { cached } from "../rest/cache.ts";
import { bytes, hex } from "../rest/chain-rest.ts";
import { REST_FIELDS as F, pick } from "../rest/fields.ts";
import { BadRequest } from "../rest/paging.ts";
import type { Reth } from "../reth.ts";
import type { AgglayerBridge } from "../agglayer/bridge.ts";
import type { AgglayerSettings } from "../agglayer/settings.ts";
import { assetsCall, claimFeeCall, decimalsCall, decodeRoutedOut, destinationCall, LISTED_TOPIC, lockRoomCall, nameCall, outOpenCall, partyHash, readAsset, readDecimals, readDestination, readFlag, readName, readNumber, readRoom, readSymbol, ROUTED_OUT_TOPIC, SWITCH_TOPIC, symbolCall } from "./abi.ts";
import type { Canton, OpenRequest } from "./canton.ts";
import type { RouteSettings } from "./settings.ts";

/** Ethereum's network id in AggLayer: the one destination of this route. */
const ETHEREUM = 0;
export const ROUTE_PATHS = ["/api/canton-route/setup", "/api/canton-route/moves"] as const;
export const ROUTE_OFF = "The Canton route is off on this explorer.";
export const UNREADABLE = "The route cannot be read right now.";
/** The most moves one answer holds, newest first. */
const MOVES_MAX = 50;
/** The most listed assets one setup reads. */
const ASSETS_MAX = 20;
const RATE = [{ capacity: 10, perSecond: 0.5 }] as const;
const LABEL = /^r1:(\d{1,10}):0x([0-9a-f]{40}):(\d{1,78}):(\d{1,20})$/;
const TRUE_WORD = Buffer.from("00".repeat(31) + "01", "hex");

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface RouteDeps {
  settings: RouteSettings;
  agglayer: Pick<AgglayerSettings, "ostiaBridge">;
  bridge: Pick<AgglayerBridge, "status">;
  reth: Pick<Reth, "block" | "callAt">;
  pool: { query(sql: string, values: unknown[]): Promise<{ rows: Row[] }> };
  /** Null: the open requests are not read (no gateway party is set). */
  canton: Canton | null;
  now?: () => number;
}

const ok = (body: unknown, rule?: "composite"): Answer => (rule ? cached({ status: 200, body }, rule) : { status: 200, body });
const fail = (status: number, error: string, headers?: Record<string, string>): Answer => ({ status, body: { error }, ...(headers ? { headers } : {}) });
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const word = (v: string): `0x${string}` => ("0x" + v.slice(-40)) as `0x${string}`;

export function createCantonRoute({ settings, reth, pool, canton, bridge, now = Date.now }: RouteDeps) {
  const limiter = createLimiter(RATE, now);
  const meta = new Map<string, { symbol: string; name: string; decimals: number }>();
  let opened = false;
  let requestsAt = -Infinity, requestsNow: Promise<OpenRequest[] | null> | null = null;

  const head = async (): Promise<number> => {
    const n = (await reth.block("latest"))?.number;
    if (n === undefined) throw new RouteUnreadable("Ostia's latest block cannot be read");
    return n;
  };
  const read = async <T>(to: string, data: string, at: number, parse: (out: string) => T): Promise<T> => {
    try { return parse(await reth.callAt(to, data, at)); } catch (e) { throw new RouteUnreadable((e as Error).message); }
  };

  /** The tokens the book lists, from its own `Listed` events, oldest first. */
  async function listed(): Promise<string[]> {
    const { rows } = await pool.query("select topic1 from logs where address = $1 and topic0 = $2 order by block_number, log_index limit $3", [bytes(settings.book), bytes(LISTED_TOPIC), ASSETS_MAX]);
    return rows.map((r) => word(hex(r.topic1)));
  }
  /** Whether the out switch has ever been turned on: a route that never opened is "not yet open", one that was and is not now is "not available". Once true it stays true. */
  async function everOpened(): Promise<boolean> {
    if (opened) return true;
    const { rows } = await pool.query("select 1 from logs where address = $1 and topic0 = $2 and topic1 = $3 and data = $3 limit 1", [bytes(settings.book), bytes(SWITCH_TOPIC), TRUE_WORD]);
    return (opened = rows.length > 0);
  }
  async function tokenMeta(token: string, at: number) {
    const had = meta.get(token);
    if (had) return had;
    const [symbol, name, decimals] = await Promise.all([read(token, symbolCall(), at, readSymbol), read(token, nameCall(), at, readName), read(token, decimalsCall(), at, readDecimals)]);
    const m = { symbol: symbol.slice(0, 12), name: name.slice(0, 40), decimals };
    meta.set(token, m);
    return m;
  }

  async function setup(): Promise<Answer> {
    const at = await head();
    const [everOn, outOpen, dest, st] = await Promise.all([everOpened(), read(settings.book, outOpenCall(), at, readFlag), read(settings.book, destinationCall(ETHEREUM), at, readDestination), bridge.status()]);
    const addresses = outOpen && dest.open ? await listed() : [];
    const assets = (await Promise.all(addresses.map(async (token) => {
      const a = await read(settings.book, assetsCall(token), at, readAsset);
      if (a.state !== 1) return null;
      const [claim, room, m] = await Promise.all([read(settings.book, claimFeeCall(token, ETHEREUM), at, (o) => readNumber("claimFee", o)), read(settings.router, lockRoomCall(token), at, readRoom), tokenMeta(token, at)]);
      return pick({ erc20: token, ...m, feeOut: a.feeOut.toString(), claimFee: claim.toString(), minAmount: a.minAmount.toString(), lockCap: a.lockCap.toString(), lockRoom: room.toString() }, F.routeAsset);
    }))).filter((a) => a !== null);
    const route = assets.length > 0 ? "open" : everOn ? "stopped" : "closed";
    return ok(pick({
      on: true, route, available: st.available, destination: pick({ network: ETHEREUM, unit: dest.unit.toString() }, F.routeDestination), assets,
      time: settings.time && pick(settings.time, F.agglayerRange), notTakenSeconds: settings.notTakenSeconds, ownClaimSeconds: settings.ownClaimSeconds,
    }, F.routeSetup), "composite");
  }

  /** The open requests, read once for a few seconds for every client; null when Canton is not read or cannot be. */
  function requests(): Promise<OpenRequest[] | null> {
    const t = now();
    if (requestsNow && t - requestsAt < 3000) return requestsNow;
    requestsAt = t;
    requestsNow = canton ? canton.requests().catch((e: Error) => { console.error(`canton route: the open requests cannot be read: ${e.message}`); return null; }) : Promise.resolve(null);
    return requestsNow;
  }

  function asked(q: URLSearchParams): { by: "party" | "evm"; value: string } {
    const party = q.get("party"), evm = q.get("evm");
    if ((party === null) === (evm === null)) throw new BadRequest("Give party or evm, one of them.");
    if (party !== null) {
      if (!/^[A-Za-z0-9_.:-]{1,300}$/.test(party)) throw new BadRequest("party is a Canton party id.");
      return { by: "party", value: party };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(evm!)) throw new BadRequest("evm is a 0x address of 40 hex digits.");
    return { by: "evm", value: evm!.toLowerCase() };
  }

  async function moves(q: URLSearchParams): Promise<Answer> {
    const { by, value } = asked(q);
    const column = by === "party" ? "l.topic2" : "l.topic3";
    const { rows } = await pool.query(
      `select l.block_number, l.topic1, l.topic3, l.data, t.hash, extract(epoch from b.timestamp)::bigint as ts
       from logs l join transactions t on t.block_number = l.block_number and t.tx_index = l.tx_index join blocks b on b.number = l.block_number
       where l.address = $1 and l.topic0 = $2 and ${column} = $3 order by l.block_number desc, l.log_index desc limit $4`,
      [bytes(settings.router), bytes(ROUTED_OUT_TOPIC), by === "party" ? bytes(partyHash(value)) : Buffer.concat([Buffer.alloc(12), bytes(value)]), MOVES_MAX],
    );
    const taken = rows.flatMap((r) => {
      const e = decodeRoutedOut(hex(r.data));
      if (!e || e.destNetwork !== ETHEREUM) return [];
      return [pick({
        id: hex(r.topic1), state: "taken", party: e.party, destAddress: word(hex(r.topic3)), erc20: e.erc20, amount: (e.send + e.fee).toString(), send: e.send.toString(), fee: e.fee.toString(), depositCount: e.depositCount,
        txHash: hex(r.hash), block: Number(r.block_number), at: iso(Number(r.ts)), maxFee: null, settleBefore: null,
      }, F.routeMove)];
    });
    const open = await requests();
    const takenIds = new Set(taken.map((m) => String(m.id).slice(2)));
    const requested = (open ?? []).flatMap((r) => {
      const m = LABEL.exec(r.label);
      if (!m || Number(m[1]) !== ETHEREUM || takenIds.has(r.depositId.toLowerCase()) || !/^[0-9a-f]{64}$/i.test(r.depositId)) return [];
      if (by === "party" ? r.party !== value : "0x" + m[2] !== value) return [];
      return [pick({
        id: "0x" + r.depositId.toLowerCase(), state: "requested", party: r.party, destAddress: "0x" + m[2], erc20: null, amount: r.amount === null ? null : r.amount.toString(), send: null, fee: null, depositCount: null,
        txHash: null, block: null, at: r.requestedAt === null ? null : new Date(r.requestedAt).toISOString(), maxFee: m[3], settleBefore: r.settleBefore === null ? null : new Date(r.settleBefore).toISOString(),
      }, F.routeMove)];
    });
    return ok(pick({ moves: [...requested, ...taken], requestsRead: open !== null }, F.routeMoves));
  }

  async function guarded(run: () => Promise<Answer>): Promise<Answer> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, e.message);
      if (e instanceof RouteUnreadable) { console.error(`canton route: ${e.message}`); return fail(503, UNREADABLE); }
      console.error(`canton route: ${(e as Error).message}`);
      return fail(503, UNREADABLE);
    }
  }

  const routes = (parts: string[], q: URLSearchParams, ip: string | undefined): (() => Promise<Answer>) | undefined => {
    if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "canton-route") return undefined;
    if (parts[2] === "setup") return () => guarded(setup);
    if (parts[2] !== "moves") return undefined;
    return async () => {
      const wait = limiter.take(ip ?? "unknown");
      return wait === null ? guarded(() => moves(q)) : fail(429, REST_REFUSED(wait), retryAfter(wait));
    };
  };
  return { routes };
}

class RouteUnreadable extends Error {}

export type CantonRoute = ReturnType<typeof createCantonRoute>;

/** The routes of the Canton route, or, with none (the switch is off), the same paths answering that it is off: `{on: false}` for the setup and 404 for the moves. */
export function cantonRouteRoutes(route: Pick<CantonRoute, "routes"> | null): CantonRoute["routes"] {
  if (route) return route.routes;
  return (parts) => {
    if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "canton-route") return undefined;
    if (parts[2] === "setup") return async () => ok(pick({ on: false }, F.routeOff));
    if (parts[2] === "moves") return async () => fail(404, ROUTE_OFF);
    return undefined;
  };
}
