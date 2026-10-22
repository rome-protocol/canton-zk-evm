import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "./http.ts";

let dir: string, server: ReturnType<typeof createHttpServer>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "explorer-cache-"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "home");
  const api = async (_m: string, target: string) =>
    target === "/api/big" ? { status: 200, body: { hex: "ab".repeat(2000) }, headers: { "cache-control": "public, max-age=3", etag: '"big1"' } }
    : target === "/api/cached" ? { status: 200, body: { n: 1 }, headers: { "cache-control": "public, max-age=3", etag: '"v1"' } }
    : target === "/api/file" ? { status: 200, body: "a,b\r\n1,2\r\n", headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="x.csv"' } }
    : target === "/api/missing" ? { status: 404, body: { error: "no" }, headers: { "cache-control": "public, max-age=3", etag: '"v1"' } }
    : { status: 200, body: { n: 2 } };
  server = createHttpServer(api, join(dir, "dist"));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
});
afterEach(async () => { await new Promise((ok) => server.close(ok)); rmSync(dir, { recursive: true, force: true }); });
const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers });

describe("the api's cache headers", () => {
  it("sends a text answer as it is, under the type it names", async () => {
    const res = await get("/api/file");
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await res.text()).toBe("a,b\r\n1,2\r\n");
    expect((await get("/api/cached")).headers.get("content-type")).toBe("application/json");
  });
  it("passes an answer's own cache rule and tag through, and never caches one that names none", async () => {
    const res = await get("/api/cached");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3");
    expect(res.headers.get("etag")).toBe('"v1"');
    expect((await get("/api/other")).headers.get("cache-control")).toBe("no-store");
  });
  it("answers 304 with no body to a matching If-None-Match, and 200 to another tag", async () => {
    const hit = await get("/api/cached", { "if-none-match": '"v1"' });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe("");
    expect((await get("/api/cached", { "if-none-match": 'W/"v1", "x"' })).status).toBe(304);
    expect((await get("/api/cached", { "if-none-match": '"v0"' })).status).toBe(200);
  });
  it("never answers 304 to an error", async () => {
    expect((await get("/api/missing", { "if-none-match": '"v1"' })).status).toBe(404);
  });
  it("gzips a big answer for a client that accepts it, and sends a small one as it is", async () => {
    const big = await get("/api/big", { "accept-encoding": "gzip" });
    expect(big.headers.get("content-encoding")).toBe("gzip");
    expect(big.headers.get("etag")).toBe('"big1-gz"');
    expect(((await big.json()) as { hex: string }).hex.length).toBe(4000);
    expect((await get("/api/cached", { "accept-encoding": "gzip" })).headers.get("content-encoding")).toBeNull();
  });
  it("gives the gzip form its own tag, and says Vary on a 304", async () => {
    const plain = await get("/api/big", { "accept-encoding": "identity" });
    expect(plain.headers.get("etag")).toBe('"big1"');
    const hit = await get("/api/big", { "accept-encoding": "gzip", "if-none-match": '"big1-gz"' });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("vary")).toBe("accept-encoding");
    expect((await get("/api/big", { "accept-encoding": "gzip", "if-none-match": '"big1"' })).status).toBe(200);
    expect((await get("/api/big", { "accept-encoding": "identity", "if-none-match": '"big1"' })).status).toBe(304);
  });
});
