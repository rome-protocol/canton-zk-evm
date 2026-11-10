// How to drive each wallet: its onboarding with the seed, its unlock, and which button a pop-up needs. Each is a best effort against the wallet's current screens and may need a change when the wallet's screens do.
import type { BrowserContext, Page } from "playwright-core";
import { clickFirst, extensionPages, inFrame, sleep, type Root } from "./browser.ts";
import { crawl, type Secret } from "./crawl.ts";

export interface Driver {
  id: string;
  /** Part of the wallet's EIP-6963 id, to pick it among the providers the page found. */
  rdns: string;
  /** The address of the wallet's pop-ups (a request to approve), as opposed to its own tabs. */
  popup: RegExp;
  /** Add the chain before connecting (the wallet gives the site permission only for the chains it has at that time). */
  chainFirst?: boolean;
  onboard(ctx: BrowserContext, extId: string, s: Secret): Promise<void>;
  unlock(ctx: BrowserContext, extId: string, s: Secret): Promise<void>;
  /** Clicks what one pop-up asks for; says what it clicked. */
  /** Opens the page of the wallet's pending requests in a tab (for a wallet whose pop-up window does not open here), or null when the wallet's own pop-up opens. */
  openRequests: ((ctx: BrowserContext, extId: string) => Promise<Page>) | null;
  approve(page: Page): Promise<string | null>;
}

const popupButtons = [/^(connect|next)$/i, /^(approve|add)$/i, /^(confirm|sign|sign in)$/i, /^(switch network|switch)$/i, /^got it$/i];

/** The wallet's own page at `path`: one that is open already (a wallet opens its welcome page when installed) or else a new one. */
const pageOf = async (ctx: BrowserContext, extId: string, path: string, wait = 20): Promise<Page> => {
  for (let i = 0; i < wait * 2; i++) {
    const have = extensionPages(ctx, extId).find((p) => p.url().includes(path));
    if (have) return have;
    await sleep(500);
  }
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/${path}`);
  return p;
};

const metamask: Driver = {
  id: "metamask", rdns: "io.metamask", popup: /notification\.html|popup\.html/, chainFirst: true,
  async onboard(ctx, extId, s) {
    const p = await pageOf(ctx, extId, "home.html");
    let jumped = false;
    const ready = async (q: Root) => {
      // The last onboarding screen leaves its buttons off for a long time (the wallet is made already): the wallet's home page is opened by its address.
      if (q.url().includes("onboarding/completion") && !jumped) { await sleep(5000); jumped = true; await q.goto(`chrome-extension://${extId}/home.html`); }
      return !q.url().includes("onboarding") && (await q.getByRole("button", { name: /^(send|receive|buy|swap)$/i }).count().catch(() => 0)) > 0;
    };
    await crawl(p, s, [/^i agree$/i, /^import an existing wallet$/i, /^i have an existing wallet$/i, /^no thanks$/i, /^import using secret recovery phrase$/i, /^continue$/i, /^import my wallet$/i, /^create password$/i, /^done$/i, /^next$/i, /^got it$/i, /^open wallet$/i, /^unlock$/i, /^not now$/i, /^maybe later$/i, /^close$/i], ready, "metamask onboarding");
  },
  async unlock(ctx, extId, s) {
    const p = await pageOf(ctx, extId, "home.html");
    const ready = async (q: Page) => (await q.locator('[data-testid="account-menu-icon"], [data-testid="account-options-menu-button"]').count().catch(() => 0)) > 0;
    await crawl(p, s, [/^unlock$/i, /^got it$/i, /^close$/i], ready, "metamask unlock", 60);
  },
  openRequests: async (ctx, extId) => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${extId}/notification.html`); return p; },
  approve: (p) => clickFirst(p, [...popupButtons]),
};

/** A wallet whose screens this harness reaches with one list of button names: the page it opens when installed, the buttons in the order to try them, and a pattern of the text its ready screen shows. */
function generic(id: string, o: { rdns: string; popup: RegExp; home: string; open: string; onboarding: RegExp[]; unlock: RegExp[]; ready: RegExp; chainFirst?: boolean; approve?: RegExp[]; approveTexts?: RegExp[]; locked?: RegExp; texts?: RegExp[]; frame?: RegExp; closedIsDone?: boolean; narrow?: boolean }): Driver {
  const isReady = async (q: Root) => {
    const text = await q.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    return o.ready.test(text) && !(o.locked && o.locked.test(text));
  };
  return {
    id, rdns: o.rdns, popup: o.popup, chainFirst: o.chainFirst,
    async onboard(ctx, extId, s) { const pg = await pageOf(ctx, extId, o.home); if (o.narrow) await pg.setViewportSize({ width: 420, height: 740 }); await crawl(pg, s, o.onboarding, isReady, `${id} onboarding`, 150, o.texts, o.frame ? inFrame(o.frame) : undefined, o.closedIsDone); },
    async unlock(ctx, extId, s) { const pg = await pageOf(ctx, extId, o.home); if (o.narrow) await pg.setViewportSize({ width: 420, height: 740 }); await crawl(pg, s, o.unlock, isReady, `${id} unlock`, 60, [], o.frame ? inFrame(o.frame) : undefined); },
    openRequests: async (ctx, extId) => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${extId}/${o.open}`); return p; },
    approve: async (p) => {
      const r = o.frame ? await inFrame(o.frame)(p) : p;
      const did = await clickFirst(r, o.approve ?? popupButtons);
      if (did) return did;
      for (const re of o.approveTexts ?? []) { const t = r.getByText(re).first(); if (await t.isVisible().catch(() => false)) { await t.click({ timeout: 3000 }).catch(() => {}); return String(re); } }
      return null;
    },
  };
}

