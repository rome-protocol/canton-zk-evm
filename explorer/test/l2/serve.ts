/**
 * The server side of L2 (l2.test.ts): the pages' routes, the live stream and the health route over the seeded database, as server/main.ts makes them, in a process of
 * their own. The deployed explorer and its indexer are two processes (explorer/run.sh starts the indexer as a container of its own), so the test's ingestion, the
 * synthetic blocks it makes and its own clients must not share the event loop of the server whose answers B3 times.
 * `node test/l2/serve.ts <config.json>`, with an IPC channel: it sends {port} once it listens; {load: true} starts the timings (each answer's time in the server and
 * the event loop's delay), {report: true} stops them and sends them back; SIGTERM closes it.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import pg from "pg";
import { createApi } from "../../server/api.ts";
import { createApiHealth } from "../../server/api-health.ts";
import { createChainDb } from "../../server/chain-db.ts";
import { loadConfig } from "../../server/config.ts";
import { createHttpServer } from "../../server/http.ts";
import type { Reth } from "../../server/reth.ts";
import { createAccountRest } from "../../server/rest/account-rest.ts";
import { createChainRest } from "../../server/rest/chain-rest.ts";
import { createEtherscanRest } from "../../server/rest/etherscan-rest.ts";
import { createStreamHub, startStreamTimers } from "../../server/rest/stream.ts";
import { createStreamSource } from "../../server/rest/stream-source.ts";

interface Config { url: string; folder: string; poolMax: number; pins: { programVK: string; rootC: string } }
const cfg: Config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const send = (message: unknown): Promise<void> => new Promise((ok) => process.send!(message, () => ok()));

// The API's pool is sized as a server's would be; the health route has a pool of its own, which its checks are written through on a timer in the background.
const pool = new pg.Pool({ connectionString: cfg.url, max: cfg.poolMax });
pool.on("error", () => undefined);
const healthPool = new pg.Pool({ connectionString: cfg.url, max: 2 });
healthPool.on("error", () => undefined);
// reth answers at once here: it is not what L2 measures. The routes under test are the database's.
const reth = { code: async () => "0x6080", token: async () => ({ name: "Token", symbol: "TKN", decimals: 6 }), block: async () => ({ number: 1 }), transaction: async () => ({ hash: "0x" }), balance: async () => 0n, balanceAt: async () => 0n, nonce: async () => 0 } as unknown as Reth;
const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => `programVK=${cfg.pins.programVK}\nrootC=${cfg.pins.rootC}\n`);
const ledger = { ledgerEnd: async () => 1 } as never;
const health = createApiHealth({ pool: healthPool, instance: "l2", reth, ledger });
const api = createApi({ config, reth, ledger, chain: createChainDb(pool, healthPool), health, rest: createChainRest(pool), accounts: createAccountRest(pool), etherscanRest: createEtherscanRest(pool), live: true });
const hub = createStreamHub();
const source = createStreamSource({ pool, connection: { connectionString: cfg.url }, hub, log: () => undefined });
const server = createHttpServer(api, cfg.folder, undefined, "x-client-ip", hub);

const served: number[] = []; // how long the server itself took for each request of the load, from its arrival to the end of its answer
const slowest: { ms: number; url: string }[] = []; // the slowest answers, named, so that a failed budget says which route
const loop = monitorEventLoopDelay({ resolution: 10 });
let timing = false;
server.on("request", (rq, rs) => {
  if (!timing) return;
  if (rq.url?.startsWith("/api/stream") || rq.url?.startsWith("/api?module=logs") || rq.url?.startsWith("/api?module=account")) return; // the stream has its own budget, and so have getLogs and txlist (B3)
  const t = performance.now(), url = rq.url ?? "";
  rs.on("finish", () => { const ms = performance.now() - t; served.push(ms); if (slowest.length < 12 || ms > slowest[slowest.length - 1]!.ms) { slowest.push({ ms, url: url.slice(0, 100) }); slowest.sort((a, b) => b.ms - a.ms); slowest.length = Math.min(slowest.length, 12); } });
});

await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
await source.start();
await health.refresh();
health.start();
const stopTimers = startStreamTimers(hub);

let closing: Promise<void> | null = null;
function close(code: number): Promise<void> {
  closing ??= (async () => {
    hub.close();
    stopTimers();
    await source.stop().catch(() => undefined);
    health.stop();
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    await Promise.all([pool.end(), healthPool.end()]).catch(() => undefined);
    process.exit(code);
  })();
  return closing;
}
process.on("SIGTERM", () => void close(0));
process.on("disconnect", () => void close(1)); // the test is gone: so is its server

process.on("message", (message) => {
  const m = message as { load?: boolean; report?: boolean };
  if (m.load) { timing = true; loop.enable(); }
  if (m.report) {
    timing = false;
    loop.disable();
    served.sort((a, b) => a - b);
    void send({ requests: served.length, p50Ms: served[Math.floor(served.length / 2)], p97_5Ms: served[Math.floor(served.length * 0.975)], maxMs: served[served.length - 1], eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6, slowest });
  }
});
await send({ port: (server.address() as AddressInfo).port });
