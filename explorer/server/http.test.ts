import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "./http.ts";

let dir: string, server: ReturnType<typeof createHttpServer>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "explorer-dist-"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<html>home</html>");
  writeFileSync(join(dir, "dist", "assets", "app.js"), "export {}");
  writeFileSync(join(dir, "secret.txt"), "not for the web");
  const api = async (method: string, target: string, body?: string) =>
    target === "/healthz" ? { status: 503, body: { ok: false } }
    : target === "/api/slow-down" ? { status: 429, body: { error: "wait" }, headers: { "Retry-After": "7" } }
    : { status: 200, body: { method, target, ...(body === undefined ? {} : { received: body }) } };
  server = createHttpServer(api, join(dir, "dist"));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
});
afterEach(async () => { await new Promise((ok) => server.close(ok)); rmSync(dir, { recursive: true, force: true }); });

const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);

const raw = (request: string) => new Promise<string>((ok, fail) => {
  const socket = connect((server.address() as AddressInfo).port, "127.0.0.1", () => socket.write(request));
  let text = "";
  socket.on("data", (d) => { text += d; }).on("end", () => ok(text)).on("error", fail);
});

describe("the http server", () => {
  it("serves the api as JSON that is never cached, with the api's own status", async () => {
    const res = await get("/api/status?x=1");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ method: "GET", target: "/api/status?x=1" });
    expect((await get("/healthz")).status).toBe(503);
    expect(await (await get("/api/faucet", { method: "POST" })).json()).toEqual({ method: "POST", target: "/api/faucet", received: "" });
  });

  it("hands a POST's body to the api, and sets the headers the api asks for", async () => {
    const posted = await get("/api/faucet", { method: "POST", body: '{"address":"0x1"}' });
    expect(await posted.json()).toEqual({ method: "POST", target: "/api/faucet", received: '{"address":"0x1"}' });
    const slow = await get("/api/slow-down", { method: "POST", body: "{}" });
    expect(slow.status).toBe(429);
    expect(slow.headers.get("retry-after")).toBe("7");
  });

  it("answers 413, and does not call the api, for a body that is too big", async () => {
    const big = await get("/api/faucet", { method: "POST", body: "x".repeat(5000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "That request is too big." });
    expect((await get("/healthz")).status).toBe(503);
  });

  it("serves the pages, with the home page for any route the pages own", async () => {
    expect(await (await get("/")).text()).toBe("<html>home</html>");
    expect(await (await get("/block/12")).text()).toBe("<html>home</html>");
    const js = await get("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await get("/assets/missing.js")).status).toBe(404);
  });

  it("serves the fonts and their licence texts with their own types", async () => {
    mkdirSync(join(dir, "dist", "fonts"));
    writeFileSync(join(dir, "dist", "fonts", "plex.woff2"), "font");
    writeFileSync(join(dir, "dist", "fonts", "OFL.txt"), "licence");
    expect((await get("/fonts/plex.woff2")).headers.get("content-type")).toBe("font/woff2");
    expect((await get("/fonts/OFL.txt")).headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("serves the Verify check's .wasm file, and a HEAD for it gives its size without the file", async () => {
    mkdirSync(join(dir, "dist", "verify"));
    writeFileSync(join(dir, "dist", "verify", "zk_explorer_verify.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const file = await get("/verify/zk_explorer_verify.wasm");
    expect(file.headers.get("content-type")).toBe("application/wasm");
    expect(file.headers.get("content-length")).toBe("8");
    expect((await file.arrayBuffer()).byteLength).toBe(8);
    const head = await get("/verify/zk_explorer_verify.wasm", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("8");
    expect(await head.text()).toBe("");
    // A missing file is a plain 404 for the page to report, never the home page.
    expect((await get("/verify/other.wasm", { method: "HEAD" })).status).toBe(404);
  });

  it("does not serve a file outside the pages' folder", async () => {
    expect((await get("/..%2fsecret.txt")).status).toBe(404);
    expect((await get("/%2e%2e/secret.txt")).status).toBe(404);
  });

  it("answers 400, and keeps serving, when the request line is not a path", async () => {
    for (const target of ["//", "///", "//x/y"]) {
      const answer = await raw(`GET ${target} HTTP/1.1\r\nhost: explorer\r\nconnection: close\r\n\r\n`);
      expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    }
    expect((await get("/healthz")).status).toBe(503);
    expect(await (await get("/api/status")).json()).toEqual({ method: "GET", target: "/api/status" });
  });
});
