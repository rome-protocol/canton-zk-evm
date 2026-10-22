/**
 * Balances and NFT owners from the transfers, the background check of balances (coin and token, `checked_block`), a token that takes a fee switched to
 * read balances, and a reindex that rebuilds every aggregate: on the pinned PostgreSQL, with the logs and reth's answers set by the tests.
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
import { BATCH_TOPIC, SELECTORS, SINGLE_TOPIC, TRANSFER_TOPIC } from "./tokens.ts";

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
const T = (n: number) => "0x" + W(n);
const hx = (n: number) => Buffer.from(A(n).slice(2), "hex");
const ERC20 = 0xa1, ERC721 = 0xa2, ERC1155 = 0xa3, FEE = 0xa5, ALICE = 0x11, BOB = 0x22, CAROL = 0x33;
const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);

const create = (path: number[], address: number): TraceFrame => ({
  traceAddress: path, type: "create", callType: "create", from: A(1), to: A(address), value: 0n, gas: 1000, gasUsed: 10, input: "0x6080", error: null, created: { address: A(address), code: "0x6001" },
});
type Log = { address: string; topics: string[]; data: string };
const erc20 = (token: number, from: number, to: number, v: number): Log => ({ address: A(token), topics: [TRANSFER_TOPIC, T(from), T(to)], data: "0x" + W(v) });
const erc721 = (token: number, from: number, to: number, id: number): Log => ({ address: A(token), topics: [TRANSFER_TOPIC, T(from), T(to), T(id)], data: "0x" });
const single = (token: number, from: number, to: number, id: number, v: number): Log => ({ address: A(token), topics: [SINGLE_TOPIC, T(0xee), T(from), T(to)], data: "0x" + W(id) + W(v) });
const batch = (token: number, from: number, to: number, ids: number[], vs: number[]): Log => ({
  address: A(token), topics: [BATCH_TOPIC, T(0xee), T(from), T(to)], data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [ids.map(BigInt), vs.map(BigInt)]),
});

/** What reth answers for `balanceOf(holder)` of a token, and of `id` for an ERC-1155. */
function answer(chain: SyntheticChain, token: number, holder: number, value: number, id?: number): void {
  const input = id === undefined ? SELECTORS.balanceOf + W(holder) : SELECTORS.balanceOf1155 + W(holder) + W(id);
  chain.reads.callResults[`${A(token)}:${input}`] = "0x" + W(value);
}

