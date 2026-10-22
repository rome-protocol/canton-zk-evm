/** Token detection, metadata and transfers in stage 2, on the pinned PostgreSQL, with the logs and the token calls set by the tests. */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import type { TraceFrame } from "./reads.ts";
import { stage2 } from "./stage2.ts";
import { BATCH_TOPIC, SELECTORS, SINGLE_TOPIC, TRANSFER_TOPIC, decodeTransfers, type LogRow } from "./tokens.ts";

const opened: Indexer[] = [];
async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    try {
      await fn(pool);
    } finally {
      for (const i of opened.splice(0)) await i.close().catch(() => undefined);
    }
  });
}

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const W = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const T = (n: number) => "0x" + W(n); // an address or an id as a topic
const ERC20 = 0xa1, ERC721 = 0xa2, ERC1155 = 0xa3, ALICE = 0x11, BOB = 0x22, CAROL = 0x33;
const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);
const uint = (n: number) => "0x" + W(n);

const create = (path: number[], address: number): TraceFrame => ({
  traceAddress: path, type: "create", callType: "create", from: A(1), to: A(address), value: 0n, gas: 1000, gasUsed: 10, input: "0x6080", error: null, created: { address: A(address), code: "0x6001" },
});

type Log = { address: string; topics: string[]; data: string };
const erc20 = (token: number, from: number, to: number, v: number): Log => ({ address: A(token), topics: [TRANSFER_TOPIC, T(from), T(to)], data: uint(v) });
const erc721 = (token: number, from: number, to: number, id: number): Log => ({ address: A(token), topics: [TRANSFER_TOPIC, T(from), T(to), T(id)], data: "0x" });
const single = (token: number, from: number, to: number, id: number, v: number): Log => ({ address: A(token), topics: [SINGLE_TOPIC, T(0xee), T(from), T(to)], data: "0x" + W(id) + W(v) });
const batch = (token: number, from: number, to: number, ids: number[], vs: number[]): Log => ({
  address: A(token), topics: [BATCH_TOPIC, T(0xee), T(from), T(to)], data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [ids.map(BigInt), vs.map(BigInt)]),
});

/** Block 1 makes the three tokens (and a fourth contract that is no token); block 2 carries `logs`. */
async function setup(pool: Pool, logs: Log[]) {
  await migrate(pool);
  const chain: SyntheticChain = makeChain([{ txs: 1 }, { txs: 1 }]);
  const t = chain.blocks[0]!.traces[0]!;
  t.frames = [{ ...t.frames[0]!, traceAddress: [], type: "call", callType: "call", created: null }, create([0], ERC20), create([1], ERC721), create([2], ERC1155), create([3], 0xa4)];
  t.calls = t.frames.length;
  chain.blocks[1]!.receipts[0]!.logs.push(...logs);
  const call = (token: number, sel: string, out: string) => { chain.reads.callResults[`${A(token)}:${sel}`] = out; };
  call(ERC20, SELECTORS.name, str("Test Coin")); call(ERC20, SELECTORS.symbol, str("TST")); call(ERC20, SELECTORS.decimals, uint(6)); call(ERC20, SELECTORS.totalSupply, uint(1000));
  call(ERC721, SELECTORS.name, str("Test Art")); call(ERC721, SELECTORS.symbol, str("ART")); call(ERC721, SELECTORS.totalSupply, uint(3));
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  return { chain, indexer };
}
const rows = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const hx = (n: number) => A(n).slice(2);

