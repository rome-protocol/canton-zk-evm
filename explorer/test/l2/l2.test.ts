/**
 * L2, the API at scale (design section 9): a database seeded through the indexer's own write path, then `L2_SECONDS` of the mixed load of the design
 * (60% single objects, 20% address pages, 10% lists, 5% getLogs, 5% search) at `L2_RATE` requests a second, while ingestion keeps writing blocks of
 * 1,428 transactions every 3 s, with `L2_SSE` live-stream clients and the health route asked throughout. It asserts B3, B4, B6 and B7 and writes the
 * numbers to `L2_RESULTS` (a JSON file) and to the log. It runs only when `L2=1`, on the pinned PostgreSQL; the design's size is
 * `L2_TRANSACTIONS=10000000 L2_SECONDS=600`, and CI runs a smaller one (docs/METRICS.md says which, and what was measured).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { createApi } from "../../server/api.ts";
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
      const { pool } = db;
      await migrate(pool);
      // ---- Seed through the indexer's own write path, a batch of blocks at a time.
      const chain = makeChain([]);
      const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      await indexer.open();
      stops.push(() => indexer.close());
      let head = 0, parent = chain.genesisHash, written = 0;
      async function append(count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
          const b = makeBlock(++head, parent, { txs: BLOCK_TXS, hot: HOT });
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
      await pool.query("vacuum (analyze)");
      const seedSeconds = (Date.now() - seedStart) / 1000;
      const bytes = Number((await pool.query("select pg_database_size(current_database()) as n")).rows[0].n);
      const hotTxs = Number((await pool.query("select count(*) as n from transactions where from_address = $1", [bytea(HOT)])).rows[0].n);

      // ---- The server: the pages' routes, the live stream, and the health route, over the database.
      const reth = { code: async () => "0x6080", token: async () => ({ name: "Token", symbol: "TKN", decimals: 6 }), block: async () => ({ number: 1 }), transaction: async () => ({ hash: "0x" }), balance: async () => 0n, balanceAt: async () => 0n, nonce: async () => 0 } as unknown as Reth;
      // reth answers at once here: it is not what L2 measures. The routes under test are the database's.
      const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`);
      const api = createApi({ config, reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), rest: createChainRest(pool), accounts: createAccountRest(pool), live: true });
      const hub = createStreamHub();
      const source = createStreamSource({ pool, connection: { connectionString: db.url }, hub, log: () => undefined });
      const server = createHttpServer(api, folder, undefined, "x-client-ip", hub);
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      stops.push(() => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }));
      await source.start();
      // The indexer's own checks (C4, C5, the derive lag), every 2 s as its run loop does, so that the rows /api/health reads are fresh.
      const checker = setInterval(() => void indexer.checkOnce().catch(() => undefined), 2000);
      stops.push(() => clearInterval(checker));
      await indexer.checkOnce();
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
      const driveConfig = join(folder, "drive.json");
      writeFileSync(driveConfig, JSON.stringify({ host: "127.0.0.1", port, seconds: SECONDS, ipHeader: "x-client-ip", connections: 20, sse: SSE, classes }));

      // ---- Run: the load in its own process, ingestion and getLogs in this one.
      const load = spawn(process.execPath, ["test/l2/drive.ts", driveConfig], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      load.stdout.on("data", (d: Buffer) => { out += d; });
      const finished = new Promise<void>((ok, fail) => { load.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`the load process exited ${code}`)))); });
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
      const logsMs: number[] = [];
      const logsLoop = (async () => {
        const last = head, first = Math.max(1, last - 9999);
        while (running) {
          const t = performance.now();
          const rows = await pool.query("select block_number, log_index, tx_index, topic0, data from logs where address = $1 and block_number between $2 and $3 order by block_number, log_index limit 1000", [bytea(HOT_LOGS), first, last]);
          logsMs.push(performance.now() - t);
          expect(rows.rowCount).toBeGreaterThan(0);
          await sleep(Math.round(1000 / Math.max(1, Math.round(RATE * 0.05))));
        }
      })();
      await finished;
      running = false;
      const ingestTimes = await ingestion;
      await logsLoop;
      const report = JSON.parse(out) as { streams: number; results: { name: string; target: number; requests: number; non2xx: number; errors: number; timeouts: number; latency: Record<string, number> }[]; received: { number: number; times: number[] }[] };

      // ---- The numbers.
      const lag = report.received.filter((b) => b.number > ingestedBefore && notifiedAt.has(b.number)).map((b) => ({ number: b.number, clients: b.times.length, p95: q95(b.times.map((t) => t - notifiedAt.get(b.number)!)), max: Math.max(...b.times.map((t) => t - notifiedAt.get(b.number)!)) }));
      const by = Object.fromEntries(report.results.map((r) => [r.name, r]));
      const summary = {
        transactions: written, blocks: head, seedSeconds, hotAddressTransactions: hotTxs, seconds: SECONDS, rate: RATE, streams: report.streams,
        databaseBytes: bytes, gigabytesPerMillionTransactions: bytes / 1e9 / (written / 1e6),
        classes: report.results, getLogs: { requests: logsMs.length, p95: q95(logsMs), max: Math.max(...logsMs) },
        sse: { blocks: lag.length, p95: Math.max(...lag.map((l) => l.p95)), max: Math.max(...lag.map((l) => l.max)), minClients: Math.min(...lag.map((l) => l.clients)) },
        ingestion: { blocks: ingestTimes.length, p95: q95(ingestTimes), max: Math.max(...ingestTimes) },
      };
      console.log("L2 " + JSON.stringify(summary, null, 1));
      if (process.env.L2_RESULTS) writeFileSync(process.env.L2_RESULTS, JSON.stringify(summary, null, 1));

      expect(report.streams).toBe(SSE);
      for (const r of report.results) { expect(r.non2xx, `${r.name}: answers that were not 2xx`).toBe(0); expect(r.errors + r.timeouts, `${r.name}: errors`).toBe(0); expect(r.requests, `${r.name}: the rate was kept`).toBeGreaterThanOrEqual(r.target * SECONDS * 0.9); }
      expect(by.single!.latency.p97_5, "B3, one block, transaction or address").toBeLessThanOrEqual(BUDGET.singleMs);
      expect(by.search!.latency.p97_5, "B3, search").toBeLessThanOrEqual(BUDGET.searchMs);
      expect(by.list!.latency.p97_5, "B3, a list page").toBeLessThanOrEqual(BUDGET.listMs);
      expect(by["address page"]!.latency.p97_5, "B3, an address's page of transactions").toBeLessThanOrEqual(BUDGET.addressPageMs);
      expect(summary.getLogs.p95, "B3, getLogs over 10,000 blocks with an address").toBeLessThanOrEqual(BUDGET.getLogsMs);
      expect(lag.length, "blocks were written during the load").toBeGreaterThanOrEqual(Math.floor(SECONDS / 3) - 4);
      expect(summary.sse.minClients, "every client got every block").toBe(SSE);
      expect(summary.sse.p95, "B4").toBeLessThanOrEqual(BUDGET.sseMs);
      expect(summary.gigabytesPerMillionTransactions, "B6").toBeLessThanOrEqual(BUDGET.gigabytesPerMillion);
      expect(by.health!.latency.p97_5, "B7").toBeLessThanOrEqual(BUDGET.healthMs);
    } finally {
      for (const stop of stops.reverse()) await Promise.resolve(stop()).catch(() => undefined);
      rmSync(folder, { recursive: true, force: true });
      await db.drop().catch(() => undefined);
    }
  }, (SECONDS + 3600) * 1000);
});
