/**
 * L2, the API at scale (design section 9): a database seeded through the indexer's own write path, then `L2_SECONDS` of the mixed load of the design
 * (60% single objects, 20% address pages, 10% lists, 5% getLogs, 5% search) at `L2_RATE` requests a second, while ingestion keeps writing blocks of
 * 1,428 transactions every 3 s, with `L2_SSE` live-stream clients and the health route asked throughout. It asserts B3, B4, B6 and B7 and writes the
 * numbers to `L2_RESULTS` (a JSON file) and to the log. It runs only when `L2=1`, on the pinned PostgreSQL; the design's size is
 * `L2_TRANSACTIONS=10000000 L2_SECONDS=600`, `L2_KEEP_DATABASE=1` leaves the seeded database in place to look at query plans, and CI runs a smaller one (docs/METRICS.md says which, and what was measured).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { createApi } from "../../server/api.ts";
import { createEtherscanRest } from "../../server/rest/etherscan-rest.ts";
import { createApiHealth } from "../../server/api-health.ts";
import { createChainDb } from "../../server/chain-db.ts";
import { loadConfig } from "../../server/config.ts";
import { migrate } from "../../server/db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase } from "../../server/db/testing.ts";
import { createHttpServer } from "../../server/http.ts";
import { createIndexer } from "../../server/indexer/indexer.ts";
import { CHANNEL } from "../../server/indexer/notify.ts";
import { createAccountRest } from "../../server/rest/account-rest.ts";
import { createChainRest } from "../../server/rest/chain-rest.ts";
import { createStreamHub, startStreamTimers } from "../../server/rest/stream.ts";
import { createStreamSource } from "../../server/rest/stream-source.ts";
import type { Reth } from "../../server/reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeBlock, makeChain } from "../synthetic-chain.ts";

const int = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const TXS = int("L2_TRANSACTIONS", 300_000), SECONDS = int("L2_SECONDS", 60), RATE = int("L2_RATE", 200), SSE = int("L2_SSE", 2000);
/** The design's one address holds 1,000,000 transactions, whatever the size of the run: a smaller database gives it a larger share (up to a half) so that B3's address-page budget is measured against that history. */
const HOT_TXS = Math.min(int("L2_HOT", 1_000_000), TXS / 2), HOT_EVERY = Math.max(2, Math.floor(TXS / HOT_TXS));
const BLOCK_TXS = 1428, BLOCK_EVERY_MS = 3000;
/** The budgets of section 9. B3 and B7 are p95; the load tool reports p97.5, which is the stricter, so that is what is held to them. */
export const BUDGET = { singleMs: 100, searchMs: 100, listMs: 200, addressPageMs: 300, getLogsMs: 500, sseMs: 500, gigabytesPerMillion: 2.5, healthMs: 50 };
const HOT = "0x" + "f0f0f0".padStart(40, "0");
const HOT_LOGS = "0x" + "d000".padStart(40, "0"); // the address the synthetic chain's token transfers log under: a fifth of all transactions

const q95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const bytea = (h: string) => Buffer.from(h.slice(2), "hex");

