import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One answer for a method: a value, or a function of the call's params (which may be async). A thrown string becomes a JSON-RPC error. */
type Handler = unknown | ((params: unknown[]) => unknown);

export interface FakeReth {
  url: string;
  /** Every method the fake was called with, in order. */
  calls: string[];
  close(): Promise<void>;
}

/** A small stand-in for reth's HTTP RPC. A method with no handler answers "method not found", as reth does for a method its HTTP port does not serve. `gate` is awaited before each answer, so a test can hold reth in the middle of a look. */
export async function startFakeReth(handlers: Record<string, Handler>, opts: { httpStatus?: number; gate?: (method: string) => Promise<void> | void } = {}): Promise<FakeReth> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (opts.httpStatus) {
        res.writeHead(opts.httpStatus).end("down");
        return;
      }
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.push(method);
      await opts.gate?.(method);
      const send = (o: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...o }));
      if (!(method in handlers)) return send({ error: { code: -32601, message: "Method not found" } });
      const h = handlers[method];
      // A handler may be async, so that a test can hold an answer back.
      Promise.resolve().then(() => (typeof h === "function" ? (h as (p: unknown[]) => unknown)(params) : h)).then(
        (result) => send({ result }),
        (e) => send({ error: { code: -32000, message: String(e) } }),
      );
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((ok) => server.close(() => ok())) };
}
