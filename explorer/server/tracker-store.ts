import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pool } from "pg";
import { READ_BACK_SECONDS } from "./leader.ts";
import type { Entry } from "./tracker.ts";

/**
 * Where the tracker keeps its list across a restart. A file is the store when no database is set; the database is the store when
 * one is. The tracker works on its list in memory and hands the store the whole list after a change, so the store decides what to write.
 */
export interface TrackerStore {
  /** What was kept, oldest first. A file answers at once; a database takes a moment. */
  load(): Entry[] | Promise<Entry[]>;
  /** Writes the list as it stands. Never throws: a failure is logged, and the next write tries again. */
  save(entries: Entry[]): Promise<void>;
  /** Entries that another instance wrote since the last call. Only a store that more than one instance shares has this. */
  changes?(): Promise<Entry[]>;
  /** How many entries the store holds a signature for (it follows the list given to save). */
  remembered?(): number;
  /** Takes the entries of an old file once, leaving rows that exist alone. */
  importEntries?(entries: Entry[]): Promise<number>;
  /** Removes what must not be kept any longer: signed bytes 7 days after a transaction settled. */
  purge?(now: number): Promise<void>;
}

const DAY = 86400_000;
export const RAW_KEPT_MS = 7 * DAY;

/** The file as it has always been: one JSON list, written to a temporary file and renamed over the real one, so a crash never leaves half a file. */
export function fileTrackerStore(file: string): TrackerStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`tracker: cannot read ${file}: ${(e as Error).message}`);
        return [];
      }
      try {
        const saved = JSON.parse(text) as { entries?: Entry[] };
        return (saved.entries ?? []).filter((e) => typeof e.hash === "string" && typeof e.from === "string");
      } catch {
        console.error(`tracker: ${file} is not a list the tracker wrote, so it starts empty`);
        return [];
      }
    },
    async save(entries) {
      let body: string;
      try {
        body = JSON.stringify({ version: 1, entries });
      } catch (e) {
        console.error(`tracker: cannot write ${file}: ${(e as Error).message}`);
        return;
      }
      try {
        mkdirSync(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, body, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      } catch (e) {
        console.error(`tracker: cannot write ${file}: ${(e as Error).message}`);
      }
    },
  };
}

const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), "hex");
const hex = (b: Buffer | null): string | null => (b === null ? null : "0x" + b.toString("hex"));
const at = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

interface Row {
  tx_hash: Buffer; raw: Buffer | null; sender: Buffer; nonce: string; open: boolean; sends: number; refusals: number;
  last_sent_at: Date; settled_at: Date | null; added_at: Date | null; state: string; reason: string | null;
  block_number: string | null; block_hash: Buffer | null; update_id: string | null; updated_at: Date;
}

const COLUMNS = "tx_hash, raw, sender, nonce, open, sends, refusals, last_sent_at, settled_at, added_at, state, reason, block_number, block_hash, update_id, updated_at";

function entryOf(r: Row): Entry {
  return {
    hash: "0x" + r.tx_hash.toString("hex"), raw: hex(r.raw), from: "0x" + r.sender.toString("hex"), nonce: Number(r.nonce),
    state: r.state as Entry["state"], reason: r.reason, block: r.block_number === null ? null : Number(r.block_number), blockHash: hex(r.block_hash),
    updateId: r.update_id, attempts: r.sends, refused: r.refusals, addedAt: (r.added_at ?? r.last_sent_at).getTime(), lastSendAt: r.last_sent_at.getTime(),
    settledAt: r.settled_at === null ? null : r.settled_at.getTime(), via: undefined,
  };
}

/** What changed in an entry, in a short string, so only entries that changed are written. */
const signature = (e: Entry): string => `${e.state}|${e.reason}|${e.block}|${e.blockHash}|${e.updateId}|${e.attempts}|${e.refused}|${e.raw === null}|${e.lastSendAt}|${e.settledAt}`;

