import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { Api } from "./api.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** The biggest request body the server reads. The faucet's is one address. */
const MAX_BODY = 1024;

/** The body as text, or null when it is bigger than the limit (what is left is thrown away). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => ok(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** Serves `/api/*` and `/healthz` from the API, and everything else from the pages' build in `dist`, with the home page for any route the pages own. */
export function createHttpServer(api: Api, dist: string): Server {
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
      if (pathname.startsWith("/api/") || pathname === "/healthz") {
        const sent = method === "POST" ? await readBody(req) : undefined;
        if (sent === null) return void res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "That request is too big." }));
        const { status, body, headers } = await api(method, target, sent);
        res.writeHead(status, { ...headers, "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
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
