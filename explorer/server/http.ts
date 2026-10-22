import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { extname, resolve, sep } from "node:path";
import type { Api } from "./api.ts";
import { MAX_BODY as RPC_MAX_BODY, type PublicRpc } from "./public-rpc.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** The biggest request body the server reads. The faucet's is one address. */
/** Room for a human check's token, which can be a few thousand characters. */
const MAX_BODY = 8192;

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

/** `ipHeader` names the header that carries the client's address for the faucet's limits, and is the public RPC's when none is given. Serves `/api/*` and `/healthz` from the API, `POST /rpc` from the public RPC when it is on, and everything else from the pages' build in `dist`, with the home page for any route the pages own. */
export function createHttpServer(api: Api, dist: string, rpc?: RpcDoor, ipHeader: string | null = rpc?.ipHeader ?? null): Server {
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
      if (pathname.startsWith("/api/") || pathname === "/healthz") {
        const sent = method === "POST" ? await readBody(req) : undefined;
        if (sent === null) return void res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "That request is too big." }));
        const { status, body, headers } = await api(method, target, sent, clientIp(req, ipHeader));
        const text = JSON.stringify(body);
        // An answer that names its cache rule (and a validator) may be cached; it is revalidated cheaply with If-None-Match. Anything else is never cached.
        const out = { "cache-control": "no-store", ...headers, "content-type": "application/json" };
        if (status === 200 && out.etag && (method === "GET" || method === "HEAD") && matches(req.headers["if-none-match"], out.etag)) {
          return void res.writeHead(304, { etag: out.etag, "cache-control": out["cache-control"] }).end();
        }
        // A big answer (a block's record is about 0.35 MB of hex) goes gzipped to a client that accepts it; the validator stays that of the text.
        if (text.length >= GZIP_FROM && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
          const zipped = gzipSync(text);
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
