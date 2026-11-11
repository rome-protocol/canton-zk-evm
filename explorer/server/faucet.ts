import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError } from "./config.ts";
import { alwaysLeader, type Leader } from "./leader.ts";
import { createSignIn, type BuilderInfo, type BuilderOptions, type BuilderRedirect, type SignIn } from "./faucet-builder.ts";
import { fileFaucetStore, type ClaimRefusal, type FaucetState, type FaucetStore, type Refused } from "./faucet-store.ts";
import { RethError, type Reth } from "./reth.ts";
import type { Tracker } from "./tracker.ts";

/** A plain transfer of the native coin costs exactly this much gas. */
export const FAUCET_GAS = 21000n;

const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface FaucetOptions {
  /** The faucet's private key, or null to turn the faucet off. */
  key: Hex | null;
  chainId: number;
  amountWei: bigint;
  perAddressSeconds: number;
  /** One request per client address in this many seconds. */
  perIpSeconds: number;
  /** At most this many requests from one IPv6 /48 in the same `perIpSeconds`, on top of the one per /64 (a /48 holds 65,536 /64s). Counted in memory by each instance, so a restart empties it. Default 10. */
  perNetMax?: number;
  /** The most requests accepted in any hour, from everyone. */
  maxPerHour: number;
  /** The most transfers sent in one batch. */
  batch: number;
  /** The most requests waiting for a batch. */
  queueMax: number;
  /** Where the limits and the waiting requests are kept: a file, or null for memory only. */
  stateFile: string | null;
  /** Or a store of its own, such as the database. It wins over `stateFile`. */
  store?: FaucetStore | null;
  /** Says whether this instance runs the worker. With one instance, always. With several, the one that holds the lock. */
  leader?: Leader;
  /** Turns a client's address into the keyed hash that is kept in its place. Without one the address is kept as it is, which only a file store does. */
  clientKeyHash?: (clientKey: string) => string;
  /** The builder grant (a GitHub account gets a larger amount), or null/absent for none. */
  builder?: BuilderOptions | null;
  /** The human check, or null for none. */
  captcha: { secret: string; verifyUrl: string; scriptUrl: string; siteKey: string; widgetClass: string } | null;
  reth: Pick<Reth, "balance" | "nonce" | "gasPrice" | "priorityFee" | "sendRaw" | "transaction"> & Partial<Pick<Reth, "block" | "rpc" | "balanceAt">>;
  /** Takes each sent transfer, and says where it is. Without one, a ticket never gets past "sent". */
  tracker?: Pick<Tracker, "track" | "state"> & Partial<Pick<Tracker, "admit">>;
  /** How often the worker looks at the queue. */
  tickMs?: number;
  /** How long the refusal counts are held in memory before they are written (milliseconds). Default 5000. */
  refusalFlushMs?: number;
  /** For the human check's call. A test gives its own. */
  fetch?: typeof fetch;
  /** The time in milliseconds. A test sets its own. */
  now?: () => number;
}

export interface FaucetAnswer { status: number; body: unknown; headers?: Record<string, string> }

/** What the faucet page shows about the faucet itself. */
export interface FaucetInfo {
  on: boolean; address: string | null; balance: string | null;
  /** The final head the balance was read at; null when reth cannot name one, and then the balance is the newest block's, which may not be final. */
  balanceBlock: number | null;
  amount: string; perAddressSeconds: number; perIpSeconds: number; maxPerHour: number;
  /** How many requests are waiting for a batch. */
  queue: number;
  /** The most payouts that go in one block (the faucet's batch size). */
  batch: number;
  /** Payouts sent since the start of the UTC day, or null when the faucet's store cannot count them (a file keeps no send times). */
  sentToday: number | null;
  /** Of those, how many are final (null as for `sentToday`). */
  finalToday: number | null;
  /** Payouts sent and now in a block being proven, whatever day they went out: not the ones still waiting in reth's pool, and not tickets the faucet gave up on (null as for `sentToday`). */
  beingProven: number | null;
  captcha: { siteKey: string; scriptUrl: string; widgetClass: string } | null;
  /** The builder grant: on or off, and its amount (wei), period and limits. No secret is in it. */
  builder: BuilderInfo;
}

/** Who is asking, and the proof that it is a person, when the faucet wants one. */
export interface FaucetCaller { ip?: string; captcha?: unknown }

/** queued: waiting for a batch. sent: reth has the transfer, and it is not final. final: final on Canton. failed: it did not happen, and the address may ask again. */
export type TicketStatus = "queued" | "sent" | "final" | "failed";

export interface TicketView {
  ticket: string;
  status: TicketStatus;
  /** Place in line, 1 first, while queued. */
  position: number | null;
  to: string;
  amount: string;
  hash: string | null;
  /** The tracker's word for a sent transfer: pending or proving. */
  state: string | null;
  block: number | null;
  reason: string | null;
}

export interface Faucet {
  readonly on: boolean;
  readonly address: string | null;
  info(): Promise<FaucetInfo>;
  /** Takes a request for coin, if the limits allow, and answers with a ticket. Never throws: every outcome is an answer. */
  request(address: unknown, caller?: FaucetCaller): Promise<FaucetAnswer>;
  /** Where a person who wants a builder grant for this address is sent first: GitHub's sign-in, or the Faucet page with a plain result. Null when the builder grant is off. */
  builderStart(address: unknown, ip?: string): BuilderRedirect | null;
  /** Where GitHub's return is answered: the Faucet page, with the result. `cookie` is the request's Cookie header, which must be the one the sign-in started with. Null when the builder grant is off. Never throws. */
  builderCallback(query: URLSearchParams, ip?: string, cookie?: string): Promise<BuilderRedirect | null>;
  /** Where a ticket is. Null when there is no such ticket. */
  ticket(id: string): TicketView | null;
  /** One pass of the worker: sends the next batch if the last one has left the pool. Resolves when the pass is over. */
  process(): Promise<void>;
  /** Starts the worker on a timer, and wakes it at each request. */
  start(): void;
  stop(): void;
  /** Resolves when everything changed so far is on disk. */
  flush(): Promise<void>;
  /** Resolves when the state has been read from where it is kept. A store that is not a file takes a moment. */
  ready(): Promise<void>;
  /** Like `ticket`, and when this instance does not know the ticket, asks the store: another instance may have taken the request. */
  find(id: string): Promise<TicketView | null>;
  /** Stops, writes what changed, and gives up the lead, so another instance takes the worker at once. */
  close(): Promise<void>;
  /** How many addresses are waiting out their day. */
  served(): number;
  /** How many requests wait for a batch. */
  queued(): number;
  /** When the oldest request still waiting for a batch was made (milliseconds since the epoch), or null when none waits. A queue that is long but moving has a young oldest request. */
  oldestQueued(): number | null;
  /** True while this instance runs the worker (it holds the faucet's lock, or there is no database and so one instance). */
  isLeading(): boolean;
}

