import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError } from "./config.ts";
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
  /** The most requests accepted in any hour, from everyone. */
  maxPerHour: number;
  /** The most transfers sent in one batch. */
  batch: number;
  /** The most requests waiting for a batch. */
  queueMax: number;
  /** Where the limits and the waiting requests are kept, or null for memory only. */
  stateFile: string | null;
  /** The human check, or null for none. */
  captcha: { secret: string; verifyUrl: string; scriptUrl: string; siteKey: string; widgetClass: string } | null;
  reth: Pick<Reth, "balance" | "nonce" | "gasPrice" | "priorityFee" | "sendRaw" | "transaction">;
  /** Takes each sent transfer, and says where it is. Without one, a ticket never gets past "sent". */
  tracker?: Pick<Tracker, "track" | "state"> & Partial<Pick<Tracker, "admit">>;
  /** How often the worker looks at the queue. */
  tickMs?: number;
  /** For the human check's call. A test gives its own. */
  fetch?: typeof fetch;
  /** The time in milliseconds. A test sets its own. */
  now?: () => number;
}

export interface FaucetAnswer { status: number; body: unknown; headers?: Record<string, string> }

/** What the faucet page shows about the faucet itself. */
export interface FaucetInfo {
  on: boolean; address: string | null; balance: string | null; amount: string; perAddressSeconds: number; perIpSeconds: number; maxPerHour: number;
  /** How many requests are waiting for a batch. */
  queue: number;
  captcha: { siteKey: string; scriptUrl: string; widgetClass: string } | null;
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
  /** Where a ticket is. Null when there is no such ticket. */
  ticket(id: string): TicketView | null;
  /** One pass of the worker: sends the next batch if the last one has left the pool. Resolves when the pass is over. */
  process(): Promise<void>;
  /** Starts the worker on a timer, and wakes it at each request. */
  start(): void;
  stop(): void;
  /** Resolves when everything changed so far is on disk. */
  flush(): Promise<void>;
  /** How many addresses are waiting out their day. */
  served(): number;
  /** How many requests wait for a batch. */
  queued(): number;
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

interface Ticket {
  id: string; to: string; ip: string | null; at: number;
  status: TicketStatus; hash: string | null; block: number | null; reason: string | null; tries: number;
  /**
   * The signed transfer and its nonce, kept from the moment it is signed until the tracker has it. They are written to disk before the batch is
   * sent, so a stop or a crash in the middle of a batch never leaves a transfer in reth that no file knows of.
   */
  nonce?: number | null; raw?: string | null;
}

const TICKETS_MAX = 10000;
const HOUR = 3600_000;
/** About one block: how long a caller turned away because the line is full is asked to wait, for each batch ahead. */
const BLOCK_SECONDS = 10;
/** Failed human checks one client may have in a window, before it is turned away without a check, and how long that window is. */
const CHECKS_FAILED_MAX = 5;
const CHECKS_WINDOW = 60_000;
/** The tracker's per-sender limit is for wallets. The faucet sends its own batches, and asks the tracker only whether it has room, as for a sender with nothing waiting. */
const NO_SENDER = "0x0000000000000000000000000000000000000000";
const KNOWN = /already known|known transaction|already imported|already in the pool/i;

/** A refusal also says which limit was hit, so a page can word it without reading the message. */
type Reason = "address" | "ip" | "hour" | "queue" | "captcha" | "checks" | "empty";
const answer = (status: number, error: string, headers?: Record<string, string>, reason?: Reason): FaucetAnswer => ({
  status, body: { error, ...(reason ? { reason } : {}) }, ...(headers ? { headers } : {}),
});
const seconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));
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

