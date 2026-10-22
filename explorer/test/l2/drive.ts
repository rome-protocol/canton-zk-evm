/**
 * The load side of L2 (design section 9), a process of its own so that the load does not share an event loop with the server it measures.
 * `node test/l2/drive.ts <config.json>` runs every class of request at its share of the rate (open loop), together, for the time given, with the live-stream clients
 * held open beside them, and prints one JSON document: each class's latencies and answers, and when each stream client received each block.
 * Every request carries its own client address in the trusted header, so that the per-client limits of 6.6 see many clients, as the public does.
 */
import { readFileSync } from "node:fs";
import { Agent, get } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

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

/**
 * One class of requests at a fixed rate, open loop: a request is due at a fixed time whether or not the earlier ones have answered, and its latency runs from
 * the time it was due to the end of its answer, so a slow server cannot hide by being asked less. (The load tools tried first, autocannon with its rate option,
 * report 50 to 100 ms against a server that answers at once, because their latency includes waiting for the rate's turn; that is why this is written here.)
 */
async function runClass(c: Config["classes"][number], ci: number) {
  const agent = new Agent({ keepAlive: true, maxSockets: cfg.connections });
  const total = Math.round(c.rate * cfg.seconds), latencies: number[] = [];
  const out = { retried: 0, requests: 0, non2xx: 0, errors: 0, timeouts: 0, s2: 0, s4: 0, s5: 0 };
  const inflight: Promise<void>[] = [];
  const start = performance.now();
  for (let k = 0; k < total; k++) {
    const due = start + (k * 1000) / c.rate;
    const wait = due - performance.now();
    if (wait > 1) await new Promise((ok) => setTimeout(ok, wait));
    const path = c.paths[k % c.paths.length]!, client = k % c.clients;
    inflight.push(new Promise<void>((done) => {
      // A server may close an idle kept-alive connection at the moment a request is written to it: the request never reached it. A client (a browser, curl) sends
      // that one again on a new connection, and so does this one, once, and counts it.
      const attempt = (again: boolean): void => {
        const req = get({ host: cfg.host, port: cfg.port, path, agent, headers: { [cfg.ipHeader]: `10.${ci + 1}.${client >> 8}.${client & 255}` } }, (res) => {
          res.resume();
          res.on("end", () => {
            out.requests++;
            latencies.push(performance.now() - due);
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) out.s2++; else { out.non2xx++; if (code >= 400 && code < 500) out.s4++; else out.s5++; }
            done();
          });
          res.on("error", () => { out.errors++; done(); });
        });
        let timedOut = false;
        req.setTimeout(10_000, () => { timedOut = true; out.timeouts++; req.destroy(); });
        req.on("error", (e: NodeJS.ErrnoException) => {
          if (timedOut) { done(); return; }
          if (again && req.reusedSocket && (e.code === "ECONNRESET" || e.code === "EPIPE")) { out.retried++; attempt(false); return; }
          out.errors++; done();
        });
      };
      attempt(true);
    }));
  }
  await Promise.all(inflight);
  agent.destroy();
  latencies.sort((x, y) => x - y);
  const at = (f: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil(latencies.length * f) - 1))] ?? 0);
  return { name: c.name, target: c.rate, retried: out.retried, requests: out.requests, non2xx: out.non2xx, errors: out.errors, timeouts: out.timeouts, statusCodes: { "2xx": out.s2, "4xx": out.s4, "5xx": out.s5 }, latency: { p50: at(0.5), p90: at(0.9), p97_5: at(0.975), p99: at(0.99), max: Math.round(latencies[latencies.length - 1] ?? 0) } };
}
const runs = cfg.classes.map((c, ci) => runClass(c, ci));
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const results = await Promise.all(runs);
loop.disable(); process.stderr.write(`load process event loop delay ms: p50 ${loop.percentile(50) / 1e6} p99 ${loop.percentile(99) / 1e6} max ${loop.max / 1e6}\n`);
await new Promise((ok) => setTimeout(ok, 1500)); // the last block's event
// A pipe's write is not done when write() returns: leave only when the whole document has been handed over, or a large one is cut short.
process.stdout.write(JSON.stringify({ streams, results, received: [...received].map(([number, times]) => ({ number, times })) }) + "\n", () => process.exit(0));
