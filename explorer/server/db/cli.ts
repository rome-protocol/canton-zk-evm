/**
 * node server/db/cli.ts migrate [--head N] [--partition-width N]
 * Applies the migrations that are missing, then makes the partitions up to block N (default 0) and two ahead. Safe to run again.
 */
import { Pool } from "pg";
import { connectionConfig } from "./connect.ts";
import { migrate } from "./migrate.ts";
import { ensurePartitions } from "./partitions.ts";

function numberFlag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} needs a whole number`);
  return n;
}

async function main(args: string[]): Promise<void> {
  if (args[0] !== "migrate") throw new Error("usage: node server/db/cli.ts migrate [--head N] [--partition-width N]");
  const pool = new Pool(connectionConfig());
  try {
    const r = await migrate(pool);
    console.log(r.applied.length ? `applied migrations ${r.applied.join(", ")}` : `no new migrations (${r.unchanged} applied already)`);
    const made = await ensurePartitions(pool, { head: numberFlag(args, "--head") ?? 0, width: numberFlag(args, "--partition-width") });
    console.log(made.length ? `made ${made.length} partitions` : "partitions are in place");
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`explorer db: ${e.message}`);
  process.exit(1);
});
