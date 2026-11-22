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
import { assetsCall, claimFeeCall, decimalsCall, decodeBack, decodeRoutedOut, destinationCall, FORWARDED_TOPIC, HELD_TOPIC, inboxOfCall, inOpenCall, INBOX_OPENED_TOPIC, LISTED_TOPIC, lockRoomCall, nameCall, outOpenCall, partyHash, readAsset, readDecimals, readDestination, readFlag, readInbox, readName, readNumber, readRoom, readSymbol, REFUNDED_TOPIC, refundWaitCall, ROUTED_OUT_TOPIC, SWITCH_TOPIC, symbolCall } from "./abi.ts";
import type { Canton, OpenRequest, Payout } from "./canton.ts";
import type { RouteSettings } from "./settings.ts";

/** Ethereum's network id in AggLayer: the one destination of this route. */
const ETHEREUM = 0;
export const ROUTE_PATHS = ["/api/canton-route/setup", "/api/canton-route/moves", "/api/canton-route/address"] as const;
export const ROUTE_OFF = "The Canton route is off on this explorer.";
export const UNREADABLE = "The route cannot be read right now.";
export const INTAKE_DOWN = "Sending to Canton is not available right now. Nothing is lost.";
export const NOT_ACCEPTED = "This Canton account does not take transfers from Ostia yet.";
/** The refund network of this route: the person's own address on Ethereum Sepolia. */
const BACK_NETWORK = 0;
/** The newest blocks looked at for the opening of an address, which is a minute or two old at most while the page waits for it. */
const OPENING_BLOCKS = 500;
/** The most events one answer holds, and the most inboxes they belong to. */
const BACK_MAX = 200;
const INBOXES_MAX = 20;
/** The most moves one answer holds, newest first. */
const MOVES_MAX = 50;
/** The most listed assets one setup reads. */
const ASSETS_MAX = 20;
const RATE = [{ capacity: 10, perSecond: 0.5 }] as const;
/** What a client may ask the intake to open: a few at once, then one every 20 seconds. */
const INTAKE_RATE = [{ capacity: 3, perSecond: 0.05 }] as const;
const PARTY = /^[A-Za-z0-9_.:-]{1,300}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const LABEL = /^r1:(\d{1,10}):0x([0-9a-f]{40}):(\d{1,78}):(\d{1,20})$/;
const TRUE_WORD = Buffer.from("00".repeat(31) + "01", "hex");
const FALSE_WORD = Buffer.alloc(32);

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface RouteDeps {
  settings: RouteSettings;
  agglayer: Pick<AgglayerSettings, "ostiaBridge">;
  bridge: Pick<AgglayerBridge, "status">;
  reth: Pick<Reth, "block" | "callAt"> & Partial<Pick<Reth, "logsSince">>;
  pool: { query(sql: string, values: unknown[]): Promise<{ rows: Row[] }> };
  /** Null: the open requests are not read (no gateway party is set). */
  canton: Canton | null;
  /** Calls the intake (the global `fetch` unless a test gives its own). */
  fetcher?: typeof fetch;
  now?: () => number;
}

const ok = (body: unknown, rule?: "composite"): Answer => (rule ? cached({ status: 200, body }, rule) : { status: 200, body });
const fail = (status: number, error: string, headers?: Record<string, string>): Answer => ({ status, body: { error }, ...(headers ? { headers } : {}) });
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const word = (v: string): `0x${string}` => ("0x" + v.slice(-40)) as `0x${string}`;

