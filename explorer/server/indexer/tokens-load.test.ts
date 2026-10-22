/**
 * A block full of token transfers through stage 2 and through the reindex's rebuild, on the pinned PostgreSQL: a contract can emit a Transfer log for
 * about 2k gas, so one block under the 30 Mgas cap holds some 15,000 of them. The time must stay inside B1 (1.0 s, stage 1) and B2 (3.0 s, both stages)
 * however many distinct holders a block names.
 */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { encodeAbiParameters } from "viem";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { reindexRange } from "./reindex.ts";
import type { TraceFrame } from "./reads.ts";
import { BATCH_TOPIC, SELECTORS, TRANSFER_TOPIC } from "./tokens.ts";

const B2_MS = 3000;
const REINDEX_MS = 10_000; // the reindex is no block's budget; the time must follow the size of the range (it was 4.5 s for 2,000 holders and over 2 minutes for 15,000)
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const W = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const T = (n: number) => "0x" + W(n);
const ERC20 = 0xa1, ERC1155 = 0xa3;
const create = (path: number[], address: number): TraceFrame => ({
  traceAddress: path, type: "create", callType: "create", from: A(1), to: A(address), value: 0n, gas: 1000, gasUsed: 10, input: "0x6080", error: null, created: { address: A(address), code: "0x6001" },
});
type Log = { address: string; topics: string[]; data: string };
const erc20 = (from: number, to: number, v: number): Log => ({ address: A(ERC20), topics: [TRANSFER_TOPIC, T(from), T(to)], data: "0x" + W(v) });
const batch = (from: number, to: number, ids: number[], vs: number[]): Log => ({
  address: A(ERC1155), topics: [BATCH_TOPIC, T(0xee), T(from), T(to)], data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [ids.map(BigInt), vs.map(BigInt)]),
});
const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);

const opened: Indexer[] = [];
async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
  });
}

describe.skipIf(!TEST_URL)("a block of thousands of transfers, on the pinned PostgreSQL", () => {
  checkRequired();
  const HOLDERS = Number(process.env.LOAD_HOLDERS ?? 2000);

  it("goes through stage 2 and the reindex's rebuild inside the budget, with every holder counted", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      const chain: SyntheticChain = makeChain([{ txs: 1 }, { txs: 1 }]);
      const t = chain.blocks[0]!.traces[0]!;
      t.frames = [{ ...t.frames[0]!, traceAddress: [], type: "call", callType: "call", created: null }, create([0], ERC20), create([1], ERC1155)];
      t.calls = t.frames.length;
      const logs: Log[] = [erc20(0, 0x1000, 5 * HOLDERS)];
      for (let i = 0; i < HOLDERS; i++) logs.push(erc20(0x1000, 0x2000 + i, 1));
      for (let i = 0; i < HOLDERS / 4; i++) logs.push(batch(0, 0x4000 + i, [1, 2, 3, 4], [1, 1, 1, 1]));
      chain.blocks[1]!.receipts[0]!.logs.push(...logs);
      const call = (sel: string, out: string) => { chain.reads.callResults[`${A(ERC20)}:${sel}`] = out; };
      call(SELECTORS.name, str("Load")); call(SELECTORS.symbol, str("LD")); call(SELECTORS.decimals, "0x" + W(6)); call(SELECTORS.totalSupply, "0x" + W(5 * HOLDERS));
      const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
      opened.push(indexer);
      await indexer.open();
      const started = Date.now();
      await indexer.runOnce();
      const took = Date.now() - started;
      if (process.env.LOAD_HOLDERS) console.log("stage1+2 ms", took);
      expect(took).toBeLessThan(B2_MS);
      const k = (await pool.query("select holder_count::int as h, transfer_count::int as t from tokens where address = $1", [Buffer.from(A(ERC20).slice(2), "hex")])).rows[0];
      expect(k).toEqual({ h: HOLDERS + 1 - 0, t: HOLDERS + 1 });
      const s = (await pool.query("select holder_count::int as h from tokens where address = $1", [Buffer.from(A(ERC1155).slice(2), "hex")])).rows[0];
      expect(s.h).toBe(HOLDERS / 4); // distinct holders, not (holder, id) pairs
      const before = (await pool.query("select (to_jsonb(x))::text as j from token_balances x order by j")).rows.map((r) => r.j);
      const r0 = Date.now();
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, null);
      if (process.env.LOAD_HOLDERS) console.log("reindex ms", Date.now() - r0);
      expect(Date.now() - r0).toBeLessThan(REINDEX_MS);
      expect((await pool.query("select (to_jsonb(x) - 'checked_block')::text as j from token_balances x order by j")).rows.length).toBe(before.length);
    });
  }, 120_000);
});