describe.skipIf(!TEST_URL || process.env.L2 !== "1")("L2: the API at scale, on the pinned PostgreSQL", () => {
  checkRequired();

  it(`serves ${RATE} requests a second for ${SECONDS} s over ${TXS.toLocaleString("en")} transactions inside B3, B4, B6 and B7`, async () => {
    const db = await makeDatabase();
    const folder = mkdtempSync(join(tmpdir(), "explorer-l2-"));
    const stops: (() => Promise<void> | void)[] = [];
    try {
      // The API's pool is sized as a server's would be (the helper's is for small tests); the pool of the helper stays for the seed's and the load's own checks.
      const pool = new pg.Pool({ connectionString: db.url, max: int("L2_POOL", 20) });
      pool.on("error", () => undefined);
      stops.push(() => pool.end());
      await migrate(pool);
      // ---- Seed through the indexer's own write path, a batch of blocks at a time.
      const chain = makeChain([]);
      const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      await indexer.open();
      stops.push(() => indexer.close());
      let head = 0, parent = chain.genesisHash, written = 0;
      async function append(count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
          const b = makeBlock(++head, parent, { txs: BLOCK_TXS, hot: HOT, hotEvery: HOT_EVERY, at: new Date().toISOString() });
          parent = b.block.hash;
          chain.blocks.push(b);
          written += BLOCK_TXS;
        }
        chain.reads.rethHead = head;
        chain.ledger.ledgerHead = head;
        await indexer.runOnce();
        // What is written is not read again: let go of the old blocks' bodies, so that the seed's memory stays flat at the design's size.
        for (const old of chain.blocks.slice(0, Math.max(0, chain.blocks.length - 5))) { old.receipts.length = 0; old.traces.length = 0; old.block.transactions = []; old.record.txsHex = ""; }
      }
      const seedStart = Date.now();
      while (written < TXS) await append(Math.min(10, Math.ceil((TXS - written) / BLOCK_TXS)));
      const seeded = (await pool.query("select (select count(*) from transactions)::int as txs, (select count(*) from blocks)::int as blocks")).rows[0] as { txs: number; blocks: number };
      expect(seeded.txs).toBe(written);
      // A database that has been up a while is not in the middle of the seed's checkpoint, and its statistics are current: finish both before the load.
      await pool.query("vacuum (analyze)");
      await pool.query("checkpoint");
      const seedSeconds = (Date.now() - seedStart) / 1000;
      const bytes = Number((await pool.query("select pg_database_size(current_database()) as n")).rows[0].n);
      const hotTxs = Number((await pool.query("select count(*) as n from transactions where from_address = $1", [bytea(HOT)])).rows[0].n);
      expect(hotTxs, "the one address's history").toBeGreaterThanOrEqual(HOT_TXS * 0.9);

      // ---- The server: the pages' routes, the live stream, and the health route, over the database.
      const reth = { code: async () => "0x6080", token: async () => ({ name: "Token", symbol: "TKN", decimals: 6 }), block: async () => ({ number: 1 }), transaction: async () => ({ hash: "0x" }), balance: async () => 0n, balanceAt: async () => 0n, nonce: async () => 0 } as unknown as Reth;
      // reth answers at once here: it is not what L2 measures. The routes under test are the database's.
      const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`);
      // The health route as the deployed server has it: this instance's checks run on a timer in the background and are written through a pool of the route's own, which reads them.
      const healthPool = new pg.Pool({ connectionString: db.url, max: 2 });
      healthPool.on("error", () => undefined);
      stops.push(() => healthPool.end());
      const ledger = { ledgerEnd: async () => 1 } as never;
      const health = createApiHealth({ pool: healthPool, instance: "l2", reth, ledger });
      const api = createApi({ config, reth, ledger, chain: createChainDb(pool, healthPool), health, rest: createChainRest(pool), accounts: createAccountRest(pool), etherscanRest: createEtherscanRest(pool), live: true });
      const hub = createStreamHub();
      const source = createStreamSource({ pool, connection: { connectionString: db.url }, hub, log: () => undefined });
      const server = createHttpServer(api, folder, undefined, "x-client-ip", hub);
      const served: number[] = []; // how long the server itself took for each request, from its arrival to the end of its answer
      const slowest: { ms: number; url: string }[] = []; // the slowest answers, named, so that a failed budget says which route
      server.on("request", (rq, rs) => {
        if (rq.url?.startsWith("/api/stream") || rq.url?.startsWith("/api?module=logs") || rq.url?.startsWith("/api?module=account")) return; // the stream has its own budget, and so have getLogs and txlist (B3)
        const t = performance.now(), url = rq.url ?? "";
        rs.on("finish", () => { const ms = performance.now() - t; served.push(ms); if (slowest.length < 12 || ms > slowest[slowest.length - 1]!.ms) { slowest.push({ ms, url: url.slice(0, 100) }); slowest.sort((a, b) => b.ms - a.ms); slowest.length = Math.min(slowest.length, 12); } });
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      stops.push(() => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }));
      await source.start();
      // The indexer's own checks (C4, C5, the derive lag), every 2 s as its run loop does, so that the rows /api/health reads are fresh.
      const checker = setInterval(() => void indexer.checkOnce().catch(() => undefined), 2000);
      stops.push(() => clearInterval(checker));
      await indexer.checkOnce();
      await health.refresh();
      health.start();
      stops.push(() => health.stop());
      stops.push(() => source.stop());
      stops.push(startStreamTimers(hub));
      stops.push(() => hub.close());

      // The moment each block's NOTIFY is sent is the moment it is indexed, for B4.
      const listener = new pg.Client({ connectionString: db.url });
      await listener.connect();
      stops.push(() => listener.end());
      const notifiedAt = new Map<number, number>();
      listener.on("notification", (m) => { const n = /^final:(\d+)$/.exec(m.payload ?? ""); if (n) notifiedAt.set(Number(n[1]), Date.now()); });
      await listener.query(`listen ${CHANNEL}`);

      // ---- What the load asks for: real blocks, transactions and addresses of the seeded database.
      const some = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows.map((r) => r.v as string);
      const blocks = (await some("select number::text as v from blocks order by random() limit 300")), hashes = await some("select '0x' || encode(hash, 'hex') as v from transactions order by random() limit 300");
      const addresses = [HOT, ...(await some("select distinct '0x' || encode(from_address, 'hex') as v from transactions limit 50"))];
      const port = (server.address() as AddressInfo).port;
      const classes = [
        { name: "single", share: 0.6, clients: 60, paths: [...blocks.slice(0, 100).map((n) => `/api/blocks/${n}`), ...hashes.slice(0, 100).map((h) => `/api/txs/${h}`), ...addresses.map((a) => `/api/addresses/${a}`)] },
        { name: "address page", share: 0.2, clients: 30, paths: [...addresses.map((a) => `/api/addresses/${a}/txs?limit=25`), `/api/addresses/${HOT}/txs?limit=25`, `/api/addresses/${HOT}/token-transfers?limit=25`] },
        { name: "list", share: 0.1, clients: 20, paths: ["/api/blocks?limit=25", "/api/txs?limit=25", ...blocks.slice(0, 20).map((n) => `/api/blocks/${n}/transactions?limit=25`)] },
        { name: "search", share: 0.05, clients: 10, paths: [...hashes.slice(0, 20).map((h) => `/api/search?q=${h}`), ...blocks.slice(0, 20).map((n) => `/api/search?q=${n}`), ...addresses.slice(0, 10).map((a) => `/api/search?q=${a}`)] },
        { name: "health", share: 0, rate: 5, clients: 1, paths: ["/api/health"] },
      ].map((c) => ({ ...c, rate: "rate" in c ? c.rate! : Math.round(RATE * c.share) }));
      // Every path the load asks for must answer 200 once, so that a wrong path is named here and not counted as load.
      const refused: string[] = [];
      for (const c of classes) for (const path of c.paths) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-client-ip": "10.250.0.1" } });
        const text = await res.text();
        if (res.status !== 200) refused.push(`${res.status} ${path.slice(0, 90)} ${text.slice(0, 80)}`);
        if (path.endsWith("/health")) continue;
        await sleep(55); // under the per-client rate of 20 a second
      }
      expect(refused, "paths of the load that did not answer 200").toEqual([]);
      // A server that has been up for a while has its pool's connections open and its database's caches warm; the first second of a cold one is not what B3 is about.
      // So, as a deployed one would have, open the pool before the load starts: a few rounds of concurrent requests, each from a client of its own.
      const warm = classes.flatMap((c) => c.paths.slice(0, 12));
      for (let round = 0; round < 3; round++) await Promise.all(warm.map((path, i) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-client-ip": `10.251.${round}.${i}` } }).then((r) => r.arrayBuffer())));
      const driveConfig = join(folder, "drive.json");
      writeFileSync(driveConfig, JSON.stringify({ host: "127.0.0.1", port, seconds: SECONDS, ipHeader: "x-client-ip", connections: 32, sse: SSE, classes }));

      // ---- Run: the load in its own process, ingestion and getLogs in this one.
      const load = spawn(process.execPath, ["test/l2/drive.ts", driveConfig], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      load.stdout.on("data", (d: Buffer) => { out += d; });
      const finished = new Promise<void>((ok, fail) => { load.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`the load process exited ${code}`)))); });
      const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
      // Every answer of the health route that is not 200, with the checks that made it so: a B7 failure says which row went down or stale.
      const unhealthy: string[] = [];
      const watch = setInterval(() => { void fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-client-ip": "10.250.0.3" } }).then(async (r) => { if (r.status === 200) return; const j = (await r.json()) as { status: string; checks: { id: string; role: string; status: string; stale: boolean; detail: unknown }[] }; unhealthy.push(`${r.status} ${j.status}: ${j.checks.filter((c) => c.status !== "ok" || c.stale).map((c) => `${c.role}/${c.id} ${c.stale ? "stale" : c.status} ${c.detail ?? ""}`).join("; ")}`); }).catch(() => undefined); }, 250);
      const ingestedBefore = head;
      let running = true;
      const ingestion = (async () => {
        const times: number[] = [];
        await sleep(2000); // the streams are open by now
        while (running) {
          const t = Date.now();
          await append(1);
          times.push(Date.now() - t);
          await sleep(Math.max(0, BLOCK_EVERY_MS - (Date.now() - t)));
        }
        return times;
      })();
      // The Etherscan routes, through the server in front (their limits too), open-loop (a request every `gap` ms whether or not the last has finished, timed from when it was due, so
      // that a slow answer cannot lower its own rate). Each request comes from a client of its own, as the load of the other routes does, so that the per-client limit of Etherscan's
      // /api (E7b) is not what is measured. A share is a fraction of RATE; `ok` says whether an answer is a good one.
      const openLoop = (target: string, share: number, ipBase: number, ms: number[], ok: (body: { status: string; result: unknown[] }) => boolean) => {
        const miss = { n: 0 };
        const done = (async () => {
          const gap = 1000 / Math.max(1, Math.round(RATE * share));
          const inflight = new Set<Promise<void>>();
          let due = performance.now(), sent = 0;
          while (running) {
            const wait = due - performance.now();
            if (wait > 0) await sleep(wait);
            const at = due, n = sent++;
            due += gap;
            const p: Promise<void> = fetch(target, { headers: { "x-client-ip": `10.${ipBase}.${(n >> 8) & 255}.${n & 255}` } })
              .then(async (res) => { const body = (await res.json()) as { status: string; result: unknown[] }; ms.push(performance.now() - at); if (res.status !== 200 || !ok(body)) miss.n++; }, () => { ms.push(Infinity); })
              .finally(() => { inflight.delete(p); });
            inflight.add(p);
          }
          await Promise.all(inflight);
        })();
        return { done, miss };
      };
      // getLogs: the last 10,000 blocks, one address, 1,000 logs.
      const logsMs: number[] = [];
      const last = head, first = Math.max(1, last - 9999);
      const logsRun = openLoop(`http://127.0.0.1:${port}/api?module=logs&action=getLogs&address=${HOT_LOGS}&fromBlock=${first}&toBlock=${last}&page=1&offset=1000`, 0.05, 253, logsMs, (b) => b.status === "1" && b.result.length > 0);
      // B3's Etherscan txlist of the address with a million transactions: a page of 100, newest first, and the default (no offset: the first 10,000 rows, with their input), each at 1% of the rate.
      const txlistMs: number[] = [], txlistWideMs: number[] = [];
      const txlistRun = openLoop(`http://127.0.0.1:${port}/api?module=account&action=txlist&address=${HOT}&page=1&offset=100&sort=desc`, 0.01, 252, txlistMs, (b) => b.status === "1" && b.result.length === 100);
      const txlistWideRun = openLoop(`http://127.0.0.1:${port}/api?module=account&action=txlist&address=${HOT}`, 0.01, 251, txlistWideMs, (b) => b.status === "1" && b.result.length > 0);
      await finished;
      loop.disable(); clearInterval(watch);
      served.sort((a, b) => a - b);
      running = false;
      const ingestTimes = await ingestion;
      await Promise.all([logsRun.done, txlistRun.done, txlistWideRun.done]);
      const logsEmpty = logsRun.miss.n;
      const report = JSON.parse(out) as { streams: number; results: { name: string; target: number; requests: number; non2xx: number; errors: number; timeouts: number; latency: Record<string, number> }[]; received: { number: number; times: number[] }[] };

      // ---- The numbers.
      const lag = report.received.filter((b) => b.number > ingestedBefore && notifiedAt.has(b.number)).map((b) => ({ number: b.number, clients: b.times.length, p95: q95(b.times.map((t) => t - notifiedAt.get(b.number)!)), max: Math.max(...b.times.map((t) => t - notifiedAt.get(b.number)!)) }));
      const by = Object.fromEntries(report.results.map((r) => [r.name, r]));
      const summary = {
        transactions: written, blocks: head, seedSeconds, hotAddressTransactions: hotTxs, seconds: SECONDS, rate: RATE, streams: report.streams,
        databaseBytes: bytes, gigabytesPerMillionTransactions: bytes / 1e9 / (written / 1e6),
        classes: report.results, getLogs: { route: "/api?module=logs&action=getLogs", requests: logsMs.length, empty: logsEmpty, p95: q95(logsMs), max: Math.max(...logsMs) },
        txlist: { route: "/api?module=account&action=txlist", page: { offset: 100, requests: txlistMs.length, wrong: txlistRun.miss.n, p95: q95(txlistMs), max: Math.max(...txlistMs) }, defaultPage: { rows: "up to 10,000", requests: txlistWideMs.length, wrong: txlistWideRun.miss.n, p95: q95(txlistWideMs), max: Math.max(...txlistWideMs) } },
        sse: { blocks: lag.length, p95: Math.max(...lag.map((l) => l.p95)), max: Math.max(...lag.map((l) => l.max)), minClients: Math.min(...lag.map((l) => l.clients)) },
        server: { requests: served.length, p50Ms: served[Math.floor(served.length / 2)], p97_5Ms: served[Math.floor(served.length * 0.975)], maxMs: served[served.length - 1], eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6, unhealthyAnswers: unhealthy.slice(0, 5), slowest },
        ingestion: { timesMs: ingestTimes, blocks: ingestTimes.length, p95: q95(ingestTimes), max: Math.max(...ingestTimes) },
      };
      console.log("L2 " + JSON.stringify(summary, null, 1));
      if (process.env.L2_RESULTS) writeFileSync(process.env.L2_RESULTS, JSON.stringify(summary, null, 1));

      expect(report.streams).toBe(SSE);
      for (const r of report.results) { expect(r.non2xx, `${r.name}: answers that were not 2xx`).toBe(0); expect(r.errors + r.timeouts, `${r.name}: errors`).toBe(0); expect(r.requests, `${r.name}: the rate was kept`).toBeGreaterThanOrEqual(r.target * SECONDS * 0.9); }
      expect(by.single!.latency.p97_5, "B3, one block, transaction or address").toBeLessThanOrEqual(BUDGET.singleMs);
      expect(by.search!.latency.p97_5, "B3, search").toBeLessThanOrEqual(BUDGET.searchMs);
      expect(by.list!.latency.p97_5, "B3, a list page").toBeLessThanOrEqual(BUDGET.listMs);
      expect(by["address page"]!.latency.p97_5, "B3, an address's page of transactions").toBeLessThanOrEqual(BUDGET.addressPageMs);
      expect(logsEmpty, "getLogs found logs every time").toBe(0);
      expect(txlistRun.miss.n + txlistWideRun.miss.n, "txlist answered rows every time").toBe(0);
      expect(txlistMs.length, "txlist was asked").toBeGreaterThan(0);
      expect(summary.txlist.page.p95, "B3, an Etherscan txlist page of the address with a million transactions").toBeLessThanOrEqual(BUDGET.addressPageMs);
      expect(summary.txlist.defaultPage.p95, "B3, the default Etherscan txlist (10,000 rows) of the address with a million transactions").toBeLessThanOrEqual(BUDGET.addressPageMs);
      expect(summary.getLogs.p95, "B3, getLogs over 10,000 blocks with an address, through the route").toBeLessThanOrEqual(BUDGET.getLogsMs);
      expect(lag.length, "blocks were written during the load").toBeGreaterThanOrEqual(Math.floor(SECONDS / 3) - 4);
      expect(summary.sse.minClients, "every client got every block").toBe(SSE);
      expect(summary.sse.p95, "B4").toBeLessThanOrEqual(BUDGET.sseMs);
      expect(summary.gigabytesPerMillionTransactions, "B6").toBeLessThanOrEqual(BUDGET.gigabytesPerMillion);
      expect(unhealthy, "B7, the health route answered something other than 200").toEqual([]);
      expect(by.health!.latency.p97_5, "B7").toBeLessThanOrEqual(BUDGET.healthMs);
    } finally {
      for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => undefined);
      rmSync(folder, { recursive: true, force: true });
      if (process.env.L2_KEEP_DATABASE === "1") console.log(`L2 left the database ${db.url} for inspection`); else await db.drop().catch(() => undefined);
    }
  }, (SECONDS + 600 + TXS / 2000) * 1000); // the seed, then the load; a hang ends the run in minutes, not in an hour
});
