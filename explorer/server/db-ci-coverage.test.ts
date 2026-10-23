import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A test that needs the database is skipped where there is none (the `tests` job has none). So every such file must be run by a CI job that has the
// database, or it is never run at all. This reads the workflow and fails for a file that reads the database and that no such job's command line reaches.

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = join(ROOT, "..", ".github", "workflows", "explorer.yml");
const READS_DATABASE = /EXPLORER_TEST_DATABASE_URL|EXPLORER_TEST_REQUIRE_DATABASE|EXPLORER_TEST_STORE|\bTEST_URL\b|db\/testing/;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (name === "node_modules") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) testFiles(rel, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

/** The jobs that give their tests a database (they set EXPLORER_TEST_DATABASE_URL), and each `vitest run` command line in them: its filters and its excludes. */
export function databaseCommands(workflow: string): { filters: string[]; excludes: string[] }[] {
  const jobs = workflow.split(/\n(?=  [a-z0-9-]+:\s*$)/m).filter((j) => j.includes("EXPLORER_TEST_DATABASE_URL="));
  const commands: { filters: string[]; excludes: string[] }[] = [];
  for (const job of jobs) {
    for (const m of job.matchAll(/vitest run([^&"\n]*)/g)) {
      const tokens = m[1]!.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^'|'$/g, ""));
      const filters: string[] = [], excludes: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === "--exclude") excludes.push(tokens[++i]!.replace(/\/\*\*$/, ""));
        else if (!tokens[i]!.startsWith("--")) filters.push(tokens[i]!);
      }
      commands.push({ filters, excludes });
    }
  }
  return commands;
}

/** The files that read the database and that no database job's command reaches. A filter matches a path that contains it, as vitest's does. */
export function uncovered(files: string[], commands: { filters: string[]; excludes: string[] }[]): string[] {
  return files.filter((f) => !commands.some((c) => c.filters.some((x) => f.includes(x)) && !c.excludes.some((x) => f.startsWith(x))));
}

describe("every test that needs the database runs in a CI job that has one", () => {
  const commands = databaseCommands(readFileSync(WORKFLOW, "utf8"));
  const readers = [...testFiles("server"), ...testFiles("test")].filter((f) => READS_DATABASE.test(readFileSync(join(ROOT, f), "utf8")));

  it("finds the database jobs' command lines and the files that read the database", () => {
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(readers).toContain("server/faucet-refusals.test.ts");
    expect(readers).toContain("server/storage.test.ts");
  });

  it("leaves no file that reads the database outside those command lines", () => {
    expect(uncovered(readers, commands)).toEqual([]);
  });

  it("would say so if a file were left out (the check can fail)", () => {
    const fixed = [{ filters: ["server/db", "server/storage.test.ts"], excludes: [] }];
    expect(uncovered(["server/db/migrate.test.ts", "server/faucet-refusals.test.ts"], fixed)).toEqual(["server/faucet-refusals.test.ts"]);
    const all = [{ filters: ["server"], excludes: ["server/verifier"] }];
    expect(uncovered(["server/faucet-refusals.test.ts", "server/verifier/api.test.ts"], all)).toEqual(["server/verifier/api.test.ts"]);
  });
});
