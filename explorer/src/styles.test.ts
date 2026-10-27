import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|css|html)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

function darkOf(c: string): string {
  return /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(c)?.[1] ?? "";
}

describe("themes", () => {
  const tokens = ["--bg", "--surface", "--ink", "--muted", "--link", "--evm", "--canton", "--ok", "--bad", "--amber"];
  const dark = darkOf(css);

  it("defines the colours once for light and again for dark, which follows the system setting", () => {
    const light = /:root \{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const t of tokens) {
      expect(light, `light ${t}`).toContain(`${t}:`);
      expect(dark, `dark ${t}`).toContain(`${t}:`);
    }
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
  });

  it("has no switch of its own: nothing reads or stores a theme choice", () => {
    for (const f of sources(join(root, "src"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/data-theme|localStorage|sessionStorage/);
  });
});

describe("fonts and outside requests", () => {
  it("serves its fonts from the explorer: every font file the styles name is in public/fonts, with its licence, and only the weights used", () => {
    const files = [...css.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(files.sort()).toEqual([
      "/fonts/dm-sans-latin-400-normal.woff2", "/fonts/dm-sans-latin-500-normal.woff2", "/fonts/dm-sans-latin-600-normal.woff2",
      "/fonts/ibm-plex-mono-latin-400-normal.woff2", "/fonts/ibm-plex-mono-latin-500-normal.woff2",
      "/fonts/literata-latin-500-italic.woff2", "/fonts/literata-latin-500-normal.woff2",
    ]);
    for (const f of files) expect(existsSync(join(root, "public", f)), f).toBe(true);
    for (const l of ["Literata", "DM-Sans", "IBM-Plex-Mono"]) expect(readFileSync(join(root, `public/fonts/OFL-${l}.txt`), "utf8"), l).toMatch(/SIL Open Font License, Version 1\.1/);
    // nothing in public/fonts that the styles do not use
    const onDisk = readdirSync(join(root, "public/fonts")).filter((n) => n.endsWith(".woff2")).map((n) => `/fonts/${n}`);
    expect(onDisk.sort()).toEqual(files);
  });

  it("sets the wordmark, the headings and the big numbers in Literata 500 with its italic, and the text in DM Sans", () => {
    expect(css).toMatch(/@font-face \{ font-family: "Literata"; font-weight: 500; font-style: normal;/);
    expect(css).toMatch(/@font-face \{ font-family: "Literata"; font-weight: 500; font-style: italic;/);
    expect(css).toMatch(/\nh1, h2, \.name \{ font-family: "Literata", [^}]*font-weight: 500/);
    expect(/\nbody \{[^}]*\}/.exec(css)?.[0]).toContain('font-family: "DM Sans"');
    expect(/\nbody \{[^}]*\}/.exec(css)?.[0]).toContain("font-variant-numeric: tabular-nums");
    const rules = rulesOf(css);
    expect(winner(rules, [".stat-v"], "font-family", false)).toMatch(/Literata/);
    expect(winner(rules, [".stat-v"], "font-weight", false)).toBe("500");
    expect(winner(rules, [".card-title h2"], "font-family", false)).toMatch(/Literata/);
  });

  it("finishes the cards, the pages, the buttons and the search box the way the Rome site does: 20 px cards with a faint border and a soft shadow, pills with the lilac glow", () => {
    const rules = rulesOf(css);
    expect(winner(rules, [".card"], "border-radius", false)).toBe("20px");
    expect(winner(rules, [".card"], "border", false)).toContain("var(--line-2)");
    expect(winner(rules, [".card"], "box-shadow", false)).toBe("var(--shadow)");
    for (const sel of [".nav .navlink", ".btn", ".rpc-btn", ".search", ".pager button"]) expect(winner(rules, [sel], "border-radius", false), sel).toBe("999px");
    for (const sel of [".btn", ".rpc-btn"]) expect(winner(rules, [sel], "box-shadow", false), sel).toBe("var(--btn-shadow)");
    expect(css).toContain("--glow: #D69ED6");
    expect(css).toContain("--btn-shadow: inset 0 0 14px rgba(214,158,214,.55)");
    expect(winner(rules, [".hero"], "background", false)).toMatch(/radial-gradient\(120% 140% at 50% 0%, var\(--hero-from\)/);
  });

  it("keeps the dark theme in step: the glow, the shadow, the hero gradient and the top bar have their own dark values", () => {
    for (const t of ["--glow", "--shadow", "--btn-shadow", "--nav-bg", "--hero-from", "--hero-to", "--topbar"]) expect(darkOf(css), t).toContain(`${t}:`);
  });

  it("sets numbers in the text face with figures of equal width, and only hashes and ids in IBM Plex Mono", () => {
    const rules = rulesOf(css);
    expect(winner(rules, [".num"], "font-family", false)).toBeUndefined();
    expect(winner(rules, [".num"], "font-variant-numeric", false)).toBe("tabular-nums");
    expect(winner(rules, [".mono"], "font-family", false)).toMatch(/IBM Plex Mono/);
  });

  it("keeps IBM Plex Mono off the numbers in the pages' tables: a right-aligned cell is a number, and is set in the text face", () => {
    for (const f of sources(join(root, "src")).filter((x) => /\.tsx$/.test(x))) expect(readFileSync(f, "utf8"), f).not.toMatch(/className="r mono"/);
  });

  it("lays the footer's sentence on the left and its links on the right in the muted colour, and stacks them on a phone", () => {
    const rules = rulesOf(css);
    expect(winner(rules, [".foot"], "flex-direction", false)).toBe("row");
    expect(winner(rules, [".foot"], "justify-content", false)).toBe("space-between");
    expect(winner(rules, [".foot-links a"], "color", false)).toBe("var(--muted)");
    expect(winner(rules, [".foot"], "flex-direction", true)).toBe("column");
  });

  it("lines the header, the top bar and the footer up with the page's column", () => {
    const column = "max(32px, calc((100% - 1280px) / 2))";
    expect(/\.main \{[^}]*max-width: 1344px[^}]*padding: 26px 32px/.exec(css)).not.toBeNull();
    for (const sel of [".top", ".topbar", ".foot"]) expect(new RegExp(`\\n\\${sel} \\{[^}]*${column.replace(/[\\()*/+]/g, "\\$&")}`).test(css), sel).toBe(true);
  });

  it("draws the network as a filled pill in the brand's purple on pink", () => {
    const pill = /\n\.pill \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(pill).toContain("background: var(--pill)");
    expect(pill).toContain("color: var(--canton)");
    expect(pill).not.toContain("border:");
  });

  it("loads nothing from another host: no web address in the pages' styles, markup or code", () => {
    for (const f of [...sources(join(root, "src")), join(root, "index.html")]) {
      // The one other address is the link to the source, which a person may follow: nothing is loaded from it.
      expect(readFileSync(f, "utf8").replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "").replace(/https:\/\/github\.com\/rome-protocol\/canton-zk-evm"/g, '"'), f).not.toMatch(/https?:\/\/|\/\/fonts\.|@import/);
    }
  });
});

type Rule = { sel: string; decls: Record<string, string>; order: number; phone: boolean };

/** The rules of the styles in file order, flat; only the plain rules and the 720 px phone rules (the font faces and the dark colours are not the cascade this test is about). */
function rulesOf(text: string): Rule[] {
  const out: Rule[] = [];
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  let order = 0;
  const walk = (block: string, phone: boolean) => {
    let i = 0;
    while (i < block.length) {
      const open = block.indexOf("{", i);
      if (open < 0) break;
      const head = block.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (depth && j < block.length) { if (block[j] === "{") depth++; else if (block[j] === "}") depth--; j++; }
      const body = block.slice(open + 1, j - 1);
      if (head.startsWith("@")) { if (head === "@media (max-width: 720px)") walk(body, true); }
      else {
        const decls: Record<string, string> = {};
        for (const d of body.split(";")) { const k = d.indexOf(":"); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim(); }
        for (const sel of head.split(",")) out.push({ sel: sel.trim().replace(/\s+/g, " "), decls, order: order++, phone });
      }
      i = j;
    }
  };
  walk(src, false);
  return out;
}
const specificity = (sel: string) => (sel.match(/[.:](?!:)[\w-]+/g) ?? []).length;

/** What the browser uses for a property of an element that the given selectors match: the most specific rule, the later one among equals. */
function winner(rules: Rule[], selectors: string[], prop: string, phone: boolean): string | undefined {
  const hits = rules.filter((r) => selectors.includes(r.sel) && prop in r.decls && (phone || !r.phone));
  hits.sort((a, b) => specificity(a.sel) - specificity(b.sel) || a.order - b.order);
  return hits.at(-1)?.decls[prop];
}

describe("a long id in a key/value cell", () => {
  it("may break, so a copy button wraps with it and no page scrolls sideways (the Canton card at laptop widths)", () => {
    expect(/\n\.hl \{([^}]*)\}/.exec(css)?.[1]).toMatch(/white-space:\s*nowrap/);
    expect(/\n\.kv-v \.hl, \.kv-v \.hl \.hx \{([^}]*)\}/.exec(css)?.[1]).toMatch(/white-space:\s*normal/);
    expect(/\n\.kv-v \{([^}]*)\}/.exec(css)?.[1]).toMatch(/overflow-wrap:\s*anywhere/);
    expect(/\n\.kv-v \{([^}]*)\}/.exec(css)?.[1]).toMatch(/min-width:\s*0/);
  });
});

