import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The files that make and use the Bridge account made from a wallet signature (the key, its store, the topology check, the signing of a prepared transaction, the account service's client, sign-in, send) are reached
 * only through `import()`s in derived.ts, which a build without the account drops. So no file the Bridge page loads with a plain `import` (a type import is erased, and does not count) may reach one of them: if one did,
 * a build without the account would carry the key code. The browser test (e2e/bridge-off.test.ts) looks for the same thing in the built pages.
 */
const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_FILES = ["bridge/account.ts", "bridge/send.ts", "bridge/canton/key.ts", "bridge/canton/keystore.ts", "bridge/canton/topology.ts", "bridge/canton/sign.ts", "bridge/canton/accounts.ts"];
const STATIC = /^\s*(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/gm;

function staticImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of text.matchAll(STATIC)) if (m[1]!.startsWith(".")) found.push(resolve(dirname(file), m[1]!));
  // Multi-line imports: `import {\n a,\n b,\n} from "./x.ts"`.
  for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)\{[^}]*\}\s*from\s+["']([^"']+)["']/gm)) if (m[1]!.startsWith(".")) found.push(resolve(dirname(file), m[1]!));
  return found;
}
/** Every file reached from `entry` through plain imports, with the path that reached it. */
function reach(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const next of staticImports(file)) {
      if (!/\.(ts|tsx)$/.test(next) || seen.has(next)) continue;
      try { readFileSync(next); } catch { continue; }
      seen.set(next, [...seen.get(file)!, next]);
      queue.push(next);
    }
  }
  return seen;
}

describe("what the Bridge page loads in every build", () => {
  const reached = reach(resolve(src, "pages/Bridge.tsx"));
  it("does reach the move's code, so the walk is looking at the right files", () => {
    for (const f of ["bridge/moves/moves.ts", "bridge/canton/answers.ts", "bridge/derived.ts", "bridge/retired.ts", "bridge/wallet/wallets.ts"]) expect(reached.has(resolve(src, f)), f).toBe(true);
  });
  it("reaches none of the Bridge account's files with a plain import", () => {
    for (const f of ACCOUNT_FILES) {
      const path = reached.get(resolve(src, f));
      expect(path ? path.map((p) => p.slice(src.length + 1)).join(" -> ") : null, f).toBeNull();
    }
  });
  it("reaches them from derived.ts only through import(): the file that holds those is not a plain import of them", () => {
    const text = readFileSync(resolve(src, "bridge/derived.ts"), "utf8");
    expect(text).not.toMatch(/^\s*(?:import|export)\s+(?!type\b)[^;]*from\s+["']\.\/(?:account|send|canton\/key|canton\/keystore)\.ts["']/m);
    expect(text.match(/if \(__BRIDGE_ACCOUNT__\) return import\("\.\/[^"]+"\);/g)?.length).toBe(3);   // each is behind the build's constant
  });
});
