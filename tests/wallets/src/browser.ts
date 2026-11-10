// A browser with one extension loaded, the helpers to read what a wallet's pages show (never an input's value), and the loop that approves a wallet's pop-ups.
import { chromium, type BrowserContext, type Frame, type Page } from "playwright-core";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { RUN } from "./lib.ts";

/** Where a wallet draws its screens: its page, or a frame inside it (OKX draws in a sandbox frame). */
export type Root = Page | Frame;
/** The frame of the page that holds the wallet's screens: the page itself when it shows buttons or fields, else the first of its frames (whose address matches) that does. */
export const inFrame = (re: RegExp) => async (p: Page): Promise<Root> => {
  const shows = async (r: Root) => (await r.locator("button:visible, input:visible").count().catch(() => 0)) > 0;
  if (await shows(p.mainFrame())) return p;
  for (const f of p.frames()) if (f !== p.mainFrame() && re.test(f.url()) && (await shows(f))) return f;
  return p;
};

export const DEBUG = process.env.WALLET_DEBUG === "1";
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function launch(walletId: string, profile: string): Promise<{ ctx: BrowserContext; extId: string }> {
  const ext = join(RUN, "ext", walletId);
  mkdirSync(profile, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-first-run", "--ignore-certificate-errors", "--no-default-browser-check", "--disable-features=DisableLoadExtensionCommandLineSwitch"],
  });
  let extId = "";
  for (let i = 0; i < 60 && !extId; i++) {
    const urls = [...ctx.serviceWorkers().map((w) => w.url()), ...ctx.backgroundPages().map((p) => p.url()), ...ctx.pages().map((p) => p.url())];
    const hit = urls.find((u) => u.startsWith("chrome-extension://"));
    if (hit) extId = new URL(hit).host; else await sleep(500);
  }
  if (!extId) throw new Error("the extension did not start");
  return { ctx, extId };
}

/** What a page shows, for working out a wallet's screens: its address, the head of its text, its buttons and the kinds of its fields. Never a field's value. It uses locators only: a wallet that scuttles its globals refuses page.evaluate. */
export async function describe(page: Root): Promise<string> {
  const guard = <T>(p: Promise<T>, d: T) => Promise.race([p.catch(() => d), sleep(4000).then(() => d)]);
  const url = new URL(page.url());
  const raw = (await guard(page.locator("body").innerText({ timeout: 3000 }), "")).replace(/\s+/g, " ");
  const text = raw.includes("አማርኛ") ? raw.slice(-320) : raw.slice(0, 320);
  const buttons: string[] = [];
  const bs = page.getByRole("button");
  for (let i = 0, n = Math.min(await guard(bs.count(), 0), 14); i < n; i++) {
    const b = bs.nth(i);
    if (!(await guard(b.isVisible(), false))) continue;
    buttons.push(((await guard(b.innerText({ timeout: 1000 }), "")) || (await guard(b.getAttribute("aria-label"), "")) || "?").trim().slice(0, 40) + ((await guard(b.isDisabled(), false)) ? "(off)" : ""));
  }
  const inputs: string[] = [];
  const ins = page.locator("input:visible, textarea:visible");
  for (let i = 0, n = Math.min(await guard(ins.count(), 0), 16); i < n; i++) {
    const f = ins.nth(i);
    inputs.push(`${(await guard(f.getAttribute("type"), "")) ?? ""}:${(await guard(f.getAttribute("data-testid"), "")) || (await guard(f.getAttribute("placeholder"), "")) || (await guard(f.getAttribute("id"), "")) || ""}`);
  }
  return `url=${url.pathname}${url.hash} text="${text}" buttons=${JSON.stringify(buttons)} inputs=${JSON.stringify(inputs)}`;
}

/** Clicks the first visible, enabled button (or role=button, or link) whose name matches one of the patterns, in the order of the patterns. */
export async function clickFirst(page: Root, names: RegExp[], roles: ReadonlyArray<"button" | "link"> = ["button", "link"]): Promise<string | null> {
  for (const re of names) {
    for (const role of roles) {
      const loc = page.getByRole(role, { name: re });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const b = loc.nth(i);
        if ((await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) {
          try { await b.click({ timeout: 4000 }); return String(re); } catch { /* try the next */ }
        }
      }
    }
  }
  return null;
}

/** The pages of the extension (its pop-ups and tabs), not the test page. */
export const extensionPages = (ctx: BrowserContext, extId: string): Page[] => ctx.pages().filter((p) => p.url().startsWith(`chrome-extension://${extId}/`));

/** Approves the wallet's pop-ups while `work` runs. `approve` clicks what a pop-up asks for and says whether it did. */
export async function withApprovals<T>(ctx: BrowserContext, extId: string, popup: RegExp, opener: (() => Promise<Page>) | null, approve: (page: Page) => Promise<string | null>, work: () => Promise<T>, what: string, seconds = 90): Promise<T> {
  let stop = false;
  const seen = new Set<string>();
  const opened: Page[] = [];
  let idle = 0;
  const loop = (async () => {
    while (!stop) {
      // A wallet that does not open its pop-up window here (nothing shows a window under a bare display) is asked for the page of its pending requests in a tab.
      const have = extensionPages(ctx, extId).filter((q) => popup.test(q.url()));
      idle = have.length ? 0 : idle + 1;
      if (opener && idle >= 3 && !opened.some((q) => !q.isClosed())) { idle = 0; try { opened.push(await opener()); } catch { /* try again */ } }
      if (DEBUG) { const u = ctx.pages().map((q) => q.url().replace(/^chrome-extension:\/\/[a-z]+/, "ext:")).join(" , "); if (!seen.has("u" + u)) { seen.add("u" + u); log(`[${what}] pages`, u); } }
      for (const p of extensionPages(ctx, extId).filter((q) => popup.test(q.url()))) {
        if (p.isClosed()) continue;
        if (DEBUG) { const d = await describe(p); if (!seen.has(d)) { seen.add(d); log(`[${what}] popup`, d); } }
        const did = await approve(p).catch(() => null);
        if (did) log(`[${what}] clicked`, did);
      }
      await sleep(700);
    }
  })();
  // A wallet that never shows its request must not hold the run: the call is given up after `seconds`.
  const limit = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no approval screen was reached in ${seconds} s (${what})`)), seconds * 1000).unref());
  try { return await Promise.race([work(), limit]); } finally { stop = true; await loop; for (const p of opened) await p.close().catch(() => {}); }
}
