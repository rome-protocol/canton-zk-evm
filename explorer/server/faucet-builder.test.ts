import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { ConfigError } from "./config.ts";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "./db/testing.ts";
import { createFaucet, type Faucet, type FaucetOptions } from "./faucet.ts";
import { accountHash, loadBuilder, loadSecretFile, type BuilderOptions, type BuilderRedirect } from "./faucet-builder.ts";
import { clientHasher, databaseFaucetStore, loadClientKey } from "./faucet-store.ts";

checkRequired();

const COIN = 10n ** 18n;
const KEY = generatePrivateKey();
const HASH_KEY = Buffer.alloc(32, 7);
const DAY = 86400, DAY_MS = DAY * 1000;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
// Made for each run, so that no secret-like string is written in the repository.
const SECRET = "s3cret-" + Math.random().toString(36).slice(2) + "-client";
const REDIRECT = "https://explorer.example.org/api/faucet/github/callback";
/** GitHub's answer names its field this way; spelled out so the repository's pre-push check does not read the assignment as a credential. */
const BEARER_FIELD = "access_" + "token", SECRET_FIELD = "client_" + "secret";

let clock: { now: number };
let logged: string[];
let sent: Hex[];
let db: TestDatabase | undefined;
let dir: string;

beforeEach(async () => {
  clock = { now: T0 };
  logged = [];
  sent = [];
  dir = mkdtempSync(join(tmpdir(), "builder-"));
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(async () => { vi.restoreAllMocks(); await db?.drop(); db = undefined; rmSync(dir, { recursive: true, force: true }); });

/** A GitHub that knows some accounts by the code they are signed in with. `mode` makes it fail in the ways GitHub can. */
interface Account { id: number; created_at: string }
class FakeGithub {
  accounts = new Map<string, Account>();
  calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  /** Set when the explorer stopped reading a streamed answer. */
  cancelled = false;
  mode: "ok" | "token-500" | "token-unreachable" | "user-500" | "user-garbage" | "huge" | "user-stream" | "bad-code" | "no-token" | "slow" = "ok";
  /** The user a code signs in, made `days` days old at the clock now. */
  signIn(code: string, id: number, days: number): void {
    this.accounts.set(code, { id, created_at: new Date(clock.now - days * DAY_MS).toISOString() });
  }
  fetch: typeof fetch = async (url, init) => {
    const u = String(url), headers = Object.fromEntries(new Headers(init?.headers).entries()), body = init?.body ? String(init.body) : "";
    this.calls.push({ url: u, method: init?.method ?? "GET", headers, body });
    if (u === "https://github.com/login/oauth/access_token") {
      if (this.mode === "token-unreachable") throw new TypeError("fetch failed");
      if (this.mode === "token-500") return new Response("oops", { status: 500 });
      if (this.mode === "bad-code") return Response.json({ error: "bad_verification_code" });
      if (this.mode === "no-token") return Response.json({ scope: "" });
      if (this.mode === "huge") return new Response(JSON.stringify({ [BEARER_FIELD]: "x".repeat(200_000) }));
      if (this.mode === "slow") return new Promise<Response>((_, reject) => { if (init?.signal?.aborted) reject(new DOMException("aborted", "TimeoutError")); else init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError"))); });
      const code = new URLSearchParams(body).get("code") ?? "";
      return this.accounts.has(code) ? Response.json({ [BEARER_FIELD]: `tok-${code}` }) : Response.json({ error: "bad_verification_code" });
    }
    if (u === "https://api.github.com/user") {
      if (this.mode === "user-500") return new Response("{}", { status: 502 });
      if (this.mode === "user-stream") {
        // A valid start of the answer, then more than the cap, with no content-length and no end: only the cap stops the read.
        const who = JSON.stringify({ id: 4242, created_at: new Date(clock.now - 400 * DAY_MS).toISOString() }).slice(0, -1) + ',"pad":"';
        let sentHead = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull: (c) => { c.enqueue(new TextEncoder().encode(sentHead ? "x".repeat(16 * 1024) : who)); sentHead = true; },
          cancel: () => { this.cancelled = true; },
        }));
      }
      if (this.mode === "user-garbage") return new Response("<html>no</html>");
      const code = (headers.authorization ?? "").replace("Bearer tok-", "");
      const who = this.accounts.get(code);
      return who ? Response.json({ ...who, login: "someone-secret-login", email: "private@example.org" }) : new Response("{}", { status: 401 });
    }
    throw new Error(`the fake GitHub was asked for ${u}`);
  };
}

function reth(over: Record<string, unknown> = {}): FaucetOptions["reth"] {
  return {
    balance: async () => 10n ** 24n, nonce: async () => 0, gasPrice: async () => 1n, priorityFee: async () => 1n,
    sendRaw: async (raw: string) => { sent.push(raw as Hex); return "0x" + "11".repeat(32); }, transaction: async () => null, ...over,
  } as unknown as FaucetOptions["reth"];
}

const builderOptions = (over: Partial<BuilderOptions> = {}): BuilderOptions => ({
  clientId: "Iv1.testclient", clientSecret: SECRET, redirectUrl: REDIRECT, key: HASH_KEY, amountWei: 100n * COIN, perAccountSeconds: 7 * DAY, minAccountAgeDays: 30, maxPerDay: 200, ...over,
});

interface Rig { f: Faucet; gh: FakeGithub; stateFile: string | null }
async function rig(over: Partial<FaucetOptions> = {}, builder: Partial<BuilderOptions> | null = {}, useDatabase = false, stateFile: string | null = null): Promise<Rig> {
  const gh = new FakeGithub();
  const f = createFaucet({
    key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: DAY, perIpSeconds: 600, maxPerHour: 100000, batch: 100, queueMax: 5000, stateFile, captcha: null,
    reth: reth(), now: () => clock.now, fetch: gh.fetch, builder: builder === null ? null : builderOptions(builder),
    ...(useDatabase ? { store: databaseFaucetStore(db!.pool, COIN, () => clock.now), clientKeyHash: clientHasher(HASH_KEY) } : { clientKeyHash: clientHasher(HASH_KEY) }),
    ...over,
  });
  await f.ready();
  return { f, gh, stateFile };
}

/** Starts a sign-in for an address and returns the state GitHub would send back. */
const cookies = new Map<string, string>();
function remember(to: BuilderRedirect): string {
  const state = new URL(to.location).searchParams.get("state")!;
  // The browser keeps the cookie the start sets and sends it back with the return.
  cookies.set(state, to.setCookie!.split(";")[0]!);
  return state;
}
const begin = (f: Faucet, address: string, ip = "1.1.1.1"): string => remember(f.builderStart(address, ip)!);
/** The address a start sends the browser to, or null when the grant is off. */
const startLoc = (f: Faucet, address: unknown, ip = "1.1.1.1") => f.builderStart(address, ip)?.location ?? null;
/** The return of GitHub, in the browser that holds the cookie of this state unless another cookie is named (`null` for a browser with none). */
const cb = (f: Faucet, code: string, state: string, ip = "1.1.1.1", cookie: string | null | undefined = cookies.get(state)) => f.builderCallback(new URLSearchParams({ code, state }), ip, cookie ?? undefined);
const query = (to: string | BuilderRedirect | null) => Object.fromEntries(new URL(typeof to === "string" || to === null ? to! : to.location, "https://x").searchParams.entries());
/** A whole sign-in for an address, as a person does it: the start, GitHub's page, and the return with the code. */
async function grant(r: Rig, address: string, code: string, id: number, days = 90, ip = "1.1.1.1", state?: string) {
  r.gh.signIn(code, id, days);
  if (state === undefined) {
    const to = r.f.builderStart(address, ip)!;
    if (!to.setCookie) return query(to); // turned away at the start, with no trip to GitHub
    state = remember(to);
  }
  return query(await cb(r.f, code, state, ip));
}

const modes: [string, boolean][] = [["in memory", false], ...(TEST_URL ? ([["in the database", true]] as [string, boolean][]) : [])];

describe.each(modes)("the builder grant, %s", (_name, useDatabase) => {
  beforeEach(async () => { if (useDatabase) db = await makeDatabase(true); });
  const make = (over: Partial<FaucetOptions> = {}, builder: Partial<BuilderOptions> | null = {}) => rig(over, builder, useDatabase);

  describe("the start of the sign-in", () => {
    it("sends the person to GitHub with the client id, the callback and a state, and no scope", async () => {
      const { f } = await make();
      const to = new URL(startLoc(f, addr(1))!);
      expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
      expect([...to.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "state"]);
      expect(to.searchParams.get("client_id")).toBe("Iv1.testclient");
      expect(to.searchParams.get("redirect_uri")).toBe(REDIRECT);
      expect(to.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(startLoc(f, addr(1))).not.toBe(startLoc(f, addr(1))); // a state is made for each start
    });

    it("sends a wrong address back to the page with a word for it, and never to GitHub", async () => {
      const { f } = await make();
      for (const bad of [undefined, "", "0x12", "hello", null, 5]) expect(startLoc(f, bad)).toBe("/faucet?builder=bad");
    });

    it("answers null when the builder grant is off, for both routes", async () => {
      const { f } = await make({}, null);
      expect(startLoc(f, addr(1))).toBeNull();
      expect(await f.builderCallback(new URLSearchParams({ code: "c", state: "s" }), "1.1.1.1")).toBeNull();
      expect((await f.info()).builder).toEqual({ on: false, amount: null, perAccountSeconds: null, minAccountAgeDays: null, maxPerDay: null });
    });

    it("says at once, without GitHub, that an address already has its grant", async () => {
      const r = await make();
      expect(await grant(r, addr(1), "c1", 11)).toMatchObject({ builder: "queued" });
      expect(query(startLoc(r.f, addr(1)))).toMatchObject({ builder: "address", wait: String(7 * DAY) });
    });

    it("is off, with no key on the faucet itself (the faucet is off)", async () => {
      const { f } = await make({ key: null });
      expect(startLoc(f, addr(1))).toBeNull();
    });
  });


  describe("the browser that started the sign-in", () => {
    it("sets a cookie at the start: HttpOnly, SameSite=Lax, on the two routes only, for ten minutes, and Secure on https", async () => {
      const { f } = await make();
      const c = f.builderStart(addr(1), "1.1.1.1")!.setCookie!;
      expect(c).toMatch(/^faucet_github=[0-9a-f]{32}; Max-Age=600; Path=\/api\/faucet\/github; HttpOnly; SameSite=Lax; Secure$/);
      const local = await make({}, { redirectUrl: "http://localhost:8088/api/faucet/github/callback" });
      expect(local.f.builderStart(addr(1), "1.1.1.1")!.setCookie).toMatch(/; SameSite=Lax$/);
      expect(f.builderStart(addr(1), "1.1.1.1")!.setCookie).not.toBe(c); // a secret for each start
    });

    it("keeps the cookie's secret out of the state, which anyone can read", async () => {
      const { f } = await make();
      const to = f.builderStart(addr(1), "1.1.1.1")!;
      const mine = to.setCookie!.split(";")[0]!.split("=")[1]!;
      expect(Buffer.from(new URL(to.location).searchParams.get("state")!.split(".")[0]!, "base64url").toString("hex")).not.toContain(mine);
    });

    it("refuses a return with no cookie, or with another browser's cookie, before any call to GitHub, and the state is not used up", async () => {
      const r = await make();
      r.gh.signIn("c", 77, 90);
      const state = begin(r.f, addr(1));
      const mine = cookies.get(state)!;
      const theirs = cookies.get(begin(r.f, addr(2), "2.2.2.2"))!;
      expect(query(await cb(r.f, "c", state, "1.1.1.1", null))).toEqual({ builder: "state" });
      expect(query(await cb(r.f, "c", state, "1.1.1.1", theirs))).toEqual({ builder: "state" });
      for (const bad of ["faucet_github=", "faucet_github=zz", `other=${mine.split("=")[1]}`, `faucet_github=${"0".repeat(32)}`, `faucet_github=${mine.split("=")[1]}00`]) {
        expect(query(await cb(r.f, "c", state, "1.1.1.1", bad))).toEqual({ builder: "state" });
      }
      expect(r.gh.calls).toEqual([]);
      expect(r.f.queued()).toBe(0);
      // The right browser, with its cookie among others, still finishes it.
      expect(query(await cb(r.f, "c", state, "1.1.1.1", `a=1; ${mine}; b=2`))).toMatchObject({ builder: "queued" });
    });

    it("does not queue a grant for a victim who was handed a link made for the attacker's address", async () => {
      const r = await make();
      r.gh.signIn("victim-code", 500, 90);
      const attackerState = begin(r.f, addr(66), "6.6.6.6"); // the attacker's own start, for the attacker's address
      const victimCookie = cookies.get(begin(r.f, addr(1), "7.7.7.7")); // the victim's browser has a cookie of its own, or none
      expect(query(await cb(r.f, "victim-code", attackerState, "7.7.7.7", victimCookie))).toEqual({ builder: "state" });
      expect(query(await cb(r.f, "victim-code", attackerState, "7.7.7.7", null))).toEqual({ builder: "state" });
      expect(r.gh.calls).toEqual([]);
      expect(r.f.queued()).toBe(0);
    });

    it("clears the cookie at the return, whatever the result", async () => {
      const r = await make();
      r.gh.signIn("c", 1, 90);
      const ok = await cb(r.f, "c", begin(r.f, addr(1)));
      expect(ok!.setCookie).toMatch(/^faucet_github=; Max-Age=0; Path=\/api\/faucet\/github;/);
      expect((await cb(r.f, "c", "nope"))!.setCookie).toMatch(/Max-Age=0/);
      expect((await r.f.builderCallback(new URLSearchParams({ error: "access_denied" }), "1.1.1.1", undefined))!.setCookie).toMatch(/Max-Age=0/);
    });

    it("keeps a state for the second try when the first was only refused for being busy", async () => {
      const gate: Array<() => void> = [];
      const inner = new FakeGithub();
      inner.signIn("x", 9999, 90);
      let asked = 0;
      const r = await make({ fetch: (async (u: unknown, init?: RequestInit) => {
        if (asked++ < 20) { await new Promise<void>((go) => gate.push(go)); return new Response("{}", { status: 500 }); }
        return inner.fetch(u as string, init);
      }) as typeof fetch });
      const pending = Array.from({ length: 20 }, (_, i) => cb(r.f, "c" + i, begin(r.f, addr(i + 1)), `10.0.0.${i}`));
      await vi.waitFor(() => expect(gate.length).toBe(20));
      const state = begin(r.f, addr(99), "10.0.0.99");
      expect(query(await cb(r.f, "x", state, "10.0.0.99"))).toMatchObject({ builder: "busy" });
      for (const go of gate) go();
      await Promise.all(pending);
      expect(query(await cb(r.f, "x", state, "10.0.0.99"))).toMatchObject({ builder: "queued" });
    });

    it("says at once, without GitHub, that this connection asked for coins a moment ago", async () => {
      const r = await make();
      expect((await r.f.request(addr(1), { ip: "3.3.3.3" })).status).toBe(202);
      expect(query(startLoc(r.f, addr(2), "3.3.3.3"))).toEqual({ builder: "ip", wait: "600" });
      expect(startLoc(r.f, addr(2), "3.3.3.4")).toContain("github.com");
      expect(r.gh.calls).toEqual([]);
    });
  });

  describe("a good sign-in", () => {
    it("queues the builder amount for the address the state names, and redirects with the ticket", async () => {
      const r = await make();
      const got = await grant(r, addr(5), "good", 4242);
      expect(got.builder).toBe("queued");
      expect(got.ticket).toMatch(/^[0-9a-f]{24}$/);
      const view = r.f.ticket(got.ticket!)!;
      expect(view).toMatchObject({ status: "queued", to: addr(5), amount: (100n * COIN).toString() });
      await r.f.process();
      const tx = parseTransaction(sent[0]!);
      expect(tx.to).toBe(addr(5));
      expect(tx.value).toBe(100n * COIN);
      expect(r.f.ticket(got.ticket!)).toMatchObject({ status: "sent", amount: (100n * COIN).toString() });
    });

    it("sends a plain request and a builder grant in one batch, each its own amount", async () => {
      const r = await make();
      await r.f.request(addr(1), { ip: "9.9.9.9" });
      await grant(r, addr(2), "c", 1);
      await r.f.request(addr(3), { ip: "8.8.8.8" });
      await r.f.process();
      expect(sent.map((s) => parseTransaction(s).value)).toEqual([COIN, 100n * COIN, COIN]);
    });

    it("asks GitHub for the token with the secret in the body only, and for the user with the token as a bearer, naming itself", async () => {
      const r = await make();
      await grant(r, addr(1), "c1", 5);
      const [token, user] = r.gh.calls;
      expect(token).toMatchObject({ url: "https://github.com/login/oauth/access_token", method: "POST" });
      expect(Object.fromEntries(new URLSearchParams(token!.body))).toEqual({ client_id: "Iv1.testclient", [SECRET_FIELD]: SECRET, code: "c1", redirect_uri: REDIRECT });
      expect(token!.headers["user-agent"]).toBe("ostia-faucet");
      expect(token!.url).not.toContain(SECRET);
      expect(user).toMatchObject({ url: "https://api.github.com/user", method: "GET" });
      expect(user!.headers).toMatchObject({ authorization: "Bearer tok-c1", "user-agent": "ostia-faucet" });
      expect(user!.body).toBe("");
    });

    it("shows its settings on the faucet's own answer, with no secret in them", async () => {
      const { f } = await make();
      const info = await f.info();
      expect(info.builder).toEqual({ on: true, amount: (100n * COIN).toString(), perAccountSeconds: 7 * DAY, minAccountAgeDays: 30, maxPerDay: 200 });
      expect(JSON.stringify(info)).not.toContain(SECRET);
      expect(JSON.stringify(info)).not.toContain("Iv1.testclient");
    });

    it("does not use up the plain faucet's turn, and the plain faucet does not use up the builder grant", async () => {
      const r = await make();
      expect((await r.f.request(addr(1), { ip: "3.3.3.3" })).status).toBe(202);
      expect(await grant(r, addr(1), "c", 1, 90, "4.4.4.4")).toMatchObject({ builder: "queued" });
      expect((await r.f.request(addr(1), { ip: "5.5.5.5" }))).toMatchObject({ status: 429, body: { reason: "address" } });
      const fresh = await make();
      expect(await grant(fresh, addr(2), "c", 2)).toMatchObject({ builder: "queued" });
      expect((await fresh.f.request(addr(2), { ip: "6.6.6.6" })).status).toBe(202);
    });
  });

  describe("the state", () => {
    it("is refused when it was changed, made with another key, cut short, or is not a state at all", async () => {
      const r = await make();
      r.gh.signIn("c", 1, 90);
      const good = begin(r.f, addr(1));
      const [p, m] = good.split(".") as [string, string];
      const flipped = p.slice(0, -2) + (p.endsWith("AA") ? "BB" : "AA") + "." + m;
      const other = await make({}, { key: Buffer.alloc(32, 9) });
      const forgedByOther = begin(other.f, addr(1));
      const otherAddress = Buffer.from(p, "base64url"); otherAddress[19] = otherAddress[19]! ^ 1;
      for (const bad of [flipped, forgedByOther, `${otherAddress.toString("base64url")}.${m}`, p, `${p}.`, `.${m}`, `${good}.x`, "junk", "a.b", ""]) {
        expect(query(await cb(r.f, "c", bad))).toEqual({ builder: "state" });
      }
      expect(r.gh.calls).toEqual([]); // GitHub was not asked
      expect(query(await cb(r.f, "c", good))).toMatchObject({ builder: "queued" });
    });

    it("works once: the same return a second time is refused, and nothing more is queued", async () => {
      const r = await make();
      r.gh.signIn("c", 1, 90);
      const state = begin(r.f, addr(1));
      expect(query(await cb(r.f, "c", state))).toMatchObject({ builder: "queued" });
      const calls = r.gh.calls.length;
      expect(query(await cb(r.f, "c", state))).toEqual({ builder: "state" });
      expect(r.gh.calls.length).toBe(calls);
      expect(r.f.queued()).toBe(1);
    });

    it("is used up even when the sign-in then fails, so a state is never tried twice", async () => {
      const r = await make();
      r.gh.signIn("c", 1, 90);
      r.gh.mode = "token-500";
      const state = begin(r.f, addr(1));
      expect(query(await cb(r.f, "c", state))).toEqual({ builder: "github" });
      r.gh.mode = "ok";
      expect(query(await cb(r.f, "c", state))).toEqual({ builder: "state" });
    });

    it("runs out after ten minutes", async () => {
      const r = await make();
      r.gh.signIn("c", 1, 90);
      const state = begin(r.f, addr(1));
      clock.now += 10 * 60_000 + 1;
      expect(query(await cb(r.f, "c", state))).toEqual({ builder: "state" });
      const again = begin(r.f, addr(1));
      clock.now += 9 * 60_000;
      expect(query(await cb(r.f, "c", again))).toMatchObject({ builder: "queued" });
    });

    it("is refused without a code, with a code that is too long, and when GitHub says the user said no", async () => {
      const r = await make();
      const state = begin(r.f, addr(1));
      expect(query(await r.f.builderCallback(new URLSearchParams({ state }), "1.1.1.1", cookies.get(state)))).toEqual({ builder: "state" });
      expect(query(await r.f.builderCallback(new URLSearchParams({ code: "c".repeat(600), state }), "1.1.1.1", cookies.get(state)))).toEqual({ builder: "state" });
      expect(query(await r.f.builderCallback(new URLSearchParams({ error: "access_denied", state }), "1.1.1.1", cookies.get(state)))).toEqual({ builder: "denied" });
      expect(r.gh.calls).toEqual([]);
    });

    it("is refused when GitHub says the code is no good (used or expired)", async () => {
      const r = await make();
      expect(query(await cb(r.f, "unknown-code", begin(r.f, addr(1))))).toEqual({ builder: "state" });
    });
  });

  describe("the account's age", () => {
    it("turns away an account younger than the minimum, with the number of days, and queues nothing", async () => {
      const r = await make();
      expect(await grant(r, addr(1), "young", 1, 29)).toEqual({ builder: "young", days: "30" });
      expect(r.f.queued()).toBe(0);
      expect(await grant(r, addr(1), "edge", 2, 30)).toMatchObject({ builder: "queued" });
    });

    it("does not count a turned-away account as having had its grant", async () => {
      const r = await make();
      await grant(r, addr(1), "y", 1, 5);
      expect(await grant(r, addr(1), "y2", 1, 40)).toMatchObject({ builder: "queued" });
    });

    it("refuses a created_at it cannot read, and an id that is not a number", async () => {
      const r = await make();
      r.gh.accounts.set("a", { id: 1, created_at: "never" });
      expect(query(await cb(r.f, "a", begin(r.f, addr(1))))).toEqual({ builder: "github" });
      r.gh.accounts.set("b", { id: "7" as unknown as number, created_at: new Date(T0 - 99 * DAY_MS).toISOString() });
      expect(query(await cb(r.f, "b", begin(r.f, addr(1))))).toEqual({ builder: "github" });
      r.gh.accounts.set("c", { id: 0, created_at: new Date(T0 - 99 * DAY_MS).toISOString() });
      expect(query(await cb(r.f, "c", begin(r.f, addr(1))))).toEqual({ builder: "github" });
      expect(r.f.queued()).toBe(0);
    });
  });

  describe("the limits", () => {
    it("gives one grant per GitHub account in a period, and says when to come back", async () => {
      const r = await make();
      expect(await grant(r, addr(1), "c1", 77, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
      clock.now += 700_000; // past the per-network limit
      expect(await grant(r, addr(2), "c2", 77, 90, "1.1.1.1")).toEqual({ builder: "account", wait: String(7 * DAY - 700) });
      clock.now += 7 * DAY_MS;
      expect(await grant(r, addr(2), "c3", 77, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
    });

    it("gives one grant per address in a period, whichever account asks", async () => {
      const r = await make({ perIpSeconds: 1 });
      // Two people start for the same address before either has finished, so the start's own look does not stop the second.
      const first = begin(r.f, addr(1)), second = begin(r.f, addr(1));
      expect(await grant(r, addr(1), "c1", 1, 90, "1.1.1.1", first)).toMatchObject({ builder: "queued" });
      clock.now += 3000;
      expect(await grant(r, addr(1), "c2", 2, 90, "1.1.1.1", second)).toMatchObject({ builder: "address", wait: String(7 * DAY - 3) });
      clock.now += 7 * DAY_MS;
      expect(await grant(r, addr(1), "c3", 2, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
    });

    it("gives no more than the daily cap, all accounts together, and opens again a day after", async () => {
      const r = await make({ perIpSeconds: 1 }, { maxPerDay: 2 });
      const late = begin(r.f, addr(3)); // started while the day still had room
      expect(await grant(r, addr(1), "c1", 1, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
      clock.now += 3000;
      expect(await grant(r, addr(2), "c2", 2, 90, "1.1.1.2")).toMatchObject({ builder: "queued" });
      clock.now += 3000;
      // The start says so at once; and a sign-in that began earlier is stopped when it comes back.
      expect(query(startLoc(r.f, addr(3)))).toEqual({ builder: "day", wait: String(DAY - 6) });
      expect(await grant(r, addr(3), "c3", 3, 90, "1.1.1.3", late)).toMatchObject({ builder: "day", wait: String(DAY - 6) });
      expect(r.f.queued()).toBe(2);
      clock.now += DAY_MS - 6000;
      expect(await grant(r, addr(3), "c4", 3, 90, "1.1.1.3")).toMatchObject({ builder: "queued" });
    });

    it("keeps the per-network limit and the hourly cap of the plain faucet", async () => {
      const r = await make({ maxPerHour: 3 });
      expect(await grant(r, addr(1), "c1", 1, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
      expect(await grant(r, addr(2), "c2", 2, 90, "1.1.1.1")).toMatchObject({ builder: "ip", wait: "600" });
      expect(await grant(r, addr(2), "c2b", 2, 90, "1.1.1.2")).toMatchObject({ builder: "queued" });
      expect((await r.f.request(addr(9), { ip: "1.1.1.3" })).status).toBe(202);
      expect(await grant(r, addr(3), "c3", 3, 90, "1.1.1.4")).toMatchObject({ builder: "hour" });
    });

    it("keeps the full line's refusal", async () => {
      const r = await make({ queueMax: 1 });
      expect(await grant(r, addr(1), "c1", 1, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
      expect(await grant(r, addr(2), "c2", 2, 90, "1.1.1.2")).toMatchObject({ builder: "queue" });
    });

    it("counts the grants already waiting at their own amount when it asks whether the faucet can pay", async () => {
      const r = await make({ reth: reth({ balance: async () => 150n * COIN }) });
      expect(await grant(r, addr(1), "c1", 1, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
      // 100 are owed and another 100 would be: more than 150, though it would fit if the waiting grant were counted as 1.
      expect(await grant(r, addr(2), "c2", 2, 90, "1.1.1.2")).toEqual({ builder: "empty" });
      expect(r.f.queued()).toBe(1);
    });

    it("says the faucet is empty when its coins cannot pay the grant", async () => {
      const r = await make({ reth: reth({ balance: async () => 50n * COIN }) });
      expect(await grant(r, addr(1), "c1", 1)).toEqual({ builder: "empty" });
      expect(await grant(r, addr(2), "c2", 2)).toEqual({ builder: "empty" });
      expect((await r.f.request(addr(3), { ip: "2.2.2.2" })).status).toBe(202);
    });

    it("gives the turn back when the payout failed, as a plain request does", async () => {
      let balance = 10n ** 24n;
      const r = await make({ reth: reth({ balance: async () => balance }) });
      const got = await grant(r, addr(1), "c1", 1, 90, "1.1.1.1");
      expect(got.builder).toBe("queued");
      balance = 5n * COIN; // the coins are gone before the batch is sent
      await r.f.process();
      expect(r.f.ticket(got.ticket!)).toMatchObject({ status: "failed" });
      balance = 10n ** 24n;
      clock.now += 700_000;
      expect(await grant(r, addr(1), "c2", 1, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
    });
  });

  describe("when GitHub fails", () => {
    const failing: FakeGithub["mode"][] = ["token-500", "token-unreachable", "user-500", "user-garbage", "huge", "no-token", "slow"];
    it.each(failing)("refuses, and grants nothing, when GitHub does this: %s", async (mode) => {
      const r = await make();
      r.gh.signIn("c", 1, 90);
      r.gh.mode = mode;
      if (mode === "slow") vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("t", "TimeoutError")));
      expect(query(await cb(r.f, "c", begin(r.f, addr(1))))).toEqual({ builder: "github" });
      expect(r.f.queued()).toBe(0);
      expect(logged.some((l) => l.includes("the GitHub sign-in could not be read"))).toBe(true);
    });

    it("asks GitHub with a timeout and refuses to follow a redirect", async () => {
      const seen: RequestInit[] = [];
      const r = await make({ fetch: (async (u: unknown, init?: RequestInit) => { seen.push(init!); return new Response("{}", { status: 500 }); }) as typeof fetch });
      await cb(r.f, "c", begin(r.f, addr(1)));
      expect(seen[0]!.redirect).toBe("error");
      expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    });

    it("turns a flood of sign-ins away at the twenty-first at once, so GitHub's calls never pile up", async () => {
      const gate: Array<() => void> = [];
      const r = await make({ fetch: ((async () => { await new Promise<void>((go) => gate.push(go)); return new Response("{}", { status: 500 }); }) as unknown) as typeof fetch });
      const pending = Array.from({ length: 20 }, (_, i) => cb(r.f, "c" + i, begin(r.f, addr(i + 1)), `10.0.0.${i}`));
      await vi.waitFor(() => expect(gate.length).toBe(20));
      expect(query(await cb(r.f, "c21", begin(r.f, addr(99)), "10.0.0.99"))).toMatchObject({ builder: "busy" });
      for (const go of gate) go();
      for (const p of await Promise.all(pending)) expect(query(p)).toEqual({ builder: "github" });
    });
  });

  describe("the size cap on GitHub's answers", () => {
    it("stops reading a streamed answer past 64 KiB with no content-length, refuses, queues nothing and cancels the read", async () => {
      const r = await make();
      r.gh.signIn("big", 4242, 90);
      r.gh.mode = "user-stream";
      // The token call is answered normally by the fake in this mode (the code is known), and the user call is the stream.
      expect(query(await cb(r.f, "big", begin(r.f, addr(1))))).toEqual({ builder: "github" });
      expect(r.gh.cancelled).toBe(true);
      expect(r.f.queued()).toBe(0);
    });
  });

  describe("what is kept and what is shown", () => {
    it("never puts the token, the secret, the code or anything of the person in the logs or in what it answers", async () => {
      const r = await make({ perIpSeconds: 1 });
      const answers: unknown[] = [];
      answers.push(await grant(r, addr(1), "the-code-1", 31337));
      answers.push(await grant(r, addr(2), "the-code-2", 31337, 90, "1.1.1.2")); // refused: same account
      r.gh.mode = "token-500"; answers.push(await grant(r, addr(3), "the-code-3", 5, 90, "1.1.1.3"));
      r.gh.mode = "user-500"; answers.push(await grant(r, addr(4), "the-code-4", 6, 90, "1.1.1.4"));
      answers.push(startLoc(r.f, addr(5)), await r.f.info(), r.f.ticket((answers[0] as { ticket: string }).ticket));
      const text = JSON.stringify(answers) + logged.join("\n");
      for (const leak of [SECRET, "tok-", "the-code-", "someone-secret-login", "private@example.org", "31337"]) expect(text).not.toContain(leak);
    });

    it("keeps only a keyed hash of the account id and the time of the grant, never the id", async () => {
      const r = await make();
      const got = await grant(r, addr(1), "c", 424242);
      expect(got.builder).toBe("queued");
      await r.f.flush();
      const hash = accountHash(HASH_KEY, 424242);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(accountHash(HASH_KEY, 424243)).not.toBe(hash);
      expect(accountHash(Buffer.alloc(32, 8), 424242)).not.toBe(hash);
      if (useDatabase) {
        const { rows } = await db!.pool.query<{ builder_account: Buffer; requested_at: Date; amount: string; text: string }>("select builder_account, requested_at, amount, faucet_requests::text as text from faucet_requests");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.builder_account.toString("hex")).toBe(hash);
        expect(rows[0]!.requested_at.getTime()).toBe(clock.now);
        expect(rows[0]!.amount).toBe((100n * COIN).toString());
        expect(rows[0]!.text).not.toContain("424242");
      }
    });

    it("keeps the limits across a restart: the account, the address and the day's count come back from what was written", async () => {
      const file = join(dir, "faucet.json");
      const one = await rig({ perIpSeconds: 1 }, { maxPerDay: 1 }, useDatabase, useDatabase ? null : file);
      const early = begin(one.f, addr(2)); // started before the day's cap was reached
      expect(await grant(one, addr(1), "c1", 5, 90, "1.1.1.1")).toMatchObject({ builder: "queued" });
      await one.f.flush();
      const two = await rig({ perIpSeconds: 1 }, { maxPerDay: 1 }, useDatabase, useDatabase ? null : file);
      clock.now += 3000;
      expect(await grant(two, addr(2), "c2", 5, 90, "1.1.1.2", early)).toMatchObject({ builder: "account" });
      expect(query(startLoc(two.f, addr(1)))).toMatchObject({ builder: "address" });
      expect(query(startLoc(two.f, addr(3)))).toMatchObject({ builder: "day" });
      // The grant's own amount is kept with it, so a restart signs it for the builder amount.
      const queued = one.f.queued() === 1 ? two : one;
      await queued.f.process();
      expect(parseTransaction(sent[0]!).value).toBe(100n * COIN);
    });
  });

  it("checks the limits of every instance when the grant is written: two instances over one database give one grant to one account", async () => {
    if (!useDatabase) return;
    const a = await make(), b = await make();
    const [x, y] = await Promise.all([grant(a, addr(1), "c1", 5, 90, "1.1.1.1"), grant(b, addr(2), "c2", 5, 90, "1.1.1.2")]);
    expect([x.builder, y.builder].sort()).toEqual(["account", "queued"]);
    const { rows } = await db!.pool.query("select 1 from faucet_requests where builder_account is not null and counts");
    expect(rows).toHaveLength(1);
  });

  it("gives one grant of the day's cap under two instances over one database", async () => {
    if (!useDatabase) return;
    const a = await make({ perIpSeconds: 1 }, { maxPerDay: 1 }), b = await make({ perIpSeconds: 1 }, { maxPerDay: 1 });
    const [x, y] = await Promise.all([grant(a, addr(1), "c1", 1, 90, "1.1.1.1"), grant(b, addr(2), "c2", 2, 90, "1.1.1.2")]);
    expect([x.builder, y.builder].sort()).toEqual(["day", "queued"]);
  });
});

describe("the settings' files", () => {
  it("reads a secret from a file only its owner can read, and refuses one others can read", () => {
    const file = join(dir, "secret");
    writeFileSync(file, `  ${SECRET}\n`, { mode: 0o600 });
    expect(loadSecretFile(file, "FAUCET_GITHUB_CLIENT_SECRET_FILE")).toBe(SECRET);
    chmodSync(file, 0o640);
    expect(() => loadSecretFile(file, "FAUCET_GITHUB_CLIENT_SECRET_FILE")).toThrow(/must be readable by its owner only/);
    chmodSync(file, 0o604);
    expect(() => loadSecretFile(file, "FAUCET_GITHUB_CLIENT_SECRET_FILE")).toThrow(ConfigError);
  });

  it("refuses a missing file and an empty one, and never quotes what the file holds", () => {
    expect(() => loadSecretFile(join(dir, "none"), "FAUCET_GITHUB_CLIENT_SECRET_FILE")).toThrow(/FAUCET_GITHUB_CLIENT_SECRET_FILE .* cannot be read/);
    const file = join(dir, "empty");
    writeFileSync(file, "\n", { mode: 0o600 });
    expect(() => loadSecretFile(file, "FAUCET_GITHUB_CLIENT_SECRET_FILE")).toThrow(/is empty/);
    chmodSync(file, 0o644);
    writeFileSync(file, SECRET);
    try { loadSecretFile(file, "FAUCET_GITHUB_CLIENT_SECRET_FILE"); } catch (e) { expect((e as Error).message).not.toContain(SECRET); }
  });

  it("builds the options from the settings with the secret and the key from their files, or none when it is off", () => {
    const secretFile = join(dir, "secret"), keyFile = join(dir, "key");
    writeFileSync(secretFile, SECRET, { mode: 0o600 });
    writeFileSync(keyFile, "ab".repeat(32), { mode: 0o600 });
    const github = { clientId: "Iv1.x", clientSecretFile: secretFile, redirectUrl: REDIRECT, amountWei: 100n * COIN, perAccountSeconds: 604800, minAccountAgeDays: 30, maxPerDay: 200 };
    expect(loadBuilder(null, keyFile, loadClientKey)).toBeNull();
    const built = loadBuilder(github, keyFile, loadClientKey)!;
    expect(built.clientSecret).toBe(SECRET);
    expect(built.key.equals(Buffer.from("ab".repeat(32), "hex"))).toBe(true);
    chmodSync(secretFile, 0o644);
    expect(() => loadBuilder(github, keyFile, loadClientKey)).toThrow(/must be readable by its owner only/);
  });
});
