import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "viem";

/** Why a compiler could not be had. `kind` tells the caller whether to retry (list, download) or to give up (unknown, refused). */
export class CompilerError extends Error {
  readonly kind: "list" | "unknown" | "download" | "refused";
  constructor(kind: "list" | "unknown" | "download" | "refused", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface CompilerStoreOptions {
  /** The address of the compiler release list (a list.json). A setting; the code has no default. */
  listUrl: string;
  /** What every outside request says it is (User-Agent). A setting that the deployment gives; the code has no default. */
  userAgent: string;
  /** The folder the compilers are kept in. The store makes it and keeps only its own files in it. */
  cacheDir: string;
  /** The cache keeps at most this many bytes of compilers and this many compilers; the least recently used go first. */
  maxCacheBytes?: number;
  maxCacheEntries?: number;
  /** Version to SHA-256 pairs that the deployment trusts beyond the list: the list must agree with them. */
  pinned?: Record<string, string>;
  fetchTimeoutMs?: number;
  maxListBytes?: number;
  maxBinaryBytes?: number;
  /** How long a list that was fetched is used before it is fetched again. */
  listTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Compiler { version: string; sha256: string; path: string }

interface Build { path: string; longVersion: string; version: string; sha256: string; keccak256?: string }
interface Listed { builds: Build[]; releases: Record<string, string>; fetchedAt: number }

const HEX64 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}$/;
const LONG_VERSION = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?\+commit\.[0-9a-f]{8}$/;
const PART = /^\.part-[0-9a-f]{16}$/;

const strip0x = (s: string): string => s.toLowerCase().replace(/^0x/, "");

/** A local address, where a plain-HTTP list is allowed (a test's, or a mirror on the machine). Anything else must be HTTPS. */
function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Reads a response body into memory, refusing one that is longer than `limit`. */
async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > limit) throw new CompilerError("download", `the answer is ${declared} bytes, over the limit of ${limit}`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > limit) throw new CompilerError("download", `the answer is over the limit of ${limit} bytes`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

function sha256File(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("error", fail).on("end", () => ok(h.digest("hex")));
  });
}

/**
 * The compilers the verifier may run: asked for by version, fetched from the release list the settings name, checked, and kept in a
 * bounded cache. A compiler is used only when its SHA-256 (and, where the list gives one, its Keccak-256) is what the list says, and the
 * list may not change its mind: a version's hash is recorded the first time it is seen (`seen.json`) or pinned by the deployment, and a
 * list that later gives another hash for it is refused, because a released compiler never changes. The list is fetched over HTTPS only
 * (plain HTTP only to this machine) and its redirects are not followed. The cached file is hashed again every time before it is used.
 */
export class CompilerStore {
  private readonly o: Required<Omit<CompilerStoreOptions, "pinned" | "fetch" | "now">> & { pinned: Record<string, string>; fetch: typeof fetch; now: () => number };
  private list: Listed | null = null;
  private readonly inflight = new Map<string, Promise<Compiler>>();
  private ready: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastListAt: number | null = null;

