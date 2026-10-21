/**
 * How the explorer reaches its database. EXPLORER_DATABASE_URL names it outright. Otherwise the parts: host, port, user and database
 * (127.0.0.1, 5433, explorer, explorer: what network/explorer-db.sh starts), with the password read from the file that script
 * made (EXPLORER_DB_PASSWORD_FILE, a line POSTGRES_PASSWORD=...), so that it is never on a command line or in a log.
 */
import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";

type Env = Record<string, string | undefined>;

export function connectionConfig(env: Env = process.env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): PoolConfig {
  if (env.EXPLORER_DATABASE_URL) return { connectionString: env.EXPLORER_DATABASE_URL };
  const file = env.EXPLORER_DB_PASSWORD_FILE;
  if (!file) throw new Error("set EXPLORER_DATABASE_URL, or EXPLORER_DB_PASSWORD_FILE with the other parts' defaults");
  const line = readFile(file).split("\n").find((l) => l.startsWith("POSTGRES_PASSWORD="));
  const password = line?.slice("POSTGRES_PASSWORD=".length).trim();
  if (!password) throw new Error(`${file} has no POSTGRES_PASSWORD line`);
  const port = Number(env.EXPLORER_DB_PORT ?? 5433);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`EXPLORER_DB_PORT is not a port: ${env.EXPLORER_DB_PORT}`);
  return {
    host: env.EXPLORER_DB_HOST ?? "127.0.0.1",
    port,
    user: env.EXPLORER_DB_USER ?? "explorer",
    database: env.EXPLORER_DB_NAME ?? "explorer",
    password,
  };
}