const rabby = generic("rabby", {
  rdns: "io.rabby", popup: /notification\.html/, home: "index.html", open: "notification.html", approveTexts: [/^ignore all$/i],
  onboarding: [/^i already have an address$/i, /^get started$/i, /^import (seed phrase|existing)/i, /^import seed phrase$/i, /^seed phrase$/i, /^confirm$/i, /^next$/i, /^(set up|create) password$/i, /^continue$/i, /^open wallet$/i, /^done$/i, /^finish$/i],
  unlock: [/^unlock$/i], texts: [/^seed phrase or private key$/i, /^seed phrase$/i],
  ready: /\b(Send|Receive|Swap)\b|Ready to Use/, locked: /unlock|password/i,
});
const coinbase = generic("coinbase", {
  rdns: "com.coinbase.wallet", narrow: true, popup: /inPageRequest=true/, home: "index.html", open: "index.html?inPageRequest=true",
  onboarding: [/^i already have a wallet$/i, /^(enter recovery phrase|import a wallet|import wallet)/i, /^acknowledge$/i, /^continue$/i, /^(import wallet|submit|next|agree|i agree|accept|done|skip|not now|close|get started)$/i],
  unlock: [/^(unlock|log in|sign in)$/i],
  ready: /\b(Send|Receive|Swap|Buy)\b/, locked: /unlock|enter your password/i,
});
const okx = generic("okx", {
  rdns: "com.okex.wallet", popup: /notification\.html|popup\.html/, home: "fullscreen.html", open: "notification.html",
  onboarding: [/^import wallet$/i, /^seed phrase or private key$/i, /^seed phrase$/i, /^confirm$/i, /^next$/i, /^(start|get started)$/i, /^(select|ok|done|skip|got it|later|close|i understand)$/i],
  unlock: [/^unlock$/i, /^cancel$/i], texts: [/^seed phrase or private key/i, /^i agree to okx/i], frame: /ses\.html/,
  ready: /\b(Send|Receive|Swap)\b/, locked: /enter password|welcome back/i,
});
const phantom = generic("phantom", {
  rdns: "app.phantom", closedIsDone: true, popup: /notification\.html|popup\.html/, home: "onboarding.html", open: "popup.html",
  onboarding: [/^i already have a wallet$/i, /^import recovery phrase/i, /^import wallet$/i, /^import$/i, /^suggested:/i, /^continue$/i, /^(get started|done|got it|skip|maybe later|close)$/i],
  unlock: [/^unlock$/i],
  ready: /\b(Send|Receive|Swap)\b/, locked: /unlock|password/i,
});

export const drivers: Record<string, Driver> = { metamask, rabby, coinbase, okx, phantom };
export { sleep };
