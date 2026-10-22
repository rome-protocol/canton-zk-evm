import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The PostgreSQL image declares a volume for its data, so a container started without --rm and removed without -v leaves an anonymous
// volume behind on every run. Every script and job that starts a throwaway PostgreSQL for the tests removes it with its container.
// (network/explorer-db.sh is not one of them: its data lives in a named volume on purpose, and `wipe` removes that volume by name.)
const ROOT = resolve(import.meta.dirname, "../..");
const FILES = ["tests/demo_rehearsal.sh", ".github/workflows/explorer.yml"];

/** The text with each backslash-continued command on one line. */
const commands = (text: string): string[] => text.replace(/\\\r?\n\s*/g, " ").split("\n");

/** The throwaway PostgreSQL containers a file starts: the whole `docker run` command, and the --name it gives. */
export function postgresRuns(text: string): { cmd: string; name: string }[] {
  return commands(text).filter((l) => /\bdocker run\b/.test(l) && /POSTGRES_IMAGE/.test(l)).map((cmd) => ({ cmd, name: /--name\s+(\S+)/.exec(cmd)?.[1] ?? "" }));
}

/** True where the file removes the named container with `docker rm` and both -f and -v (together or apart). */
export function removedWithVolume(text: string, name: string): boolean {
  return commands(text).some((l) => {
    const m = /\bdocker rm\b(.*)/.exec(l);
    if (!m || !m[1]!.split(/\s+/).includes(name)) return false;
    const flags = m[1]!.split(/\s+/).filter((w) => /^-[a-z]+$/.test(w)).join("");
    return flags.includes("f") && flags.includes("v");
  });
}

describe("the PostgreSQL containers the tests start", () => {
  for (const file of FILES) {
    it(`${file}: each one leaves no volume behind`, () => {
      expect(existsSync(resolve(ROOT, file)), `${file} is not there`).toBe(true);
      const text = readFileSync(resolve(ROOT, file), "utf8");
      const runs = postgresRuns(text);
      expect(runs.length, `${file} starts no PostgreSQL: the check is looking in the wrong place`).toBeGreaterThan(0);
      for (const { cmd, name } of runs) {
        const rm = /\s--rm(\s|$)/.test(cmd);
        expect(rm || (name !== "" && removedWithVolume(text, name)), `${name || cmd}: start it with --rm, or remove it with docker rm -f -v`).toBe(true);
      }
    });
  }

  it("the check itself tells a leak from a clean start", () => {
    const leaky = "docker run -d --name a \\\n  -e X=1 \"$POSTGRES_IMAGE\"\ndocker rm -f a\n";
    expect(postgresRuns(leaky)).toEqual([{ cmd: expect.stringContaining("--name a"), name: "a" }]);
    expect(removedWithVolume(leaky, "a")).toBe(false);
    expect(removedWithVolume("docker rm -f -v a", "a")).toBe(true);
    expect(removedWithVolume("docker rm -fv a >/dev/null", "a")).toBe(true);
    expect(removedWithVolume("docker rm -f -v b", "a")).toBe(false);
    expect(/\s--rm(\s|$)/.test(postgresRuns("docker run -d --rm --name a \"$POSTGRES_IMAGE\"")[0]!.cmd)).toBe(true);
  });
});