export function createFaucet(o: FaucetOptions): Faucet {
  const now = o.now ?? Date.now;
  const account = o.key ? privateKeyToAccount(o.key) : null;
  const address = account ? account.address.toLowerCase() : null;
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const addressMs = o.perAddressSeconds * 1000, ipMs = o.perIpSeconds * 1000;
  // Each map is in the order of time: a key is set only when it is not there, so the oldest is always the first.
  const addresses = new Map<string, number>(), ips = new Map<string, number>();
  let hourly: number[] = [];
  const tickets = new Map<string, Ticket>();
  const queue: Ticket[] = [];
  /** Tickets whose transfer is in reth and not yet settled. */
  const open = new Set<Ticket>();
  let running: Promise<void> | null = null, timer: ReturnType<typeof setInterval> | undefined, started = false;
  let view: View | null = null, viewing: Promise<View | null> | null = null;
  let verifying = 0;
  /** Clients with a human check under way, so one client has one at a time. */
  const checking = new Set<string>();
  /** Failed human checks for each client in its window, oldest window first. */
  const checksFailed = new Map<string, { n: number; since: number }>();
  /** Set by stop() while a batch is going out: the batch ends after the send in hand. */
  let halted = false;
  let writing: Promise<void> = Promise.resolve(), dirty = false, saving = false;

  // --- what is kept across a restart
  function load(): void {
    if (!o.stateFile) return;
    let text: string;
    try {
      text = readFileSync(o.stateFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`faucet: cannot read ${o.stateFile}: ${(e as Error).message}`);
      return;
    }
    try {
      const s = JSON.parse(text) as { addresses?: [string, number][]; ips?: [string, number][]; hourly?: number[]; tickets?: Ticket[] };
      for (const [a, t] of s.addresses ?? []) if (typeof a === "string" && Number.isFinite(t)) addresses.set(a, t);
      for (const [a, t] of s.ips ?? []) if (typeof a === "string" && Number.isFinite(t)) ips.set(a, t);
      hourly = (s.hourly ?? []).filter(Number.isFinite);
      for (const t of s.tickets ?? []) {
        if (typeof t.id !== "string" || typeof t.to !== "string") continue;
        tickets.set(t.id, t);
        if (t.status === "queued") queue.push(t);
        else if (t.status === "sent") open.add(t);
      }
    } catch {
      console.error(`faucet: ${o.stateFile} is not a file the faucet wrote, so it starts with no limits`);
    }
    // A transfer signed before the last stop may or may not have reached reth. Its ticket is sent, never queued again: the tracker holds the signed
    // bytes, sends them if reth does not have them, and says what became of them. Signing the request again would pay the address twice.
    for (const t of [...queue]) {
      if (!t.raw || !t.hash) { t.raw = null; t.nonce = null; continue; }
      queue.splice(queue.indexOf(t), 1);
      t.status = "sent"; open.add(t);
    }
    for (const t of open) {
      if (!t.raw || !t.hash) continue;
      if (o.tracker && !o.tracker.state(t.hash)) o.tracker.track(t.raw, t.hash, address!, t.nonce ?? 0);
      t.raw = null; t.nonce = null;
    }
  }

  /** Writes the state to a temporary file and renames it over the real one, so a crash never leaves half a file. Writes that pile up become one. */
  function save(): Promise<void> {
    if (!o.stateFile) return Promise.resolve();
    dirty = true;
    if (saving) return writing;
    saving = true;
    writing = (async () => {
      try {
        while (dirty) {
          dirty = false;
          const body = JSON.stringify({ version: 1, addresses: [...addresses], ips: [...ips], hourly, tickets: [...tickets.values()] });
          mkdirSync(dirname(o.stateFile!), { recursive: true });
          await writeFile(`${o.stateFile}.tmp`, body, { mode: 0o600 });
          await rename(`${o.stateFile}.tmp`, o.stateFile!);
        }
      } catch (e) {
        console.error(`faucet: cannot write ${o.stateFile}: ${(e as Error).message}`);
      } finally {
        saving = false;
      }
    })();
    return writing;
  }

  // --- the limits
  function forget(t: number): void {
    for (const [m, ms] of [[addresses, addressMs], [ips, ipMs]] as const) for (const [k, at] of m) { if (at + ms > t) break; m.delete(k); }
    let i = 0;
    while (i < hourly.length && hourly[i]! + HOUR <= t) i++;
    if (i) hourly = hourly.slice(i);
  }

  /** The refusal for a caller, or null when the limits let it through. */
  function limited(to: string, ip: string | undefined, t: number): FaucetAnswer | null {
    forget(t);
    const a = addresses.get(to);
    if (a !== undefined) return answer(429, `This address was given coins in the last ${period(o.perAddressSeconds)}. Try again later.`, { "Retry-After": seconds(a + addressMs - t) }, "address");
    const i = ip === undefined ? undefined : ips.get(ip);
    if (i !== undefined) return answer(429, `This connection asked for coins in the last ${period(o.perIpSeconds)}. Try again later.`, { "Retry-After": seconds(i + ipMs - t) }, "ip");
    if (hourly.length >= o.maxPerHour) return answer(429, `The faucet has given out all it gives in an hour (${o.maxPerHour} requests). Try again later.`, { "Retry-After": seconds(hourly[0]! + HOUR - t) }, "hour");
    if (queue.length >= o.queueMax) {
      return answer(503, "The faucet's line is full, so this request was turned away, not lost: nothing was taken from you. Try again in a little while.", { "Retry-After": String(Math.max(5, Math.ceil(queue.length / o.batch) * BLOCK_SECONDS)) }, "queue");
    }
    return null;
  }

  /** Takes back what a request used, when it came to nothing. */
  function refund(t: Ticket): void {
    if (addresses.get(t.to) === t.at) addresses.delete(t.to);
    if (t.ip !== null && ips.get(t.ip) === t.at) ips.delete(t.ip);
    const i = hourly.indexOf(t.at);
    if (i >= 0) hourly.splice(i, 1);
  }

  const fail = (t: Ticket, reason: string): void => {
    t.status = "failed"; t.reason = reason; open.delete(t);
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
  const cost = (gasPrice: bigint) => o.amountWei + FAUCET_GAS * gasPrice * 2n;

  /** Brings a sent ticket up to date from the tracker. Final only when the tracker says the transfer is final. */
  function refresh(t: Ticket): void {
    if (t.status !== "sent" || !t.hash || !o.tracker) return;
    const s = o.tracker.state(t.hash);
    if (!s) return void open.delete(t);
    if (s.state === "final") { t.status = "final"; t.block = s.block; open.delete(t); save(); }
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
      if (found) open.delete(t);
      else fail(t, s.reason ?? "The transfer did not land on the chain.");
    }
  }

  function trim(): void {
    for (const [id, t] of tickets) {
      if (tickets.size <= TICKETS_MAX) break;
      if (t.status !== "queued" && !open.has(t)) tickets.delete(id);
    }
  }

  /** Sends the next batch, if there is one and the last one has left reth's pool. */
  async function pass(): Promise<void> {
    if (!account) return;
    for (const t of open) refresh(t);
    await settleDropped();
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
    const maxFeePerGas = gasPrice * 2n;
    const batch = queue.slice(0, o.batch);
    const afford = balance / cost(gasPrice) < BigInt(batch.length) ? Number(balance / cost(gasPrice)) : batch.length;
    // The coins are gone: the requests that cannot be paid are told so, and may ask again once the faucet is filled.
    for (const t of batch.slice(afford)) { queue.splice(queue.indexOf(t), 1); fail(t, "The faucet ran out of coins before this request was sent."); }
    const going = batch.slice(0, afford);
    // The whole batch is signed first, and written to disk with its nonces and bytes before the first send. Whatever happens after that, every
    // transfer that may be in reth is in a file, and a restart hands it to the tracker instead of signing the request again.
    try {
      for (const [i, t] of going.entries()) {
        const raw = await account.signTransaction({
          type: "eip1559", chainId: o.chainId, nonce: nonce + i, to: t.to as Hex, value: o.amountWei, gas: FAUCET_GAS, maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas,
        });
        t.raw = raw; t.hash = keccak256(raw); t.nonce = nonce + i;
      }
    } catch {
      console.error("faucet: a payout failed before it was sent");
      for (const t of going) { t.raw = null; t.hash = null; t.nonce = null; }
      return;
    }
    await save();
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
        t.status = "sent"; t.reason = null;
        open.add(t);
        o.tracker?.track(raw, hash, address!, t.nonce!);
        t.raw = null; t.nonce = null;
      }
      if (stopBatch) break;
    }
    // What was not sent goes back to waiting, with no signature kept: it is signed again from reth's count at the next batch.
    for (const t of going) if (t.status !== "sent") { t.raw = null; t.hash = null; t.nonce = null; }
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

  function viewOf(t: Ticket): TicketView {
    refresh(t);
    const s = t.status === "sent" && t.hash ? o.tracker?.state(t.hash) : undefined;
    return {
      ticket: t.id, status: t.status, position: t.status === "queued" ? queue.indexOf(t) + 1 : null, to: t.to, amount: o.amountWei.toString(),
      hash: t.status === "queued" ? null : t.hash, state: s ? s.state : null, block: t.block ?? s?.block ?? null, reason: t.reason,
    };
  }

  load();

  return {
    on: account !== null,
    address,
    served: () => addresses.size,
    queued: () => queue.length,
    process,
    /** Waits for the batch in hand to end, then writes everything as it stands. */
    flush: async () => {
      await running?.catch(() => {});
      await save();
    },

    async info() {
      let balance: string | null = null;
      if (address) balance = await o.reth.balance(address).then((b) => b.toString(), () => null);
      return {
        on: account !== null, address, balance, amount: o.amountWei.toString(), perAddressSeconds: o.perAddressSeconds, perIpSeconds: o.perIpSeconds,
        maxPerHour: o.maxPerHour, queue: queue.length, captcha: o.captcha && { siteKey: o.captcha.siteKey, scriptUrl: o.captcha.scriptUrl, widgetClass: o.captcha.widgetClass },
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

    async request(raw, caller = {}) {
      if (!account) return answer(503, "The faucet is off.");
      const to = typeof raw === "string" ? raw.toLowerCase() : "";
      if (!ADDRESS.test(to)) return answer(400, "That is not an address. An address is 0x and 40 hex digits.");
      const ip = clientKey(caller.ip);
      const early = limited(to, ip, now());
      if (early) return early;
      const refused = await human(caller.captcha, caller.ip);
      if (refused) return refused;
      const seen = await chain();
      // Time has passed while the check and the balance were read: the limits are looked at again, and nothing awaits between that look and the ticket.
      const t = now();
      const late = limited(to, ip, t);
      if (late) return late;
      if (seen && seen.balance < BigInt(queue.length + open.size + 1) * cost(seen.gasPrice)) return answer(503, "The faucet is empty.", undefined, "empty");
      const ticket: Ticket = { id: randomBytes(12).toString("hex"), to, ip: ip ?? null, at: t, status: "queued", hash: null, block: null, reason: null, tries: 0 };
      tickets.set(ticket.id, ticket);
      queue.push(ticket);
      addresses.set(to, t);
      if (ip !== undefined) ips.set(ip, t);
      hourly.push(t);
      trim();
      save();
      if (started && !running) void process().catch((e) => console.error(`faucet: ${(e as Error).message}`));
      return { status: 202, body: { ticket: ticket.id, position: queue.length, to, amount: o.amountWei.toString() } };
    },
  };
}