describe("decodeTransfers", () => {
  const row = (l: Log): LogRow => ({
    log_index: 0, tx_index: 0, address: Buffer.from(l.address.slice(2), "hex"), data: Buffer.from(l.data.slice(2), "hex"),
    topic0: Buffer.from(l.topics[0]!.slice(2), "hex"), topic1: l.topics[1] ? Buffer.from(l.topics[1].slice(2), "hex") : null,
    topic2: l.topics[2] ? Buffer.from(l.topics[2].slice(2), "hex") : null, topic3: l.topics[3] ? Buffer.from(l.topics[3].slice(2), "hex") : null,
  });
  it("tells ERC-20 from ERC-721 by the topics, and reads the batch", () => {
    expect(decodeTransfers(row(erc20(ERC20, ALICE, BOB, 7)))).toMatchObject([{ standard: "ERC-20", amount: 7n, tokenId: null, from: A(ALICE), to: A(BOB) }]);
    expect(decodeTransfers(row(erc721(ERC721, ALICE, BOB, 9)))).toMatchObject([{ standard: "ERC-721", amount: null, tokenId: 9n }]);
    expect(decodeTransfers(row(single(ERC1155, ALICE, BOB, 5, 2)))).toMatchObject([{ standard: "ERC-1155", tokenId: 5n, amount: 2n, from: A(ALICE), to: A(BOB) }]);
    expect(decodeTransfers(row(batch(ERC1155, ALICE, BOB, [1, 2], [10, 20])))).toMatchObject([{ batchIndex: 0, tokenId: 1n, amount: 10n }, { batchIndex: 1, tokenId: 2n, amount: 20n }]);
  });
  it("gives nothing for a log that is not shaped as a standard says", () => {
    expect(decodeTransfers(row({ address: A(ERC20), topics: [TRANSFER_TOPIC, T(1), T(2)], data: "0x00" }))).toEqual([]);
    expect(decodeTransfers(row({ address: A(ERC1155), topics: [BATCH_TOPIC, T(1), T(2), T(3)], data: "0x" + "00".repeat(128) }))).toEqual([]);
    expect(decodeTransfers(row({ address: A(ERC1155), topics: [BATCH_TOPIC, T(1), T(2), T(3)], data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [[1n, 2n], [1n]]) }))).toEqual([]);
  });
});

