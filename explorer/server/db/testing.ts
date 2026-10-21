/** For the database tests: a database of its own for each test, made and dropped through EXPLORER_TEST_DATABASE_URL. */
import { randomBytes } from "node:crypto";
import pg from "pg";

export const TEST_URL = process.env.EXPLORER_TEST_DATABASE_URL;

/** A pull-request job that must run the database tests sets EXPLORER_TEST_REQUIRE_DATABASE=1, so that a missing database fails instead of skipping. */
export function checkRequired(): void {
  if (process.env.EXPLORER_TEST_REQUIRE_DATABASE === "1" && !TEST_URL) throw new Error("EXPLORER_TEST_DATABASE_URL is not set, and this run needs it");
}

export interface TestDatabase { pool: pg.Pool; url: string; drop(): Promise<void> }

/** A database of its own, with the migrations applied when `migrated` is set. Drop it when the test is over. */
export async function makeDatabase(migrated = false): Promise<TestDatabase> {
  const admin = new pg.Pool({ connectionString: TEST_URL, max: 1 });
  const name = `explorer_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${name}`);
  const url = new URL(TEST_URL as string);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  // The database is dropped with force right after the pool ends. A connection that the server closes a moment before the client has
  // finished with it would otherwise be an uncaught error after the test is over.
  pool.on("error", () => undefined);
  if (migrated) {
    const { migrate } = await import("./migrate.ts");
    await migrate(pool);
  }
  return {
    pool, url: url.toString(),
    async drop() {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

export async function withDatabase(fn: (pool: pg.Pool, url: string) => Promise<void>): Promise<void> {
  const db = await makeDatabase();
  try {
    await fn(db.pool, db.url);
  } finally {
    await db.drop();
  }
}

/**
 * The tracker's and the faucet's tests run twice: with a file, and, when EXPLORER_TEST_STORE=database (and a database is set), with
 * the database in the file's place. The ones that look inside a file are for the file only.
 */
export const DATABASE_MODE = process.env.EXPLORER_TEST_STORE === "database";
