import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    const big = await get("/api/faucet", { method: "POST", body: "x".repeat(20000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "That request is too big." });
    expect((await get("/healthz")).status).toBe(503);
  });

  it("takes a body of up to 600 KB for the verification route only, and answers 413 above that without calling the api", async () => {
    const source = "x".repeat(550 * 1024);
    const taken = await get("/api/verify", { method: "POST", body: source });
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { received: string }).received.length).toBe(source.length);
    const big = await get("/api/verify", { method: "POST", body: "x".repeat(601 * 1024) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "That request is too big." });
    expect((await get("/api/faucet", { method: "POST", body: "x".repeat(20000) })).status).toBe(413);
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

  it("serves the icons the page names, as images that a browser may keep for a day", async () => {
    const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
    for (const [name, type] of [["favicon.ico", "image/x-icon"], ["favicon-32.png", "image/png"], ["apple-touch-icon.png", "image/png"]] as const) {
      expect(page, name).toContain(`href="/${name}"`);
      copyFileSync(join(pub, name), join(dir, "dist", name));
      const res = await get(`/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toBe(type);
      expect(res.headers.get("cache-control"), name).toBe("public, max-age=86400");
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(pub, name))), name).toBe(true);
    }
    // Missing, the icon is a plain 404, never the home page.
    rmSync(join(dir, "dist", "favicon.ico"));
    expect((await get("/favicon.ico")).status).toBe(404);
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

describe("the Content-Security-Policy", () => {
  const POLICY = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

  it("is on every HTML answer (the home page and any route the pages own), and on nothing else", async () => {
    for (const path of ["/", "/block/12", "/index.html"]) {
      const res = await get(path);
      expect(res.headers.get("content-security-policy"), path).toBe(POLICY);
    }
    expect((await get("/assets/app.js")).headers.get("content-security-policy")).toBeNull();
    expect((await get("/api/status")).headers.get("content-security-policy")).toBeNull();
  });

  it("names the human check's origin, and only that, when its script is set; a setting that is no address adds nothing", async () => {
    const api = async () => ({ status: 200, body: {} });
    const asked = async (url: string | null) => {
      const s = createHttpServer(api, join(dir, "dist"), undefined, null, undefined, undefined, url);
      await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/faucet`);
      await new Promise((ok) => s.close(ok));
      return res.headers.get("content-security-policy");
    };
    expect(await asked("https://check.example/api.js?render=explicit")).toBe("script-src 'self' 'wasm-unsafe-eval' https://check.example; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    expect(await asked("not an address")).toBe(POLICY);
    expect(await asked(null)).toBe(POLICY);
  });

  it("holds the built page's shape: its only script is a file of this site, with no inline script and no handler in its markup", () => {
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, inline] of scripts) {
      expect(attrs).toMatch(/\bsrc="\//);
      expect(inline!.trim()).toBe("");
    }
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/javascript:/i);
  });
});

