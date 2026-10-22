import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompilerError, CompilerStore } from "./compilers.ts";
import { FakeMirror, sha } from "./fake-mirror.ts";

const UA = "Test Agent test@example.invalid";

/** A compiler made of the given text, long enough to pass the size check. */
const binary = (tag: string): Buffer => Buffer.from(`#!/bin/sh\n# ${tag}\n${"# padding\n".repeat(200)}echo ${tag}\n`);

const V1 = "0.8.28+commit.7893614a";
const V2 = "0.8.27+commit.40a35a09";
const V3 = "0.8.26+commit.8a97fa7a";

let mirror: FakeMirror;
let dir: string;
beforeEach(async () => {
  mirror = new FakeMirror();
  await mirror.start();
  dir = mkdtempSync(join(tmpdir(), "verifier-cache-"));
});
afterEach(async () => {
  await mirror.stop();
  // Exactly the folder this test made.
  rmSync(dir, { recursive: true, force: true });
});

const store = (extra: Record<string, unknown> = {}): CompilerStore => new CompilerStore({ listUrl: mirror.url, userAgent: UA, cacheDir: join(dir, "cache"), ...extra });
const refused = async (p: Promise<unknown>, kind: string, text?: RegExp): Promise<void> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(CompilerError);
  expect((e as CompilerError).kind).toBe(kind);
  if (text) expect((e as CompilerError).message).toMatch(text);
};

describe("a good download", () => {
  it("is fetched once, cached, and used again without the network", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    const a = await store().get(`v${V1}`);
    expect(a.version).toBe(V1);
    expect(a.sha256).toBe(sha(mirror.entries[0]!.body));
    expect(statSync(a.path).mode & 0o111).not.toBe(0);
    expect(mirror.downloads()).toBe(1);
    // A second store on the same folder (a restart): the cached file is used. No list, no compiler: the list gives the hash to check.
    mirror.listStatus = 500;
    await refused(store().get(V1), "list");
    mirror.listStatus = 200;
    const c = await store().get(V1);
    expect(c.path).toBe(a.path);
    expect(mirror.downloads()).toBe(1);
  });

  it("is asked for by the long version, with or without v, or by a release's short version", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    const s = store();
    const p = (await s.get(`v${V1}`)).path;
    expect((await s.get(V1)).path).toBe(p);
    expect((await s.get("0.8.28")).path).toBe(p);
    expect(mirror.downloads()).toBe(1);
  });

  it("sends the identity the deployment gave, to the list and to the download", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    await store().get(V1);
    expect(mirror.hits.length).toBe(2);
    for (const h of mirror.hits) expect(h.ua).toBe(UA);
  });

  it("is fetched once when many ask at the same time", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    const s = store();
    await Promise.all([s.get(V1), s.get(V1), s.get(`v${V1}`)]);
    expect(mirror.downloads()).toBe(1);
  });

  it("is hashed again before every use: a damaged cache file is replaced", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    const s = store();
    const a = await s.get(V1);
    writeFileSync(a.path, "tampered");
    const b = await s.get(V1);
    expect(sha(readFileSync(b.path))).toBe(a.sha256);
    expect(mirror.downloads()).toBe(2);
  });
});

describe("a download that is not what the list says", () => {
  it("is refused when the SHA-256 is wrong, and nothing is kept", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one"), sha256: "ab".repeat(32) }];
    await refused(store().get(V1), "refused", /SHA-256/);
    expect(readdirSync(join(dir, "cache", "bin"))).toEqual([]);
  });

  it("is refused when the Keccak-256 is wrong though the SHA-256 is right", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one"), keccak256: `0x${"cd".repeat(32)}` }];
    await refused(store().get(V1), "refused", /Keccak/);
    expect(readdirSync(join(dir, "cache", "bin"))).toEqual([]);
  });

  it("is refused when it is too small to be a compiler", async () => {
    const body = Buffer.from("tiny");
    mirror.entries = [{ longVersion: V1, body }];
    await refused(store().get(V1), "refused", /too small/);
  });

  it("is refused when it is bigger than the limit", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    await refused(store({ maxBinaryBytes: 500 }).get(V1), "download", /limit/);
    expect(readdirSync(join(dir, "cache", "bin"))).toEqual([]);
  });

  it("is refused when the list gives another hash for a version it gave before", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    await store().get(V1);
    mirror.entries = [{ longVersion: V1, body: binary("two") }];
    await refused(store().get(V1), "refused", /changed the hash/);
  });

  it("is refused when the list does not give the hash the deployment pinned", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    await refused(store({ pinned: { [V1]: "ef".repeat(32) } }).get(V1), "refused", /pinned/);
    expect(mirror.downloads()).toBe(0);
    const ok = await store({ pinned: { [V1]: sha(mirror.entries[0]!.body) } }).get(V1);
    expect(ok.version).toBe(V1);
  });

  it("is refused when the list names the version twice with different hashes", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }, { longVersion: V1, body: binary("two"), path: "other" }];
    await refused(store().get(V1), "refused", /twice/);
  });

  it("is never fetched from a path outside the list's folder", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one"), path: "../etc-passwd" }];
    await refused(store().get(V1), "unknown");
    expect(mirror.downloads()).toBe(0);
  });
});

