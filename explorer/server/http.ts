import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { textOf } from "./rest/cache.ts";

const gzipAsync = promisify(gzip);
import { extname, resolve, sep } from "node:path";
import type { Api } from "./api.ts";
import { MAX_BODY as RPC_MAX_BODY, type PublicRpc } from "./public-rpc.ts";
import { lastIdOf, topicsOf, type StreamHub } from "./rest/stream.ts";
import { ETHERSCAN_REFUSED, MAX_VERIFY_BODY, REST_REFUSED, createLimits, isVerification, retryAfter, verificationRefused, verificationTooBig, type Limits } from "./limits.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** The biggest request body the server reads. The faucet's is one address. */
/** Room for a human check's token, which can be a few thousand characters. */
const MAX_BODY = 8192;
/** The one POST that takes a contract's source: up to 500 KB of it and its JSON around it. */
const VERIFY_BODY_MAX = 600 * 1024;

/** An ended stream that has not flushed and closed by now is destroyed: a client that stops reading cannot hold its slot. */
export const END_DEADLINE_MS = 10_000;
export function endWithin(res: ServerResponse, ms = END_DEADLINE_MS): void {
  res.end();
  const t = setTimeout(() => res.destroy(), ms);
  t.unref();
  res.once("close", () => clearTimeout(t));
}

