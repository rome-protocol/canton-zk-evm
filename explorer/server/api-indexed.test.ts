import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi } from "./api.ts";
import { createChainDb } from "./chain-db.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "./db/testing.ts";
import { createIndexer } from "./indexer/indexer.ts";
import type { Reth } from "./reth.ts";
import { CHAIN_ID, CONFIRMER, GATEWAY, OPERATOR, PINS, makeChain } from "../test/synthetic-chain.ts";

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
});
