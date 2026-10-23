import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
const tx = read("tx.css"), block = read("block.css"), token = read("token.css"), styles = read("../styles.css");

/** The rules of a sheet outside any @media block: [selector, body]. A comma list is split into its selectors. */
function rules(css: string, media = false): [string, string][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: [string, string][] = [];
  const re = /([^{}]+)\{([^{}]*)\}|@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[3] !== undefined) { if (media) out.push(...rules(m[3], false)); continue; }
    if (!media) for (const s of m[1]!.split(",")) out.push([s.trim(), m[2]!.trim()]);
  }
  return out;
}
/** Specificity as [ids, classes + attributes + pseudo-classes, elements + pseudo-elements]. */
function spec(sel: string): [number, number, number] {
  const s = sel.replace(/::[a-z-]+/g, " el ").replace(/\[[^\]]*\]/g, ".a").replace(/:not\(([^)]*)\)/g, "$1");
  const pseudo = (s.match(/(?<!:):[a-z-]+/g) ?? []).length;
  const el = (s.match(/(^|[\s>+~])[a-z][a-z0-9]*/gi) ?? []).length;
  return [(s.match(/#[\w-]+/g) ?? []).length, (s.match(/\.[\w-]+/g) ?? []).length + pseudo, el];
}
const beats = (a: [number, number, number], b: [number, number, number]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
/** What block.css's .how-steps selector for the same part of a step would be: the way-steps one with its second class taken off. */
const plain = (sel: string) => sel.replace(".how-steps.way-steps", ".how-steps").replace(".way-steps", ".how-steps");

describe("the way to final: tx.css wins over block.css whichever sheet comes last in the bundle", () => {
  it("never styles the steps with a bare .way-steps selector, which ties block.css's .how-steps", () => {
    const all = [...rules(tx), ...rules(tx, true)].map(([s]) => s).filter((s) => s.includes("way-steps"));
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(s, s).toContain(".how-steps.way-steps");
  });

  it("gives each way-steps rule more specificity than the how-steps rule it overrides", () => {
    const base = [...rules(block), ...rules(block, true)];
    let compared = 0;
    for (const [s] of [...rules(tx), ...rules(tx, true)].filter(([x]) => x.includes("way-steps"))) {
      const twin = base.find(([b]) => b === plain(s));
      if (!twin) continue;
      compared++;
      expect(beats(spec(s), spec(twin[0])), `${s} vs ${twin[0]}`).toBe(true);
    }
    expect(compared).toBeGreaterThanOrEqual(3);
  });

  it("lays the four steps out in four columns, not block.css's six", () => {
    const cols = rules(tx).find(([s]) => s === ".how-steps.way-steps")?.[1] ?? "";
    expect(cols).toContain("grid-template-columns: repeat(4, 1fr)");
    const base = rules(block).find(([s]) => s === ".how-steps")?.[1] ?? "";
    expect(base).toMatch(/grid-template-columns:\s*repeat\(6,\s*1fr\)/);
  });

  it("puts the step's dot above its name: room above the text, and the dot and the line lower than block.css's", () => {
    const get = (s: string) => rules(tx).find(([x]) => x === s)?.[1] ?? "";
    expect(get(".how-steps.way-steps li")).toMatch(/padding-top: 40px/);
    expect(get(".how-steps.way-steps .how-dot")).toMatch(/top: 22px/);
    expect(get(".how-steps.way-steps li::before")).toMatch(/top: 28px/);
  });
});

describe("the token page's cards", () => {
  it("lets a stat card shrink and wrap, so a long supply or address stays inside it", () => {
    const get = (s: string) => rules(token).find(([x]) => x === s)?.[1] ?? "";
    expect(get(".tok-stats .stat")).toMatch(/min-width: 0/);
    expect(get(".tok-stats .stat-v")).toMatch(/overflow-wrap: anywhere/);
    expect(get(".tok-stats .stat-v")).toMatch(/min-width: 0/);
  });
});

describe("the card header", () => {
  it("is small, in the shared sheet only: the title at 15px, the words beside it at 12.5px, over a line; tx.css keeps no copy", () => {
    const get = (s: string) => rules(styles).find(([x]) => x === s)?.[1] ?? "";
    expect(get(".card-title h2")).toMatch(/font-size: 15px/);
    expect(get(".card-title .muted")).toMatch(/font-size: 12.5px/);
    expect(get(".card-head")).toMatch(/border-bottom: 1px solid/);
    expect(tx).not.toMatch(/\.card-h\b/);
  });
});

describe("home: the hero's search box", () => {
  const home = read("home.css");
  it("sits under the intro from the left: no auto left margin, and a width the sheet that styles .search cannot cap at 600 px", () => {
    const own = rules(home).filter(([sel]) => /hero-search/.test(sel));
    expect(own).toHaveLength(1);
    const [sel, body] = own[0]!;
    expect(body).toMatch(/margin-left:\s*0\b/);
    expect(body).toMatch(/max-width:\s*900px/);
    // It beats the shared `.search` rule (max-width 600 px, margin-left auto) whichever sheet comes last.
    const shared = rules(styles).find(([s]) => s === ".search")!;
    expect(shared[1]).toMatch(/max-width:\s*600px/);
    expect(beats(spec(sel), spec(".search"))).toBe(true);
  });
});
