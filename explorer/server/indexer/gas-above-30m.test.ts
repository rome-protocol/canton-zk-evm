import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { createChainRest } from "../rest/chain-rest.ts";
import { createStatsRest } from "../rest/stats-rest.ts";
import { createEtherscanRest } from "../rest/etherscan-rest.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createLedger } from "../ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { rollupStats } from "./stats.ts";
import { CHAIN_ID, CONFIRMER, GATEWAY, OPERATOR, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { FAKE_READER, createdEvent, startFakeLedger, transaction, type FakeLedger } from "../../test/fake-ledger.ts";

// A block header's gas limit above 30,000,000 (the limit a chain can be raised past) is stored whole, read back whole, and divided by in the
// stats: nothing in the explorer holds 30,000,000 as a ceiling. Eight blocks of 300,000,000 (the highest a chain can be raised to) share one minute,
// so that minute's sums pass 2^31 and a column narrowed to a 32-bit integer would fail here.
const M = 1_000_000;
const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
const NOW = Date.UTC(2026, 9, 21, 0, 10, 0);

checkRequired();
describe.skipIf(!TEST_URL)("blocks with a gas limit above 30M, through the indexer", { timeout: 60_000 }, () => {
  let db: TestDatabase, chain: SyntheticChain, indexer: Indexer;
  const get = (target: string) => createApi({
    config, reth: {} as never, ledger: {} as never, chain: createChainDb(db.pool), rest: createChainRest(db.pool), stats: createStatsRest(db.pool), now: () => NOW,
  })("GET", target);

  beforeAll(async () => {
    db = await makeDatabase();
    await migrate(db.pool);
    chain = makeChain([
      ...Array.from({ length: 8 }, () => ({ txs: 2, gasLimit: 300 * M, gasUsed: 270 * M })),
      { txs: 3, gasLimit: 30 * M, gasUsed: 12 * M },
      { txs: 5, gasLimit: 60 * M, gasUsed: 45 * M },
      { txs: 4, gasLimit: 60 * M, gasUsed: 60 * M },
    ]);
    indexer = createIndexer({ pool: db.pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 11 });
    await rollupStats(db.pool, { now: () => NOW });
  });
  afterAll(async () => { await indexer?.close().catch(() => undefined); await db?.drop(); });

  it("stores the limit and the gas used of each block as they are", async () => {
    const rows = (await db.pool.query("select number::int as number, gas_limit::text as gas_limit, gas_used::text as gas_used from blocks order by number")).rows;
    expect(rows.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, i) => ({ number: i + 1, gas_limit: "300000000", gas_used: "270000000" })));
    expect(rows.slice(8)).toEqual([
      { number: 9, gas_limit: "30000000", gas_used: "12000000" },
      { number: 10, gas_limit: "60000000", gas_used: "45000000" },
      { number: 11, gas_limit: "60000000", gas_used: "60000000" },
    ]);
  });

  it("serves them from the block route, the block list and the CSV export", async () => {
    const one = (await get("/api/blocks/10")).body as Record<string, unknown>;
    expect(one).toMatchObject({ number: 10, gasUsed: 45 * M, gasLimit: 60 * M });
    expect((await get("/api/blocks/1")).body).toMatchObject({ number: 1, gasUsed: 270 * M, gasLimit: 300 * M });
    const list = (await get("/api/blocks?limit=20")).body as { items: Array<Record<string, unknown>> };
    expect(list.items.find((b) => b.number === 11)).toMatchObject({ gasUsed: 60 * M, gasLimit: 60 * M });
    expect(list.items.find((b) => b.number === 9)).toMatchObject({ gasUsed: 12 * M, gasLimit: 30 * M });
    const csv = (await get("/api/blocks?format=csv")).body as string;
    expect(csv.split("\n").find((l) => l.startsWith("10,"))).toContain(",45000000,60000000,");
  });

  it("rolls the gas up in whole numbers past 2^31, and fullness divides by the blocks' own limits", async () => {
    const rows = (await db.pool.query("select sum(gas_used)::text as used, sum(gas_limit_sum)::text as lim from stats_minute")).rows[0];
    expect(rows).toEqual({ used: String(2277 * M), lim: String(2550 * M) });
    const s = (await get("/api/stats/summary?window=1h")).body as { fullness: number | null };
    expect(s.fullness).toBeCloseTo(2277 / 2550, 6);
  });

  it("gives the gas oracle each recent block's used share of its own limit", async () => {
    const sample = await createEtherscanRest(db.pool).feeSample();
    expect(sample?.usedRatios).toEqual([0.9, 0.9, 12 / 30, 0.75, 1]);
  });
});

