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
import { rebuildTokens } from "./aggregates.ts";
import { reindexRange } from "./reindex.ts";
import type { TraceFrame } from "./reads.ts";
import { BATCH_TOPIC, SELECTORS, TRANSFER_TOPIC } from "./tokens.ts";

const B2_MS = 3000;
const REINDEX_MS = 10_000; // the reindex is no block's budget; the time must follow the size of the range (it was 4.5 s for 2,000 holders and over 2 minutes for 15,000)
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const W = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const T = (n: number) => "0x" + W(n);
const ERC20 = 0xa1, ERC721 = 0xa2, ERC1155 = 0xa3;
const create = (path: number[], address: number): TraceFrame => ({
  traceAddress: path, type: "create", callType: "create", from: A(1), to: A(address), value: 0n, gas: 1000, gasUsed: 10, input: "0x6080", error: null, created: { address: A(address), code: "0x6001" },
});
type Log = { address: string; topics: string[]; data: string };
const erc20 = (from: number, to: number, v: bigint | number): Log => ({ address: A(ERC20), topics: [TRANSFER_TOPIC, T(from), T(to)], data: "0x" + W(v) });
const batch = (from: number, to: number, ids: number[], vs: number[]): Log => ({
  address: A(ERC1155), topics: [BATCH_TOPIC, T(0xee), T(from), T(to)], data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [ids.map(BigInt), vs.map(BigInt)]),
});
const nft = (from: number, to: number, id: number): Log => ({ address: A(ERC721), topics: [TRANSFER_TOPIC, T(from), T(to), T(id)], data: "0x" });
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

  // The shapes below run stage 2 alone (the `behind` shape) so its time is measured on its own, against B1; the reindex of the same keys against the same budget.
  const B1_MS = 1000;
  const N = 5000;
  async function load(blocks: Log[][], erc20Supply: number, fn: (pool: Pool, indexer: Indexer, chain: SyntheticChain, stage2Ms: () => number) => Promise<void>): Promise<void> {
    await inDb(async (pool) => {
      let last = -1; // stage 2's write time of the newest block derived
      await migrate(pool);
      const chain: SyntheticChain = makeChain([{ txs: 1 }, ...blocks.map(() => ({ txs: 1 }))]);
      const t = chain.blocks[0]!.traces[0]!;
      t.frames = [{ ...t.frames[0]!, traceAddress: [], type: "call", callType: "call", created: null }, create([0], ERC20), create([1], ERC1155), create([2], ERC721)];
      t.calls = t.frames.length;
      blocks.forEach((logs, i) => chain.blocks[i + 1]!.receipts[0]!.logs.push(...logs));
      const call = (sel: string, out: string) => { chain.reads.callResults[`${A(ERC20)}:${sel}`] = out; };
      call(SELECTORS.name, str("Load")); call(SELECTORS.symbol, str("LD")); call(SELECTORS.decimals, "0x" + W(6)); call(SELECTORS.totalSupply, "0x" + W(erc20Supply));
      const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "behind", onTiming: (t) => { if (t.stage === 2) last = t.writeMs; } });
      opened.push(indexer);
      await indexer.open();
      await fn(pool, indexer, chain, () => last);
    });
  }
  const tok = (pool: Pool, a: number) => pool.query("select holder_count::int as h, transfer_count::int as t from tokens where address = $1", [Buffer.from(A(a).slice(2), "hex")]).then((r) => r.rows[0]);
  const snapshot = async (pool: Pool) => (await pool.query("select (to_jsonb(x) - 'checked_block')::text as j from token_balances x order by j")).rows.map((r) => r.j);
  /** The reindex's rebuild of the tokens and balances over every block, against B1, then the whole reindex (every aggregate) against the reindex's own limit; the rows come out the same. */
  async function reindexAgainstBudget(pool: Pool, chain: SyntheticChain): Promise<void> {
    const before = await snapshot(pool);
    const head = chain.blocks.length;
    await pool.query("analyze token_transfers");
    const r0 = Date.now();
    await rebuildTokens(pool, 1, head, head, false);
    const took = Date.now() - r0;
    if (process.env.LOAD_HOLDERS) console.log("rebuildTokens ms", took);
    expect(took).toBeLessThan(B1_MS);
    expect(await snapshot(pool)).toEqual(before);
    const r1 = Date.now();
    await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, null);
    if (process.env.LOAD_HOLDERS) console.log("reindex ms", Date.now() - r1);
    expect(Date.now() - r1).toBeLessThan(REINDEX_MS);
    expect(await snapshot(pool)).toEqual(before);
  }

  it("5,000 distinct-holder ERC-20 transfers in one block: stage 2 and the reindex's rebuild each inside B1", async () => {
    const logs = [erc20(0, 0x1000, 5 * N)];
    for (let i = 0; i < N; i++) logs.push(erc20(0x1000, 0x2000 + i, 1));
    await load([logs], 5 * N, async (pool, indexer, chain, stage2Ms) => {
      await indexer.runOnce();
      await indexer.deriveOnce();
      const took = stage2Ms();
      if (process.env.LOAD_HOLDERS) console.log("stage 2 ms", took);
      expect(took).toBeLessThan(B1_MS);
      expect(await tok(pool, ERC20)).toEqual({ h: N + 1, t: N + 1 });
      await reindexAgainstBudget(pool, chain);
      expect(await tok(pool, ERC20)).toEqual({ h: N + 1, t: N + 1 });
    });
  }, 120_000);

  it("5,000 holders that empty their balance in one block (a sweep), the shape that evaluates the holder count's second look", async () => {
    const fund = [erc20(0, 0x1000, 5 * N)];
    for (let i = 0; i < N; i++) fund.push(erc20(0x1000, 0x2000 + i, 1));
    const sweep: Log[] = [];
    for (let i = 0; i < N; i++) sweep.push(erc20(0x2000 + i, 0x9000, 1));
    await load([fund, sweep], 5 * N, async (pool, indexer, chain, stage2Ms) => {
      await indexer.runOnce();
      await indexer.deriveOnce(); // derives the block that makes the tokens and then the one with the sweep, which is the one timed
      if (process.env.LOAD_HOLDERS) console.log("stage 2 ms", stage2Ms());
      expect(stage2Ms()).toBeLessThan(B1_MS);
      expect(await tok(pool, ERC20)).toEqual({ h: 2, t: 2 * N + 1 }); // the sink and the first holder, which keeps what is left of the supply
      await reindexAgainstBudget(pool, chain);
      expect(await tok(pool, ERC20)).toEqual({ h: 2, t: 2 * N + 1 });
    });
  }, 120_000);

  it("1,250 ERC-1155 holders of four ids that each empty one id in one block: counted once each, inside B1", async () => {
    const H = N / 4;
    const fund: Log[] = [];
    for (let i = 0; i < H; i++) fund.push(batch(0, 0x4000 + i, [1, 2, 3, 4], [1, 1, 1, 1]));
    const empty: Log[] = [];
    for (let i = 0; i < H; i++) empty.push(batch(0x4000 + i, 0x7000, [1], [1]));
    await load([fund, empty], 1, async (pool, indexer, chain, stage2Ms) => {
      await indexer.runOnce();
      await indexer.deriveOnce();
      if (process.env.LOAD_HOLDERS) console.log("stage 2 ms", stage2Ms());
      expect(stage2Ms()).toBeLessThan(B1_MS);
      expect((await tok(pool, ERC1155)).h).toBe(H + 1); // every holder still holds three ids; the sink holds one
      await reindexAgainstBudget(pool, chain);
      expect((await tok(pool, ERC1155)).h).toBe(H + 1);
    });
  }, 120_000);

  const MAX = (1n << 256n) - 1n;
  it("nine transfers of the largest amount to one holder: stage 2 and the reindex finish, and the next block is indexed", async () => {
    const mint: Log[] = [];
    for (let i = 0; i < 9; i++) mint.push(erc20(0, 0x1000, MAX));
    await load([mint, [erc20(0x1000, 0x2000, 1)]], 1, async (pool, indexer, chain) => {
      await indexer.runOnce();
      await indexer.deriveOnce();
      expect(await tok(pool, ERC20)).toEqual({ h: 2, t: 10 }); // the token's last block was derived too: the cursor went past the nine logs
      const value = () => pool.query("select value::text as v from token_balances where holder = $1", [Buffer.from(A(0x1000).slice(2), "hex")]).then((r) => r.rows[0].v);
      expect(await value()).toBe((9n * MAX - 1n).toString());
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, null);
      expect(await value()).toBe((9n * MAX - 1n).toString());
      expect(await tok(pool, ERC20)).toEqual({ h: 2, t: 10 });
    });
  }, 120_000);

  it("one block of four 4,096-id TransferBatch logs to one holder: stage 2 and the reindex's rebuild each inside B1", async () => {
    const logs: Log[] = [];
    for (let b = 0; b < 4; b++) logs.push(batch(0, 0x4000, Array.from({ length: 4096 }, (_, i) => b * 4096 + i + 1), Array.from({ length: 4096 }, () => 1)));
    await load([logs], 1, async (pool, indexer, chain, stage2Ms) => {
      await indexer.runOnce();
      await indexer.deriveOnce();
      if (process.env.LOAD_HOLDERS) console.log("stage 2 ms", stage2Ms());
      expect(stage2Ms()).toBeLessThan(B1_MS);
      expect((await tok(pool, ERC1155)).h).toBe(1);
      await reindexAgainstBudget(pool, chain);
      expect((await tok(pool, ERC1155)).h).toBe(1);
      // A full reindex's orphan delete checks the same keys.
      const f0 = Date.now();
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, null);
      if (process.env.LOAD_HOLDERS) console.log("full reindex ms", Date.now() - f0);
      expect(Date.now() - f0).toBeLessThan(REINDEX_MS);
    });
  }, 300_000);

  it("5,000 NFTs of a collection with history moved in one block: the owners rebuild inside B1, and the full reindex inside its limit", async () => {
    const mint: Log[] = [], move: Log[] = [];
    for (let i = 0; i < N; i++) mint.push(nft(0, 0x5000 + i, i + 1));
    for (let i = 0; i < N; i++) move.push(nft(0x5000 + i, 0x7000 + i, i + 1));
    await load([mint, move], 1, async (pool, indexer, chain) => {
      await indexer.runOnce();
      await indexer.deriveOnce();
      const owners = async () => (await pool.query("select (to_jsonb(x))::text as j from nft_owners x order by j")).rows.map((r) => r.j);
      const before = await owners();
      expect(before.length).toBe(N);
      await pool.query("analyze token_transfers");
      const r0 = Date.now();
      await rebuildTokens(pool, 3, 3, 3, false); // the block that moves them
      if (process.env.LOAD_HOLDERS) console.log("nft rebuildTokens ms", Date.now() - r0);
      expect(Date.now() - r0).toBeLessThan(B1_MS);
      expect(await owners()).toEqual(before);
      const f0 = Date.now();
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 1, null);
      if (process.env.LOAD_HOLDERS) console.log("nft full reindex ms", Date.now() - f0);
      expect(Date.now() - f0).toBeLessThan(REINDEX_MS);
      expect(await owners()).toEqual(before);
    });
  }, 300_000);
});