/** Block 1 makes the four tokens; block 2 mints; block 3 moves; block 4 (indexed later by a test) moves the fee token again. */
async function setup(pool: Pool, upTo = 3) {
  await migrate(pool);
  const chain: SyntheticChain = makeChain([{ txs: 1 }, { txs: 1 }, { txs: 1 }, { txs: 1 }]);
  const t = chain.blocks[0]!.traces[0]!;
  t.frames = [{ ...t.frames[0]!, traceAddress: [], type: "call", callType: "call", created: null }, create([0], ERC20), create([1], ERC721), create([2], ERC1155), create([3], FEE)];
  t.calls = t.frames.length;
  const at = (n: number, ...logs: Log[]) => chain.blocks[n - 1]!.receipts[0]!.logs.push(...logs);
  at(2, erc20(ERC20, 0, ALICE, 1000), erc721(ERC721, 0, ALICE, 1), erc721(ERC721, 0, ALICE, 2), single(ERC1155, 0, ALICE, 7, 5), single(ERC1155, 0, ALICE, 8, 3), erc20(FEE, 0, ALICE, 1000));
  at(3, erc20(ERC20, ALICE, BOB, 250), erc721(ERC721, ALICE, BOB, 1), batch(ERC1155, ALICE, CAROL, [7, 8], [2, 3]), erc20(FEE, ALICE, BOB, 100));
  at(4, erc20(FEE, BOB, CAROL, 10));
  const call = (token: number, sel: string, out: string) => { chain.reads.callResults[`${A(token)}:${sel}`] = out; };
  for (const [tk, nm] of [[ERC20, "Coin"], [ERC721, "Art"], [FEE, "Fee Coin"]] as const) { call(tk, SELECTORS.name, str(nm)); call(tk, SELECTORS.symbol, str(nm.slice(0, 3))); call(tk, SELECTORS.totalSupply, "0x" + W(1000)); }
  call(ERC20, SELECTORS.decimals, "0x" + W(6)); call(FEE, SELECTORS.decimals, "0x" + W(6));
  chain.reads.rethHead = upTo;
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  return { chain, indexer };
}
/** The answers of a token that does what it says, for the state after block 3; the fee token is set by the tests. */
function honest(chain: SyntheticChain): void {
  answer(chain, ERC20, ALICE, 750); answer(chain, ERC20, BOB, 250);
  answer(chain, ERC721, ALICE, 1); answer(chain, ERC721, BOB, 1);
  answer(chain, ERC1155, ALICE, 3, 7); answer(chain, ERC1155, ALICE, 0, 8); answer(chain, ERC1155, CAROL, 2, 7); answer(chain, ERC1155, CAROL, 3, 8);
}
const rows = async (pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const hex = (b: Buffer) => b.toString("hex");
const balances = async (pool: Pool) =>
  (await rows(pool, "select encode(token, 'hex') as t, encode(holder, 'hex') as h, token_id::text as id, value::text as v, updated_block as u, checked_block as c from token_balances order by token, holder, token_id"))
    .map((r) => [r.t, r.h, r.id, r.v, r.u, r.c]);
const b = (token: number, holder: number, id: number, v: number, u: number, c: number | null) => [hex(hx(token)), hex(hx(holder)), String(id), String(v), String(u), c === null ? null : String(c)];

describe.skipIf(!TEST_URL)("balances, owners and the check, on the pinned PostgreSQL", () => {
  checkRequired();

  it("works balances and NFT owners out from the transfers, and counts the holders", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool);
      await indexer.runOnce();
      expect(await balances(pool)).toEqual([
        b(ERC20, ALICE, 0, 750, 3, null), b(ERC20, BOB, 0, 250, 3, null),
        b(ERC721, ALICE, 0, 1, 3, null), b(ERC721, BOB, 0, 1, 3, null),
        b(ERC1155, ALICE, 7, 3, 3, null), b(ERC1155, ALICE, 8, 0, 3, null), b(ERC1155, CAROL, 7, 2, 3, null), b(ERC1155, CAROL, 8, 3, 3, null),
        b(FEE, ALICE, 0, 900, 3, null), b(FEE, BOB, 0, 100, 3, null),
      ]);
      expect(await rows(pool, "select token_id::text as id, encode(owner, 'hex') as o, updated_block as u from nft_owners order by token_id")).toEqual([
        { id: "1", o: hex(hx(BOB)), u: "3" }, { id: "2", o: hex(hx(ALICE)), u: "2" },
      ]);
      const holders = await rows(pool, "select encode(address, 'hex') as a, holder_count from tokens order by address");
      expect(holders.map((r) => [r.a, r.holder_count])).toEqual([[hex(hx(ERC20)), "2"], [hex(hx(ERC721)), "2"], [hex(hx(ERC1155)), "2"], [hex(hx(FEE)), "2"]]); // the ERC-1155 counts ALICE and CAROL once each, not once for each id
      await indexer.close();
    });
  });

  it("checks the balances against balanceOf and sets checked_block when they agree", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool);
      honest(chain); answer(chain, FEE, ALICE, 900); answer(chain, FEE, BOB, 100);
      await indexer.runOnce();
      const r = await indexer.balancesOnce();
      expect(r).toMatchObject({ blocks: 3, checked: 10, switched: 0 });
      expect((await balances(pool)).every((x) => x[5] === x[4])).toBe(true);
      expect(await rows(pool, "select balance_mode from tokens where balance_mode <> 'derived'")).toEqual([]);
      // Nothing is left to read: a second turn reads no token balance.
      expect(await indexer.balancesOnce()).toMatchObject({ blocks: 0, checked: 0, switched: 0 });
      await indexer.close();
    });
  });

  it("reads the coin balances of the accounts of each block, behind the derive cursor", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool);
      honest(chain); answer(chain, FEE, ALICE, 900); answer(chain, FEE, BOB, 100);
      chain.reads.balance = async (a: string, n: number) => BigInt(n) * 1000n + BigInt(parseInt(a.slice(-2), 16));
      await indexer.runOnce();
      await indexer.balancesOnce();
      const hist = await rows(pool, "select block_number, count(*) as n from coin_balance_history group by block_number order by block_number");
      expect(hist.map((x) => x.block_number)).toEqual(["1", "2", "3"]);
      expect((await rows(pool, "select position from cursors where stream = 'balances'"))[0].position).toBe("3");
      const sample = (await rows(pool, "select address, value::text as v, block_number from coin_balance_history where block_number = 3 limit 1"))[0];
      expect(sample.v).toBe(String(3000n + BigInt(sample.address.at(-1))));
      const addr = (await rows(pool, "select coin_balance::text as v, coin_balance_block from addresses where address = $1", [sample.address]))[0];
      expect(addr).toEqual({ v: sample.v, coin_balance_block: "3" });
      await indexer.close();
    });
  });

  it("switches a token that takes a fee to read balances, and reads them from then on", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool);
      honest(chain); answer(chain, FEE, ALICE, 900); answer(chain, FEE, BOB, 98); // BOB got 100 less a fee of 2
      await indexer.runOnce();
      expect(await indexer.balancesOnce()).toMatchObject({ checked: 10, switched: 1 });
      expect(await rows(pool, "select encode(address, 'hex') as a, balance_mode from tokens where balance_mode = 'read'")).toEqual([{ a: hex(hx(FEE)), balance_mode: "read" }]);
      // ALICE's balance was checked before the token was switched: it is read again, as every holder of the token is.
      expect((await balances(pool)).filter((x) => x[0] === hex(hx(FEE)))).toEqual([b(FEE, ALICE, 0, 900, 3, null), b(FEE, BOB, 0, 98, 3, 3)]);
      expect(await indexer.balancesOnce()).toMatchObject({ checked: 1, switched: 0 });
      expect((await balances(pool)).filter((x) => x[0] === hex(hx(FEE)))).toEqual([b(FEE, ALICE, 0, 900, 3, 3), b(FEE, BOB, 0, 98, 3, 3)]);

      // Block 4 moves the fee token again: the rows it touches are marked, not added up; the check reads them.
      chain.reads.rethHead = 4;
      answer(chain, FEE, BOB, 88); answer(chain, FEE, CAROL, 9);
      await indexer.runOnce();
      expect((await balances(pool)).filter((x) => x[0] === hex(hx(FEE)))).toEqual([b(FEE, ALICE, 0, 900, 3, 3), b(FEE, BOB, 0, 98, 4, null), b(FEE, CAROL, 0, 0, 4, null)]);
      expect(await indexer.balancesOnce()).toMatchObject({ checked: 2, switched: 0 });
      expect((await balances(pool)).filter((x) => x[0] === hex(hx(FEE)))).toEqual([b(FEE, ALICE, 0, 900, 3, 3), b(FEE, BOB, 0, 88, 4, 4), b(FEE, CAROL, 0, 9, 4, 4)]);
      expect((await rows(pool, "select holder_count from tokens where address = $1", [hx(FEE)]))[0].holder_count).toBe("3");
      await indexer.close();
    });
  });
});