describe("the list", () => {
  it("must be fetched over HTTPS unless it is on this machine", () => {
    expect(() => new CompilerStore({ listUrl: "http://example.invalid/list.json", userAgent: UA, cacheDir: dir })).toThrow(/HTTPS/);
    expect(() => new CompilerStore({ listUrl: "https://example.invalid/list.json", userAgent: UA, cacheDir: dir })).not.toThrow();
    expect(() => new CompilerStore({ listUrl: "https://u:p@example.invalid/list.json", userAgent: UA, cacheDir: dir })).toThrow(/credentials/);
  });

  it("needs an identity for the outside requests", () => {
    expect(() => new CompilerStore({ listUrl: mirror.url, userAgent: " ", cacheDir: dir })).toThrow(/OUTSIDE_USER_AGENT/);
  });

  it("is a failure to retry, not an unknown version, when it cannot be fetched", async () => {
    mirror.listStatus = 503;
    await refused(store().get(V1), "list");
  });

  it("says unknown for a version it does not have", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    await refused(store().get("0.4.1+commit.11111111"), "unknown");
  });

  it("is fetched again only after its time to live", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    let t = 1_000_000;
    const s = store({ now: () => t, listTtlMs: 1000 });
    await s.get(V1);
    await s.get(V1);
    expect(mirror.hits.filter((h) => h.url === "/bin/list.json").length).toBe(1);
    t += 2000;
    await s.get(V1);
    expect(mirror.hits.filter((h) => h.url === "/bin/list.json").length).toBe(2);
  });
});

describe("the cache is bounded", () => {
  it("removes the least recently used compilers over the entry limit, never the one in use", async () => {
    mirror.entries = [V1, V2, V3].map((v) => ({ longVersion: v, body: binary(v) }));
    let t = 1_000_000;
    const s = store({ now: () => (t += 1000), maxCacheEntries: 2 });
    const a = await s.get(V1);
    const b = await s.get(V2);
    await s.get(V1); // V1 is now more recent than V2
    const c = await s.get(V3);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(false);
    expect(existsSync(c.path)).toBe(true);
    expect((await s.status()).entries).toBe(2);
  });

  it("removes them over the byte limit too", async () => {
    mirror.entries = [V1, V2].map((v) => ({ longVersion: v, body: binary(v) }));
    let t = 1_000_000;
    const size = binary(V1).length;
    const s = store({ now: () => (t += 1000), maxCacheBytes: size + 10 });
    const a = await s.get(V1);
    const b = await s.get(V2);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect((await s.status()).bytes).toBeLessThanOrEqual(size + 10);
  });

  it("keeps only its own files: a stranger's file in the folder is left alone", async () => {
    mirror.entries = [V1, V2].map((v) => ({ longVersion: v, body: binary(v) }));
    const s = store({ maxCacheEntries: 1 });
    await s.get(V1);
    writeFileSync(join(dir, "cache", "bin", "notes.txt"), "x");
    await s.get(V2);
    expect(existsSync(join(dir, "cache", "bin", "notes.txt"))).toBe(true);
  });

  it("clears an old half-written download at start, and only that", async () => {
    mirror.entries = [{ longVersion: V1, body: binary("one") }];
    const s = store();
    await s.get(V1);
    const old = join(dir, "cache", "bin", ".part-0123456789abcdef");
    writeFileSync(old, "half");
    const stale = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, stale, stale);
    await store().get(V1);
    expect(existsSync(old)).toBe(false);
  });
});
