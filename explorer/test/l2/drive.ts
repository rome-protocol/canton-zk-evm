/**
 * The load side of L2 (design section 9), a process of its own so that the load does not share an event loop with the server it measures.
 * `node test/l2/drive.ts <config.json>` runs every class of request at its share of the rate, together, for the time given, with the live-stream clients
 * held open beside them, and prints one JSON document: each class's latencies and answers, and when each stream client received each block.
 * Every request carries its own client address in the trusted header, so that the per-client limits of 6.6 see many clients, as the public does.
 */
import { readFileSync } from "node:fs";
import { get } from "node:http";
import autocannon from "autocannon";

interface Config {
  host: string; port: number; seconds: number; ipHeader: string; connections: number; sse: number;
  classes: { name: string; rate: number; paths: string[]; clients: number }[];
}
const cfg: Config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));

/** Receive times of each block's `block` event, by block number. */
const received = new Map<number, number[]>();
let streams = 0;
function holdStream(i: number): void {
  const ip = `10.${(i >> 8) & 255}.${i & 255}.9`;
  get({ host: cfg.host, port: cfg.port, path: "/api/stream?topics=blocks", headers: { [cfg.ipHeader]: ip, accept: "text/event-stream" } }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; }
    streams++;
    let pending = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      const t = Date.now();
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!/^event: block$/m.test(frame)) continue;
        const id = /^id: (\d+)$/m.exec(frame);
        if (id) (received.get(Number(id[1])) ?? received.set(Number(id[1]), []).get(Number(id[1]))!).push(t);
      }
    });
    res.on("error", () => undefined);
  }).on("error", () => undefined);
}
// Open the streams in groups, so that the server's accept queue is not the thing measured.
for (let i = 0; i < cfg.sse; i += 100) {
  for (let j = i; j < Math.min(cfg.sse, i + 100); j++) holdStream(j);
  await new Promise((ok) => setTimeout(ok, 50));
}
await new Promise((ok) => setTimeout(ok, 1000));
process.stderr.write(`${streams} streams open\n`);

const runs = cfg.classes.map(async (c, ci) => {
  let n = 0;
  const requests = c.paths.map((path) => ({
    method: "GET" as const, path,
    setupRequest: (req: { headers?: Record<string, string> }) => { const k = n++ % c.clients; req.headers = { ...req.headers, [cfg.ipHeader]: `10.${ci + 1}.${k >> 8}.${k & 255}` }; return req; },
  }));
  const r = await autocannon({ url: `http://${cfg.host}:${cfg.port}`, connections: cfg.connections, overallRate: c.rate, duration: cfg.seconds, requests, timeout: 10 });
  return { name: c.name, target: c.rate, requests: r.requests.total, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts, statusCodes: { "2xx": r["2xx"], "4xx": r["4xx"], "5xx": r["5xx"] }, latency: { p50: r.latency.p50, p90: r.latency.p90, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max } };
});
const results = await Promise.all(runs);
await new Promise((ok) => setTimeout(ok, 1500)); // the last block's event
console.log(JSON.stringify({ streams, results, received: [...received].map(([number, times]) => ({ number, times })) }));
process.exit(0);