/**
 * Reads the faucet's key from the file `FAUCET_KEY_FILE` names: 64 hex digits, with or without 0x. A missing or wrong file stops
 * the server at start. The message names the setting and never quotes the file.
 */
export function loadFaucetKey(file: string | null, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Hex | null {
  if (file === null) return null;
  let text: string;
  try {
    text = read(file);
  } catch {
    throw new ConfigError(`FAUCET_KEY_FILE ${file} cannot be read`);
  }
  const key = text.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(key)) throw new ConfigError(`FAUCET_KEY_FILE ${file} must hold 64 hex digits, with or without 0x`);
  return `0x${key}`;
}

/** What was last read of the chain: the faucet's balance, and the price of gas. */
interface View { at: number; balance: bigint; gasPrice: bigint }

export interface Ticket {
  id: string; to: string; ip: string | null; at: number;
  status: TicketStatus; hash: string | null; block: number | null; reason: string | null; tries: number;
  /**
   * The signed transfer and its nonce, kept from the moment it is signed until the tracker has it. They are written to disk before the batch is
   * sent, so a stop or a crash in the middle of a batch never leaves a transfer in reth that no file knows of.
   */
  nonce?: number | null; raw?: string | null;
  /** The nonce the transfer was sent with, kept after it is handed over, so a late payout can be told from one that another transaction took the place of. */
  sentNonce?: number | null;
  /** True once the tracker stopped following the transfer: the faucet then follows it by hash itself, until it is final or its nonce is used. */
  watch?: boolean;
  /** The batch it was signed in, once the store has numbered it. */
  batch?: number | null;
  /** A builder grant: the keyed hash of the GitHub account it was given to (never the account itself), and its amount in wei as a decimal string. A plain request has neither. */
  account?: string | null; amount?: string | null;
  /** The IPv6 /48 the request came from (hashed like `ip`), for the per-network count. A file keeps it with the ticket; the database does not, so after a restart on the database the count starts empty. */
  net?: string | null;
  /** True from the moment the request is in memory until the store has checked the limits against every instance's requests and written it. The worker leaves it alone. */
  claiming?: boolean;
}

export const TICKETS_MAX = 10000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** How long the faucet follows, by hash, a transfer the tracker stopped following. After this the ticket says so and is left. */
const WATCH_MS = 48 * HOUR;
/** The most late transfers looked at in one pass, oldest look first, so a long list costs reth a few calls a second at most. */
const WATCH_PER_PASS = 20;
/** About one block: how long a caller turned away because the line is full is asked to wait, for each batch ahead. */
const BLOCK_SECONDS = 10;
/** Failed human checks one client may have in a window, before it is turned away without a check, and how long that window is. */
const CHECKS_FAILED_MAX = 5;
const CHECKS_WINDOW = 60_000;
/** The tracker's per-sender limit is for wallets. The faucet sends its own batches, and asks the tracker only whether it has room, as for a sender with nothing waiting. */
const NO_SENDER = "0x0000000000000000000000000000000000000000";
const KNOWN = /already known|known transaction|already imported|already in the pool/i;

