import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { ConfigError, type Config } from "./config.ts";

/**
 * The builder grant: a GitHub account that is old enough gets a larger amount than the plain faucet gives, once in a period.
 * This file holds the sign-in with GitHub. The faucet holds the limits and the queue, and is called once an account has been read.
 */

export interface BuilderOptions {
  /** The GitHub App's client id, and its client secret (read from a file only its owner can read). */
  clientId: string;
  clientSecret: string;
  /** Where GitHub sends the person back: the explorer's own /api/faucet/github/callback. */
  redirectUrl: string;
  /** The key a GitHub account id is hashed with before it is kept (the same key client addresses are hashed with). */
  key: Buffer;
  amountWei: bigint;
  perAccountSeconds: number;
  minAccountAgeDays: number;
  /** The most grants in a day, all accounts together. */
  maxPerDay: number;
}

export const CALLBACK_PATH = "/api/faucet/github/callback";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const USER_AGENT = "ostia-faucet";
/** How long a sign-in may take from the click to the return, and how long each call to GitHub may take. */
const STATE_TTL_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 5000;
/** The most of a GitHub answer that is read. The answers used here are a few hundred bytes. */
const ANSWER_MAX = 64 * 1024;
/** Sign-ins being finished at once: past this, a person is asked to try again, so GitHub's calls never pile up. */
const BUSY_MAX = 20;
const DAY_MS = 86400_000;

