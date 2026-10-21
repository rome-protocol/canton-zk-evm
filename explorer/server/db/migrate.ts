/**
 * The explorer's schema is a set of numbered SQL files in explorer/db/migrations/. This runner applies the ones a database has not
 * seen, in order, each in its own transaction, and writes the SHA-256 of every file it applied into schema_migrations.
 *
 * It refuses, and applies nothing, when the database and the files disagree: a file that was changed after it was applied, an
 * applied version whose file is gone, or files that skip a number. Run twice, the second run changes nothing. Two runners started
 * together take turns (an advisory lock), so the second finds the work done.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** Any fixed number; it only has to be the same for every runner of this schema. */
const LOCK_KEY = 7_207_371_001;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: Buffer;
}

export class MigrationError extends Error {}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const found: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const m = FILE.exec(file);
    if (!m) throw new MigrationError(`${file}: a migration is named NNNN_name.sql, with four digits and lowercase letters, digits or _`);
    const bytes = readFileSync(`${dir}/${file}`);
    found.push({ version: Number(m[1]), name: m[2] as string, sql: bytes.toString("utf8"), checksum: createHash("sha256").update(bytes).digest() });
  }
  found.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`the migrations skip or repeat a number: expected ${i + 1}, found ${m.version} (${m.name})`);
  });
  return found;
}

export interface MigrateResult {
  /** The versions applied by this run. */
  applied: number[];
  /** How many were there already, with the checksum their file still has. */
  unchanged: number;
}

export async function migrate(pool: Pool, migrations: Migration[] = loadMigrations()): Promise<MigrateResult> {
  const db = await pool.connect();
  try {
    await db.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    // The one table the runner makes itself: it has to exist before the first file can be recorded.
    await db.query(
      "create table if not exists schema_migrations (version integer primary key, checksum bytea not null, applied_at timestamptz not null)",
    );
    const { rows } = await db.query<{ version: number; checksum: Buffer }>("select version, checksum from schema_migrations order by version");
    const known = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const version of known.keys()) {
      const file = migrations.find((m) => m.version === version);
      if (!file) throw new MigrationError(`the database has migration ${version} applied, but there is no file for it: this code is older than the database`);
      if (!file.checksum.equals(known.get(version) as Buffer)) {
        throw new MigrationError(`migration ${version} (${file.name}) was changed after it was applied: write a new migration instead`);
      }
    }
    const applied: number[] = [];
    for (const m of migrations) {
      if (known.has(m.version)) continue;
      try {
        await db.query("begin");
        await db.query(m.sql);
        await db.query("insert into schema_migrations (version, checksum, applied_at) values ($1, $2, now())", [m.version, m.checksum]);
        await db.query("commit");
      } catch (e) {
        await db.query("rollback").catch(() => undefined);
        throw new MigrationError(`migration ${m.version} (${m.name}) failed and was rolled back: ${(e as Error).message}`);
      }
      applied.push(m.version);
    }
    return { applied, unchanged: known.size };
  } finally {
    await db.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    db.release();
  }
}