describe.skipIf(!TEST_URL)("an update with no block record, read from Canton by the indexer", { timeout: 60_000 }, () => {
  let db: TestDatabase, fake: FakeLedger | undefined, indexer: Indexer | undefined;
  beforeAll(async () => { db = await makeDatabase(); await migrate(db.pool); });
  afterAll(async () => { await indexer?.close().catch(() => undefined); await fake?.close(); await db?.drop(); });

  /** A block's record as the Ledger API shows it, from the synthetic chain's own record. */
  const fields = (r: SyntheticChain["blocks"][number]["record"]) => ({
    operator: OPERATOR, confirmer: CONFIRMER, builder: "builder::1220" + "11".repeat(32), reader: FAKE_READER, chainId: String(r.chainId), number: String(r.number),
    blockHash: r.blockHash.slice(2), parentHash: r.parentHash.slice(2), headerHex: r.headerHex, txsHex: r.txsHex, proofHex: r.proofHex,
  });

  it("is skipped, and the blocks on both sides of it are indexed", async () => {
    const chain = makeChain([{ txs: 2, gasLimit: 30 * M }, { txs: 3, gasLimit: 60 * M, gasUsed: 50 * M }, { txs: 2, gasLimit: 60 * M, gasUsed: 55 * M }]);
    const rec = (i: number) => chain.blocks[i]!.record;
    const block = (i: number) => transaction(rec(i).offset, rec(i).updateId, [createdEvent(rec(i).offset, fields(rec(i)))], rec(i).recordTime);
    // Accepting a gas cap archives the proposal and the chain contract and creates a new chain contract, and no block record. Offsets 15 and 25 sit between the blocks.
    const capUpdate = (offset: number) => transaction(offset, `1220cap${offset}`, [
      { ArchivedEvent: { offset, nodeId: 0, contractId: "00cap0", templateId: "abc123def456:Zk.Chain:GasCapProposal" } },
      { ArchivedEvent: { offset, nodeId: 1, contractId: "00cap1", templateId: "abc123def456:Zk.Chain:ZkChain" } },
      createdEvent(offset, { operator: OPERATOR, confirmer: CONFIRMER, gasCap: "60000000" }, "abc123def456:Zk.Chain:ZkChain"),
    ]);
    fake = await startFakeLedger([block(0), capUpdate(15), block(1), capUpdate(25), block(2), capUpdate(35)], { ledgerEnd: 35 });
    const ledger = createLedger(fake.url, 2000, FAKE_READER);
    indexer = createIndexer({ pool: db.pool, reads: chain.reads, ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 3 });
    expect((await db.pool.query("select count(*)::int as n from blocks")).rows[0].n).toBe(3);
    const rows = (await db.pool.query("select number, gas_limit::text as gas_limit from blocks order by number")).rows;
    expect(rows.map((r) => r.gas_limit)).toEqual(["30000000", "60000000", "60000000"]);
    expect((await db.pool.query("select status from health_checks where check_id in ('C1','C2','C3','C7') and status <> 'ok'")).rowCount).toBe(0);
    // The trailing update has no record either: the next look finds nothing new, and the indexer is still running.
    expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 0 });
  });
});
