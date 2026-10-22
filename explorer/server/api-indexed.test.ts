import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi } from "./api.ts";
import { createChainDb } from "./chain-db.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "./db/testing.ts";
import { createIndexer } from "./indexer/indexer.ts";
import { createJournal } from "./indexer/journal.ts";
import { RUN1, RUN2, Run, iso, makeFolder, putFile, removeFolders } from "./indexer/journal-fixtures.ts";
import type { Reth } from "./reth.ts";
import { CHAIN_ID, CONFIRMER, GATEWAY, OPERATOR, PINS, makeChain } from "../test/synthetic-chain.ts";

afterAll(removeFolders);

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const token = { name: "Token", symbol: "TKN", decimals: 6 };

/** The pages' routes over rows that the indexer's own stage 1 wrote: reth and Canton are not asked for anything a final block needs. */
async function served(pool: Pool, shapes: Parameters<typeof makeChain>[0], { now, hasCode = () => true }: { now?: () => number; hasCode?: (address: string) => boolean } = {}) {
  await migrate(pool);
  const chain = makeChain(shapes);
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  await indexer.open();
  try {
    await indexer.runOnce();
  } finally {
    await indexer.close();
  }
  const asked = { code: [] as string[], token: [] as string[] };
  const reth = {
    code: async (a: string) => { asked.code.push(a); return hasCode(a) ? "0x6080" : "0x"; },
    token: async (a: string) => { asked.token.push(a); return token; },
    block: async () => undefined, transaction: async () => null,
  } as unknown as Reth;
  const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
  const db = createChainDb(pool);
  const api = createApi({ config, reth, ledger: { ledgerEnd: async () => 1 } as never, chain: db, ...(now ? { now } : {}) });
  return { chain, db, asked, get: (target: string) => api("GET", target) };
}