describe("phone width", () => {
  const phone = /@media \(max-width: 720px\) \{([\s\S]*)\n\}/.exec(css)?.[1] ?? "";

  it("keeps the name and the network pill on the top row with a menu button, and puts the search box under them at full width", () => {
    expect(phone).not.toMatch(/\.pill \{ display: none; \}/);
    expect(css).toMatch(/\n\.menu \{[^}]*display: none/);
    expect(phone).toMatch(/\.menu \{[^}]*display: (inline-)?flex/);
  });

  it("folds the pages away behind the menu button, and shows them when it is open", () => {
    expect(phone).toMatch(/\.nav \{[^}]*display: none/);
    expect(phone).toMatch(/\.nav\.open \{[^}]*display: flex/);
  });

  // The rules above only read the text. These decide which rule the browser uses, as the first version of this header was broken by a base rule that came later in the file.
  const all = rulesOf(css);
  const NAV = [".nav", ".top .nav"], NAV_OPEN = [...NAV, ".nav.open", ".top .nav.open"], SEARCH = [".search", ".top .search"];

  it("keeps the phone rules in force: the pages are folded away, and the search box takes the whole row, whichever rule comes later in the file", () => {
    expect(winner(all, NAV, "display", false)).toBe("flex");
    expect(winner(all, NAV, "display", true)).toBe("none");
    expect(winner(all, NAV_OPEN, "display", true)).toBe("flex");
    expect(winner(all, NAV, "flex", true)).toBe("1 1 100%");
    expect(winner(all, SEARCH, "flex", true)).toBe("1 1 100%");
    expect(winner(all, SEARCH, "max-width", true)).toBe("none");
    expect(winner(all, SEARCH, "margin-left", true)).toBe("0");
    expect(winner(all, SEARCH, "flex", false)).toBe("0 1 380px");
  });

  it("holds the top bar to one line: the checks and the final block, with the rest left for wide screens", () => {
    expect(phone).toMatch(/\.topbar \{[^}]*flex-wrap: nowrap/);
    expect(phone).toMatch(/\.tb-wide \{ display: none; \}/);
  });

  it("puts every phone rule after all the base rules: no plain rule with the same selector follows a phone rule", () => {
    const late = all.filter((r) => r.phone).flatMap((p) => all.filter((b) => !b.phone && b.sel === p.sel && b.order > p.order).map((b) => b.sel));
    expect(late).toEqual([]);
    // and the phone blocks are the last thing in the file, so no media block sits between base rules
    const firstPhone = css.indexOf("@media (max-width: 720px)");
    expect(css.slice(firstPhone).replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media \(max-width: 720px\) \{(?:[^{}]|\{[^{}]*\})*\}/g, "").trim()).toBe("");
  });

  it("makes the phone top bar one line whatever the base rule says: no wrap, the narrow gap and the 16 px sides", () => {
    expect(winner(all, [".topbar"], "flex-wrap", true)).toBe("nowrap");
    expect(winner(all, [".topbar"], "flex-wrap", false)).toBe("wrap");
    expect(winner(all, [".topbar"], "gap", true)).toBe("0 14px");
    expect(winner(all, [".topbar"], "padding", true)).toBe("7px 16px");
    expect(winner(all, [".stats.six"], "grid-template-columns", true)).toBe("repeat(2, minmax(0, 1fr))");
    expect(winner(all, [".cells"], "grid-template-columns", true)).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("gives every grid of the home page columns that may shrink, so that a phone does not scroll sideways", () => {
    const every = css.split("@media (max-width: 720px)").slice(1).join("\n");
    expect(every).toMatch(/\.cols \{ grid-template-columns: minmax\(0, 1fr\);/);
    expect(every).toMatch(/\.stats, \.stats\.six, \.cells \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\.foot-links \{[^}]*flex-wrap: wrap/);
  });

  it("lays the block page out in one column, EVM side first and Canton second, with each value under its label", () => {
    expect(phone).toMatch(/\.sides \{ grid-template-columns: 1fr;/);
    expect(phone).toMatch(/\.kv, \.kv\.wide \{ grid-template-columns: 1fr;/);
    expect(phone).toMatch(/\.facts \{ grid-template-columns: 1fr;/);
    // block.css spans the wide value over a second column; in one column that would make a hidden column and slip every pair
    expect(phone).toMatch(/\.facts \.f-v\.wide2 \{ grid-column: auto;/);
    // the two sides come in this order in the page itself, so one column keeps it
    const page = readFileSync(join(root, "src/pages/Block.tsx"), "utf8");
    expect(page.indexOf("<EvmSide")).toBeLessThan(page.indexOf("<CantonPanel"));
  });

  it("puts the neighbouring blocks under the title, and each step's time under its text", () => {
    expect(phone).toMatch(/\.pn \{ flex: 1 0 100%; justify-content: space-between;/);
    expect(phone).toMatch(/\.st-t \{ grid-column: 2; grid-row: 2;/);
  });

  it("turns the table of a block's transactions into one card each, with no column heads", () => {
    expect(phone).toMatch(/\.txs thead \{ display: none; \}/);
    expect(phone).toMatch(/\.txs tr \{ display: grid;[^}]*grid-template-areas: "h h res" "from to to" "did did did"/);
  });
  it("keeps a stacked transaction row inside the panel's inset, and a one-wei value whole, on a phone", () => {
    expect(phone).toMatch(/\.panel \.txs tr \{ padding: 10px 20px; \}/);
    expect(phone).toMatch(/\.panel \.txs td:first-child, \.panel \.txs td:last-child \{ padding: 0; \}/);
    expect(phone).toMatch(/\.txs td\.r \{ overflow-wrap: anywhere;/);
  });
});

describe("panel notes", () => {
  it("keeps the padding of a Stats chart message inside a panel: the panel's note rule leaves .chart-msg alone", () => {
    expect(css).toMatch(/\.panel > p\.muted:not\(\.card-note\):not\(\.chart-msg\) \{ padding: 0 20px; \}/);
    expect(css).toMatch(/\.chart-msg \{ padding: 18px 20px;/);
  });

  it("draws the block's cube in the accent on Home", () => {
    expect(readFileSync(join(root, "src/pages/home.css"), "utf8")).toMatch(/\.idcell\.blk \.ic \{ color: var\(--canton\);/);
  });
});

describe("the display face asks only for the weight that ships", () => {
  const sheets = sources(join(root, "src")).filter((f) => f.endsWith(".css"));
  // what takes Literata: the headings, the wordmark, the big numbers, and the classes the pages put on a heading
  const literata = /(^|[ >])(h[123]|\.name|\.stat-v|\.tx-h|\.rec-k|\.about-h)$/;
  it("sets no Literata heading or number in a bold the browser would have to fake", () => {
    for (const f of sheets) {
      for (const r of rulesOf(readFileSync(f, "utf8"))) {
        if (literata.test(r.sel) && r.decls["font-weight"]) expect(r.decls["font-weight"], `${f.slice(root.length)} ${r.sel}`).toBe("500");
      }
    }
  });
  it("gives the Verify panel the card finish of the pages", () => {
    const rules = rulesOf(readFileSync(join(root, "src/verify/VerifyPanel.css"), "utf8"));
    expect(winner(rules, [".verify"], "border-radius", false)).toBe("20px");
    expect(winner(rules, [".verify"], "border", false)).toContain("var(--line-2)");
    expect(winner(rules, [".verify"], "box-shadow", false)).toBe("var(--shadow)");
  });
});

describe("the finish of small controls and notes", () => {
  it("draws the pager buttons in the page font, and keeps a mono function name at the weight that ships", () => {
    expect(/\n\.pager button \{([^}]*)\}/.exec(css)?.[1]).toMatch(/font:\s*inherit/);
    expect(/\n\.fn-name \{([^}]*)\}/.exec(css)?.[1]).toMatch(/font-weight:\s*500/);
  });
  it("sets code in IBM Plex Mono like the other mono text", () => {
    expect(/\ncode \{([^}]*)\}/.exec(css)?.[1]).toMatch(/font-family:\s*"IBM Plex Mono"/);
  });
  it("keeps every mono text at 400 or 500, the weights IBM Plex Mono ships: no .mono or .fn-name rule asks for more", () => {
    for (const f of sources(join(root, "src")).filter((x) => x.endsWith(".css"))) {
      for (const r of rulesOf(readFileSync(f, "utf8"))) {
        const w = r.decls["font-weight"];
        if (/\.(mono|fn-name)\b/.test(r.sel) && w) expect(/^\d+$/.test(w) ? Number(w) : 700, `${f.slice(root.length)} ${r.sel}`).toBeLessThanOrEqual(500);
      }
    }
  });
  it("shrinks a stat tile's big number on a phone so an 8-digit count with commas (10,540,146) fits the narrowest tile: a clamp that is at most 25 px at 390 px and under 29 px at 768 px (four tiles in a row), and 30 px on a wide screen", () => {
    const m = /\n\.stat-v \{[^}]*font-size:\s*clamp\((\d+)px,\s*([\d.]+)vw,\s*(\d+)px\)/.exec(css);
    expect(m).not.toBeNull();
    const [min, vw, max] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(max).toBe(30);
    expect(Math.max(min, Math.min(max, (vw / 100) * 390))).toBeLessThanOrEqual(25);
    expect(Math.max(min, Math.min(max, (vw / 100) * 768))).toBeLessThan(29);
    expect(css).toMatch(/\n\.cell \.stat-v \{[^}]*clamp\(/);
  });
  it("keeps the header no wider than before the restyle: the search box takes 380 px (366 px below 1366 px) at most, and the links are 14 px with a 20.3 px line", () => {
    expect(/\n@media \(min-width: 721px\) \{[^@]*?\.top \.search \{[^}]*flex-basis:\s*(\d+)px/.exec(css)?.[1]).toBe("380");
    expect(/max-width: 1365px\) \{[^@]*?\.top \.search \{[^}]*flex-basis:\s*(\d+)px/.exec(css)?.[1]).toBe("366");
    expect(/\n\.nav \.navlink \{[^}]*line-height:\s*1\.45/.test(css) || /min-width: 721px\) \{[^@]*?\.nav \.navlink \{[^}]*line-height:\s*1\.45/.test(css)).toBe(true);
  });
  it("puts the peak on a line of its own", () => {
    expect(/\n\.stat-v \.stat-peak \{([^}]*)\}/.exec(css)?.[1]).toMatch(/display:\s*block/);
  });
});
