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

describe("themes", () => {
  const tokens = ["--bg", "--surface", "--ink", "--muted", "--link", "--evm", "--canton", "--ok", "--bad", "--amber"];
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? "";

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
  it("serves IBM Plex from the explorer: every font file the styles name is in public/fonts, with its licence", () => {
    const files = [...css.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(files.length).toBe(5);
    for (const f of files) expect(existsSync(join(root, "public", f)), f).toBe(true);
    expect(existsSync(join(root, "public/fonts/OFL-IBM-Plex-Sans.txt"))).toBe(true);
    expect(existsSync(join(root, "public/fonts/OFL-IBM-Plex-Mono.txt"))).toBe(true);
  });

  it("loads nothing from another host: no web address in the pages' styles, markup or code", () => {
    for (const f of [...sources(join(root, "src")), join(root, "index.html")]) {
      expect(readFileSync(f, "utf8").replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ""), f).not.toMatch(/https?:\/\/|\/\/fonts\.|@import/);
    }
  });
});

describe("phone width", () => {
  const phone = /@media \(max-width: 720px\) \{([\s\S]*)\n\}/.exec(css)?.[1] ?? "";

  it("keeps the name and Faucet on the top row, drops the chain id and puts the search box under them", () => {
    expect(phone).toMatch(/\.pill \{ display: none; \}/);
    expect(phone).toMatch(/\.search \{[^}]*flex-basis: 100%/);
  });

  it("lays the block page out in one column, EVM side first and Canton second, with each value under its label", () => {
    expect(phone).toMatch(/\.sides \{ grid-template-columns: 1fr;/);
    expect(phone).toMatch(/\.kv, \.kv\.wide \{ grid-template-columns: 1fr;/);
    expect(phone).toMatch(/\.facts \{ grid-template-columns: 1fr;/);
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
});
