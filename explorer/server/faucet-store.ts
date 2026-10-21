import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pool, PoolClient } from "pg";
import { ConfigError } from "./config.ts";
import type { Ticket, TicketStatus } from "./faucet.ts";
import { CLAIM_LOCK, LOCK_CLASS } from "./leader.ts";

/** What the faucet keeps: each address's last request, each client's, the requests of the last hour, and the tickets. */
export interface FaucetState {
  addresses: [string, number][];
  ips: [string, number][];
  hourly: number[];
  tickets: Ticket[];
}

/** How much of the past the faucet needs in memory: the windows of its limits. */
export interface LoadWindow { now: number; addressMs: number; ipMs: number; max: number }
export interface ClaimRules { addressMs: number; ipMs: number; maxPerHour: number }
export type ClaimRefusal = "address" | "ip" | "hour";

/**
 * Where the faucet keeps its state across a restart: a file when no database is set, the database when one is. The faucet works in
 * memory and hands the store its tickets after each change. Only a database is shared, so only it has the steps for several instances.
 */
export interface FaucetStore {
  load(w: LoadWindow): FaucetState | Promise<FaucetState>;
  /** Writes what changed. Resolves false when the write did not happen (a failure is logged, and the next write tries again); it never throws. The batch that is about to be sent waits for true. */
  save(tickets: Ticket[], limits: () => Pick<FaucetState, "addresses" | "ips" | "hourly">): Promise<boolean>;
  /** Checks the limits against every instance's requests and writes the request, in one step. Null when it was taken. */
  claim?(t: Ticket, rules: ClaimRules): Promise<ClaimRefusal | null>;
  /** Tickets another instance wrote since the last call. */
  changes?(): Promise<Ticket[]>;
  find?(id: string): Promise<Ticket | null>;
  /** Every request that is queued in the database, whatever this store has read before. The leader takes the ones it does not hold. */
  queued?(): Promise<Ticket[]>;
  /** How many rows the store holds a signature for (it follows the list given to save). */
  remembered?(): number;
  /** A batch is signed and written before the first send; this records it and says its number. */
  batchSigned?(firstNonce: number, size: number, at: number): Promise<number | null>;
  batchSent?(id: number, at: number): Promise<void>;
  /** Takes the tickets of an old file once, leaving rows that exist alone. */
  importState?(s: FaucetState, hash: (clientKey: string) => string): Promise<number>;
  /** Removes signed bytes of settled requests, and the settled requests older than 90 days after adding them to their day's count. */
  purge?(now: number): Promise<void>;
}

export const CLIENT_HASH_KEPT_MS = 90 * 86400_000;

/** The file as it has always been, written to a temporary file and renamed over the real one, so a crash never leaves half a file. */
export function fileFaucetStore(file: string): FaucetStore {
  return {
    load() {
      const empty: FaucetState = { addresses: [], ips: [], hourly: [], tickets: [] };
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`faucet: cannot read ${file}: ${(e as Error).message}`);
        return empty;
      }
      try {
        const s = JSON.parse(text) as Partial<FaucetState>;
        return {
          addresses: (s.addresses ?? []).filter(([a, t]) => typeof a === "string" && Number.isFinite(t)),
          ips: (s.ips ?? []).filter(([a, t]) => typeof a === "string" && Number.isFinite(t)),
          hourly: (s.hourly ?? []).filter(Number.isFinite),
          tickets: (s.tickets ?? []).filter((t) => typeof t.id === "string" && typeof t.to === "string"),
        };
      } catch {
        console.error(`faucet: ${file} is not a file the faucet wrote, so it starts with no limits`);
        return empty;
      }
    },
    async save(tickets, limits) {
      try {
        const body = JSON.stringify({ version: 1, ...limits(), tickets });
        mkdirSync(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, body, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        return true;
      } catch (e) {
        console.error(`faucet: cannot write ${file}: ${(e as Error).message}`);
        return false;
      }
    },
  };
}

/**
 * The key that client addresses are hashed with: 64 hex digits in a file that only its owner can read, named by a setting.
 * A file that others can read is refused: with it, anyone holding the database could try every address of a network.
 */
