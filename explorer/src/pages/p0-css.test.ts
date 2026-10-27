import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
const contract = read("contract.css"), apiDocs = read("api-docs.css");
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
    expect(get(".how-steps.way-steps .how-dot")).toMatch(/top: 18px/);
    // The tick is the ink of a filled accent (white in light, dark in dark), not a fixed white that is faint on the pale dark-mode circles.
    expect(get(".how-steps.way-steps .how-dot")).toMatch(/color: var\(--btn-ink\)/);
    expect(get(".how-steps.way-steps .how-dot")).not.toMatch(/#fff/i);
    expect(get(".how-steps.way-steps li::before")).toMatch(/top: 29px/);
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
  it("is small, in the shared sheet only: the title at 18px, the words beside it at 12.5px, over a line; tx.css keeps no copy", () => {
    const get = (s: string) => rules(styles).find(([x]) => x === s)?.[1] ?? "";
    expect(get(".card-title h2")).toMatch(/font-size: 18px/);
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

describe("the transaction page on a phone, as screen 14 has it", () => {
  const block = (width: number) => { const m = new RegExp(`@media \\(max-width: ${width}px\\) \\{([\\s\\S]*?)\\n\\}`).exec(tx); return m ? m[1]! : ""; };
  const body = (css: string, sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  it("shows no delta under a step's time", () => {
    expect(body(block(900), ".how-steps.way-steps .way-delta")).toMatch(/display:\s*none/);
  });
  it("sets the footer's lines one under another, left-aligned", () => {
    expect(body(block(900), ".way-foot-l, .way-foot-r")).toMatch(/text-align:\s*left/);
    expect(body(block(900), ".way-foot")).toMatch(/flex-direction:\s*column/);
  });
  it("stacks each argument of the input data instead of scrolling a table sideways", () => {
    const phone = block(720);
    expect(body(phone, ".args-table thead")).toMatch(/display:\s*none/);
    expect(body(phone, ".args-table tr")).toMatch(/display:\s*grid/);
    expect(body(phone, ".args-table td:nth-child(4)")).toMatch(/grid-column:\s*1 \/ -1/);
  });
});

describe("final polish: the 21-screen check", () => {
  const home = read("home.css"), api = read("api-docs.css");
  const get = (css: string, sel: string, media = false) => rules(css, media).find(([x]) => x === sel)?.[1] ?? "";

  it("tints the Lost card green with a rule that beats the shared .card, whichever sheet comes last", () => {
    const tint = rules(home).find(([s]) => s.includes("stat-ok"))!;
    expect(tint[1]).toMatch(/background:\s*var\(--ok-tint\)/);
    expect(beats(spec(tint[0]), spec(".card"))).toBe(true);
  });

  it("lets a figure break only at its commas (the <wbr> points) unless one group alone is wider than the card, and keeps `anywhere` for the hashes", () => {
    expect(get(token, ".tok-stats .stat-v:not(.stat-hash)")).toMatch(/overflow-wrap:\s*break-word/);
    expect(get(token, ".tok-stats .stat-v")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps the token page's supply in one piece on a phone: a smaller figure, not a break inside the number", () => {
    expect(get(token, ".tok-stats .stat-v:not(.stat-hash)", true)).toMatch(/font-size:\s*(2[0-4]px|clamp\()/);
  });

  it("wraps the API page's method chips on a phone instead of cutting them", () => {
    expect(get(api, ".mchip")).toMatch(/max-width:\s*100%/);
    expect(get(api, ".mchip")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(get(api, ".api-table td")).toMatch(/min-width:\s*0/);
    expect(get(api, ".api-eth-main .api-table td", true)).toMatch(/display:\s*block/);
  });

  it("lets the wallet table's cells shrink to the card (anywhere, the last resort after the <wbr> break points), so no width needs a sideways scroll", () => {
    expect(get(api, ".api-details td")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("sets the wallet URLs in a 12px mono and gives the wallet column room, so each fits one line at laptop widths", () => {
    expect(get(api, ".api-details .mono")).toMatch(/font-size:\s*12px/);
    expect(get(api, ".api-lower")).toMatch(/minmax\(0, 1\.5fr\) minmax\(0, 1fr\)/);
  });
});

describe("the address page's direction tag and the transaction page's way-to-final card do not share a class", () => {
  const sheets = readdirSync(join(import.meta.dirname, "..")).concat(readdirSync(import.meta.dirname).map((f) => `pages/${f}`))
    .filter((f) => f.endsWith(".css")).map((f) => [f, read(`../${f}`)] as const);
  const classesOfLast = (sel: string) => (sel.trim().split(/[\s>+~]+/).pop()!.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
  const all = (css: string) => [...rules(css), ...rules(css, true)];

  it("styles the .way class only in tx.css, where the card is", () => {
    for (const [f, css] of sheets) {
      if (f === "pages/tx.css") continue;
      for (const [s] of all(css)) expect(s, `${f}: ${s}`).not.toMatch(/\.way(?![\w-])/);
    }
  });

  it("has no rule of the tag's that an element with the card's classes (card way) can match", () => {
    const address = all(read("address.css"));
    expect(address.some(([s]) => s === ".dir-tag")).toBe(true);
    for (const [s] of address) {
      const cls = classesOfLast(s);
      expect(cls.includes("way") && cls.every((c) => c === "card" || c === "way"), s).toBe(false);
    }
    expect(read("AddressTabs.tsx")).not.toMatch(/className="[^"]*\bway\b/);
  });
});

describe("narrow screens, 320 to 360 px", () => {
  it("lets the contract's ABI and settings cards shrink below 340 px, as .api-two does", () => {
    const pair = rules(contract).find(([x]) => x === ".code-pair")?.[1] ?? "";
    expect(pair).toMatch(/minmax\(min\(340px, 100%\), 1fr\)/);
    expect(pair).not.toMatch(/minmax\(340px/);
    expect(rules(contract).find(([x]) => x === ".code-pair > *")?.[1] ?? "").toMatch(/min-width: 0/);
  });

  it("lets the Etherscan card's address line break anywhere, so it cannot widen the page", () => {
    const get = (s: string) => rules(apiDocs).find(([x]) => x === s)?.[1] ?? "";
    expect(get(".api-eth .card-title .muted")).toMatch(/overflow-wrap: anywhere/);
    expect(get(".api-eth .card-title")).toMatch(/min-width: 0/);
  });
});

describe("the way-to-final card against screen 05", () => {
  const get = (s: string) => rules(tx).find(([x]) => x === s)?.[1] ?? "";
  it("draws a hairline under the title row, reaching the card's edges like the shared card header", () => {
    const h = get(".way > .sec-h");
    expect(h).toMatch(/border-bottom: 1px solid var\(--line-2\)/);
    expect(h).toMatch(/margin: -18px -20px 14px/);
    expect(h).toMatch(/padding: 14px 20px/);
  });
  it("tints the footer lighter than the page's accent tint", () => {
    const f = get(".way-foot");
    expect(f).not.toMatch(/background: var\(--canton-tint\)/);
    expect(f).toMatch(/background: color-mix\(in srgb, var\(--canton-tint\) \d+%, transparent\)/);
  });
});