  constructor(opts: CompilerStoreOptions) {
    const u = (() => { try { return new URL(opts.listUrl); } catch { throw new CompilerError("refused", "the compiler list's address is not a URL"); } })();
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) throw new CompilerError("refused", "the compiler list must be fetched over HTTPS");
    if (u.username || u.password || u.search || u.hash) throw new CompilerError("refused", "the compiler list's address has credentials, a query or a fragment");
    if (!opts.userAgent.trim()) throw new CompilerError("refused", "an outside request needs the identity the deployment gives (OUTSIDE_USER_AGENT)");
    for (const [v, h] of Object.entries(opts.pinned ?? {})) if (!HEX64.test(strip0x(h))) throw new CompilerError("refused", `the pinned hash of ${v} is not a SHA-256`);
    this.o = {
      maxCacheBytes: 1 << 30, maxCacheEntries: 40, fetchTimeoutMs: 120_000, maxListBytes: 16 << 20, maxBinaryBytes: 128 << 20, listTtlMs: 3_600_000,
      fetch: globalThis.fetch, now: Date.now, ...opts, pinned: Object.fromEntries(Object.entries(opts.pinned ?? {}).map(([v, h]) => [v, strip0x(h)])),
    };
  }

  private get bin(): string { return join(this.o.cacheDir, "bin"); }
  private get seenFile(): string { return join(this.o.cacheDir, "seen.json"); }

  /** For the verifier's health row: how the cache and the last list fetch stand. */
  async status(): Promise<{ entries: number; bytes: number; lastListAt: number | null; lastError: string | null }> {
    const files = await this.cached();
    return { entries: files.length, bytes: files.reduce((a, f) => a + f.size, 0), lastListAt: this.lastListAt, lastError: this.lastError };
  }

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.bin, { recursive: true });
      // A download that a crash cut off: only the store's own temporary names, and only when an hour old.
      for (const name of await readdir(this.bin)) {
        if (!PART.test(name)) continue;
        const s = await stat(join(this.bin, name)).catch(() => null);
        if (s && this.o.now() - s.mtimeMs > 3_600_000) await rm(join(this.bin, name), { force: true });
      }
    })();
    return this.ready;
  }

  private async request(url: URL, limit: number): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.o.fetch(url, { headers: { "user-agent": this.o.userAgent, accept: "*/*" }, redirect: "error", signal: AbortSignal.timeout(this.o.fetchTimeoutMs) });
    } catch (e) {
      throw new CompilerError("download", `${url.pathname} could not be fetched: ${(e as Error).message}`);
    }
    if (!res.ok) throw new CompilerError("download", `${url.pathname} answered ${res.status}`);
    return readLimited(res, limit);
  }

  private async fetchList(): Promise<Listed> {
    if (this.list && this.o.now() - this.list.fetchedAt < this.o.listTtlMs) return this.list;
    let body: Buffer;
    try {
      body = await this.request(new URL(this.o.listUrl), this.o.maxListBytes);
    } catch (e) {
      this.lastError = (e as Error).message;
      throw new CompilerError("list", `the compiler list is not available: ${(e as Error).message}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(body.toString("utf8")); } catch { this.lastError = "the compiler list is not JSON"; throw new CompilerError("list", this.lastError); }
    const listed = this.parseList(raw);
    this.list = listed;
    this.lastListAt = listed.fetchedAt;
    this.lastError = null;
    return listed;
  }

  private parseList(raw: unknown): Listed {
    const r = raw as { builds?: unknown; releases?: unknown } | null;
    if (!r || !Array.isArray(r.builds)) throw new CompilerError("list", "the compiler list has no builds");
    const builds: Build[] = [];
    for (const b of r.builds as Record<string, unknown>[]) {
      // An entry that is not well formed is left out; it can never be asked for.
      if (typeof b?.path !== "string" || !FILE_NAME.test(b.path) || typeof b.longVersion !== "string" || !LONG_VERSION.test(b.longVersion) || typeof b.version !== "string" || typeof b.sha256 !== "string" || !HEX64.test(strip0x(b.sha256))) continue;
      const k = typeof b.keccak256 === "string" && HEX64.test(strip0x(b.keccak256)) ? strip0x(b.keccak256) : undefined;
      builds.push({ path: b.path, longVersion: b.longVersion, version: b.version, sha256: strip0x(b.sha256), ...(k ? { keccak256: k } : {}) });
    }
    const releases: Record<string, string> = {};
    if (r.releases && typeof r.releases === "object") for (const [v, p] of Object.entries(r.releases)) if (typeof p === "string") releases[v] = p;
    return { builds, releases, fetchedAt: this.o.now() };
  }

  /** The version as the list names it: `v0.8.28+commit.7893614a` (what Etherscan's tools send) or `0.8.28+commit.7893614a`, or a release's short `0.8.28`. */
  private find(listed: Listed, asked: string): Build {
    const v = asked.trim().replace(/^v/, "");
    let matches = listed.builds.filter((b) => b.longVersion === v);
    if (matches.length === 0 && /^\d+\.\d+\.\d+$/.test(v)) {
      const path = listed.releases[v];
      matches = listed.builds.filter((b) => b.path === path);
    }
    if (matches.length === 0) throw new CompilerError("unknown", `the compiler list has no version ${asked}`);
    // Two entries for one version that disagree are a list that cannot be trusted.
    if (matches.some((m) => m.sha256 !== matches[0]!.sha256 || m.path !== matches[0]!.path)) throw new CompilerError("refused", `the compiler list names ${asked} twice, differently`);
    return matches[0]!;
  }

  private async seen(): Promise<Record<string, string>> {
    try {
      const j = JSON.parse(await readFile(this.seenFile, "utf8")) as Record<string, string>;
      return j && typeof j === "object" ? j : {};
    } catch { return {}; }
  }

  private async record(version: string, sha: string): Promise<void> {
    const all = await this.seen();
    all[version] = sha;
    const tmp = join(this.o.cacheDir, `.seen-${randomHex()}`);
    await writeFile(tmp, JSON.stringify(all, null, 1));
    await rename(tmp, this.seenFile);
  }

  /**
   * The compiler for a version: from the cache when it is there and still hashes right, else downloaded, checked and cached. When `signal` aborts, the caller stops
   * waiting (it rejects with the signal's reason); a download in hand still ends by itself, and the cache keeps it.
   */
  get(asked: string, signal?: AbortSignal): Promise<Compiler> {
    const got = this.fetchOne(asked);
    if (!signal) return got;
    if (signal.aborted) { got.catch(() => undefined); return Promise.reject(signal.reason); }
    return new Promise<Compiler>((ok, no) => {
      const onAbort = (): void => no(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      got.then(ok, no).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private fetchOne(asked: string): Promise<Compiler> {
    const key = asked.trim().replace(/^v/, "");
    let p = this.inflight.get(key);
    if (!p) {
      p = this.load(asked).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async load(asked: string): Promise<Compiler> {
    await this.init();
    const build = this.find(await this.fetchList(), asked);
    const sha = build.sha256;
    const pinned = this.o.pinned[build.longVersion] ?? this.o.pinned[build.version];
    if (pinned && pinned !== sha) throw new CompilerError("refused", `the compiler list's hash for ${build.longVersion} is not the one pinned for it`);
    const before = (await this.seen())[build.longVersion];
    if (before && before !== sha) throw new CompilerError("refused", `the compiler list changed the hash of ${build.longVersion} since it was first seen`);

    const path = join(this.bin, sha);
    const have = await stat(path).then((st) => st, () => null);
    if (have) {
      // Only a regular file that hashes right is used. Anything else at the compiler's path (a folder that a mount made, a link) is damage in the store's own
      // cache, and is removed.
      if (have.isFile() && (await sha256File(path)) === sha) {
        const t = new Date(this.o.now());
        await utimes(path, t, t);
        return { version: build.longVersion, sha256: sha, path };
      }
      // A cached file that no longer hashes right (damaged, or changed by someone): the store's own file, so it is removed and fetched again.
      await rm(path, { recursive: true, force: true });
    }

    const body = await this.request(new URL(build.path, this.o.listUrl), this.o.maxBinaryBytes);
    const got = createHash("sha256").update(body).digest("hex");
    if (got !== sha) throw new CompilerError("refused", `the download of ${build.longVersion} has SHA-256 ${got}, not the list's ${sha}`);
    if (build.keccak256 && strip0x(keccak256(body)) !== build.keccak256) throw new CompilerError("refused", `the download of ${build.longVersion} does not have the list's Keccak-256`);
    if (body.length < 1024) throw new CompilerError("refused", `the download of ${build.longVersion} is too small to be a compiler`);

    const tmp = join(this.bin, `.part-${randomHex()}`);
    try {
      await writeFile(tmp, body, { mode: 0o755 });
      await chmod(tmp, 0o755);
      await rename(tmp, path);
      const t = new Date(this.o.now());
      await utimes(path, t, t);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await this.record(build.longVersion, sha);
    await this.evict(path);
    return { version: build.longVersion, sha256: sha, path };
  }

  private async cached(): Promise<{ path: string; size: number; mtimeMs: number }[]> {
    await this.init();
    const out: { path: string; size: number; mtimeMs: number }[] = [];
    for (const name of await readdir(this.bin)) {
      if (!HEX64.test(name)) continue;
      const s = await stat(join(this.bin, name)).catch(() => null);
      if (s) out.push({ path: join(this.bin, name), size: s.size, mtimeMs: s.mtimeMs });
    }
    return out;
  }

  /** Keeps the cache within its bounds: the least recently used compilers are removed, never the one in use. */
  private async evict(keep: string): Promise<void> {
    const files = (await this.cached()).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let bytes = files.reduce((a, f) => a + f.size, 0);
    let count = files.length;
    for (const f of files) {
      if (bytes <= this.o.maxCacheBytes && count <= this.o.maxCacheEntries) break;
      if (f.path === keep) continue;
      await rm(f.path, { force: true });
      bytes -= f.size;
      count -= 1;
    }
  }
}

function randomHex(): string {
  return randomBytes(8).toString("hex");
}