export function loadClientKey(file: string, setting = "FAUCET_CLIENT_KEY_FILE"): Buffer {
  let text: string;
  try {
    if (statSync(file).mode & 0o077) throw new ConfigError(`${setting} ${file} must be readable by its owner only (chmod 600)`);
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${setting} ${file} cannot be read`);
  }
  const key = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new ConfigError(`${setting} ${file} must hold 64 hex digits`);
  return Buffer.from(key, "hex");
}

/** A client address (its /64 for IPv6) as a keyed hash: it still tells one client from another, and tells nobody's address. */
export function clientHasher(key: Buffer): (clientKey: string) => string {
  return (c) => createHmac("sha256", key).update(c).digest("hex");
}

// --- the database

/**
 * A ticket's id is 24 hex digits, 12 random bytes. The table's key is a uuid, so the id is written as the first 12 bytes of one, with
 * the rest zero. The page and the wallets keep the 24 digits they were given.
 */
const uuidOf = (id: string): string => { const h = `${id}00000000`; return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const idOf = (uuid: string): string => uuid.replace(/-/g, "").slice(0, 24);
const bytes = (hex: string | null | undefined): Buffer | null => (hex ? Buffer.from(hex.replace(/^0x/, ""), "hex") : null);
const hexOf = (b: Buffer | null, prefix: boolean): string | null => (b === null ? null : (prefix ? "0x" : "") + b.toString("hex"));

interface Row {
  ticket: string; address: Buffer; client_key: Buffer; state: string; reason: string | null; batch_id: string | null; nonce: string | null; tx_hash: Buffer | null;
  signed_raw: Buffer | null; requested_at: Date; final_block: string | null; tries: number; sent_nonce: string | null; watching: boolean; updated_at: Date;
}
const COLUMNS = "ticket, address, client_key, state, reason, batch_id, nonce, tx_hash, signed_raw, requested_at, final_block, tries, sent_nonce, watching, updated_at";

function ticketOf(r: Row): Ticket {
  return {
    id: idOf(r.ticket), to: "0x" + r.address.toString("hex"), ip: r.client_key.length ? r.client_key.toString("hex") : null, at: r.requested_at.getTime(),
    status: r.state as TicketStatus, hash: hexOf(r.tx_hash, true), block: r.final_block === null ? null : Number(r.final_block), reason: r.reason, tries: r.tries,
    // The column keeps the payout's nonce for good; the ticket carries it only while the batch is signed and not yet sent.
    nonce: r.nonce === null || (r.state !== "queued" && r.signed_raw === null) ? null : Number(r.nonce), raw: hexOf(r.signed_raw, true), sentNonce: r.sent_nonce === null ? null : Number(r.sent_nonce), watch: r.watching,
    batch: r.batch_id === null ? null : Number(r.batch_id),
  };
}

/** A ticket made in memory leaves some fields out where a row read back has them as false or null, so the optional ones are normalised: the same ticket signs the same either way. */
const signature = (t: Ticket): string => JSON.stringify([t.status, t.hash ?? null, t.block ?? null, t.reason ?? null, t.tries, t.nonce ?? null, t.raw ?? null, t.sentNonce ?? null, t.watch === true, t.batch ?? null]);

const INSERT = `
  insert into faucet_requests (ticket, address, client_key, amount, state, reason, batch_id, nonce, tx_hash, signed_raw, counts, requested_at, sent_at, final_at, final_block, tries, sent_nonce, watching, updated_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, case when $5 in ('sent', 'final') then $13::timestamptz end, case when $5 = 'final' then $13::timestamptz end, $14, $15, $16, $17, now())
  on conflict (ticket) do`;
const UPDATE = ` update set
    state = excluded.state, reason = excluded.reason, batch_id = coalesce(excluded.batch_id, faucet_requests.batch_id), nonce = excluded.nonce, tx_hash = excluded.tx_hash,
    signed_raw = excluded.signed_raw, counts = excluded.counts, sent_at = coalesce(faucet_requests.sent_at, excluded.sent_at), final_at = coalesce(faucet_requests.final_at, excluded.final_at),
    final_block = excluded.final_block, tries = excluded.tries, sent_nonce = excluded.sent_nonce, watching = excluded.watching, updated_at = now()`;

/** The tickets in the explorer's database. A request that came to nothing has `counts` false, so its address and client get their turn back. */
export function databaseFaucetStore(pool: Pool, amountWei: bigint, now: () => number = Date.now): FaucetStore {
  const written = new Map<string, string>();
  let cursor: Date | null = null;

  /** Writes a ticket as it stands in the copy it is given, and says what it wrote. The caller records it as written once the transaction has committed. */
  async function put(c: PoolClient, t: Ticket, keepExisting = false): Promise<[string, string]> {
    await c.query(INSERT + (keepExisting ? " nothing" : UPDATE), [
      uuidOf(t.id), bytes(t.to), bytes(t.ip) ?? Buffer.alloc(0), amountWei.toString(), t.status, t.reason, t.batch ?? null, t.nonce ?? t.sentNonce ?? null, bytes(t.hash), bytes(t.raw),
      t.status !== "failed", new Date(t.at), new Date(now()), t.status === "final" ? t.block : null, t.tries, t.sentNonce ?? null, t.watch === true, 
    ]);
    return [t.id, signature(t)];
  }

  async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const r = await fn(c);
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  return {
    async load(w) {
      const { rows } = await pool.query<Row>(
        `select ${COLUMNS} from faucet_requests
          where state in ('queued', 'sent') or ticket in (select ticket from faucet_requests order by requested_at desc limit $1)
          order by requested_at, nonce nulls last, ticket`,
        [w.max],
      );
      const tickets = rows.map(ticketOf);
      for (const t of tickets) written.set(t.id, signature(t));
      cursor = rows.reduce<Date | null>((m, r) => (m === null || r.updated_at > m ? r.updated_at : m), null) ?? (await pool.query<{ now: Date }>("select now() as now")).rows[0]!.now;
      // The limits are what the requests that count say, inside their windows.
      const addresses = new Map<string, number>(), ips = new Map<string, number>(), hourly: number[] = [];
      for (const t of tickets) {
        if (t.status === "failed") continue;
        if (t.at + w.addressMs > w.now) addresses.set(t.to, t.at);
        if (t.ip !== null && t.at + w.ipMs > w.now) ips.set(t.ip, t.at);
        if (t.at + 3600_000 > w.now) hourly.push(t.at);
      }
      return { addresses: [...addresses], ips: [...ips], hourly, tickets };
    },
    async save(tickets) {
      // The list handed over is the bounded truth: what it no longer holds is forgotten here too.
      if (written.size > tickets.length) { const keep = new Set(tickets.map((t) => t.id)); for (const id of written.keys()) if (!keep.has(id)) written.delete(id); }
      // The tickets change in place while a write is on its way, so what is written, and what is marked as written, is one copy.
      const changed = tickets.filter((t) => written.get(t.id) !== signature(t) && !t.claiming).map((t) => ({ ...t }));
      if (!changed.length) return true;
      try {
        const done = await inTransaction(async (c) => { const out: Array<[string, string]> = []; for (const t of changed) out.push(await put(c, t)); return out; });
        for (const [id, sig] of done) written.set(id, sig);
        return true;
      } catch (e) {
        console.error(`faucet: cannot write the database: ${(e as Error).message}`);
        return false;
      }
    },
    async claim(t, r) {
      const copy = { ...t };
      let wrote: [string, string] | null = null;
      const refused = await inTransaction(async (c) => {
        await c.query("select pg_advisory_xact_lock($1, $2)", [LOCK_CLASS, CLAIM_LOCK]);
        const { rows } = await c.query<{ address: boolean; ip: boolean; hour: string }>(
          `select exists (select 1 from faucet_requests where address = $1 and counts and requested_at > $2) as address,
                  ($3::bytea <> ''::bytea and exists (select 1 from faucet_requests where client_key = $3 and counts and requested_at > $4)) as ip,
                  (select count(*) from faucet_requests where counts and requested_at > $5) as hour`,
          [bytes(t.to), new Date(t.at - r.addressMs), bytes(t.ip) ?? Buffer.alloc(0), new Date(t.at - r.ipMs), new Date(t.at - 3600_000)],
        );
        const s = rows[0]!;
        if (s.address) return "address";
        if (s.ip) return "ip";
        if (Number(s.hour) >= r.maxPerHour) return "hour";
        wrote = await put(c, copy);
        return null;
      });
      if (wrote) written.set(wrote[0], wrote[1]);
      return refused;
    },
    async changes() {
      const { rows } = await pool.query<Row>(`select ${COLUMNS} from faucet_requests where updated_at > $1::timestamptz - interval '5 seconds' order by updated_at`, [cursor ?? new Date(0)]);
      for (const r of rows) if (cursor === null || r.updated_at > cursor) cursor = r.updated_at;
      const fresh = rows.map(ticketOf).filter((t) => written.get(t.id) !== signature(t));
      for (const t of fresh) written.set(t.id, signature(t));
      return fresh;
    },
    async find(id) {
      if (!/^[0-9a-f]{24}$/.test(id)) return null;
      const { rows } = await pool.query<Row>(`select ${COLUMNS} from faucet_requests where ticket = $1`, [uuidOf(id)]);
      if (!rows[0]) return null;
      // A found row is only shown, never held, so it is not marked as written: the leader's catch-up must still see it.
      return ticketOf(rows[0]);
    },
    async queued() {
      const { rows } = await pool.query<Row>(`select ${COLUMNS} from faucet_requests where state = 'queued' order by requested_at, ticket`);
      return rows.map(ticketOf);
    },
    remembered: () => written.size,
    async batchSigned(firstNonce, size, at) {
      const { rows } = await pool.query<{ batch_id: string }>("insert into faucet_batches (signed_at, first_nonce, size) values ($1, $2, $3) returning batch_id", [new Date(at), firstNonce, size]);
      return Number(rows[0]!.batch_id);
    },
    async batchSent(id, at) {
      await pool.query("update faucet_batches set sent_at = $2 where batch_id = $1", [id, new Date(at)]);
    },
    async importState(s, hash) {
      let n = 0;
      await inTransaction(async (c) => {
        const addressAt = new Map<string, number>(), clientAt = new Map<string, number>(), hourAt: number[] = [];
        for (const t of s.tickets) {
          if (!/^[0-9a-f]{24}$/.test(t.id) || !/^0x[0-9a-f]{40}$/.test(t.to)) continue;
          const ip = t.ip === null ? null : hash(t.ip);
          await put(c, { ...t, ip }, true);
          n++;
          if (t.status === "failed") continue;
          addressAt.set(t.to, Math.max(addressAt.get(t.to) ?? 0, t.at));
          if (ip !== null) clientAt.set(ip, Math.max(clientAt.get(ip) ?? 0, t.at));
          hourAt.push(t.at);
        }
        // A limit can outlive its ticket (the file keeps the last 10,000 tickets, and the limits for as long as their windows). The limit
        // comes over as a request of its own that is already settled, so it still counts and nothing is sent for it.
        // The id comes from the limit itself (a keyed hash of its kind, key, time and place among equals), so a second import writes the same rows and the existing ones stay.
        const placeOf = new Map<string, number>();
        const limitOnly = async (to: string, ip: string | null, at: number): Promise<void> => {
          const key = `limit|${to}|${ip ?? ""}|${at}`;
          const nth = (placeOf.get(key) ?? 0) + 1;
          placeOf.set(key, nth);
          await put(c, { id: hash(`${key}|${nth}`).slice(0, 24), to, ip, at, status: "final", hash: null, block: null, reason: "a limit imported from the old file", tries: 0 }, true);
        };
        for (const [a, at] of s.addresses) if (/^0x[0-9a-f]{40}$/.test(a) && (addressAt.get(a) ?? -1) < at) { await limitOnly(a, null, at); hourAt.push(at); }
        for (const [k, at] of s.ips) { const ip = hash(k); if ((clientAt.get(ip) ?? -1) < at) { await limitOnly("0x", ip, at); hourAt.push(at); } }
        // The hour's count: what the file counted that the requests above do not show.
        const seen = new Map<number, number>();
        for (const at of hourAt) seen.set(at, (seen.get(at) ?? 0) + 1);
        for (const at of s.hourly) {
          if ((seen.get(at) ?? 0) > 0) { seen.set(at, seen.get(at)! - 1); continue; }
          await limitOnly("0x", null, at);
        }
      });
      return n;
    },
    async purge(t) {
      await pool.query("update faucet_requests set signed_raw = null where signed_raw is not null and state in ('final', 'failed')");
      await pool.query("update faucet_requests set client_key = ''::bytea where client_key <> ''::bytea and requested_at < $1", [new Date(t - CLIENT_HASH_KEPT_MS)]);
      // Settled requests older than 90 days leave only their day's count, in one step so a request is never deleted without being counted.
      await pool.query(
        `with old as (delete from faucet_requests where requested_at < $1 and state in ('final', 'failed') returning requested_at, state)
         insert into faucet_daily_counts (day, requests, failed)
           select (requested_at at time zone 'UTC')::date, count(*)::int, (count(*) filter (where state = 'failed'))::int from old group by 1
         on conflict (day) do update set requests = faucet_daily_counts.requests + excluded.requests, failed = faucet_daily_counts.failed + excluded.failed`,
        [new Date(t - CLIENT_HASH_KEPT_MS)],
      );
    },
  };
}