describe.skipIf(!TEST_URL)("the reindex rebuilds every aggregate, on the pinned PostgreSQL", () => {
  checkRequired();
  const AGGREGATES = ["tokens", "token_balances", "nft_owners", "addresses", "contracts"];
  const snap = async (pool: Pool, drop: string[] = []) => {
    const out: Record<string, string[]> = {};
    for (const t of AGGREGATES) out[t] = (await rows(pool, `select (to_jsonb(x) - $1::text[])::text as j from ${t} x order by j`, [drop])).map((r) => r.j as string);
    return out;
  };

  it("gives identical aggregates when a range is reindexed twice, and the ones stage 2 made block by block", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, 4);
      honest(chain); answer(chain, FEE, ALICE, 900); answer(chain, FEE, BOB, 88); answer(chain, FEE, CAROL, 9);
      await indexer.runOnce();
      await indexer.balancesOnce(); await indexer.balancesOnce();
      expect((await rows(pool, "select balance_mode from tokens where address = $1", [hx(FEE)]))[0].balance_mode).toBe("read");
      const before = await snap(pool, ["checked_block"]);
      const o = { pool, reads: chain.reads, gateway: GATEWAY };
      await reindexRange(o, 2, 4);
      const once = await snap(pool);
      await reindexRange(o, 2, 4);
      expect(await snap(pool)).toEqual(once);
      await reindexRange(o, 1, null);
      expect(await snap(pool)).toEqual(once);
      // What stage 2 made block by block is what the reindex works out from the facts (the check's marks aside).
      expect(await snap(pool, ["checked_block"])).toEqual(before);
      await indexer.close();
    });
  });

  it("clears checked_block, the coin balance history of the range and the check's cursor, and the check reads them again", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, 4);
      honest(chain); answer(chain, FEE, ALICE, 900); answer(chain, FEE, BOB, 88); answer(chain, FEE, CAROL, 9);
      await indexer.runOnce();
      await indexer.balancesOnce(); await indexer.balancesOnce();
      expect((await balances(pool)).every((x) => x[5] !== null)).toBe(true);
      const history = Number((await rows(pool, "select count(*) as n from coin_balance_history where block_number between 3 and 4"))[0].n);
      expect(history).toBeGreaterThan(0);
      await reindexRange({ pool, reads: chain.reads, gateway: GATEWAY }, 3, 4);
      const after = await balances(pool);
      // The rows the range touches are unchecked; the one it does not (block 2 only) keeps its mark.
      expect(after.filter((x) => x[5] === null).length).toBe(after.length - after.filter((x) => Number(x[4]) < 3).length);
      expect(Number((await rows(pool, "select count(*) as n from coin_balance_history where block_number between 3 and 4"))[0].n)).toBe(0);
      expect(Number((await rows(pool, "select count(*) as n from coin_balance_history where block_number < 3"))[0].n)).toBeGreaterThan(0);
      expect((await rows(pool, "select position from cursors where stream = 'balances'"))[0].position).toBe("2");
      await indexer.balancesOnce(); await indexer.balancesOnce();
      expect((await balances(pool)).every((x) => x[5] !== null)).toBe(true);
      expect(Number((await rows(pool, "select count(*) as n from coin_balance_history where block_number between 3 and 4"))[0].n)).toBe(history);
      await indexer.close();
    });
  });
});