/** A setting that names a file that holds a client secret. The file must be readable by its owner only (chmod 600), and the message never quotes it. */
export function loadSecretFile(file: string, setting: string): string {
  let text: string;
  try {
    if (statSync(file).mode & 0o077) throw new ConfigError(`${setting} ${file} must be readable by its owner only (chmod 600)`);
    text = readFileSync(file, "utf8").trim();
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${setting} ${file} cannot be read`);
  }
  if (!text) throw new ConfigError(`${setting} ${file} is empty`);
  return text;
}

/** What `GET /api/faucet` says of the builder grant. No secret is in it. */
export interface BuilderInfo {
  on: boolean;
  amount: string | null;
  perAccountSeconds: number | null;
  minAccountAgeDays: number | null;
  maxPerDay: number | null;
}

/** The places the sign-in sends a person back to the Faucet page, and what each one means. */
export type BuilderOutcome =
  | "queued" | "young" | "account" | "address" | "day" | "ip" | "hour" | "queue" | "empty"
  | "state" | "denied" | "github" | "busy" | "bad" | "off" | "problem";

/** What the faucet answers the sign-in with after it has looked at its limits. */
export interface GrantAnswer { status: number; body: unknown; headers?: Record<string, string> }

export interface SignInDeps {
  fetch: typeof fetch;
  now: () => number;
  /** Queues the grant for an address, or says which limit stopped it. Never throws. */
  grant: (to: string, account: string, ip: string | undefined) => Promise<GrantAnswer>;
  /** The refusal an address would get now, without spending a GitHub sign-in, or null. */
  early: (to: string) => { outcome: BuilderOutcome; wait: number } | null;
}

export interface SignIn {
  /** Where to send a person who clicked "Sign in with GitHub" for this address: GitHub's page, or the Faucet page with a plain result. */
  start(address: unknown): string;
  /** Where to send a person GitHub sent back, after the code has been read and the account looked at. Never throws. */
  callback(query: URLSearchParams, ip: string | undefined): Promise<string>;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** The page's address for a result. Only a code and a few numbers go in it: the page has the words. */
export function backTo(outcome: BuilderOutcome, extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams({ builder: outcome });
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return `/faucet?${q}`;
}

/** A GitHub account id as the keyed hash that is kept in its place: it tells one account from another and tells nobody which account it is. */
export const accountHash = (key: Buffer, githubId: number): string => createHmac("sha256", key).update(`github|${githubId}`).digest("hex");

/** Reads at most `max` bytes of an answer as JSON; null when it is longer, or is not JSON. */
async function readJson(res: Response, max = ANSWER_MAX): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

class GithubFailed extends Error {}

export function createSignIn(o: BuilderOptions, d: SignInDeps): SignIn {
  /** States already used, by nonce, until they would have run out anyway. */
  const used = new Map<string, number>();
  let busy = 0;

  const macOf = (payload: Buffer): Buffer => createHmac("sha256", o.key).update("builder-state|").update(payload).digest();

  /** A state names the address it was made for, and runs out. It is signed, so it cannot be made or changed by anyone without the key. */
  function makeState(to: string): string {
    const expires = Buffer.alloc(6);
    expires.writeUIntBE(d.now() + STATE_TTL_MS, 0, 6);
    const payload = Buffer.concat([Buffer.from(to.slice(2), "hex"), expires, randomBytes(16)]);
    return `${payload.toString("base64url")}.${macOf(payload).toString("base64url")}`;
  }

  function readState(state: string): { to: string; nonce: string; expires: number } | null {
    const [p, m, ...rest] = state.split(".");
    if (!p || !m || rest.length) return null;
    const payload = Buffer.from(p, "base64url"), mac = Buffer.from(m, "base64url");
    if (payload.length !== 20 + 6 + 16 || mac.length !== 32) return null;
    const right = macOf(payload);
    if (!timingSafeEqual(mac, right)) return null;
    const expires = payload.readUIntBE(20, 6);
    if (expires <= d.now()) return null;
    return { to: `0x${payload.subarray(0, 20).toString("hex")}`, nonce: payload.subarray(26).toString("hex"), expires };
  }

  /** The state is single use: this says it has been seen, and false when it had been. */
  function take(nonce: string, expires: number): boolean {
    const t = d.now();
    for (const [n, e] of used) { if (e > t) break; used.delete(n); }
    if (used.has(nonce)) return false;
    used.set(nonce, expires);
    return true;
  }

  async function call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await d.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch {
      throw new GithubFailed("not reached");
    }
    const body = await readJson(res).catch(() => null);
    if (body === null || typeof body !== "object") throw new GithubFailed(`status ${res.status}, no readable answer`);
    if (!res.ok && !("error" in body)) throw new GithubFailed(`status ${res.status}`);
    return body;
  }

  /** The GitHub account behind a code: its id and when it was made. The token lives in this function and nowhere else. */
  async function account(code: string): Promise<{ id: number; createdAt: number }> {
    const exchanged = (await call(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: new URLSearchParams([["client_id", o.clientId], ["client" + "_secret", o.clientSecret], ["code", code], ["redirect_uri", o.redirectUrl]]),
    })) as Record<string, unknown>;
    if (exchanged.error === "bad_verification_code") throw new BadCode();
    const bearer = exchanged["access_" + "token"];
    if (typeof bearer !== "string" || !bearer || bearer.length > 1024) throw new GithubFailed("no bearer");
    const user = (await call(USER_URL, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${bearer}`, "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" },
    })) as { id?: unknown; created_at?: unknown };
    const createdAt = typeof user.created_at === "string" ? Date.parse(user.created_at) : NaN;
    if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0 || !Number.isFinite(createdAt)) throw new GithubFailed("no account");
    return { id: user.id, createdAt };
  }
  class BadCode extends Error {}

  return {
    start(address) {
      const to = typeof address === "string" ? address.toLowerCase() : "";
      if (!ADDRESS.test(to)) return backTo("bad");
      const early = d.early(to);
      if (early) return backTo(early.outcome, { wait: early.wait });
      const q = new URLSearchParams({ client_id: o.clientId, redirect_uri: o.redirectUrl, state: makeState(to) });
      return `${AUTHORIZE_URL}?${q}`;
    },

    async callback(query, ip) {
      if (query.get("error")) return backTo("denied");
      const code = query.get("code"), state = query.get("state");
      if (!code || !state || code.length > 512 || state.length > 512) return backTo("state");
      const s = readState(state);
      if (!s || !take(s.nonce, s.expires)) return backTo("state");
      if (busy >= BUSY_MAX) return backTo("busy", { wait: 5 });
      busy++;
      let who: { id: number; createdAt: number };
      try {
        who = await account(code);
      } catch (e) {
        if (e instanceof BadCode) return backTo("state");
        // Only the step is logged: never the code, the token, the secret or anything GitHub said about the person.
        console.error(`faucet: the GitHub sign-in could not be read (${e instanceof GithubFailed ? e.message : "failed"})`);
        return backTo("github");
      } finally {
        busy--;
      }
      if (d.now() - who.createdAt < o.minAccountAgeDays * DAY_MS) return backTo("young", { days: o.minAccountAgeDays });
      const answer = await d.grant(s.to, accountHash(o.key, who.id), ip);
      if (answer.status === 202) {
        const ticket = (answer.body as { ticket?: unknown }).ticket;
        return typeof ticket === "string" ? backTo("queued", { ticket }) : backTo("problem");
      }
      const reason = (answer.body as { reason?: unknown }).reason;
      const wait = Number(answer.headers?.["Retry-After"]);
      const extra: Record<string, number> = Number.isFinite(wait) && wait > 0 ? { wait } : {};
      switch (reason) {
        case "account": return backTo("account", extra);
        case "builder-address": return backTo("address", extra);
        case "day": return backTo("day", extra);
        case "ip": return backTo("ip", extra);
        case "hour": return backTo("hour", extra);
        case "queue": return backTo("queue", extra);
        case "empty": return backTo("empty");
        default: return backTo("problem");
      }
    },
  };
}

/** The builder grant's options from the settings, or null when it is off. Reads the secret and the key, and refuses to start on a file others can read. */
export function loadBuilder(github: NonNullable<Config["faucet"]["github"]> | null, clientKeyFile: string | null, loadKey: (file: string) => Buffer): BuilderOptions | null {
  if (!github) return null;
  return {
    clientId: github.clientId, clientSecret: loadSecretFile(github.clientSecretFile, "FAUCET_GITHUB_CLIENT_SECRET_FILE"), redirectUrl: github.redirectUrl,
    key: loadKey(clientKeyFile!), amountWei: github.amountWei, perAccountSeconds: github.perAccountSeconds, minAccountAgeDays: github.minAccountAgeDays, maxPerDay: github.maxPerDay,
  };
}
