import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type AddressInfo } from "node:net";
import { createHttpServer } from "../http.ts";
import { createStreamHub, type BlockEvent, type StreamHub } from "./stream.ts";

const block = (n: number): BlockEvent => ({ number: n, hash: "0x" + n.toString(16).padStart(64, "0"), txCount: n, recordTime: null, updateId: null });
let server: ReturnType<typeof createHttpServer>, hub: StreamHub, aborts: AbortController[];
const api = async () => ({ status: 200, body: {} });
beforeEach(async () => {
  hub = createStreamHub({ perClient: 2 });
  aborts = [];
  server = createHttpServer(api, "/nonexistent", undefined, null, hub);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
});
afterEach(async () => {
  for (const a of aborts) a.abort();
  hub.close();
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
});
const url = (path: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;

/** Opens a stream and reads it: `until(text => ok)` waits for what has arrived to satisfy the test. */
async function open(path: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  aborts.push(abort);
  const res = await fetch(url(path), { headers, signal: abort.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    res,
    get text() { return text; },
    async until(ok: (t: string) => boolean): Promise<string> {
      const stop = Date.now() + 3000;
      while (!ok(text)) {
        if (Date.now() > stop) throw new Error(`timed out; got ${JSON.stringify(text)}`);
        const r = await Promise.race([reader!.read(), new Promise<null>((f) => setTimeout(() => f(null), 100))]);
        if (r && !r.done) text += decoder.decode(r.value);
      }
      return text;
    },
    close: () => abort.abort(),
  };
}
const ids = (t: string) => [...t.matchAll(/^id: (\d+)\nevent: (\w+)$/gm)].map((m) => `${m[1]}:${m[2]}`);

describe("GET /api/stream", () => {
  it("is an event stream that is not cached, with a retry delay first, and sends the events as they come, in order", async () => {
    const s = await open("/api/stream?topics=blocks,txs");
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    expect(s.res.headers.get("cache-control")).toContain("no-store");
    await s.until((t) => t.startsWith("retry: 3000\n\n"));
    hub.publishBlock(block(1), ["0xaa"]);
    hub.publishBlock(block(2), []);
    const t = await s.until((x) => ids(x).length >= 4);
    expect(ids(t)).toEqual(["1:block", "1:txs", "2:block", "2:txs"]);
    expect(t).toContain(`data: {"number":1,"hashes":["0xaa"],"more":false}`);
  });

  it("resumes with Last-Event-ID, from the buffer, before anything new", async () => {
    for (let n = 1; n <= 4; n++) hub.publishBlock(block(n), []);
    const s = await open("/api/stream?topics=blocks", { "last-event-id": "2" });
    await s.until((t) => ids(t).length >= 2);
    hub.publishBlock(block(5), []);
    const t = await s.until((x) => ids(x).length >= 3);
    expect(ids(t)).toEqual(["3:block", "4:block", "5:block"]);
  });

  it("sends a keep-alive comment and the stats event", async () => {
    const s = await open("/api/stream?topics=stats");
    hub.heartbeat();
    hub.stats();
    const t = await s.until((x) => x.includes(": keep-alive") && x.includes("event: stats"));
    expect(t).toContain("data: {\"finalBlock\":null,");
  });

  it("refuses a stream over the client's limit with 429 and Retry-After, and takes another when one is closed", async () => {
    const a = await open("/api/stream"), b = await open("/api/stream");
    await a.until((t) => t.length > 0); await b.until((t) => t.length > 0);
    const third = await fetch(url("/api/stream"));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("5");
    expect((await third.json()).error).toContain("2 streams");
    a.close();
    for (let i = 0; i < 100 && hub.count() > 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(hub.count()).toBe(1);
    const c = await fetch(url("/api/stream"));
    expect(c.status).toBe(200);
    await c.body?.cancel();
  });

  it("closes the socket of a client that never reads, and keeps it counted until it is closed", async () => {
    const sock = connect((server.address() as AddressInfo).port, "127.0.0.1");
    await new Promise((ok) => sock.once("connect", ok));
    sock.write("GET /api/stream?topics=txs HTTP/1.1\r\nhost: x\r\n\r\n");
    sock.pause();
    for (let i = 0; i < 50 && hub.count() < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(hub.count()).toBe(1);
    const hashes = Array.from({ length: 50 }, (_, i) => "0x" + i.toString(16).padStart(64, "0"));
    const open = () => new Promise<number>((ok) => server.getConnections((_, n) => ok(n)));
    let n = 0;
    while (n < 20000 && (await open()) > 0) {
      for (let i = 0; i < 100; i++) hub.publishBlock(block(++n), hashes);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await open()).toBe(0);
    expect(hub.count()).toBe(0);
    sock.destroy();
  });

  it("refuses a topic that is not one, and any method but GET", async () => {
    expect((await fetch(url("/api/stream?topics=blocks,mempool"))).status).toBe(400);
    const post = await fetch(url("/api/stream"), { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("answers 404 when the explorer has no live updates", async () => {
    const plain = createHttpServer(api, "/nonexistent");
    await new Promise<void>((ok) => plain.listen(0, "127.0.0.1", ok));
    try {
      expect((await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/api/stream`)).status).toBe(404);
    } finally {
      await new Promise((ok) => plain.close(ok));
    }
  });
});
