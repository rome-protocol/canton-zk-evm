import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { createFaucet, type Faucet } from "../server/faucet.ts";
import { createHttpServer } from "../server/http.ts";
import type { Api } from "../server/api.ts";
import type { Server } from "node:http";

/**
 * The builder grant in a real browser, at the width of a phone: the built pages (BRIDGE_E2E_DIST) served by the explorer's own HTTP server over a real faucet, with GitHub faked
 * on both sides (the faucet's calls to GitHub are a fake `fetch`, and the browser's visit to GitHub's page is answered by the test, which sends it back with a code, as GitHub does).
 * A person types an address, presses "Sign in with GitHub", comes back to the Faucet page and sees the grant queued; a second account on the same address, and a young account, are
 * turned away in plain words. The token and the secret are never in anything the browser asked for or was shown. Runs when BRIDGE_E2E_DIST is set (the `bridge-page` job of
 * .github/workflows/explorer.yml does), with PLAYWRIGHT_CORE naming the playwright-core of explorer/test/l4.
 */
const dist = process.env.BRIDGE_E2E_DIST;
const COIN = 10n ** 18n;
const SECRET = "e2e-secret-" + Math.random().toString(36).slice(2);
const ADDRESS = "0x" + "5a".repeat(20), OTHER = "0x" + "6b".repeat(20);
const STATUS = {
  chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), rootC: "0x" + "cd".repeat(32), file: "session.txt" },
  ok: true, starting: false, problems: [], evm: true, canton: true, final: null, proving: null, latest: [], signers: null, faucet: { on: true }, publicRpc: true, indexHead: 1, indexLag: 0, deriveCursor: 1, chainInstance: "i1",
};
const DAY_MS = 86400_000;
/** What the fake GitHub knows, by code: the account's id and age. */
const ACCOUNTS: Record<string, { id: number; days: number }> = { old: { id: 1001, days: 400 }, again: { id: 1001, days: 400 }, young: { id: 1002, days: 5 }, other: { id: 1003, days: 90 } };

