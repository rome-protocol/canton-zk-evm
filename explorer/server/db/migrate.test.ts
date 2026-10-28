import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MigrationError, loadMigrations, migrate } from "./migrate.ts";
import { describeSchema } from "./schema-snapshot.ts";
import { TEST_URL, checkRequired, withDatabase } from "./testing.ts";

const SNAPSHOT = new URL("../../db/schema.snapshot.txt", import.meta.url);

// Every table of the design's schema, by name. A migration that drops one must change this list on purpose.
const TABLES = [
  "abi_fragments", "addresses", "attempt_transactions", "block_attempts", "block_records", "blocks", "bytecodes", "canton_funded_claims", "canton_gateway_tokens", "canton_participants",
  "canton_parties", "canton_registry", "canton_synchronizers", "canton_templates", "canton_updates", "canton_venue_cursor", "canton_venue_trades", "coin_balance_history", "contracts", "cursors",
  "faucet_batches", "faucet_daily_counts", "faucet_refusals", "faucet_refusals_since", "faucet_requests", "gateway_legs", "gateway_tokens", "health_checks", "internal_calls", "logs", "meta", "nft_owners", "pool_samples",
  "producer_runs", "proofs", "proxies", "schema_migrations", "stats_day", "stats_dirty", "stats_hour", "stats_minute", "token_balances",
  "token_transfers", "tokens", "tracked_transactions", "transactions", "tx_hashes", "tx_lifecycle", "tx_traces", "verification_jobs",
  "verified_sources",
];

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("the migration files", () => {
  it("are numbered from 1 with no gap, and each has a checksum", () => {
    const all = loadMigrations();
    expect(all.length).toBeGreaterThan(5);
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1));
    expect(new Set(all.map((m) => m.checksum.toString("hex"))).size).toBe(all.length);
  });

  it("are refused when a number is skipped, repeated or a name is wrong", () => {
    expect(() => loadMigrations(folder({ "0001_a.sql": "select 1", "0003_b.sql": "select 1" }))).toThrow(/skip or repeat/);
    expect(() => loadMigrations(folder({ "0001_a.sql": "select 1", "0001_b.sql": "select 1" }))).toThrow(/skip or repeat/);
    expect(() => loadMigrations(folder({ "1_a.sql": "select 1" }))).toThrow(/NNNN_name.sql/);
  });

  it("give the same checksum for the same bytes and another for a changed byte", () => {
    const a = loadMigrations(folder({ "0001_a.sql": "select 1" }))[0]!;
    const b = loadMigrations(folder({ "0001_a.sql": "select 1" }))[0]!;
    const c = loadMigrations(folder({ "0001_a.sql": "select 2" }))[0]!;
    expect(a.checksum.equals(b.checksum)).toBe(true);
    expect(a.checksum.equals(c.checksum)).toBe(false);
  });
});

describe.skipIf(!TEST_URL)("the migration runner, on the pinned PostgreSQL", () => {
  checkRequired();

  it("applies every migration to an empty database, and again with no change", async () => {
    await withDatabase(async (pool) => {
      const files = loadMigrations();
      const first = await migrate(pool);
      expect(first).toEqual({ applied: files.map((m) => m.version), unchanged: 0 });
      const tables = await pool.query<{ relname: string }>(
        "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by relname",
      );
      expect(tables.rows.map((r) => r.relname)).toEqual(TABLES);
      const recorded = await pool.query<{ version: number; checksum: Buffer }>("select version, checksum from schema_migrations order by version");
      expect(recorded.rows.map((r) => [r.version, r.checksum.toString("hex")])).toEqual(files.map((m) => [m.version, m.checksum.toString("hex")]));

      const before = await describeSchema(pool);
      const again = await migrate(pool);
      expect(again).toEqual({ applied: [], unchanged: files.length });
      expect(await describeSchema(pool)).toBe(before);
    });
  });

  it("matches the committed snapshot of the schema (UPDATE_SNAPSHOT=1 rewrites it)", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      const now = await describeSchema(pool);
      if (process.env.UPDATE_SNAPSHOT === "1") writeFileSync(SNAPSHOT, now);
      expect(now).toBe(readFileSync(SNAPSHOT, "utf8"));
    });
  });

  it("refuses a migration that was changed after it was applied, and applies nothing more", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool, loadMigrations(folder({ "0001_a.sql": "create table one (id int)" })));
      const changed = folder({ "0001_a.sql": "create table one (id bigint)", "0002_b.sql": "create table two (id int)" });
      await expect(migrate(pool, loadMigrations(changed))).rejects.toThrow(/migration 1 \(a\) was changed/);
      expect((await pool.query("select to_regclass('two') as t")).rows[0].t).toBeNull();
    });
  });

  it("refuses a database that is ahead of the files", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool, loadMigrations(folder({ "0001_a.sql": "select 1", "0002_b.sql": "select 1" })));
      await expect(migrate(pool, loadMigrations(folder({ "0001_a.sql": "select 1" })))).rejects.toThrow(/no file for it/);
    });
  });

  it("rolls a failing migration back whole and does not record it", async () => {
    await withDatabase(async (pool) => {
      const bad = folder({ "0001_a.sql": "create table ok (id int)", "0002_b.sql": "create table half (id int); select 1/0" });
      await expect(migrate(pool, loadMigrations(bad))).rejects.toThrow(MigrationError);
      expect((await pool.query("select to_regclass('half') as t")).rows[0].t).toBeNull();
      expect((await pool.query("select version from schema_migrations")).rows).toEqual([{ version: 1 }]);
    });
  });

  it("lets two runners start together: one applies, the other finds it done", async () => {
    await withDatabase(async (pool) => {
      const [a, b] = await Promise.all([migrate(pool), migrate(pool)]);
      const total = loadMigrations().length;
      expect([a.applied.length, b.applied.length].sort((x, y) => x - y)).toEqual([0, total]);
    });
  });
});

describe.skipIf(!TEST_URL)("the migration that gives back the dictionary ids", () => {
  checkRequired();
  const TABLES = ["canton_synchronizers", "canton_templates", "canton_parties", "canton_participants"];
  const RESTART = loadMigrations().find((m) => m.name.includes("dictionary_id_restart"))!;
  const next = async (pool: import("pg").Pool, t: string) => Number((await pool.query(`select nextval(pg_get_serial_sequence('${t}', 'id')) as n`)).rows[0].n);

  it("restarts a sequence that burned its ids just above the highest id in use, and does nothing when run again", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      await pool.query("insert into canton_synchronizers (synchronizer_id, first_seen) values ('s', now())");
      await pool.query("insert into canton_parties (party, role) values ('a', 'operator'), ('b', 'confirmer')");
      // Burn ids the way the old insert did: an id taken with no row added.
      for (let i = 0; i < 500; i++) await next(pool, "canton_parties");
      await pool.query("select setval(pg_get_serial_sequence('canton_templates', 'id'), 300)");
      await pool.query(RESTART.sql);
      await pool.query(RESTART.sql);
      expect(await next(pool, "canton_parties")).toBe(3);
      expect(await next(pool, "canton_synchronizers")).toBe(2);
      // An empty table starts again at 1, whatever its sequence had reached.
      expect(await next(pool, "canton_templates")).toBe(1);
      expect(await next(pool, "canton_participants")).toBe(1);
      for (const t of TABLES) expect(Number((await pool.query(`select count(*) as n from ${t}`)).rows[0].n)).toBeLessThanOrEqual(2);
    });
  });
});