export function createCantonRoute({ settings, reth, pool, canton, bridge, fetcher = fetch, now = Date.now }: RouteDeps) {
  const limiter = createLimiter(RATE, now);
  const intakeLimiter = createLimiter(INTAKE_RATE, now);
  const meta = new Map<string, { symbol: string; name: string; decimals: number }>();
  const opened = { out: false, in: false };
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
  /** Whether a direction's switch has ever been turned on: a route that never opened is "not yet open", one that was and is not now is "not available". Once true it stays true. */
  async function everOpened(out: boolean): Promise<boolean> {
    if (opened[out ? "out" : "in"]) return true;
    const { rows } = await pool.query("select 1 from logs where address = $1 and topic0 = $2 and topic1 = $3 and data = $4 limit 1", [bytes(settings.book), bytes(SWITCH_TOPIC), out ? TRUE_WORD : FALSE_WORD, TRUE_WORD]);
    return (opened[out ? "out" : "in"] = rows.length > 0);
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
    const flow = settings.in;
    const [everOn, outOpen, dest, st, everIn, inOpen, wait, pay] = await Promise.all([
      everOpened(true), read(settings.book, outOpenCall(), at, readFlag("outOpen")), read(settings.book, destinationCall(ETHEREUM), at, readDestination), bridge.status(),
      flow ? everOpened(false) : false, flow ? read(settings.book, inOpenCall(), at, readFlag("inOpen")) : false, flow ? read(settings.book, refundWaitCall(), at, (o) => readNumber("refundWait", o)) : 0n, flow ? payout() : null,
    ]);
    const outLive = outOpen && dest.open, inLive = flow !== null && inOpen;
    const addresses = outLive || inLive ? await listed() : [];
    const assets = (await Promise.all(addresses.map(async (token) => {
      const a = await read(settings.book, assetsCall(token), at, readAsset);
      if (a.state !== 1) return null;
      const [claim, room, m] = await Promise.all([read(settings.book, claimFeeCall(token, ETHEREUM), at, (o) => readNumber("claimFee", o)), read(settings.router, lockRoomCall(token), at, readRoom), tokenMeta(token, at)]);
      return pick({ erc20: token, ...m, feeOut: a.feeOut.toString(), claimFee: claim.toString(), minAmount: a.minAmount.toString(), lockCap: a.lockCap.toString(), lockRoom: room.toString(), ...(flow ? { feeIn: a.feeIn.toString(), feeRefund: a.feeRefund.toString() } : {}) }, F.routeAsset);
    }))).filter((a) => a !== null);
    const route = outLive && assets.length > 0 ? "open" : everOn ? "stopped" : "closed";
    const back = flow && pick({
      route: inLive && assets.length > 0 ? "open" : everIn ? "stopped" : "closed", refundNetwork: BACK_NETWORK, refundWaitSeconds: Number(wait), router: settings.router, book: settings.book, setupSeconds: flow.setupSeconds, setupTime: flow.setupTime && pick(flow.setupTime, F.agglayerRange),
      claimOstia: flow.claimOstia && pick(flow.claimOstia, F.routeClaimOstia), payout: pay && pick({ paused: pay.paused, pausedUntil: pay.pausedUntil, assets: [...pay.assets].map(([erc20, t]) => pick({ erc20, left: t.left === null ? null : t.left.toString(), renewsAt: t.renewsAt }, F.routePayoutAsset)) }, F.routePayout),
    }, F.routeIn);
    return ok(pick({
      on: true, route, available: st.available, destination: pick({ network: ETHEREUM, unit: dest.unit.toString() }, F.routeDestination), assets,
      time: settings.time && pick(settings.time, F.agglayerRange), notTakenSeconds: settings.notTakenSeconds, ownClaimSeconds: settings.ownClaimSeconds, ...(back ? { in: back } : {}),
    }, F.routeSetup), "composite");
  }

  /** What Canton can pay out, read once for a few seconds for every client; null when Canton is not read or cannot be. */
  let payoutAt = -Infinity, payoutNow: Promise<Payout | null> | null = null;
  function payout(): Promise<Payout | null> {
    const t = now();
    if (payoutNow && t - payoutAt < 3000) return payoutNow;
    payoutAt = t;
    payoutNow = canton ? canton.payout().catch((e: Error) => { console.error(`canton route: the payout limit cannot be read: ${e.message}`); return null; }) : Promise.resolve(null);
    return payoutNow;
  }

  /** The open requests, read once for a few seconds for every client; null when Canton is not read or cannot be. */
  function requests(): Promise<OpenRequest[] | null> {
    const t = now();
    if (requestsNow && t - requestsAt < 3000) return requestsNow;
    requestsAt = t;
    requestsNow = canton ? canton.requests().catch((e: Error) => { console.error(`canton route: the open requests cannot be read: ${e.message}`); return null; }) : Promise.resolve(null);
    return requestsNow;
  }

  function asked(q: URLSearchParams): { by: "party" | "evm" | "ostia"; value: string } {
    const party = q.get("party"), evm = q.get("evm"), ostia = settings.in ? q.get("ostia") : null;
    if ([party, evm, ostia].filter((v) => v !== null).length !== 1) throw new BadRequest(settings.in ? "Give party, evm or ostia, one of them." : "Give party or evm, one of them.");
    if (party !== null) {
      if (!PARTY.test(party)) throw new BadRequest("party is a Canton party id.");
      return { by: "party", value: party };
    }
    if (ostia !== null) {
      if (!EVM.test(ostia)) throw new BadRequest("ostia is a 0x address of 40 hex digits.");
      return { by: "ostia", value: ostia.toLowerCase() };
    }
    if (!EVM.test(evm!)) throw new BadRequest("evm is a 0x address of 40 hex digits.");
    return { by: "evm", value: evm!.toLowerCase() };
  }

  /**
   * The router's flow C events for the inboxes asked about, newest first: the opening of each inbox (which names its party and way back) and what happened to the coin in it (held, paid on, sent back).
   * An inbox is found by its party (the hash is an indexed topic), by its way-back address, or by its own address on Ostia.
   */
  async function backEvents(by: "party" | "evm" | "ostia", value: string) {
    const column = by === "party" ? "o.topic2" : by === "evm" ? "o.topic3" : "o.topic1";
    const key = by === "party" ? bytes(partyHash(value)) : Buffer.concat([Buffer.alloc(12), bytes(value)]);
    const topics = [INBOX_OPENED_TOPIC, HELD_TOPIC, FORWARDED_TOPIC, REFUNDED_TOPIC].map(bytes);
    const { rows } = await pool.query(
      `select l.topic0, l.topic1, l.topic2, l.topic3, l.data, l.block_number, t.hash, extract(epoch from b.timestamp)::bigint as ts
       from logs l join transactions t on t.block_number = l.block_number and t.tx_index = l.tx_index join blocks b on b.number = l.block_number
       where l.address = $1 and l.topic0 = any($2) and l.topic1 in (select o.topic1 from logs o where o.address = $1 and o.topic0 = $3 and ${column} = $4 group by o.topic1 order by max(o.block_number) desc, max(o.log_index) desc limit $5)
       order by l.block_number desc, l.log_index desc limit $6`,
      [bytes(settings.router), topics, bytes(INBOX_OPENED_TOPIC), key, INBOXES_MAX, BACK_MAX],
    );
    // Anyone may put another coin into an inbox and call the router's mark: only the book's listed assets are shown as a holding.
    const known = new Set(await listed());
    return rows.flatMap((r) => {
      const e = decodeBack(hex(r.topic0), hex(r.data));
      if (!e) return [];
      const opened = e.kind === "opened";
      if (!opened && !known.has(word(hex(r.topic2)))) return [];
      return [pick({
        kind: e.kind, inbox: word(hex(r.topic1)), erc20: opened ? null : word(hex(r.topic2)), party: opened ? e.party : null, refundNetwork: opened ? e.refundNetwork : null, refundAddress: opened ? word(hex(r.topic3)) : null,
        balance: e.kind === "held" ? e.balance.toString() : null, refundAt: e.kind === "held" ? iso(Number(e.refundAt)) : null,
        amount: e.kind === "forwarded" || e.kind === "refunded" ? e.amount.toString() : null, fee: e.kind === "forwarded" || e.kind === "refunded" ? e.fee.toString() : null, depositCount: e.kind === "refunded" ? e.depositCount : null,
        txHash: hex(r.hash), block: Number(r.block_number), at: iso(Number(r.ts)),
      }, F.routeBack)];
    });
  }

  async function moves(q: URLSearchParams): Promise<Answer> {
    const { by, value } = asked(q);
    const out = by !== "ostia";
    const column = by === "party" ? "l.topic2" : "l.topic3";
    const { rows } = out ? await pool.query(
      `select l.block_number, l.topic1, l.topic3, l.data, t.hash, extract(epoch from b.timestamp)::bigint as ts
       from logs l join transactions t on t.block_number = l.block_number and t.tx_index = l.tx_index join blocks b on b.number = l.block_number
       where l.address = $1 and l.topic0 = $2 and ${column} = $3 order by l.block_number desc, l.log_index desc limit $4`,
      [bytes(settings.router), bytes(ROUTED_OUT_TOPIC), by === "party" ? bytes(partyHash(value)) : Buffer.concat([Buffer.alloc(12), bytes(value)]), MOVES_MAX],
    ) : { rows: [] };
    const taken = rows.flatMap((r) => {
      const e = decodeRoutedOut(hex(r.data));
      if (!e || e.destNetwork !== ETHEREUM) return [];
      return [pick({
        id: hex(r.topic1), state: "taken", party: e.party, destAddress: word(hex(r.topic3)), erc20: e.erc20, amount: (e.send + e.fee).toString(), send: e.send.toString(), fee: e.fee.toString(), depositCount: e.depositCount,
        txHash: hex(r.hash), block: Number(r.block_number), at: iso(Number(r.ts)), maxFee: null, settleBefore: null,
      }, F.routeMove)];
    });
    const open = out ? await requests() : null;
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
    const back = settings.in ? await backEvents(by, value) : undefined;
    // Whether each account in those events takes withdrawals now: the held coin's reason ("no longer takes transfers") and whether the page may offer "Send on to Canton".
    const pay = back ? await payout() : null;
    const parties = back ? [...new Set([...back.flatMap((e) => (e.party === null ? [] : [e.party])), ...(by === "party" ? [value] : [])])] : [];
    const accepts = pay ? parties.map((party) => pick({ party, accepts: pay.acceptances.has(party) }, F.routeAccepts)) : null;
    return ok(pick({ moves: [...requested, ...taken], requestsRead: open !== null || !out, ...(back ? { back, accepts } : {}) }, F.routeMoves));
  }

  /** The opening of an inbox by a final block: its transaction and time, when a final `InboxOpened` names this inbox with this party and this way back. */
  async function openedFinal(inbox: string, party: string, refundAddress: string): Promise<{ txHash: string; at: string } | null> {
    const { rows } = await pool.query(
      `select l.data, t.hash, extract(epoch from b.timestamp)::bigint as ts
       from logs l join transactions t on t.block_number = l.block_number and t.tx_index = l.tx_index join blocks b on b.number = l.block_number
       where l.address = $1 and l.topic0 = $2 and l.topic1 = $3 and l.topic2 = $4 and l.topic3 = $5 order by l.block_number, l.log_index limit 5`,
      [bytes(settings.router), bytes(INBOX_OPENED_TOPIC), Buffer.concat([Buffer.alloc(12), bytes(inbox)]), bytes(partyHash(party)), Buffer.concat([Buffer.alloc(12), bytes(refundAddress)])],
    );
    for (const r of rows) {
      const e = decodeBack(INBOX_OPENED_TOPIC, hex(r.data));
      if (e?.kind === "opened" && e.party === party && e.refundNetwork === BACK_NETWORK) return { txHash: hex(r.hash), at: iso(Number(r.ts)) };
    }
    return null;
  }

  /** The party and the way back of an address request, checked: the party id's shape, the refund network (Ethereum Sepolia only) and a 0x address. */
  function addressArgs(party: unknown, refundNetwork: unknown, refundAddress: unknown): { party: string; refundAddress: string } {
    if (typeof party !== "string" || !PARTY.test(party)) throw new BadRequest("party is a Canton party id.");
    if (String(refundNetwork) !== String(BACK_NETWORK)) throw new BadRequest(`refundNetwork is ${BACK_NETWORK} (Ethereum Sepolia).`);
    if (typeof refundAddress !== "string" || !EVM.test(refundAddress)) throw new BadRequest("refundAddress is a 0x address of 40 hex digits.");
    return { party, refundAddress: refundAddress.toLowerCase() };
  }

  /**
   * An account's Ostia address, as the router works it out (`inboxOf`), whether the account takes withdrawals, and whether a final block has opened the address with this party and this way back. While it is not
   * final, `openTx` is the transaction that opens it if one is in the newest blocks, so that the page shows its Sent, Proven and Final marks. The page works the address out itself too and shows it only when both agree.
   */
  async function address(q: URLSearchParams): Promise<Answer> {
    const { party, refundAddress } = addressArgs(q.get("party"), q.get("refundNetwork"), q.get("refundAddress"));
    const at = await head();
    const inbox = await read(settings.router, inboxOfCall(party, BACK_NETWORK, refundAddress), at, readInbox);
    const [pay, final] = await Promise.all([payout(), openedFinal(inbox, party, refundAddress)]);
    let openTx: string | null = final?.txHash ?? null;
    if (!final && reth.logsSince) {
      const topic = "0x" + "00".repeat(12) + inbox.slice(2);
      openTx = await reth.logsSince(settings.router, [INBOX_OPENED_TOPIC, topic], Math.max(0, at - OPENING_BLOCKS)).then((l) => l.at(-1)?.txHash ?? null, () => null);
    }
    return ok(pick({ party, refundNetwork: BACK_NETWORK, refundAddress, inbox, accepts: pay ? pay.acceptances.has(party) : null, opened: final !== null, openedAt: final?.at ?? null, openTx }, F.routeAddress));
  }

  /** Asks the intake to open an account's Ostia address. Only the intake's status is read: the page learns the address from Ostia, never from this answer. A client may ask a few times, then once in 20 seconds. */
  async function intake(body: string | undefined, ip: string | undefined): Promise<Answer> {
    let sent: Record<string, unknown>;
    try { sent = JSON.parse(body ?? "") as Record<string, unknown>; if (typeof sent !== "object" || sent === null || Array.isArray(sent)) throw new Error(); } catch { return fail(400, "Send JSON: party, refundNetwork and refundAddress."); }
    let args: { party: string; refundAddress: string };
    try { args = addressArgs(sent.party, sent.refundNetwork, sent.refundAddress); } catch (e) { return fail(400, (e as Error).message); }
    const wait = intakeLimiter.take(ip ?? "unknown");
    if (wait !== null) return fail(429, REST_REFUSED(wait), retryAfter(wait));
    const pay = await payout();
    if (pay && !pay.acceptances.has(args.party)) return fail(400, NOT_ACCEPTED);
    try {
      const res = await fetcher(settings.in!.intake, {
        method: "POST", headers: { "content-type": "application/json", "user-agent": "Rome Protocol rome@romeprotocol.com" },
        body: JSON.stringify({ party: args.party, refundNetwork: BACK_NETWORK, refundAddress: args.refundAddress }), signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`the intake answered ${res.status}`);
      return ok(pick({ asked: true }, F.routeAsked));
    } catch (e) {
      console.error(`canton route: the intake cannot be asked: ${(e as Error).message}`);
      return fail(503, INTAKE_DOWN);
    }
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
    const run = parts[2] === "moves" ? () => moves(q) : parts[2] === "address" && settings.in ? () => address(q) : null;
    if (!run) return undefined;
    return async () => {
      const wait = limiter.take(ip ?? "unknown");
      return wait === null ? guarded(run) : fail(429, REST_REFUSED(wait), retryAfter(wait));
    };
  };
  return { routes, intake: (body: string | undefined, ip: string | undefined): Promise<Answer> => (settings.in ? guarded(() => intake(body, ip)) : Promise.resolve(fail(404, ROUTE_OFF))) };
}

class RouteUnreadable extends Error {}

export type CantonRoute = ReturnType<typeof createCantonRoute>;

/** The routes of the Canton route, or, with none (the switch is off), the same paths answering that it is off: `{on: false}` for the setup and 404 for the moves. */
export function cantonRouteRoutes(route: Pick<CantonRoute, "routes"> | null): CantonRoute["routes"] {
  if (route) return route.routes;
  return (parts) => {
    if (parts.length !== 3 || parts[0] !== "api" || parts[1] !== "canton-route") return undefined;
    if (parts[2] === "setup") return async () => ok(pick({ on: false }, F.routeOff));
    if (parts[2] === "moves" || parts[2] === "address") return async () => fail(404, ROUTE_OFF);
    return undefined;
  };
}