describe("the security headers", () => {
  const SENT = { "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin", "strict-transport-security": "max-age=31536000" };

  it("are on the pages, the files, the api (a refusal too) and the 404", async () => {
    for (const [path, init] of [["/", undefined], ["/block/12", undefined], ["/assets/app.js", undefined], ["/api/status", undefined], ["/api/faucet", { method: "POST", body: "{}" }], ["/api/slow-down", { method: "POST", body: "{}" }], ["/healthz", undefined], ["/missing.png", undefined]] as const) {
      const res = await get(path, init);
      for (const [name, value] of Object.entries(SENT)) expect(res.headers.get(name), `${path} ${name}`).toBe(value);
    }
  });

  it("send no includeSubDomains and no preload with HSTS, and a framing refusal in the policy and in X-Frame-Options", async () => {
    const res = await get("/");
    expect(res.headers.get("strict-transport-security")).not.toMatch(/includeSubDomains|preload/i);
    expect(res.headers.get("content-security-policy")).toMatch(/(^|; )frame-ancestors 'none'(;|$)/);
    expect(res.headers.get("content-security-policy")).toMatch(/(^|; )form-action 'self'(;|$)/);
  });

  it("leave a route's own Referrer-Policy as the route sets it", async () => {
    const api = async () => ({ status: 302, body: {}, headers: { location: "/faucet", "referrer-policy": "no-referrer" } });
    const s = createHttpServer(api, join(dir, "dist"));
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/faucet/github/start`, { redirect: "manual" });
    await new Promise((ok) => s.close(ok));
    expect(res.status).toBe(302);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("the client's address for the faucet", () => {
  async function serve(ipHeader: string | null | undefined) {
    const api = async (_m: string, _t: string, _b?: string, ip?: string) => ({ status: 200, body: { ip } });
    const s = ipHeader === undefined ? createHttpServer(api, dir) : createHttpServer(api, dir, undefined, ipHeader);
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    const ask = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/faucet`, { method: "POST", body: "{}", headers }).then((r) => r.json());
    return { ask, close: () => new Promise((ok) => s.close(ok)) };
  }

  it("is the socket's, and a header that nothing is told to trust is ignored", async () => {
    const s = await serve(undefined);
    expect(await s.ask({ "x-real-ip": "6.6.6.6" })).toEqual({ ip: "127.0.0.1" });
    await s.close();
  });

  it("is the last in the trusted header, which a proxy writes", async () => {
    const s = await serve("x-forwarded-for");
    expect(await s.ask({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).toEqual({ ip: "203.0.113.9" });
    expect(await s.ask()).toEqual({ ip: "127.0.0.1" });
    await s.close();
  });
});

describe("the Bridge's own host", () => {
  const BRIDGE = "https://bridge.ostia.test";
  let own: ReturnType<typeof createHttpServer>, root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "explorer-dist-bridge-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<html>explorer</html>");
    writeFileSync(join(root, "bridge.html"), "<html>bridge</html>");
    writeFileSync(join(root, "assets", "app.js"), "export {}");
    const api = async (_method: string, target: string) => ({ status: 200, body: { target } });
    own = createHttpServer(api, root, undefined, null, undefined, undefined, null, BRIDGE);
    await new Promise<void>((ok) => own.listen(0, "127.0.0.1", ok));
  });
  afterEach(async () => { await new Promise((ok) => own.close(ok)); rmSync(root, { recursive: true, force: true }); });

  /** A GET with the Host header a proxy would send (fetch does not let a script set it). */
  const at = (host: string, path: string) => new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: (own.address() as AddressInfo).port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => { body += d; }).on("end", () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", fail).end();
  });

  it("gives the Bridge's page for / and for every path the pages own, and never the explorer's", async () => {
    for (const path of ["/", "/bridge", "/blocks", "/tx/0x1", "/anything/else"]) {
      const r = await at("bridge.ostia.test", path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).toBe("<html>bridge</html>");
    }
    expect((await at("bridge.ostia.test", "/index.html")).status).toBe(404);
  });

  it("reads the host in lower case and without its port", async () => {
    expect((await at("BRIDGE.Ostia.Test:443", "/")).body).toBe("<html>bridge</html>");
    expect((await at("bridge.ostia.test:8088", "/blocks")).body).toBe("<html>bridge</html>");
  });

  it("gives the explorer's page on any other host and has no /bridge.html there", async () => {
    for (const host of ["ostia.test", "127.0.0.1:8088", "bridge.ostia.test.evil", "evil.bridge.ostia.test", "[::1]:8088"]) {
      expect((await at(host, "/")).body, String(host)).toBe("<html>explorer</html>");
      expect((await at(host, "/bridge")).body, String(host)).toBe("<html>explorer</html>");
      expect((await at(host, "/bridge.html")).status, String(host)).toBe(404);
    }
  });

  it("answers the api, the files and the policy the same on both hosts", async () => {
    for (const host of ["bridge.ostia.test", "ostia.test"]) {
      expect(JSON.parse((await at(host, "/api/status")).body)).toEqual({ target: "/api/status" });
      expect((await at(host, "/assets/app.js")).body).toBe("export {}");
    }
    const a = (await at("bridge.ostia.test", "/")).headers["content-security-policy"];
    const b = (await at("ostia.test", "/")).headers["content-security-policy"];
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("serves /bridge.html as it does any file while the setting is off, so a local run can open the app", async () => {
    const off = createHttpServer(async () => ({ status: 200, body: {} }), root);
    await new Promise<void>((ok) => off.listen(0, "127.0.0.1", ok));
    const r = await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/bridge.html`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<html>bridge</html>");
    expect(await (await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/`)).text()).toBe("<html>explorer</html>");
    await new Promise((ok) => off.close(ok));
  });
});