describe.skipIf(!TEST_URL)("stage 2's tokens and transfers, on the pinned PostgreSQL", () => {
  checkRequired();
  const logs = [
    erc20(ERC20, 0, ALICE, 1000), erc20(ERC20, ALICE, BOB, 250),
    erc721(ERC721, 0, ALICE, 1), erc721(ERC721, ALICE, BOB, 1),
    single(ERC1155, 0, ALICE, 7, 5), batch(ERC1155, ALICE, CAROL, [7, 8], [2, 3]),
    erc20(0xbad, ALICE, BOB, 1), // from an address that is no known contract
    erc20(0xa4, ALICE, BOB, 1), // from a contract that answers none of the token reads: still a token whose supply failed
  ];

  it("detects an ERC-20, an ERC-721 and an ERC-1155 token with their metadata, and stores their transfers", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, logs);
      expect(await indexer.runOnce()).toEqual({ state: "caught-up", indexed: 2 });
      const tokens = await rows(pool, "select encode(address, 'hex') as a, standard, name, symbol, decimals, total_supply::text as supply, total_supply_block, first_transfer_block, metadata_status, balance_mode from tokens order by address");
      expect(tokens).toEqual([
        { a: hx(ERC20), standard: "ERC-20", name: "Test Coin", symbol: "TST", decimals: 6, supply: "1000", total_supply_block: "2", first_transfer_block: "2", metadata_status: "read", balance_mode: "derived" },
        { a: hx(ERC721), standard: "ERC-721", name: "Test Art", symbol: "ART", decimals: null, supply: "3", total_supply_block: "2", first_transfer_block: "2", metadata_status: "read", balance_mode: "derived" },
        { a: hx(ERC1155), standard: "ERC-1155", name: null, symbol: null, decimals: null, supply: null, total_supply_block: null, first_transfer_block: "2", metadata_status: "read", balance_mode: "derived" },
        { a: hx(0xa4), standard: "ERC-20", name: null, symbol: null, decimals: null, supply: null, total_supply_block: null, first_transfer_block: "2", metadata_status: "failed", balance_mode: "derived" },
      ]);
      const transfers = await rows(pool, "select block_number, log_index, batch_index, encode(token, 'hex') as t, encode(from_address, 'hex') as f, encode(to_address, 'hex') as o, amount::text, token_id::text from token_transfers order by log_index, batch_index");
      const mine = transfers.filter((r) => r.t !== hx(0xa4));
      expect(mine.map((r) => [r.t, r.f, r.o, r.amount, r.token_id])).toEqual([
        [hx(ERC20), hx(0), hx(ALICE), "1000", null], [hx(ERC20), hx(ALICE), hx(BOB), "250", null],
        [hx(ERC721), hx(0), hx(ALICE), null, "1"], [hx(ERC721), hx(ALICE), hx(BOB), null, "1"],
        [hx(ERC1155), hx(0), hx(ALICE), "5", "7"],
        [hx(ERC1155), hx(ALICE), hx(CAROL), "2", "7"], [hx(ERC1155), hx(ALICE), hx(CAROL), "3", "8"],
      ]);
      expect(transfers.filter((r) => r.batch_index === 1).map((r) => r.token_id)).toEqual(["8"]);
      expect(transfers.every((r) => r.block_number === "2" && r.t !== hx(0xbad))).toBe(true);
      expect(await rows(pool, "select 1 from tokens where address = $1", [Buffer.from(hx(0xbad), "hex")])).toEqual([]);
      await indexer.close();
    });
  });

  it("names a token's contract with the token's name", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, logs);
      await indexer.runOnce();
      const names = await rows(pool, "select encode(address, 'hex') as a, name from contracts where address = any($1::bytea[]) order by address", [[ERC20, ERC721, ERC1155].map((n) => Buffer.from(hx(n), "hex"))]);
      expect(names).toEqual([{ a: hx(ERC20), name: "Test Coin" }, { a: hx(ERC721), name: "Test Art" }, { a: hx(ERC1155), name: null }]);
      await indexer.close();
    });
  });

  it("writes nothing twice for a block that is replayed", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, logs);
      await indexer.runOnce();
      const snap = async () => ({
        transfers: await rows(pool, "select * from token_transfers order by block_number, log_index, batch_index"),
        tokens: await rows(pool, "select * from tokens order by address"),
        counts: await rows(pool, "select (select count(*) from token_transfers) as t, (select count(*) from tokens) as k"),
      });
      const before = await snap();
      const c = await pool.connect();
      try {
        await c.query("begin");
        expect(await stage2(c, 2, (await chain.reads.traces(2))!, chain.reads)).toEqual({ derived: false });
        await c.query("commit");
      } finally {
        c.release();
      }
      expect(await indexer.deriveOnce()).toEqual({ state: "caught-up", indexed: 0 });
      expect(await snap()).toEqual(before);
      expect(before.counts).toEqual([{ t: "8", k: "4" }]);
      await indexer.close();
    });
  });

  it("counts the transfers of each token and of each address", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, logs);
      await indexer.runOnce();
      const counts = await rows(pool, "select encode(address, 'hex') as a, transfer_count from tokens order by address");
      expect(counts.map((r) => [r.a, r.transfer_count])).toEqual([[hx(ERC20), "2"], [hx(ERC721), "2"], [hx(ERC1155), "3"], [hx(0xa4), "1"]]);
      const addr = await rows(pool, "select encode(address, 'hex') as a, token_transfer_count from addresses where address = any($1::bytea[]) order by address", [[ALICE, BOB, CAROL].map((n) => Buffer.from(hx(n), "hex"))]);
      expect(addr.map((r) => [r.a, r.token_transfer_count])).toEqual([[hx(ALICE), "8"], [hx(BOB), "3"], [hx(CAROL), "2"]]);
      await indexer.close();
    });
  });
});