const UPSERT = {
  head: `
  insert into tracked_transactions (tx_hash, raw, bytes, sender, nonce, open, sends, refusals, last_sent_at, settled_at, added_at, state, reason, block_number, block_hash, update_id, updated_at)
  select tx_hash, raw, bytes, sender, nonce, open, sends, refusals, last_sent_at, settled_at, added_at, state, reason, block_number, block_hash, update_id, now()
    from unnest($1::bytea[], $2::bytea[], $3::int[], $4::bytea[], $5::bigint[], $6::bool[], $7::int[], $8::int[], $9::timestamptz[], $10::timestamptz[], $11::timestamptz[], $12::text[], $13::text[], $14::bigint[], $15::bytea[], $16::text[])
      as t(tx_hash, raw, bytes, sender, nonce, open, sends, refusals, last_sent_at, settled_at, added_at, state, reason, block_number, block_hash, update_id)
  on conflict (tx_hash) do`,
  update: ` update set
    raw = excluded.raw, bytes = greatest(tracked_transactions.bytes, excluded.bytes),
    added_at = case when not tracked_transactions.open and excluded.open then excluded.added_at else tracked_transactions.added_at end, open = excluded.open, sends = excluded.sends, refusals = excluded.refusals,
    last_sent_at = excluded.last_sent_at, settled_at = excluded.settled_at, state = excluded.state, reason = excluded.reason, block_number = excluded.block_number,
    block_hash = excluded.block_hash, update_id = excluded.update_id, updated_at = now()`,
  keep: " nothing",
};

/**
 * The API's own columns of tx_lifecycle (section 4.6 of the design): when reth took the transaction and through which door, the sender
 * and nonce, the resends, and the state. `final` is terminal and beats every other word, whoever wrote it; anything else is
 * replaced by the newer word. The first accepted_at stays.
 */
const LIFECYCLE = `
  insert into tx_lifecycle (tx_hash, accepted_at, accepted_via, sender, nonce, state, state_reason, resends, drop_cause, updated_at)
  select tx_hash, accepted_at, accepted_via, sender, nonce, state, state_reason, resends, drop_cause, now()
    from unnest($1::bytea[], $2::timestamptz[], $3::text[], $4::bytea[], $5::bigint[], $6::text[], $7::text[], $8::int[], $9::text[])
      as t(tx_hash, accepted_at, accepted_via, sender, nonce, state, state_reason, resends, drop_cause)
  on conflict (tx_hash) do`;
const LIFECYCLE_UPDATE = ` update set
    accepted_at = coalesce(tx_lifecycle.accepted_at, excluded.accepted_at),
    accepted_via = coalesce(tx_lifecycle.accepted_via, excluded.accepted_via),
    sender = coalesce(tx_lifecycle.sender, excluded.sender),
    nonce = coalesce(tx_lifecycle.nonce, excluded.nonce),
    resends = excluded.resends,
    -- Only a dropped transaction has a cause; one dropped before the cause was kept (an entry read back from the list) keeps what it had.
    drop_cause = case when tx_lifecycle.state <> 'final' and excluded.state = 'dropped' then coalesce(excluded.drop_cause, tx_lifecycle.drop_cause) else null end,
    state = case when tx_lifecycle.state = 'final' then 'final' else excluded.state end,
    state_reason = case when tx_lifecycle.state = 'final' then tx_lifecycle.state_reason else excluded.state_reason end,
    updated_at = now()`;
/** An import leaves a lifecycle row that exists alone, so a second import never rolls a state back. */
const LIFECYCLE_KEEP = " nothing";