/** The body as text, or null when it is bigger than the limit (what is left is thrown away). */
function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string | null> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => ok(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** An answer of at least this many characters is gzipped for a client that accepts it. */
const GZIP_FROM = 1024;

/** True when an `If-None-Match` header names the tag (a weak mark on either side does not matter for a GET). */
function matches(header: string | string[] | undefined, etag: string): boolean {
  const sent = (Array.isArray(header) ? header.join(",") : header)?.split(",").map((t) => t.trim().replace(/^W\//, ""));
  return !!sent && (sent.includes("*") || sent.includes(etag.replace(/^W\//, "")));
}

/** The public RPC's door: its handler, and the header that names the client's address when a trusted proxy sets one. */
export interface RpcDoor { handler: PublicRpc; ipHeader: string | null }

const JSON_TYPE = { "content-type": "application/json" };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };

/** The client's address: the socket's, or the last one in the trusted header (a proxy adds the client's address at the end). */
function clientIp(req: IncomingMessage, ipHeader: string | null): string {
  const sent = ipHeader ? req.headers[ipHeader] : undefined;
  const last = (Array.isArray(sent) ? sent.join(",") : sent)?.split(",").pop()?.trim();
  return last || req.socket.remoteAddress || "unknown";
}

/** `ipHeader` names the header that carries the client's address for the faucet's and the REST limits (6.6), and is the public RPC's when none is given. `limits` holds the per-client limits of the REST routes, the Etherscan door and verification; `/rpc`, the live streams and the faucet keep their own. Serves `/api/*` and `/healthz` from the API, `POST /rpc` from the public RPC when it is on, and everything else from the pages' build in `dist`, with the home page for any route the pages own. */
export function createHttpServer(api: Api, dist: string, rpc?: RpcDoor, ipHeader: string | null = rpc?.ipHeader ?? null, stream?: StreamHub, limits: Limits = createLimits()): Server {
  const root = resolve(dist);
  async function page(pathname: string): Promise<{ file: string; bytes: Buffer } | null> {
    let name: string;
    try { name = decodeURIComponent(pathname); } catch { return null; }
    let file = resolve(root, "." + name);
    if (file !== root && !file.startsWith(root + sep)) return null;
    if (!(await stat(file).then((s) => s.isFile(), () => false))) {
      if (extname(name)) return null;
      file = resolve(root, "index.html");
    }
    return readFile(file).then((bytes) => ({ file, bytes }), () => null);
  }

  return createServer(async (req, res) => {
    const method = req.method ?? "GET", target = req.url ?? "/";
    let pathname: string;
    try {
      // A path starts with one slash: "//" would be read as a host, and "*" or a full address is not a path at all.
      if (!/^\/(?!\/)/.test(target)) throw new Error("not a path");
      pathname = new URL(target, "http://explorer").pathname;
    } catch {
      return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "That is not a path." }));
    }
    try {
      if (pathname === "/rpc") {
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
          void res.writeHead(status, { ...JSON_TYPE, ...CORS, "cache-control": "no-store", ...headers }).end(JSON.stringify(body));
        if (!rpc) return send(404, { error: "The public RPC is off on this explorer." });
        if (method === "OPTIONS") return void res.writeHead(204, CORS).end();
        if (method !== "POST") return send(405, { error: "Use POST." }, { allow: "POST, OPTIONS" });
        const tooBig = () => send(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "That request is too big." } }, { connection: "close" });
        if (Number(req.headers["content-length"] ?? 0) > RPC_MAX_BODY) return tooBig();
        const sent = await readBody(req, RPC_MAX_BODY);
        if (sent === null) return tooBig();
        try {
          const { status, body, headers } = await rpc.handler(sent, clientIp(req, rpc.ipHeader));
          return send(status, body, headers);
        } catch (e) {
          // A browser page gets an error it can read, with the headers that let it read it.
          console.error(`${method} ${pathname}: ${(e as Error).message}`);
          return send(200, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Something went wrong in the RPC. Try again in a moment." } });
        }
      }
      if (pathname === "/api/stream") {
        const fail = (status: number, error: string, headers: Record<string, string> = {}) =>
          void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify({ error }));
        if (!stream) return fail(404, "Live updates are off on this explorer.");
        if (method !== "GET") return fail(405, "Use GET.", { allow: "GET" });
        const topics = topicsOf(new URL(target, "http://explorer").searchParams.get("topics"));
        if (!topics) return fail(400, "topics is a list of blocks, txs, inflight and stats.");
        // The head goes out with the first byte: a stream that is refused is a plain 429, and one that is taken starts with its retry delay.
        let started = false;
        const open = () => {
          if (started) return;
          started = true;
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
          res.write("retry: 3000\n\n");
        };
        const sink = { write: (c: string) => { open(); res.write(c); }, backlog: () => res.writableLength, end: () => endWithin(res), destroy: () => void res.destroy() };
        const attached = stream.attach(clientIp(req, ipHeader), topics, lastIdOf(req.headers["last-event-id"]), sink);
        if (!attached.ok) return fail(429, attached.error, { "retry-after": "5" });
        req.socket.setNoDelay(true);
        req.socket.setTimeout(0);
        res.on("close", attached.detach);
        return void open();
      }
      if (pathname === "/api") {
        // The Etherscan door: its own rate, and its own answer when the client is over it (HTTP 200, as Etherscan gives, and a Retry-After).
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
          void res.writeHead(status, { ...JSON_TYPE, "cache-control": "no-store", ...headers }).end(JSON.stringify(body));
        const ip = clientIp(req, ipHeader);
        const wait = limits.etherscan.take(ip);
        if (wait !== null) return send(200, ETHERSCAN_REFUSED, retryAfter(wait));
        const query = new URL(target, "http://explorer").searchParams;
        let sent: string | undefined;
        if (method === "POST") {
          // The action may be in the form, so a body is read up to a verification's 500 KB; one that is not a verification may be no bigger than the other routes' bodies.
          if (Number(req.headers["content-length"] ?? 0) > MAX_VERIFY_BODY) return send(200, verificationTooBig(), { connection: "close" });
          const body = await readBody(req, MAX_VERIFY_BODY);
          if (body === null || (body.length > MAX_BODY && !isVerification(query, body))) return send(200, verificationTooBig(), { connection: "close" });
          sent = body;
        }
        if (isVerification(query, sent)) {
          const later = limits.verification.take(ip);
          if (later !== null) return send(200, verificationRefused(later), retryAfter(later));
        }
        const { status, body, headers } = await api(method, target, sent, ip);
        return send(status, body, { ...headers });
      }
      // The pages' REST routes share one rate per client, and `/healthz` is in it: it answers the same as `/api/status` (reth and Canton on every call), so it must not be a way round the limit. The rate is far above any proxy's probe. The faucet has its own limits, and the live stream its own count.
      if ((pathname.startsWith("/api/") && pathname !== "/api/faucet" && !pathname.startsWith("/api/faucet/")) || pathname === "/healthz") {
        const wait = limits.rest.take(clientIp(req, ipHeader));
        if (wait !== null) return void res.writeHead(429, { ...JSON_TYPE, "cache-control": "no-store", ...retryAfter(wait) }).end(JSON.stringify({ error: REST_REFUSED(wait) }));
      }
      if (pathname.startsWith("/api/") || pathname === "/healthz") {
        const sent = method === "POST" ? await readBody(req, pathname === "/api/verify" ? VERIFY_BODY_MAX : MAX_BODY) : undefined;
        if (sent === null) return void res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "That request is too big." }));
        const { status, body, headers } = await api(method, target, sent, clientIp(req, ipHeader));
        const text = textOf(body);
        // An answer that names its cache rule (and a validator) may be cached; it is revalidated cheaply with If-None-Match. Anything else is never cached.
        // A big answer (a block's record is about 0.35 MB of hex) goes gzipped to a client that accepts it, off the event loop; the gzip form has its own tag.
        const out: Record<string, string> = { "cache-control": "no-store", "content-type": "application/json", ...headers };
        const zip = text.length >= GZIP_FROM && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
        if (zip && out.etag) out.etag = out.etag.replace(/"$/, '-gz"');
        if (status === 200 && out.etag && (method === "GET" || method === "HEAD") && matches(req.headers["if-none-match"], out.etag)) {
          return void res.writeHead(304, { etag: out.etag, "cache-control": out["cache-control"] as string, vary: "accept-encoding" }).end();
        }
        if (zip) {
          const zipped = await gzipAsync(text);
          return void res.writeHead(status, { ...out, "content-encoding": "gzip", vary: "accept-encoding", "content-length": zipped.length }).end(method === "HEAD" ? undefined : zipped);
        }
        res.writeHead(status, { ...out, vary: "accept-encoding" }).end(text);
      } else if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
      } else {
        const found = await page(pathname);
        if (!found) return void res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        res.writeHead(200, { "content-type": TYPES[extname(found.file)] ?? "application/octet-stream", "content-length": found.bytes.length, "x-content-type-options": "nosniff" }).end(method === "HEAD" ? undefined : found.bytes);
      }
    } catch (e) {
      console.error(`${method} ${pathname}: ${(e as Error).message}`);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "Something went wrong in the explorer." }));
    }
  });
}
