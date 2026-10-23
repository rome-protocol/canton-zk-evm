import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createIndexer } from "../indexer/indexer.ts";
import type { Reth } from "../reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createEtherscanRest } from "./etherscan-rest.ts";
import { MODULES, TEXTS, gwei } from "./etherscan.ts";

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const who = (n: number) => Buffer.alloc(20, n);
const h = (n: number) => "0x" + who(n).toString("hex");
const A = h(0xa1), B = h(0xa2), C = h(0xa3), T1 = h(0xb1), T2 = h(0xb2), T3 = h(0xb3);

/** An answer that Etherscan gives: the three fields and nothing else. */
const shape = (a: Answer) => {
  expect(a.status).toBe(200);
  expect(Object.keys(a.body as object)).toEqual(["status", "message", "result"]);
  return a.body as { status: string; message: string; result: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const NOTOK = (result: string) => ({ status: "0", message: "NOTOK", result });
const OK = (result: unknown) => ({ status: "1", message: "OK", result });
const GWEI = 1_000_000_000n;

describe("gwei", () => {
  it("writes wei as Etherscan writes a price, with the digits it needs", () => {
    expect(gwei(0n)).toBe("0");
    expect(gwei(30n * GWEI)).toBe("30");
    expect(gwei(1_500_000_000n)).toBe("1.5");
    expect(gwei(1n)).toBe("0.000000001");
    expect(gwei(1_234_567_891n)).toBe("1.234567891");
  });
});

describe.skipIf(!TEST_URL)("the Etherscan-compatible /api: the token, stats and gastracker modules", () => {
  checkRequired();
  let db: TestDatabase, pool: Pool;
  const supplies = new Map<string, bigint>();
  const supplyAsked: [string, number][] = [];
  const config = () => loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
  const reth = { tokenSupplyAt: async (t: string, n: number) => (supplyAsked.push([t, n]), supplies.get(t) ?? 0n) } as unknown as Reth;
  const api = () => createApi({ config: config(), reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), etherscanRest: createEtherscanRest(pool) });
  const get = async (target: string) => api()("GET", target);
  const sql = (text: string, values: unknown[] = []) => pool.query(text, values);

  beforeAll(async () => {
    db = await makeDatabase();
    pool = db.pool;
    await migrate(pool);
    const chain = makeChain([{ txs: 0 }, { txs: 5, leg: 2 }, { txs: 7 }]);
    const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }
    await sql("insert into bytecodes (code_hash, code, size) values ($1, $2, 2)", [Buffer.alloc(32, 1), Buffer.from("6080", "hex")]);
    await sql(
      `insert into contracts (address, origin, creator, creation_block, creation_tx_index, runtime_code_hash, name, interaction_count, last_interaction_block) values
        ($1, 'create', $4, 2, 0, $5, 'Test Token', 1, 3), ($2, 'create', $4, 2, 0, $5, 'Gadget', 1, 3), ($3, 'create', $4, 2, 0, $5, 'Punks', 1, 3)`,
      [who(0xb1), who(0xb2), who(0xb3), who(0xa1), Buffer.alloc(32, 1)],
    );
    await sql(
      `insert into tokens (address, standard, name, symbol, decimals, total_supply, total_supply_block, holder_count, transfer_count, first_transfer_block, metadata_status) values
        ($1, 'ERC-20', 'Test Token', 'TT', 6, 1000, 3, 2, 3, 2, 'read'), ($2, 'ERC-1155', 'Gadget', null, null, null, null, 3, 2, 3, 'read'), ($3, 'ERC-721', 'Punks', 'PNK', null, null, null, 1, 1, 3, 'read')`,
      [who(0xb1), who(0xb2), who(0xb3)],
    );
    // T1's holders: A 700, B 300 and C 700 (a tie with A, which is ordered by address), D has sold everything; T3's holder A has one NFT; T2's balances are by token id.
    await sql(
      `insert into token_balances (token, holder, token_id, value, updated_block) values
        ($1, $4, 0, 700, 3), ($1, $5, 0, 300, 3), ($1, $6, 0, 700, 3), ($1, $7, 0, 0, 3), ($3, $4, 0, 1, 3), ($2, $4, 1, 7, 3), ($2, $5, 2, 8, 3)`,
      [who(0xb1), who(0xb2), who(0xb3), who(0xa1), who(0xa2), who(0xa3), who(0xa4)],
    );
    // The coin: 1,000 coins were allocated at genesis, and every block burnt block number x 1 gwei (block 1, 2 and 3: 6 gwei in all).
    await sql("insert into meta (key, value) values ('genesis_supply', '1000000000000000000000') on conflict (key) do update set value = excluded.value");
    await sql("update blocks set burnt_fees = number * 1000000000");
    // The fees: the base fee of block n is 1 gwei + n x 0.1 gwei, a transaction pays 0.1 gwei times (its index + 1) over it, and block n used n x 10% of its gas.
    await sql("update blocks set base_fee_per_gas = 1000000000 + number * 100000000, gas_limit = 30000000, gas_used = number * 3000000");
    await sql("update transactions t set effective_gas_price = b.base_fee_per_gas + (t.tx_index + 1) * 100000000 from blocks b where b.number = t.block_number");
  });
  afterAll(async () => { await db?.drop(); });

  it("lists each module's actions in MODULES, which is what x-modules is built from", () => {
    expect(Object.keys(MODULES.token as object)).toEqual(["tokeninfo", "tokenholdercount", "tokenholderlist"]);
    expect(Object.keys(MODULES.stats as object)).toEqual(["ethsupply", "tokensupply", "ethprice"]);
    expect(Object.keys(MODULES.gastracker as object)).toEqual(["gasoracle", "gasestimate"]);
    // tokenbalance is one implementation, the account module's.
    expect(Object.keys(MODULES.account as object)).toContain("tokenbalance");
    expect(MODULES.token).not.toHaveProperty("tokenbalance");
  });

  describe("token", () => {
    it("answers tokeninfo as Etherscan's one-element list (recorded answer)", async () => {
      expect(shape(await get(`/api?module=token&action=tokeninfo&contractaddress=${T1.toUpperCase().replace("0X", "0x")}`))).toEqual(OK([{
        contractAddress: T1, tokenName: "Test Token", symbol: "TT", divisor: "6", tokenType: "ERC20", totalSupply: "1000", blueCheckmark: "false",
        description: "", website: "", email: "", blog: "", reddit: "", slack: "", facebook: "", twitter: "", bitcointalk: "", github: "", telegram: "", wechat: "", linkedin: "", discord: "", whitepaper: "",
        tokenPriceUSD: "",
      }]));
      const nft = shape(await get(`/api?module=token&action=tokeninfo&contractaddress=${T3}`)).result[0];
      expect(nft).toMatchObject({ contractAddress: T3, tokenName: "Punks", symbol: "PNK", divisor: "", tokenType: "ERC721", totalSupply: "" });
      expect(shape(await get(`/api?module=token&action=tokeninfo&contractaddress=${T2}`)).result[0]).toMatchObject({ tokenType: "ERC1155", symbol: "" });
    });

    it("answers an address that is no token with Etherscan's 'No data found', and a bad address with its refusal (recorded answers)", async () => {
      for (const action of ["tokeninfo", "tokenholdercount", "tokenholderlist"]) {
        expect(shape(await get(`/api?module=token&action=${action}&contractaddress=${C}`))).toEqual({ status: "0", message: "No data found", result: [] });
        expect(shape(await get(`/api?module=token&action=${action}&contractaddress=nope`))).toEqual(NOTOK("Error! Invalid contractaddress format"));
        expect(shape(await get(`/api?module=token&action=${action}`))).toEqual(NOTOK("Error! Invalid contractaddress format"));
      }
    });

    it("answers tokenholdercount as a decimal string (recorded answer)", async () => {
      expect(shape(await get(`/api?module=token&action=tokenholdercount&contractaddress=${T1}`))).toEqual(OK("2"));
      expect(shape(await get(`/api?module=token&action=tokenholdercount&contractaddress=${T3}`))).toEqual(OK("1"));
    });

    it("lists the holders of a token with a balance, the largest first and ties by address, a page at a time (recorded answers)", async () => {
      const url = (extra = "") => `/api?module=token&action=tokenholderlist&contractaddress=${T1}${extra}`;
      expect(shape(await get(url()))).toEqual(OK([
        { TokenHolderAddress: A, TokenHolderQuantity: "700" }, { TokenHolderAddress: C, TokenHolderQuantity: "700" }, { TokenHolderAddress: B, TokenHolderQuantity: "300" },
      ]));
      expect(shape(await get(url("&page=2&offset=2"))).result).toEqual([{ TokenHolderAddress: B, TokenHolderQuantity: "300" }]);
      expect(shape(await get(url("&page=1&offset=1"))).result).toEqual([{ TokenHolderAddress: A, TokenHolderQuantity: "700" }]);
      expect(shape(await get(url("&page=1&offset=10001"))).message).toBe(TEXTS.window);
      expect(shape(await get(`/api?module=token&action=tokenholderlist&contractaddress=${T3}`))).toEqual(OK([{ TokenHolderAddress: A, TokenHolderQuantity: "1" }]));
      // An ERC-1155 balance is by token id, so it has no list of quantities.
      expect(shape(await get(`/api?module=token&action=tokenholderlist&contractaddress=${T2}`))).toEqual(NOTOK("not supported on Ostia"));
    });

    it("serves tokenbalance from the account module, read from reth, and not as a token action", async () => {
      expect(shape(await get(`/api?module=token&action=tokenbalance&contractaddress=${T1}&address=${A}`))).toEqual(NOTOK("Error! Missing Or invalid Action name"));
      expect(shape(await get(`/api?module=token&action=toptokenholders&contractaddress=${T1}`))).toEqual(NOTOK("not supported on Ostia"));
    });
  });

  describe("stats", () => {
    it("answers ethsupply as the genesis allocation minus the burnt fees, in wei (recorded answer)", async () => {
      expect(shape(await get("/api?module=stats&action=ethsupply"))).toEqual(OK("999999999994000000000"));
      // Only the fees burnt in final blocks count, so the answer follows the blocks.
      await sql("update blocks set burnt_fees = burnt_fees + 1000000000 where number = 3");
      expect(shape(await get("/api?module=stats&action=ethsupply")).result).toBe("999999999993000000000");
      await sql("update blocks set burnt_fees = number * 1000000000");
    });

    it("keeps each block's running total of burnt fees, so that ethsupply reads one row (migration 0029)", async () => {
      const totals = async () => (await sql("select number::int, burnt_total::text as t from blocks order by number")).rows.map((r) => [r.number, r.t]);
      expect(await totals()).toEqual([[1, "1000000000"], [2, "3000000000"], [3, "6000000000"]]);
      // A reindex that changes block 1 moves the totals after it, and a removed block takes its fees out of the later totals.
      await sql("update blocks set burnt_fees = 5000000000 where number = 1");
      expect(await totals()).toEqual([[1, "5000000000"], [2, "7000000000"], [3, "10000000000"]]);
      await sql("update blocks set burnt_fees = 1000000000 where number = 1");
      // A block written above the others adds to the last total.
      const add = (n: number, fees: number) => sql("insert into blocks select $2::bigint, $1::bytea, parent_hash, timestamp, fee_recipient, gas_limit, gas_used, base_fee_per_gas, $3::numeric, priority_fees, tx_count, log_count, size_bytes, state_root, transactions_root, receipts_root, extra_data, legs_count, legs_hash, update_id, record_time, attempt_id, indexed_at, 0 from blocks where number = 3", [Buffer.alloc(32, n), n, fees]);
      await add(4, 7000000000);
      try {
        expect((await totals()).at(-1)).toEqual([4, "13000000000"]);
      } finally { await sql("delete from blocks where number = 4"); }
      expect(await totals()).toEqual([[1, "1000000000"], [2, "3000000000"], [3, "6000000000"]]);
    });

    it("keeps the totals right for a block written out of order, and equal to a full recompute", async () => {
      const add = (n: number, fees: number) => sql("insert into blocks select $2::bigint, $1::bytea, parent_hash, timestamp, fee_recipient, gas_limit, gas_used, base_fee_per_gas, $3::numeric, priority_fees, tx_count, log_count, size_bytes, state_root, transactions_root, receipts_root, extra_data, legs_count, legs_hash, update_id, record_time, attempt_id, indexed_at, 0 from blocks where number = 3", [Buffer.alloc(32, n), n, fees]);
      const wrong = async () => (await sql("select count(*)::int as n from blocks b join (select number, sum(burnt_fees) over (order by number) as t from blocks) s using (number) where b.burnt_total <> s.t")).rows[0].n;
      const totals = async () => (await sql("select number::int, burnt_total::text as t from blocks where number > 3 order by number")).rows.map((r) => [r.number, r.t]);
      // Blocks 4, 5 and 7 first, then 6 below the last: the totals of 7 moves, and every total is the sum of the fees up to it.
      for (const [n, f] of [[4, 1], [5, 2], [7, 4], [6, 3]]) await add(n, f * 1000000000);
      try {
        expect(await totals()).toEqual([[4, "7000000000"], [5, "9000000000"], [6, "12000000000"], [7, "16000000000"]]);
        expect(await wrong()).toBe(0);
        await sql("update blocks set burnt_fees = 10000000000 where number = 5");
        expect(await totals()).toEqual([[4, "7000000000"], [5, "17000000000"], [6, "20000000000"], [7, "24000000000"]]);
        expect(await wrong()).toBe(0);
        await sql("delete from blocks where number = 6");
        expect(await totals()).toEqual([[4, "7000000000"], [5, "17000000000"], [7, "21000000000"]]);
        expect(await wrong()).toBe(0);
      } finally { await sql("delete from blocks where number > 3"); }
      expect(await wrong()).toBe(0);
    });

    it("leaves the later blocks alone when a reindexed block keeps its fees (no row rewritten), and moves them when the fees change", async () => {
      const xmins = async () => (await sql("select number::int, xmin::text as x from blocks where number > 1 order by number")).rows.map((r) => [r.number, r.x]);
      const before = await xmins();
      await sql("update blocks set burnt_fees = burnt_fees, hash = hash where number = 1");
      await sql("update blocks set burnt_fees = burnt_fees where number = 1");
      expect(await xmins()).toEqual(before);
      expect((await sql("select burnt_total::text as t from blocks where number = 3")).rows[0].t).toBe("6000000000");
      await sql("update blocks set burnt_fees = burnt_fees + 1 where number = 1");
      try {
        expect(await xmins()).not.toEqual(before);
        expect((await sql("select burnt_total::text as t from blocks where number = 3")).rows[0].t).toBe("6000000001");
      } finally { await sql("update blocks set burnt_fees = 1000000000 where number = 1"); }
      expect((await sql("select burnt_total::text as t from blocks where number = 3")).rows[0].t).toBe("6000000000");
    });

    it("refuses a statement that writes several blocks, which would count the fees of its earlier rows twice (migration 0029)", async () => {
      await expect(sql("insert into blocks select n, $1::bytea || int4send(n), parent_hash, timestamp, fee_recipient, gas_limit, gas_used, base_fee_per_gas, burnt_fees, priority_fees, tx_count, log_count, size_bytes, state_root, transactions_root, receipts_root, extra_data, legs_count, legs_hash, update_id, record_time, attempt_id, indexed_at, 0 from blocks, generate_series(10, 11) n where number = 3", [Buffer.alloc(28, 9)])).rejects.toThrow(/insert one block at a time/);
      expect((await sql("select count(*)::int as n from blocks")).rows[0].n).toBe(3);
    });

    it("refuses ethsupply while the database does not hold the genesis allocation", async () => {
      await sql("delete from meta where key = 'genesis_supply'");
      try {
        expect(shape(await get("/api?module=stats&action=ethsupply"))).toEqual(NOTOK(TEXTS.noGenesis));
      } finally {
        await sql("insert into meta (key, value) values ('genesis_supply', '1000000000000000000000')");
      }
    });

    it("answers tokensupply from reth at the final head (recorded answer), and 0 for an address that is no token", async () => {
      supplies.set(T1, 123456789n);
      supplyAsked.length = 0;
      expect(shape(await get(`/api?module=stats&action=tokensupply&contractaddress=${T1}`))).toEqual(OK("123456789"));
      expect(supplyAsked).toEqual([[T1, 3]]);
      expect(shape(await get(`/api?module=stats&action=tokensupply&contractaddress=${C}`))).toEqual(OK("0"));
      expect(shape(await get("/api?module=stats&action=tokensupply"))).toEqual(NOTOK("Error! Invalid contractaddress format"));
    });

    it("says a test coin has no price, and does not serve the paid statistics (recorded answers)", async () => {
      expect(shape(await get("/api?module=stats&action=ethprice"))).toEqual(NOTOK("Error! A test coin has no price, so Ostia gives none"));
      for (const action of ["dailytx", "dailyavgblocksize", "chainsize", "ethsupply2", "tokenCsupply", "nodecount"]) {
        expect(shape(await get(`/api?module=stats&action=${action}&startdate=2026-01-01&enddate=2026-01-02&sort=asc`))).toEqual(NOTOK("not supported on Ostia"));
      }
      expect(shape(await get("/api?module=stats&action=nope"))).toEqual(NOTOK("Error! Missing Or invalid Action name"));
    });
  });

  describe("gastracker", () => {
    it("answers gasoracle in gwei from the base fee and the recent priority fees (recorded answer)", async () => {
      // Block 3's base fee is 1.3 gwei. The 12 tips of blocks 2 and 3 are 0.1 to 0.5 and 0.1 to 0.7: the 25th percentile is 0.2, the median 0.3, the 75th 0.5.
      expect(shape(await get("/api?module=gastracker&action=gasoracle"))).toEqual(OK({
        LastBlock: "3", SafeGasPrice: "1.5", ProposeGasPrice: "1.6", FastGasPrice: "1.8", suggestBaseFee: "1.3", gasUsedRatio: "0.1,0.2,0.3",
      }));
    });

    it("answers gasoracle with the base fee alone when no transaction paid a tip in the last blocks", async () => {
      const lone = await makeDatabase(true);
      try {
        const chain = makeChain([{ txs: 0 }, { txs: 0 }]);
        const indexer = createIndexer({ pool: lone.pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
        await indexer.open();
        try { await indexer.runOnce(); } finally { await indexer.close(); }
        await lone.pool.query("update blocks set base_fee_per_gas = 7000000000");
        const a = await createApi({ config: config(), reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(lone.pool), etherscanRest: createEtherscanRest(lone.pool) })("GET", "/api?module=gastracker&action=gasoracle");
        const r = shape(a);
        expect(r.status).toBe("1");
        expect(r.result).toMatchObject({ SafeGasPrice: "7", ProposeGasPrice: "7", FastGasPrice: "7", suggestBaseFee: "7" });
      } finally { await lone.drop(); }
    });

    it("answers gasestimate with the median seconds to final, rounded up, whatever gasprice is given (recorded answer)", async () => {
      // No transaction has both its acceptance and its final block yet.
      expect(shape(await get("/api?module=gastracker&action=gasestimate&gasprice=2000000000"))).toEqual(NOTOK(TEXTS.noFinalTx));
      // Twelve final transactions that took 0.4, 0.8 ... 4.8 seconds: the median is the sixth, 2.4, which is 3 whole seconds.
      for (let i = 1; i <= 12; i++) {
        await sql(
          `insert into tx_lifecycle (tx_hash, accepted_at, final_block, final_at, state, updated_at)
           values ($1, '2026-10-01T00:00:00Z'::timestamptz + interval '1 hour' * $2 - interval '1 millisecond' * 400 * $2, 3, '2026-10-01T00:00:00Z'::timestamptz + interval '1 hour' * $2, 'final', now())`,
          [Buffer.alloc(32, 0x40 + i), i],
        );
      }
      expect(shape(await get("/api?module=gastracker&action=gasestimate&gasprice=2000000000"))).toEqual(OK("3"));
      expect(shape(await get("/api?module=gastracker&action=gasestimate")).result).toBe("3");
      expect(shape(await get("/api?module=gastracker&action=gasestimate&gasprice=cheap"))).toEqual(NOTOK("Error! Invalid gasprice"));
      expect(shape(await get("/api?module=gastracker&action=dailyavggasprice&startdate=2026-01-01&enddate=2026-01-02&sort=asc"))).toEqual(NOTOK("not supported on Ostia"));
    });
  });
});