describe.skipIf(!dist)("the builder grant, in a browser at 360 px", () => {
  let server: Server, browser: any, faucet: Faucet, base = "";
  const browserAsked: string[] = [];
  const strangerSaw: string[] = [];
  beforeAll(async () => {
    const github: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://github.com/login/oauth/access_token") {
        const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
        return ACCOUNTS[code] ? Response.json({ ["access_" + "token"]: "tok-" + code }) : Response.json({ error: "bad_verification_code" });
      }
      const who = ACCOUNTS[(new Headers(init?.headers).get("authorization") ?? "").replace("Bearer tok-", "")];
      return who ? Response.json({ id: who.id, created_at: new Date(Date.now() - who.days * DAY_MS).toISOString() }) : new Response("{}", { status: 401 });
    }) as typeof fetch;
    faucet = createFaucet({
      key: generatePrivateKey(), chainId: 770101, amountWei: COIN, perAddressSeconds: 86400, perIpSeconds: 1, maxPerHour: 1000, batch: 100, queueMax: 100, stateFile: null, captcha: null,
      reth: { balance: async () => 10n ** 24n, nonce: async () => 0, gasPrice: async () => 1n, priorityFee: async () => 1n, sendRaw: async () => "0x" + "11".repeat(32), transaction: async () => null } as never,
      fetch: github, clientKeyHash: (c) => c,
      builder: { clientId: "Iv1.e2e", clientSecret: SECRET, redirectUrl: "http://127.0.0.1/api/faucet/github/callback", key: Buffer.alloc(32, 5), amountWei: 100n * COIN, perAccountSeconds: 604800, minAccountAgeDays: 30, maxPerDay: 200 },
    });
    // The explorer's routes for the faucet and the status, as createApi has them; the rest is not found. The routes' own code is tested in server/api.test.ts.
    const api: Api = async (method, target, _body, ip, cookie) => {
      const url = new URL(target, "http://x");
      const route = url.pathname;
      if (route === "/api/status") return { status: 200, body: STATUS };
      if (route === "/api/faucet") return { status: 200, body: await faucet.info() };
      const ticket = /^\/api\/faucet\/ticket\/([0-9a-f]+)$/.exec(route);
      if (ticket) { const t = faucet.ticket(ticket[1]!); return t ? { status: 200, body: t } : { status: 404, body: { error: "No such ticket." } }; }
      if (method === "GET" && (route === "/api/faucet/github/start" || route === "/api/faucet/github/callback")) {
        const to = route.endsWith("start") ? faucet.builderStart(url.searchParams.get("address"), ip) : await faucet.builderCallback(url.searchParams, ip, cookie);
        return { status: 302, body: {}, headers: { location: to?.location ?? "/faucet?builder=off", "referrer-policy": "no-referrer", ...(to?.setCookie ? { "set-cookie": to.setCookie } : {}) } };
      }
      return { status: 404, body: { error: "Not found." } };
    };
    server = createHttpServer(api, dist!);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await faucet?.close(); await new Promise((done) => server?.close(done)); });

  /** A page at 360 px that answers GitHub's sign-in page as GitHub does: it sends the person back to the callback with the code the test names, and the state it was given. */
  async function newPage(code: string) {
    const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
    page.on("request", (r: any) => browserAsked.push(r.url() + " " + (r.postData() ?? "")));
    // Nothing leaves this machine. The browser is not sent to GitHub: the explorer's answer to the start is read here, checked to be GitHub's sign-in address with the
    // explorer's client id and callback, and answered the way GitHub answers a person who allows it: back to the callback with a code and the state it was given.
    await page.route((url: URL) => url.hostname !== "127.0.0.1", (route: any) => route.abort());
    await page.route("**/api/faucet/github/start*", async (route: any) => {
      const answer = await route.fetch({ maxRedirects: 0 });
      const to = new URL(answer.headers().location);
      expect(answer.status()).toBe(302);
      // The start sets the cookie that binds this sign-in to this browser: it is passed on to the browser, which sends it back with the return.
      const cookie = answer.headers()["set-cookie"];
      expect(cookie).toMatch(/^faucet_github=[0-9a-f]{32}; Max-Age=600; Path=\/api\/faucet\/github; HttpOnly; SameSite=Lax$/);
      expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
      expect(to.searchParams.get("client_id")).toBe("Iv1.e2e");
      expect([...to.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "state"]);
      browserAsked.push("github " + to.search);
      const back = new URL(to.searchParams.get("redirect_uri")!);
      const returnTo = `${base}${back.pathname}?code=${code}&state=${encodeURIComponent(to.searchParams.get("state")!)}`;
      if (code === "elsewhere") {
        // Another person's browser, with no cookie, is handed this link: the return is refused and GitHub is not asked.
        const stranger = await browser.newContext({ viewport: { width: 360, height: 740 } });
        const refused = await stranger.request.get(returnTo, { maxRedirects: 0 });
        strangerSaw.push(new URL(refused.headers().location!, base).toString());
        await stranger.close();
      }
      await route.fulfill({ status: 302, headers: { location: returnTo, "set-cookie": cookie } });
    });
    return page;
  }
  const signIn = async (page: any, address: string) => {
    await page.goto(base + "/faucet", { waitUntil: "load" });
    await page.fill("input[name=address]", address);
    await page.click(".builder-grant a");
  };
  const noSideways = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  it("offers the sign-in under the form, and only with an address", async () => {
    const page = await newPage("old");
    await page.goto(base + "/faucet", { waitUntil: "load" });
    await page.waitForSelector(".builder-grant");
    expect(await page.textContent(".builder-grant")).toContain("Building on Ostia? Get 100 tROME.");
    expect(await page.locator(".builder-grant a").count()).toBe(0);
    expect(await page.locator(".builder-grant button.gh-btn").isDisabled()).toBe(true);
    expect(await page.locator(".builder-grant .gh-btn").evaluate((e: any) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.fill("input[name=address]", ADDRESS);
    expect(await page.getAttribute(".builder-grant a", "href")).toBe(`/api/faucet/github/start?address=${ADDRESS}`);
    expect(await page.locator(".builder-grant a svg.gh-mark").count()).toBe(1);
    // GitHub's look survives the page's own link rules: white on #24292f in a light page.
    expect(await page.locator(".builder-grant a").evaluate((e: any) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor]; })).toEqual(["rgb(255, 255, 255)", "rgb(36, 41, 47)"]);
    expect(await noSideways(page)).toBe(true);
    await page.close();
  }, 60_000);

  it("takes a person through GitHub and back, and shows the grant queued for 100 tROME with the address cleaned of the result", async () => {
    const page = await newPage("old");
    await signIn(page, ADDRESS);
    await page.waitForSelector("text=Your builder grant of 100 tROME is queued.");
    await page.waitForSelector(".request");
    // The card names the address once the faucet's ticket has been read (the page reads it every two seconds).
    await page.waitForFunction(() => document.querySelector(".request")?.textContent?.includes("100 tROME to 0x5a5a…5a5a"), undefined, { timeout: 15_000 });
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/faucet");
    expect(await noSideways(page)).toBe(true);
    expect(faucet.queued()).toBe(1);
    await page.close();
  }, 60_000);

  it("says in plain words that the same GitHub account has had its grant, and that a young account does not get one", async () => {
    await new Promise((done) => setTimeout(done, 1200)); // past the per-network limit, which the test itself runs under
    const again = await newPage("again");
    await signIn(again, OTHER);
    await again.waitForSelector("text=This GitHub account was given a builder grant in the last 7 days.");
    expect(await again.textContent(".alert")).toMatch(/Try again in \d+ days/);
    expect(await noSideways(again)).toBe(true);
    await again.close();
    const young = await newPage("young");
    await signIn(young, OTHER);
    await young.waitForSelector("text=less than 30 days old");
    expect(faucet.queued()).toBe(1);
    await young.close();
  }, 60_000);

  it("refuses a return in a browser that did not start the sign-in, and the grant is not queued", async () => {
    await new Promise((done) => setTimeout(done, 1200));
    const before = faucet.queued();
    const page = await newPage("elsewhere");
    ACCOUNTS.elsewhere = { id: 1004, days: 400 };
    await signIn(page, "0x" + "7c".repeat(20));
    await page.waitForSelector("text=Your builder grant of 100 tROME is queued.");
    // The stranger's browser, which carried no cookie, was sent to the page with the state word, and nothing was queued for it.
    expect(strangerSaw).toHaveLength(1);
    expect(new URL(strangerSaw[0]!).searchParams.get("builder")).toBe("state");
    expect(faucet.queued()).toBe(before + 1);
    await page.close();
  }, 60_000);

  it("keeps the secret and the token out of everything the browser asked for and was shown", async () => {
    const page = await newPage("other");
    await new Promise((done) => setTimeout(done, 1200));
    await signIn(page, OTHER);
    await page.waitForSelector("text=Your builder grant of 100 tROME is queued.");
    const shown = await page.content();
    await page.close();
    for (const leak of [SECRET, "tok-", "created_at"]) {
      expect(shown).not.toContain(leak);
      expect(browserAsked.join("\n")).not.toContain(leak);
    }
  }, 60_000);
});