describe.skipIf(!TEST_URL)("the routes over what the indexer wrote", () => {
  checkRequired();

  it("serves a block, its transactions and its Canton side from the rows", async () => {
    await withDatabase(async (pool) => {
      const { chain, get } = await served(pool, [{ txs: 0 }, { txs: 5, leg: 2 }, { txs: 2 }]);
      const b = chain.blocks[1]!;
      const { status, body } = await get(`/api/block/${b.block.number}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "final", number: 2, hash: b.block.hash, parentHash: b.block.parentHash, timestamp: b.block.timestamp, txCount: 5, gasUsed: b.block.gasUsed, gasLimit: 30_000_000, baseFee: "7",
        miner: b.block.miner, stateRoot: b.block.stateRoot, genesisReferenced: null,
        canton: {
          updateId: b.record.updateId, recordTime: b.record.recordTime, hashesMatch: true, headerHex: b.record.headerHex, txsHex: b.record.txsHex, proofHex: b.record.proofHex, proofBytes: 1344,
          proof: { programVK: { value: PINS.programVK, ok: true }, rootC: { value: PINS.rootC, ok: true }, blockHash: { value: b.block.hash, ok: true } },
        },
      });
      const txs = (body as { transactions: { hash: string; success: boolean; transfer: unknown }[] }).transactions;
      expect(txs.map((t) => t.hash)).toEqual(b.block.transactions.map((t) => t.hash));
      expect(txs.map((t) => t.success)).toEqual(b.receipts.map((r) => r.status === 1));
      expect(txs[1]!.transfer).toMatchObject({ symbol: "TKN", decimals: 6, value: "0" }); // the second one is an ERC-20 transfer
      expect((await get(`/api/block/${b.block.hash}`)).body).toEqual(body);
      expect((await get(`/api/search?q=${b.record.updateId}`)).body).toEqual({ path: "/block/2" });
    });
  });

  it("serves a transaction with its receipt's fields and logs, in the order they were written", async () => {
    await withDatabase(async (pool) => {
      const { chain, get } = await served(pool, [{ txs: 5 }]);
      const b = chain.blocks[0]!;
      const logsOf = async (k: number) => ((await get(`/api/tx/${b.block.transactions[k]!.hash}`)).body as Record<string, unknown>);
      const failed = await logsOf(4);
      expect(failed).toMatchObject({ status: "final", state: "final", success: false, block: { number: 1, hash: b.block.hash, updateId: b.record.updateId }, gasUsed: 30000, gasPrice: "8", fee: String(30000 * 8), logs: [] });
      const many = await logsOf(3);
      expect(many).toMatchObject({ success: true, gasUsed: 90000, to: b.block.transactions[3]!.to, input: b.block.transactions[3]!.input, nonce: 3, type: 2, gas: 100000 });
      expect((many.logs as unknown[]).length).toBe(6);
      expect((many.logs as { address: string; topics: string[] }[])[5]).toMatchObject({ address: "0x" + (0xe005).toString(16).padStart(40, "0"), topics: ["0x" + "77".repeat(32)] });
      const created = await logsOf(2);
      expect(created).toMatchObject({ to: null, created: b.receipts[2]!.contractAddress });
      expect((await get(`/api/search?q=${"1220" + "00".repeat(32)}`)).status).toBe(404);
    });
  });

  it("says who the two signers are and that the indexer has written, with no problem", async () => {
    await withDatabase(async (pool) => {
      const { db } = await served(pool, [{ txs: 1 }]);
      // Records written and no check round yet (as after a rebuild from an export): not healthy until the refreshed checks have been looked at.
      expect((await db.indexer()).problems).toEqual(["C4", "C5", "derive_lag", "C10"].map((c) => `${c}: the indexer has not checked yet`));
      await pool.query("insert into health_checks (check_id, status, changed_at, checked_at) select c, 'ok', now(), now() from unnest($1::text[]) as c", [["C4", "C5", "derive_lag", "C10"]]);
      expect(await db.indexer()).toEqual({ started: true, problems: [], signers: { operator: OPERATOR, confirmer: CONFIRMER } });
      expect(await db.genesisReferenced()).toBe(true);
    });
  });

  describe("the token details of a transaction's destination", () => {
    const to = (chain: Awaited<ReturnType<typeof served>>["chain"], k: number) => chain.blocks[0]!.block.transactions[k]!.to as string;

    it("is not asked of reth for an address that holds no code, and a repeat visit asks nothing", async () => {
      await withDatabase(async (pool) => {
        const { chain, asked, get } = await served(pool, [{ txs: 2 }], { hasCode: () => false });
        const hash = chain.blocks[0]!.block.transactions[0]!.hash;
        expect((await get(`/api/tx/${hash}`)).body).toMatchObject({ status: "final", toToken: null });
        expect(asked.token).toEqual([]);
        expect(asked.code).toEqual([to(chain, 0)]);
        await get(`/api/tx/${hash}`);
        expect(asked.code).toEqual([to(chain, 0)]);
      });
    });

    it("is read again after a minute, so that a new chain's contract at the same address is not shown as the old one's token", async () => {
      await withDatabase(async (pool) => {
        let t = 1_000;
        let code = true;
        const { chain, asked, get } = await served(pool, [{ txs: 1 }], { now: () => t, hasCode: () => code });
        const hash = chain.blocks[0]!.block.transactions[0]!.hash;
        expect((await get(`/api/tx/${hash}`)).body).toMatchObject({ toToken: "TKN" });
        code = false; t += 59_000;
        expect((await get(`/api/tx/${hash}`)).body).toMatchObject({ toToken: "TKN" }); // still inside the minute
        t += 1_001;
        expect((await get(`/api/tx/${hash}`)).body).toMatchObject({ toToken: null });
        expect(asked.code.length).toBe(2);
      });
    });
  });
  describe("the lifecycle", () => {
    it("is in the transaction route: the stages and their times, and blank for a transaction that nobody tracked", async () => {
      await withDatabase(async (pool) => {
        const { chain, get } = await served(pool, [{ txs: 2 }]);
        const [a, b] = chain.blocks[0]!.block.transactions;
        const t = Date.parse(chain.blocks[0]!.record.recordTime);
        // before any journal: the row stage 1 wrote has the final fields only
        expect((await get(`/api/tx/${a!.hash}`)).body).toMatchObject({
          lifecycle: { state: "final", acceptedAt: null, acceptedVia: null, includedAt: null, attempts: 0, proofStartedAt: null, committedAt: null, finalAt: iso(t), finalBlock: 1, timeToFinalMs: null },
        });
        // the API accepted `a`, 9 s before the block's record time
        await pool.query("update tx_lifecycle set accepted_at = $2, accepted_via = 'rpc' where tx_hash = $1", [Buffer.from(a!.hash.slice(2), "hex"), iso(t - 9000)]);
        const dir = makeFolder();
        const run = new Run(RUN1);
        run.start(t - 60_000);
        run.committed(1, 1, chain);
        putFile(dir, "2026-10-21.jsonl", run.lines);
        await createJournal({ pool, folder: dir }).load();
        const { body } = await get(`/api/tx/${a!.hash}`);
        expect((body as { lifecycle: unknown }).lifecycle).toEqual({
          state: "final", reason: null, acceptedAt: iso(t - 9000), acceptedVia: "rpc", includedAt: iso(t - 7000), attempts: 1, leftOutReason: null,
          proofStartedAt: iso(t - 6800), proofEndedAt: iso(t - 100), submittedAt: iso(t - 50), committedAt: iso(t + 40), finalAt: iso(t), finalBlock: 1, timeToFinalMs: 9000,
        });
        // the other one was never accepted by the API: it has an inclusion time and no acceptance time
        expect((await get(`/api/tx/${b!.hash}`)).body).toMatchObject({ lifecycle: { acceptedAt: null, includedAt: iso(t - 7000), timeToFinalMs: null } });
      });
    });

    it("takes the committed attempt over one cut short by a crash, and gives a block settled as committed its commit time", async () => {
      // a transaction built in run 1, which crashed during the proof, then committed in run 2
      await withDatabase(async (pool) => {
        const { chain, get } = await served(pool, [{ txs: 1 }]);
        const t = Date.parse(chain.blocks[0]!.record.recordTime);
        const hash = chain.blocks[0]!.block.transactions[0]!.hash;
        const b = chain.blocks[0]!;
        const dir = makeFolder();
        const run1 = new Run(RUN1);
        run1.start(t - 120_000);
        run1.add(t - 100_000, "cut", { attempt: 1, number: 1, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 5, in_flight_at_cut: 0 });
        run1.add(t - 99_000, "built", { attempt: 1, block_hash: "0x" + "77".repeat(32), parent_hash: b.block.parentHash, tx_hashes: [hash], gas_used: 21000, legs: 0, rebuilds: 0, left_out: [] });
        run1.add(t - 98_000, "proof_started", { attempt: 1, prover: "prover-a" });
        const run2 = new Run(RUN2);
        run2.start(t - 60_000);
        run2.committed(1, 1, chain);
        putFile(dir, "2026-10-21.jsonl", [...run1.lines, ...run2.lines]);
        await createJournal({ pool, folder: dir }).load();
        expect((await get(`/api/tx/${hash}`)).body).toMatchObject({
          lifecycle: { state: "final", proofStartedAt: iso(t - 6800), proofEndedAt: iso(t - 100), submittedAt: iso(t - 50), committedAt: iso(t + 40), finalAt: iso(t) },
        });
      });
      // an attempt whose outcome the producer never knew, settled as committed by the indexed block
      await withDatabase(async (pool) => {
        const { chain, get } = await served(pool, [{ txs: 1 }]);
        const t = Date.parse(chain.blocks[0]!.record.recordTime);
        const b = chain.blocks[0]!;
        const dir = makeFolder();
        const run = new Run(RUN1);
        run.start(t - 60_000);
        run.add(t - 8000, "cut", { attempt: 1, number: 1, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 5, in_flight_at_cut: 0 });
        run.add(t - 7000, "built", { attempt: 1, block_hash: b.block.hash, parent_hash: b.block.parentHash, tx_hashes: b.block.transactions.map((x) => x.hash), gas_used: b.block.gasUsed, legs: 0, rebuilds: 0, left_out: [] });
        run.add(t - 100, "proof_ended", { attempt: 1, prover: "prover-a", outcome: "ok", seconds: 6.7 });
        run.add(t - 50, "submitted", { attempt: 1, command_id: "ostia-1", argument_bytes: 4321 });
        run.add(t + 30_000, "answered", { attempt: 1, outcome: "unknown", reason: "timeout", update_id: null, completion_offset: null, seconds: 30, traffic_bytes: null, traffic_before: null, traffic_after: null });
        putFile(dir, "2026-10-21.jsonl", run.lines);
        await createJournal({ pool, folder: dir }).load();
        const lifecycle = (await get(`/api/tx/${b.block.transactions[0]!.hash}`)).body as { lifecycle: { committedAt: string | null; submittedAt: string | null } };
        expect(lifecycle.lifecycle.submittedAt).toBe(iso(t - 50));
        expect(lifecycle.lifecycle.committedAt).not.toBeNull();
      });
    });

    it("lists the attempts that are not final at /api/in-flight, with the pool's latest count, and says they are not final", async () => {
      await withDatabase(async (pool) => {
        const { chain, get } = await served(pool, [{ txs: 1 }]);
        const t = Date.parse(chain.blocks[0]!.record.recordTime);
        const hash = chain.blocks[0]!.block.transactions[0]!.hash;
        const dir = makeFolder();
        const r = new Run(RUN1);
        r.start(t - 60_000);
        r.committed(1, 1, chain); // final and indexed: not in flight
        const cut = (attempt: number, number: number, at: number, reason = "pool") => r.add(at, "cut", { attempt, number, strategy: "on_demand", cut_reason: reason, pool_waiting: 2, idle_before_cut_ms: 5, in_flight_at_cut: 0 });
        const built = (attempt: number, at: number, h: string) => r.add(at, "built", { attempt, block_hash: h, parent_hash: "0x" + "00".repeat(32), tx_hashes: [hash], gas_used: 21000, legs: 0, rebuilds: 0, left_out: [] });
        const base = Date.now() - 120_000; // the attempts are recent: one that is older than an hour is not in flight
        cut(2, 2, base); // only cut
        cut(3, 3, base + 1000); built(3, base + 1100, "0x" + "33".repeat(32)); r.add(base + 1200, "proof_started", { attempt: 3, prover: "prover-a" }); // being proven
        cut(4, 4, base + 2000); built(4, base + 2100, "0x" + "44".repeat(32)); r.add(base + 2200, "proof_started", { attempt: 4, prover: "prover-a" });
        r.add(base + 3000, "proof_ended", { attempt: 4, prover: "prover-a", outcome: "ok", seconds: 0.8 });
        r.add(base + 3100, "submitted", { attempt: 4, command_id: "ostia-1-4-x-1", argument_bytes: 10 }); // submitted, no answer yet
        cut(5, 5, base + 4000); built(5, base + 4100, "0x" + "55".repeat(32));
        r.add(base + 4200, "answered", { attempt: 5, outcome: "refused", reason: "stale", update_id: null, completion_offset: null, seconds: 0.1, traffic_bytes: null }); // ended: not in flight
        cut(6, 6, base + 5000); built(6, base + 5100, "0x" + "66".repeat(32));
        r.add(base + 5200, "answered", { attempt: 6, outcome: "committed", reason: null, update_id: "1220" + "66".repeat(32), completion_offset: 60, seconds: 0.1, traffic_bytes: null }); // committed, not final yet
        cut(7, 1, base - 7_200_000); // an hour old and more: a run that stopped
        r.add(base + 6000, "pool", { waiting: 4 });
        putFile(dir, "2026-10-21.jsonl", r.lines);
        await createJournal({ pool, folder: dir }).load();
        const { status, body } = await get("/api/in-flight");
        expect(status).toBe(200);
        const f = body as { final: boolean; attempts: Record<string, unknown>[]; poolWaiting: unknown };
        expect(f.final).toBe(false);
        expect(f.attempts.map((x) => [x.number, x.stage])).toEqual([[2, "cut"], [3, "proving"], [4, "submitted"], [6, "committed"]]);
        expect(f.attempts[1]).toEqual({
          number: 3, strategy: "on_demand", cutReason: "pool", stage: "proving", txCount: 1, poolWaiting: 2, cutAt: iso(base + 1000), builtAt: iso(base + 1100), proofStartedAt: iso(base + 1200),
          proofEndedAt: null, submittedAt: null, answeredAt: null, outcome: null,
        });
        expect(f.poolWaiting).toEqual({ waiting: 4, at: iso(base + 6000) });
        expect((await get("/api/in-flight/x")).status).toBe(404);
      });
    });

    it("is empty and has no pool sample when there is no journal", async () => {
      await withDatabase(async (pool) => {
        const { get } = await served(pool, [{ txs: 1 }]);
        expect((await get("/api/in-flight")).body).toEqual({ final: false, attempts: [], poolWaiting: null });
      });
    });
  });
});