/** A refusal also says which limit was hit, so a page can word it without reading the message. */
type Reason = "address" | "ip" | "net" | "hour" | "queue" | "captcha" | "checks" | "empty" | "account" | "builder-address" | "day";
const answer = (status: number, error: string, headers?: Record<string, string>, reason?: Reason): FaucetAnswer => ({
  status, body: { error, ...(reason ? { reason } : {}) }, ...(headers ? { headers } : {}),
});
const seconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));
const days = (s: number) => (s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? "" : "s"}` : period(s));
const period = (s: number) => (s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? "" : "s"}` : s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`);

/**
 * What counts as one client. An IPv6 host has a /64 of its own, so its limit is for the whole /64. An IPv4 address written as IPv6 is that IPv4
 * address. Anything that does not read as an address is kept as it is.
 */
export function clientKey(ip: string | undefined): string | undefined {
  if (ip === undefined) return undefined;
  let a = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!a.includes(":")) return a;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const [b0, b1, b2, b3] = [dotted[2]!, dotted[3]!, dotted[4]!, dotted[5]!].map(Number) as [number, number, number, number];
    if ([b0, b1, b2, b3].some((b) => b > 255)) return a;
    a = `${dotted[1]}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return a;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return a;
  const groups = [...head, ...(halves.length === 2 ? Array(8 - head.length - tail.length).fill("0") : []), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
  const n = groups.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff) return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  return `${n.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * The network a client belongs to when a limit also counts by network: an IPv6 address as its /48. An IPv4 address, an IPv4 address written as IPv6 and anything that does not read
 * as an address have none (the per-client limit already counts them one by one).
 */
export function clientNet(ip: string | undefined): string | undefined {
  const k = clientKey(ip);
  if (k === undefined || !k.endsWith("::/64")) return undefined;
  return `${k.slice(0, -"::/64".length).split(":").slice(0, 3).join(":")}::/48`;
}

export function createFaucet(o: FaucetOptions): Faucet {
  const now = o.now ?? Date.now;
  const account = o.key ? privateKeyToAccount(o.key) : null;
  const address = account ? account.address.toLowerCase() : null;
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const addressMs = o.perAddressSeconds * 1000, ipMs = o.perIpSeconds * 1000;
  // Each map is in the order of time: a key is set only when it is not there, so the oldest is always the first.
  const addresses = new Map<string, number>(), ips = new Map<string, number>();
  /** The times of the requests of each IPv6 /48 inside the window of the per-client limit, oldest first. In memory only (see `perNetMax`). */
  const nets = new Map<string, number[]>();
  const netMax = o.perNetMax ?? 10;
  let hourly: number[] = [];
  // The builder grant's limits, in the order of time like the maps above: one grant per GitHub account and one per address in a period, and a count for the day.
  const builder = o.builder ?? null;
  const builderMs = (builder?.perAccountSeconds ?? 0) * 1000;
  const builderAccounts = new Map<string, number>(), builderAddresses = new Map<string, number>();
  let builderDaily: number[] = [];
  const tickets = new Map<string, Ticket>();
  const queue: Ticket[] = [];
  /** Tickets whose transfer is in reth and not yet settled. */
  const open = new Set<Ticket>();
  /** Tickets whose transfer the tracker stopped following while reth may still mine it. Kept apart from `open`, which counts the transfers the tracker follows. */
  const watching = new Set<Ticket>();
  let running: Promise<void> | null = null, timer: ReturnType<typeof setInterval> | undefined, started = false;
  let view: View | null = null, viewing: Promise<View | null> | null = null;
  let verifying = 0;
  /** Clients with a human check under way, so one client has one at a time. */
  const checking = new Set<string>();
  /** Failed human checks for each client in its window, oldest window first. */
  const checksFailed = new Map<string, { n: number; since: number }>();
  /** Set by stop() while a batch is going out: the batch ends after the send in hand. */
  let halted = false;
  let writing: Promise<boolean> = Promise.resolve(true), dirty = false, saving = false;

  // --- what is kept across a restart, and, with a database, what the other instances keep
  const store: FaucetStore | null = o.store ?? (o.stateFile ? fileFaucetStore(o.stateFile) : null);
  const leader = o.leader ?? alwaysLeader;
  /** True when this instance runs the worker. A file has one instance, which leads. */
  let leading = !o.store;
  /** Set when this instance takes the lead. Nothing is signed until reth's pending and latest counts for the faucet agree, so a batch the old leader sent is never signed over. */
  let settling = false;
  let loaded: Promise<void> = Promise.resolve();
  const hashed = (k: string | undefined): string | undefined => (k === undefined || !o.clientKeyHash ? k : o.clientKeyHash(k));

  function rebuildSets(): void {
    open.clear(); watching.clear();
    for (const t of tickets.values()) if (t.status === "sent") (t.watch ? watching : open).add(t);
  }

  /** A transfer signed before the last stop may or may not have reached reth. Its ticket is sent, never queued again: the tracker holds the signed
   * bytes, sends them if reth does not have them, and says what became of them. Signing the request again would pay the address twice. */
  function recover(): void {
    for (const t of [...queue]) {
      if (!t.raw || !t.hash) { t.raw = null; t.nonce = null; continue; }
      queue.splice(queue.indexOf(t), 1);
      t.status = "sent"; t.sentNonce = t.nonce ?? null; open.add(t);
    }
    for (const t of open) {
      if (!t.raw || !t.hash) continue;
      if (o.tracker && !o.tracker.state(t.hash)) o.tracker.track(t.raw, t.hash, address!, t.nonce ?? 0, "faucet");
      t.raw = null; t.nonce = null;
    }
    if (store?.changes) void save();
  }

  function adopt(s: FaucetState): void {
    for (const [a, t] of s.addresses) addresses.set(a, t);
    for (const [a, t] of s.ips) ips.set(a, t);
    hourly = s.hourly;
    for (const t of s.tickets) {
      tickets.set(t.id, t);
      if (t.status === "queued") queue.push(t);
      else if (t.status === "sent") (t.watch ? watching : open).add(t);
    }
    // The per-network count is what the tickets that kept their network say, inside the window.
    for (const t of [...s.tickets].filter((x) => x.net && x.status !== "failed" && x.at + ipMs > now()).sort((a, b) => a.at - b.at)) nets.set(t.net!, [...(nets.get(t.net!) ?? []), t.at]);
    // The builder limits are what the grants say, inside their windows. A grant that came to nothing does not count.
    if (builder) {
      const t0 = now();
      for (const t of [...s.tickets].filter((x) => x.account && x.status !== "failed").sort((a, b) => a.at - b.at)) {
        if (t.at + builderMs > t0) { builderAccounts.set(t.account!, t.at); builderAddresses.set(t.to, t.at); }
        if (t.at + DAY > t0) builderDaily.push(t.at);
      }
    }
  }

  function load(): void {
    if (!store) return;
    const got = store.load({ now: now(), addressMs, ipMs, max: TICKETS_MAX });
    if ("tickets" in got) {
      adopt(got);
      recover();
      return;
    }
    loaded = got.then(async (s) => {
      adopt(s);
      leading = await leader.isLeader();
      if (leading) recover();
    }, (e: Error) => { console.error(`faucet: cannot read its state: ${e.message}`); });
  }

  /** Writes the state through the store. Writes that pile up become one. Says whether the last write went through: the batch about to be sent waits for that. */
  function save(): Promise<boolean> {
    if (!store) return Promise.resolve(true);
    dirty = true;
    if (saving) return writing;
    saving = true;
    writing = (async () => {
      let ok = true;
      try {
        while (dirty) {
          dirty = false;
          ok = await store.save([...tickets.values()], () => ({ addresses: [...addresses], ips: [...ips], hourly }));
        }
      } catch (e) {
        console.error(`faucet: cannot write its state: ${(e as Error).message}`);
        ok = false;
      } finally {
        saving = false;
      }
      return ok;
    })();
    return writing;
  }

  /** What the other instances wrote. The leader's memory is the record, so it takes only the requests it did not know. A follower takes every change, to show the page. */
  async function catchUp(): Promise<void> {
    if (!store?.changes) return;
    await save(); // what this instance changed goes first, so reading back cannot undo it
    let rows;
    try {
      rows = await store.changes();
    } catch (e) {
      console.error(`faucet: cannot read the database: ${(e as Error).message}`);
      return;
    }
    for (const r of rows) {
      const mine = tickets.get(r.id);
      if (!mine) {
        tickets.set(r.id, r);
        const next = queue.findIndex((q) => q.at > r.at);
        if (r.status === "queued") queue.splice(next < 0 ? queue.length : next, 0, r);
        continue;
      }
      if (leading || mine.claiming) continue;
      const was = mine.status;
      Object.assign(mine, r);
      if (was === "queued" && r.status !== "queued") queue.splice(queue.indexOf(mine), 1);
      if (r.status === "failed" && was !== "failed") refund(mine); // the instance that failed it gave the limits back; the others do the same
    }
    // A queued request the leader does not hold is taken whatever the store has seen of it, so a payout is never lost to a filter.
    if (leading && store.queued) {
      let queuedRows: Ticket[] = [];
      try { queuedRows = await store.queued(); } catch (e) { console.error(`faucet: cannot read the database: ${(e as Error).message}`); }
      for (const r of queuedRows) {
        if (tickets.has(r.id)) continue;
        tickets.set(r.id, r);
        const next = queue.findIndex((q) => q.at > r.at);
        queue.splice(next < 0 ? queue.length : next, 0, r);
      }
    }
    trim();
  }

  /**
   * On taking the lead: every queued and sent row is read in full, and the database copy replaces what this instance holds for them. The windowed read of
   * catchUp() can miss a row for good (one that committed late, with an older time than rows already read), and a stale "queued" copy of a row the old leader
   * signed would be signed again.
   */
  async function readUnsettled(): Promise<void> {
    if (!store?.unsettled) return;
    let rows: Ticket[];
    try {
      const known = [...tickets.values()].filter((t) => !t.claiming && (t.status === "queued" || t.status === "sent")).map((t) => t.id);
      rows = await store.unsettled(known);
    } catch (e) {
      console.error(`faucet: cannot read the database: ${(e as Error).message}`);
      return;
    }
    for (const r of rows) {
      const mine = tickets.get(r.id);
      if (!mine) { tickets.set(r.id, r); continue; }
      if (mine.claiming) continue;
      const was = mine.status;
      Object.assign(mine, r);
      if (r.status === "failed" && was !== "failed") refund(mine);
    }
    // The queue is what the tickets say it is, oldest first.
    const next = [...tickets.values()].filter((t) => t.status === "queued").sort((a, b) => a.at - b.at);
    queue.splice(0, queue.length, ...next);
  }

  // --- the limits
  function forget(t: number): void {
    for (const [m, ms] of [[addresses, addressMs], [ips, ipMs], [builderAccounts, builderMs], [builderAddresses, builderMs]] as const) for (const [k, at] of m) { if (at + ms > t) break; m.delete(k); }
    for (const [k, times] of nets) {
      let n = 0;
      while (n < times.length && times[n]! + ipMs <= t) n++;
      if (n === times.length) nets.delete(k);
      else if (n) times.splice(0, n);
    }
    let i = 0;
    while (i < hourly.length && hourly[i]! + HOUR <= t) i++;
    if (i) hourly = hourly.slice(i);
    let j = 0;
    while (j < builderDaily.length && builderDaily[j]! + DAY <= t) j++;
    if (j) builderDaily = builderDaily.slice(j);
  }

  /** The refusal for a limit, with the wait it asks for. */
  function turnedAway(limit: ClaimRefusal | "net", waitMs: number): FaucetAnswer {
    const header = { "Retry-After": seconds(waitMs) };
    if (limit === "account") return answer(429, `This GitHub account was given a builder grant in the last ${days(o.builder?.perAccountSeconds ?? 0)}. Try again later.`, header, "account");
    if (limit === "builder-address") return answer(429, `This address was given a builder grant in the last ${days(o.builder?.perAccountSeconds ?? 0)}. Try again later.`, header, "builder-address");
    if (limit === "day") return answer(429, `The builder grants for today are all given out (${o.builder?.maxPerDay ?? 0}). Try again tomorrow.`, header, "day");
    if (limit === "address") return answer(429, `This address was given coins in the last ${period(o.perAddressSeconds)}. Try again later.`, { "Retry-After": seconds(waitMs) }, "address");
    if (limit === "ip") return answer(429, `This connection asked for coins in the last ${period(o.perIpSeconds)}. Try again later.`, { "Retry-After": seconds(waitMs) }, "ip");
    if (limit === "net") return answer(429, `This network has asked for ${netMax} requests' worth of coins in the last ${period(o.perIpSeconds)}, which is the most it may. Try again later, or from another network.`, { "Retry-After": seconds(waitMs) }, "net");
    return answer(429, `The faucet has given out all it gives in an hour (${o.maxPerHour} requests). Try again later.`, { "Retry-After": seconds(waitMs) }, "hour");
  }

  /** The refusal for a caller, or null when the limits let it through. */
  function limited(to: string, ip: string | undefined, t: number, account?: string, net?: string): FaucetAnswer | null {
    forget(t);
    if (account !== undefined) {
      const c = builderAccounts.get(account);
      if (c !== undefined) return turnedAway("account", c + builderMs - t);
      const b = builderAddresses.get(to);
      if (b !== undefined) return turnedAway("builder-address", b + builderMs - t);
    } else {
      const a = addresses.get(to);
      if (a !== undefined) return turnedAway("address", a + addressMs - t);
    }
    const i = ip === undefined ? undefined : ips.get(ip);
    if (i !== undefined) return turnedAway("ip", i + ipMs - t);
    const n = net === undefined ? undefined : nets.get(net);
    if (n !== undefined && n.length >= netMax) return turnedAway("net", n[0]! + ipMs - t);
    if (hourly.length >= o.maxPerHour) return turnedAway("hour", hourly[0]! + HOUR - t);
    if (account !== undefined && builderDaily.length >= (builder?.maxPerDay ?? 0)) return turnedAway("day", builderDaily[0]! + DAY - t);
    if (queue.length >= o.queueMax) {
      return answer(503, "The faucet's line is full, so this request was turned away, not lost: nothing was taken from you. Try again in a little while.", { "Retry-After": String(Math.max(5, Math.ceil(queue.length / o.batch) * BLOCK_SECONDS)) }, "queue");
    }
    return null;
  }

  /** Takes a request back as if it had never been made. */
  function unqueue(t: Ticket): void {
    const i = queue.indexOf(t);
    if (i >= 0) queue.splice(i, 1);
    tickets.delete(t.id);
    refund(t);
  }

  /** Takes back what a request used, when it came to nothing. */
  function refund(t: Ticket): void {
    if (t.account) {
      if (builderAccounts.get(t.account) === t.at) builderAccounts.delete(t.account);
      if (builderAddresses.get(t.to) === t.at) builderAddresses.delete(t.to);
      const d = builderDaily.indexOf(t.at);
      if (d >= 0) builderDaily.splice(d, 1);
    } else if (addresses.get(t.to) === t.at) addresses.delete(t.to);
    if (t.ip !== null && ips.get(t.ip) === t.at) ips.delete(t.ip);
    const times = t.net ? nets.get(t.net) : undefined;
    if (t.net && times) { const j = times.indexOf(t.at); if (j >= 0) times.splice(j, 1); if (!times.length) nets.delete(t.net); }
    const i = hourly.indexOf(t.at);
    if (i >= 0) hourly.splice(i, 1);
  }

  const fail = (t: Ticket, reason: string): void => {
    t.status = "failed"; t.reason = reason; open.delete(t); watching.delete(t); t.watch = false;
    refund(t);
    save();
  };

  // --- the chain
  /** The faucet's balance and the gas price, read at most once in a few seconds, however many ask. */
  function chain(): Promise<View | null> {
    if (view && now() - view.at < 5000) return Promise.resolve(view);
    return (viewing ??= Promise.all([o.reth.balance(address!), o.reth.gasPrice()]).then(
      ([balance, gasPrice]) => (view = { at: now(), balance, gasPrice }),
      () => view, // reth cannot be reached: the last reading is all there is
    ).finally(() => { viewing = null; }));
  }
  const amountOf = (t: Pick<Ticket, "amount">): bigint => (t.amount ? BigInt(t.amount) : o.amountWei);
  const cost = (gasPrice: bigint, amount: bigint = o.amountWei) => amount + FAUCET_GAS * gasPrice * 2n;

  /** The tracker no longer follows this transfer, and reth may still mine it: the faucet follows it by hash from here on. */
  function late(t: Ticket, nonce?: number): void {
    open.delete(t);
    if (t.status !== "sent") return;
    if (t.sentNonce == null && nonce !== undefined) t.sentNonce = nonce;
    if (!t.watch) { t.watch = true; save(); }
    watching.add(t);
  }

  /** Brings a sent ticket up to date from the tracker. Final only when the tracker says the transfer is final. */
  function refresh(t: Ticket): void {
    if (t.status !== "sent" || !t.hash || !o.tracker || !leading) return;
    const s = o.tracker.state(t.hash);
    if (!s) return late(t);
    if (s.state === "final") { t.status = "final"; t.block = s.block; t.watch = false; open.delete(t); watching.delete(t); save(); }
    else if (s.state === "replaced") fail(t, s.reason ?? "The transfer did not land on the chain.");
    // "dropped" is not a verdict: the tracker also drops what it has no room to follow, and that may still land. pass() asks reth.
  }

  /** For each transfer the tracker stopped following: failed if reth does not have it, and left as it is, with its turn used, if reth does or cannot say. */
  async function settleDropped(): Promise<void> {
    for (const t of [...open]) {
      const s = t.status === "sent" && t.hash ? o.tracker?.state(t.hash) : undefined;
      if (s?.state !== "dropped") continue;
      let found: unknown;
      try {
        found = await o.reth.transaction(t.hash!);
      } catch {
        continue; // reth cannot say: asked again at the next pass
      }
      if (found) late(t, s.nonce);
      else fail(t, s.reason ?? "The transfer did not land on the chain.");
    }
  }

  /**
   * Follows the transfers the tracker stopped following, by hash and cheaply: one look at the transaction, and, when it is in no block, one at
   * the sender's count as of the finalized block. Final when it is in a finalized block; failed when that count has passed its nonce while it is
   * in no finalized block, which means another transaction took the nonce. After WATCH_MS the ticket says it is no longer followed.
   */
  async function watchLate(): Promise<void> {
    if (!watching.size) return;
    const t0 = now();
    const look: Ticket[] = [];
    for (const t of [...watching]) {
      if (t.status !== "sent" || !t.hash) { watching.delete(t); continue; }
      if (t0 - t.at >= WATCH_MS) {
        watching.delete(t); t.watch = false;
        t.reason = "The faucet stopped following this transfer after two days without it being final. Look up the hash on the chain.";
        save();
        continue;
      }
      if (look.length < WATCH_PER_PASS) look.push(t);
    }
    if (!look.length || !o.reth.block || !o.reth.rpc) return;
    let finalized: number;
    try {
      finalized = (await o.reth.block("finalized"))?.number ?? 0;
    } catch {
      return; // reth cannot say: asked again at the next pass
    }
    for (const t of look) {
      // Looked at in turn: this one goes behind the rest.
      watching.delete(t); watching.add(t);
      try {
        const found = await o.reth.transaction(t.hash!);
        if (found && found.blockNumber !== null && found.blockNumber <= finalized) {
          t.status = "final"; t.block = found.blockNumber; t.watch = false; t.reason = null; watching.delete(t); save();
          continue;
        }
        if (t.sentNonce == null) continue;
        const used = Number(BigInt(await o.reth.rpc("eth_getTransactionCount", [address, "0x" + finalized.toString(16)]) as string));
        if (used > t.sentNonce) fail(t, "Another transaction took this transfer's place on the chain, so it did not happen.");
      } catch {
        continue; // reth cannot say: asked again at the next pass
      }
    }
  }

  function trim(): void {
    for (const [id, t] of tickets) {
      if (tickets.size <= TICKETS_MAX) break;
      if (t.status !== "queued" && !open.has(t) && !watching.has(t)) tickets.delete(id);
    }
  }

  /** Sends the next batch, if there is one and the last one has left reth's pool. */
  let purged = 0;
  async function pass(): Promise<void> {
    if (!account) return;
    if (store?.changes) {
      await loaded;
      await catchUp();
      const was = leading;
      const lead = await leader.isLeader();
      // The old leader may have written between the read above and the lock just taken. Once the lock is held, the database is the record: it is read
      // again, as a follower reads it, before this instance rebuilds from it or signs anything.
      if (lead && !was) { await catchUp(); await readUnsettled(); }
      leading = lead;
      if (!leading) return;
      if (!was) { rebuildSets(); recover(); settling = true; }
      if (store.purge && now() - purged >= HOUR) {
        purged = now();
        await store.purge(now()).catch((e: Error) => console.error(`faucet: cannot clean the database: ${e.message}`));
      }
    }
    for (const t of open) refresh(t);
    await settleDropped();
    await watchLate();
    if (!queue.length) return;
    if (o.tracker) for (const t of open) if (t.hash && o.tracker.state(t.hash)?.state === "pending") return;
    let balance: bigint, nonce: number, gasPrice: bigint, tip: bigint;
    try {
      [balance, nonce, gasPrice, tip] = await Promise.all([o.reth.balance(address!), o.reth.nonce(address!, "pending"), o.reth.gasPrice(), o.reth.priorityFee()]);
    } catch (e) {
      console.error(`faucet: ${(e as Error).message}`);
      return;
    }
    view = { at: now(), balance, gasPrice };
    if (settling) {
      try {
        if (await o.reth.nonce(address!, "latest") !== nonce) return; // the old leader's transfers are still in reth's pool: asked again at the next pass
        settling = false;
      } catch (e) {
        console.error(`faucet: ${(e as Error).message}`);
        return;
      }
    }
    const maxFeePerGas = gasPrice * 2n;
    const batch = queue.filter((t) => !t.claiming).slice(0, o.batch);
    if (!batch.length) return;
    // As many from the front of the batch as the balance pays for, each at its own amount.
    let afford = 0, left = balance;
    for (const t of batch) { const c = cost(gasPrice, amountOf(t)); if (left < c) break; left -= c; afford++; }
    // The coins are gone: the requests that cannot be paid are told so, and may ask again once the faucet is filled.
    for (const t of batch.slice(afford)) { queue.splice(queue.indexOf(t), 1); fail(t, "The faucet ran out of coins before this request was sent."); }
    const going = batch.slice(0, afford);
    // The whole batch is signed first, and written to disk with its nonces and bytes before the first send. Whatever happens after that, every
    // transfer that may be in reth is in a file, and a restart hands it to the tracker instead of signing the request again.
    try {
      for (const [i, t] of going.entries()) {
        const raw = await account.signTransaction({
          type: "eip1559", chainId: o.chainId, nonce: nonce + i, to: t.to as Hex, value: amountOf(t), gas: FAUCET_GAS, maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas,
        });
        t.raw = raw; t.hash = keccak256(raw); t.nonce = nonce + i;
      }
    } catch {
      console.error("faucet: a payout failed before it was sent");
      for (const t of going) { t.raw = null; t.hash = null; t.nonce = null; }
      return;
    }
    const batchId = going.length ? await store?.batchSigned?.(nonce, going.length, now()).catch(() => null) : null;
    for (const t of going) t.batch = batchId ?? null;
    // The write must have gone through before the first send. If it did not, nothing is sent: a restart or a hand-over would find these requests queued
    // with no bytes, sign them again from reth's count, and pay them twice.
    if (!(await save())) {
      console.error("faucet: the batch could not be written, so it was not sent");
      for (const t of going) { t.raw = null; t.hash = null; t.nonce = null; t.batch = null; }
      return;
    }
    // Still the lead, just before the first send: a lock lost during the signing means another instance may be taking over.
    // The batch stays as it was written, queued with its bytes: whichever instance leads next hands it to the tracker as sent. Clearing it here and writing
    // that would undo what the new leader has already written about it, and the request would be signed and paid again.
    if (store?.changes && !(await leader.isLeader())) {
      leading = false;
      return;
    }
    for (const t of going) {
      if (halted) break;
      const raw = t.raw as Hex, hash = t.hash!;
      const noRoom = o.tracker?.admit?.(raw, hash, NO_SENDER);
      if (noRoom) { console.error(`faucet: the tracker has no room: ${noRoom}`); break; }
      let handOver = true, stopBatch = false;
      try {
        await o.reth.sendRaw(raw);
      } catch (e) {
        console.error(`faucet: ${(e as Error).message}`);
        if (e instanceof RethError && e.answered && !KNOWN.test(e.message)) {
          // Reth did not take it. The nonce is still free, and the next batch is signed again from reth's count, so there is no gap. A transfer refused again and again is given up.
          handOver = false; stopBatch = true;
          if (++t.tries >= 5) { queue.splice(queue.indexOf(t), 1); fail(t, "The chain did not accept the faucet's transfer."); }
        } else if (!(e instanceof RethError && e.answered)) {
          // Reth did not answer: it may have the transfer all the same. The ticket is sent, the tracker holds the bytes and sends them again if reth lacks them, and the batch stops here.
          stopBatch = true;
        }
      }
      if (handOver) {
        queue.splice(queue.indexOf(t), 1);
        t.status = "sent"; t.reason = null; t.sentNonce = t.nonce;
        open.add(t);
        o.tracker?.track(raw, hash, address!, t.nonce!, "faucet");
        t.raw = null; t.nonce = null;
      }
      if (stopBatch) break;
    }
    // What was not sent goes back to waiting, with no signature kept: it is signed again from reth's count at the next batch. If the lock was lost during
    // the sends, they are left as they are written (queued, with their bytes), for the same reason as above: the new leader may have taken them already.
    if (store?.changes && going.some((t) => t.status !== "sent") && !(await leader.isLeader())) leading = false;
    else for (const t of going) if (t.status !== "sent") { t.raw = null; t.hash = null; t.nonce = null; t.batch = null; }
    if (batchId != null) await store?.batchSent?.(batchId, now()).catch(() => undefined);
    await save();
  }

  function process(): Promise<void> {
    return (running ??= pass().finally(() => { running = null; halted = false; }));
  }

  /** A client that failed its checks too often in the last minute is turned away before any check is made, so junk costs the verifier nothing. */
  function tooManyFailures(key: string | undefined, t: number): FaucetAnswer | null {
    for (const [k, f] of checksFailed) { if (f.since + CHECKS_WINDOW > t) break; checksFailed.delete(k); }
    const f = key === undefined ? undefined : checksFailed.get(key);
    if (!f || f.n < CHECKS_FAILED_MAX) return null;
    return answer(429, "This connection failed the human check several times. Wait a little, then reload the page and try again.", { "Retry-After": seconds(f.since + CHECKS_WINDOW - t) }, "checks");
  }
  function checkFailed(key: string | undefined, t: number): void {
    if (key === undefined) return;
    const f = checksFailed.get(key);
    if (f && f.since + CHECKS_WINDOW > t) f.n++;
    else { checksFailed.delete(key); checksFailed.set(key, { n: 1, since: t }); }
  }

  async function human(token: unknown, ip: string | undefined): Promise<FaucetAnswer | null> {
    const c = o.captcha;
    if (!c) return null;
    const key = clientKey(ip);
    const cooling = tooManyFailures(key, now());
    if (cooling) return cooling;
    if (typeof token !== "string" || !token || token.length > 4096) { checkFailed(key, now()); return answer(403, "Complete the human check first.", undefined, "captcha"); }
    if (key !== undefined && checking.has(key)) return answer(429, "Your last human check is still being looked at. Wait a moment.", { "Retry-After": "2" }, "checks");
    if (verifying >= 50) return answer(503, "Too many people are being checked at this moment. Try again in a moment.", { "Retry-After": "2" });
    verifying++;
    if (key !== undefined) checking.add(key);
    try {
      const form = new URLSearchParams({ secret: c.secret, response: token, ...(ip ? { remoteip: ip } : {}) });
      const res = await doFetch(c.verifyUrl, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(5000) });
      const said = (await res.json()) as { success?: unknown } | null;
      if (said?.success === true) return null;
      checkFailed(key, now());
      return answer(403, "The human check did not pass. Reload the page and try again.", undefined, "captcha");
    } catch {
      console.error("faucet: the human check could not be reached");
      return answer(503, "The human check cannot be reached right now. Try again in a moment.", { "Retry-After": "5" });
    } finally {
      verifying--;
      if (key !== undefined) checking.delete(key);
    }
  }

  /** Counts a refusal that is a limit or a failed human check, once, and hands the answer back. Only the reason is counted, in memory: the answer never waits for the database, and a timer writes the counts. */
  let refusalTimer: ReturnType<typeof setTimeout> | undefined;
  function counted(a: FaucetAnswer): FaucetAnswer {
    const said = (a.body as { reason?: string }).reason;
    const reason = said === "net" ? "ip" : said;   // a network's limit is counted with the per-client one: the counts have no column of their own
    if ((reason === "address" || reason === "ip" || reason === "hour" || reason === "captcha") && store?.refused && store.flushRefusals) {
      store.refused(reason satisfies Refused, now());
      refusalTimer ??= setTimeout(() => { refusalTimer = undefined; void store.flushRefusals!(); }, o.refusalFlushMs ?? 5000).unref();
    }
    return a;
  }
  /** Writes the refusal counts held in memory now (at close, and when the caller flushes). */
  async function writeRefusals() {
    if (refusalTimer) { clearTimeout(refusalTimer); refusalTimer = undefined; }
    await store?.flushRefusals?.();
  }

  function viewOf(t: Ticket): TicketView {
    refresh(t);
    const s = t.status === "sent" && t.hash ? o.tracker?.state(t.hash) : undefined;
    return {
      ticket: t.id, status: t.status, position: t.status === "queued" ? Math.max(1, queue.indexOf(t) + 1) : null, to: t.to, amount: amountOf(t).toString(),
      hash: t.status === "queued" ? null : t.hash, state: s ? s.state : null, block: t.block ?? s?.block ?? null, reason: t.reason,
    };
  }

  /** What the queued and the open requests will take, each at its own amount. */
  const owed = (gasPrice: bigint): bigint => {
    let sum = 0n;
    for (const t of queue) sum += cost(gasPrice, amountOf(t));
    for (const t of open) sum += cost(gasPrice, amountOf(t));
    return sum;
  };

  /**
   * Takes a request for coin. A plain request (no `account`) asks for the faucet's amount and passes the human check. A builder grant (`account` is the keyed
   * hash of the GitHub account) asks for the builder amount, and GitHub's sign-in stands in for the human check. The queue, the batch, the per-client and the
   * hourly limits are the same for both.
   */
  async function submit(raw: unknown, caller: FaucetCaller, grantee?: string): Promise<FaucetAnswer> {
    if (!address) return answer(503, "The faucet is off.");
    if (grantee !== undefined && !builder) return answer(503, "The builder grant is off.");
    const to = typeof raw === "string" ? raw.toLowerCase() : "";
    if (!ADDRESS.test(to)) return answer(400, "That is not an address. An address is 0x and 40 hex digits.");
    const ip = hashed(clientKey(caller.ip)), net = hashed(clientNet(caller.ip));
    const early = limited(to, ip, now(), grantee, net);
    if (early) return counted(early);
    if (grantee === undefined) {
      const refused = await human(caller.captcha, caller.ip);
      if (refused) return counted(refused);
    }
    const seen = await chain();
    // Time has passed while the check and the balance were read: the limits are looked at again, and nothing awaits between that look and the ticket.
    const t = now();
    const late = limited(to, ip, t, grantee, net);
    if (late) return counted(late);
    const amount = grantee === undefined ? o.amountWei : builder!.amountWei;
    if (seen && seen.balance < owed(seen.gasPrice) + cost(seen.gasPrice, amount)) return answer(503, "The faucet is empty.", undefined, "empty");
    const ticket: Ticket = { id: randomBytes(12).toString("hex"), to, ip: ip ?? null, at: t, status: "queued", hash: null, block: null, reason: null, tries: 0, ...(net !== undefined ? { net } : {}), ...(grantee !== undefined ? { account: grantee, amount: amount.toString() } : {}) };
    tickets.set(ticket.id, ticket);
    queue.push(ticket);
    if (grantee !== undefined) { builderAccounts.set(grantee, t); builderAddresses.set(to, t); builderDaily.push(t); } else addresses.set(to, t);
    if (ip !== undefined) ips.set(ip, t);
    if (net !== undefined) nets.set(net, [...(nets.get(net) ?? []), t]);
    hourly.push(t);
    if (store?.claim) {
      // With a database, other instances take requests too. The limits are checked against all of them as the request is written. Until then
      // the worker leaves the request alone, and if the store turns it away, the request is taken back as if it had never been made.
      ticket.claiming = true;
      let turned: ClaimRefusal | null = null;
      try {
        turned = await store.claim(ticket, { addressMs, ipMs, maxPerHour: o.maxPerHour, ...(grantee !== undefined ? { builder: { accountMs: builderMs, maxPerDay: builder!.maxPerDay } } : {}) });
      } catch (e) {
        console.error(`faucet: cannot write the request: ${(e as Error).message}`);
        unqueue(ticket);
        return answer(503, "The faucet cannot save requests right now, so this one was turned away, not lost: nothing was taken from you. Try again in a moment.", { "Retry-After": "5" });
      }
      ticket.claiming = false;
      if (turned) {
        unqueue(ticket);
        const wait = turned === "address" ? addressMs : turned === "ip" ? ipMs : turned === "account" || turned === "builder-address" ? builderMs : turned === "day" ? DAY : HOUR;
        return counted(turnedAway(turned, wait));
      }
    }
    trim();
    save();
    if (started && !running) void process().catch((e) => console.error(`faucet: ${(e as Error).message}`));
    return { status: 202, body: { ticket: ticket.id, position: queue.indexOf(ticket) + 1, to, amount: amount.toString() } };
  }

  /** The sign-in with GitHub, when the builder grant is on. It hands an account it has read to the same submit as a plain request. */
  const signIn: SignIn | null = builder && account ? createSignIn(builder, {
    fetch: doFetch, now,
    grant: (to, who, ip) => submit(to, { ip }, who),
    early: (to, ip) => {
      forget(now());
      const b = builderAddresses.get(to);
      if (b !== undefined) return { outcome: "address", wait: Math.ceil((b + builderMs - now()) / 1000) };
      const h = hashed(clientKey(ip));
      const i = h === undefined ? undefined : ips.get(h);
      if (i !== undefined) return { outcome: "ip", wait: Math.ceil((i + ipMs - now()) / 1000) };
      if (builderDaily.length >= builder.maxPerDay) return { outcome: "day", wait: Math.ceil((builderDaily[0]! + DAY - now()) / 1000) };
      return null;
    },
  }) : null;

  load();

  return {
    on: account !== null,
    address,
    served: () => addresses.size,
    queued: () => queue.length,
    oldestQueued: () => queue[0]?.at ?? null,
    isLeading: () => leading,
    process,
    ready: () => loaded,
    async find(id) {
      const t = tickets.get(id);
      if (t) return viewOf(t);
      const r = await store?.find?.(id);
      return r ? viewOf(r) : null;
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined; started = false;
      await running?.catch(() => {});
      await save();
      await writeRefusals();
      await leader.release();
    },
    /** Waits for the batch in hand to end, then writes everything as it stands. */
    flush: async () => {
      await running?.catch(() => {});
      await save();
      await writeRefusals();
    },

    async info() {
      const t = now();
      // The count and the chain are read together, so the answer waits for the slowest and not for the sum.
      const payouts = store?.payouts ? store.payouts(t - (t % 86400_000)).catch(() => null) : Promise.resolve(null);
      let balance: string | null = null, balanceBlock: number | null = null;
      if (address) {
        // Read at the final head (reth's finalized block is Canton's head), named by its number: the number is read first and the balance at that number, so the two belong together.
        const at = o.reth.block && o.reth.balanceAt ? await o.reth.block("finalized").then((b) => b?.number ?? null, () => null) : null;
        if (at !== null) balance = await o.reth.balanceAt!(address, at).then((b) => (balanceBlock = at, b.toString()), () => null);
        if (balance === null) balance = await o.reth.balance(address).then((b) => b.toString(), () => null);
      }
      const p = await payouts;
      return {
        on: account !== null, address, balance, balanceBlock, amount: o.amountWei.toString(), perAddressSeconds: o.perAddressSeconds, perIpSeconds: o.perIpSeconds,
        maxPerHour: o.maxPerHour, queue: queue.length, batch: o.batch, sentToday: p?.sent ?? null, finalToday: p?.final ?? null, beingProven: p?.beingProven ?? null,
        captcha: o.captcha && { siteKey: o.captcha.siteKey, scriptUrl: o.captcha.scriptUrl, widgetClass: o.captcha.widgetClass },
        builder: builder
          ? { on: account !== null, amount: builder.amountWei.toString(), perAccountSeconds: builder.perAccountSeconds, minAccountAgeDays: builder.minAccountAgeDays, maxPerDay: builder.maxPerDay }
          : { on: false, amount: null, perAccountSeconds: null, minAccountAgeDays: null, maxPerDay: null },
      };
    },

    ticket(id) {
      const t = tickets.get(id);
      return t ? viewOf(t) : null;
    },

    start() {
      if (!account || started) return;
      started = true;
      const tick = () => void process().catch((e) => console.error(`faucet: ${(e as Error).message}`));
      timer = setInterval(tick, o.tickMs ?? 1000);
      timer.unref();
      if (queue.length) tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined; started = false;
      if (running) halted = true; // the batch in hand ends after its current send
    },

    request: (raw, caller = {}) => submit(raw, caller),

    builderStart: (address, ip) => (signIn ? signIn.start(address, ip) : null),
    builderCallback: async (query, ip, cookie) => (signIn ? signIn.callback(query, ip, cookie) : null),
  };
}