/** The list in the explorer's database. Writes are batches of changed entries. Rows are never deleted by the tracker; retention removes them. */
export function databaseTrackerStore(pool: Pool, max: number): TrackerStore {
  const written = new Map<string, string>();
  let cursor: Date | null = null;

  async function write(entries: Entry[], keepExisting: boolean): Promise<void> {
    if (!entries.length) return;
    const c = await pool.connect();
    try {
      await c.query("begin");
      const col = <T>(f: (e: Entry) => T): T[] => entries.map(f);
      const open = (e: Entry) => e.state === "pending" || e.state === "proving";
      const params = [
        col((e) => bytes(e.hash)), col((e) => (e.raw ? bytes(e.raw) : null)), col((e) => (e.raw ? (e.raw.length - 2) / 2 : 0)), col((e) => bytes(e.from)), col((e) => e.nonce),
        col(open), col((e) => e.attempts), col((e) => e.refused), col((e) => at(e.lastSendAt)), col((e) => at(e.settledAt)), col((e) => at(e.addedAt)), col((e) => e.state),
        col((e) => e.reason), col((e) => e.block), col((e) => (e.blockHash ? bytes(e.blockHash) : null)), col((e) => e.updateId),
      ];
      await c.query(UPSERT.head + (keepExisting ? UPSERT.keep : UPSERT.update), params);
      await c.query(LIFECYCLE + (keepExisting ? LIFECYCLE_KEEP : LIFECYCLE_UPDATE), [
        col((e) => bytes(e.hash)), col((e) => at(e.addedAt)), col((e) => e.via ?? null), col((e) => bytes(e.from)), col((e) => e.nonce), col((e) => e.state), col((e) => e.reason),
        col((e) => Math.max(0, e.attempts - 1)), col((e) => (e.state === "dropped" ? e.cause ?? null : null)),
      ]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  return {
    async load() {
      const { rows } = await pool.query<Row>(
        `with open as (select ${COLUMNS} from tracked_transactions where open),
              settled as (select ${COLUMNS} from tracked_transactions where not open order by settled_at desc nulls last limit $1)
         select * from (select * from open union all select * from settled) o order by coalesce(added_at, last_sent_at)`,
        [Math.max(0, max)],
      );
      cursor = rows.reduce<Date | null>((m, r) => (m === null || r.updated_at > m ? r.updated_at : m), null) ?? (await pool.query<{ now: Date }>("select now() as now")).rows[0]!.now;
      const entries = rows.map(entryOf);
      for (const e of entries) written.set(e.hash, signature(e));
      return entries;
    },
    async save(entries) {
      // The list handed over is the bounded truth: what it no longer holds is forgotten here too.
      if (written.size > entries.length) { const keep = new Set(entries.map((e) => e.hash)); for (const h of written.keys()) if (!keep.has(h)) written.delete(h); }
      const changed = entries.filter((e) => written.get(e.hash) !== signature(e));
      if (!changed.length) return;
      // The entries change in place while a write is on its way, so what is written, and what is marked as written, is one copy.
      const copy = changed.map((e) => ({ ...e }));
      try {
        await write(copy, false);
        for (const e of copy) written.set(e.hash, signature(e));
      } catch (e) {
        console.error(`tracker: cannot write the database: ${(e as Error).message}`);
      }
    },
    remembered: () => written.size,
    async changes() {
      // A little before the last reading: a row that committed late, with an older time, is read once more instead of missed.
      const { rows } = await pool.query<Row>(`select ${COLUMNS} from tracked_transactions where updated_at > $1::timestamptz - interval '${READ_BACK_SECONDS} seconds' order by updated_at`, [cursor ?? new Date(0)]);
      for (const r of rows) if (cursor === null || r.updated_at > cursor) cursor = r.updated_at;
      const adopted = rows.map(entryOf).filter((e) => written.get(e.hash) !== signature(e));
      for (const e of adopted) written.set(e.hash, signature(e));
      return adopted;
    },
    async importEntries(entries) {
      const fresh = entries.filter((e) => /^0x[0-9a-f]+$/.test(e.hash) && /^0x[0-9a-f]{40}$/.test(e.from));
      await write(fresh, true);
      return fresh.length;
    },
    async purge(now) {
      await pool.query("update tracked_transactions set raw = null where raw is not null and not open and settled_at < $1", [new Date(now - RAW_KEPT_MS)]);
    },
  };
}
