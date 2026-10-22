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
import { MAX_BALANCES, TEXTS } from "./etherscan.ts";

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const who = (n: number) => Buffer.alloc(20, n);
const h = (n: number) => "0x" + who(n).toString("hex");
// The addresses of the fixture: three accounts, a contract made by a transaction, and an ERC-20, an ERC-1155 and an ERC-721 token.
const A = h(0xa1), B = h(0xa2), C = h(0xa3), T1 = h(0xb1), T2 = h(0xb2), T3 = h(0xb3);

/** An answer that Etherscan gives: the three fields and nothing else. */
const shape = (a: Answer) => {
  expect(a.status).toBe(200);
  expect(Object.keys(a.body as object)).toEqual(["status", "message", "result"]);
  return a.body as { status: string; message: string; result: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const NO_ROWS = { status: "0", message: "No transactions found", result: [] };
const NOTOK = (result: string) => ({ status: "0", message: "NOTOK", result });

describe.skipIf(!TEST_URL)("the Etherscan-compatible /api: the account module", () => {
  checkRequired();
  let db: TestDatabase, pool: Pool;
  const asked: [string, number][] = [];
  const balances = new Map<string, bigint>();
  const tokens = new Map<string, bigint>();
  const tokenAsked: [string, string, number][] = [];
  const config = () => loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
  const reth = {
    balanceAt: async (a: string, n: number) => (asked.push([a, n]), balances.get(a) ?? 0n),
    tokenBalanceAt: async (t: string, a: string, n: number) => (tokenAsked.push([t, a, n]), tokens.get(`${t}:${a}`) ?? 0n),
  } as unknown as Reth;
  const api = () => createApi({ config: config(), reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), etherscanRest: createEtherscanRest(pool) });
  const get = async (target: string) => api()("GET", target);
  const post = async (target: string, form: string) => api()("POST", target, form);
  const sql = (text: string, values: unknown[] = []) => pool.query(text, values);
  const setCursor = (n: number) => sql("update cursors set position = $1 where stream = 'derive'", [n]);
  const blockHash = async (n: number) => "0x" + ((await sql("select hash from blocks where number = $1", [n])).rows[0].hash as Buffer).toString("hex");
  const txHash = async (b: number, i: number) => "0x" + ((await sql("select hash from transactions where block_number = $1 and tx_index = $2", [b, i])).rows[0].hash as Buffer).toString("hex");
  const stamp = async (n: number) => String((await sql("select extract(epoch from timestamp)::bigint as t from blocks where number = $1", [n])).rows[0].t);

  beforeAll(async () => {
    db = await makeDatabase();
    pool = db.pool;
    await migrate(pool);
    const chain = makeChain([{ txs: 0 }, { txs: 5, leg: 2 }, { txs: 7 }]);
    const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }
    // The rows these answers read, as stages 1 and 2 write them, for addresses of the fixture's own. The database's copy of A's balance is not reth's.
    await sql("insert into addresses (address, first_seen_block, last_active_block, coin_balance, coin_balance_block) values ($1, 1, 3, 999, 3)", [who(0xa1)]);
    await sql("insert into bytecodes (code_hash, code, size) values ($1, $2, 2)", [Buffer.alloc(32, 1), Buffer.from("6080", "hex")]);
    await sql(
      `insert into contracts (address, origin, creator, creation_block, creation_tx_index, runtime_code_hash, name, interaction_count, last_interaction_block) values
        ($1, 'create', $4, 2, 0, $5, null, 1, 3), ($2, 'create', $4, 2, 0, $5, 'Test Token', 1, 3), ($3, 'create', $4, 2, 0, $5, 'Gadget', 1, 3), ($6, 'create', $4, 2, 0, $5, 'Punks', 1, 3)`,
      [who(0xa3), who(0xb1), who(0xb2), who(0xa1), Buffer.alloc(32, 1), who(0xb3)],
    );
    await sql(
      `insert into tokens (address, standard, name, symbol, decimals, total_supply, total_supply_block, holder_count, transfer_count, first_transfer_block, metadata_status) values
        ($1, 'ERC-20', 'Test Token', 'TT', 6, 1000, 3, 2, 3, 2, 'read'), ($2, 'ERC-1155', 'Gadget', null, null, null, null, 3, 2, 3, 'read'), ($3, 'ERC-721', 'Punks', 'PNK', null, null, null, 1, 1, 3, 'read')`,
      [who(0xb1), who(0xb2), who(0xb3)],
    );
    await sql(
      `insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) values
        (2, 500, 0, 0, $1, $4, $5, 10, null), (2, 501, 0, 0, $1, $5, $4, 20, null), (3, 500, 0, 0, $1, $4, $4, 5, null),
        (3, 501, 0, 1, $2, $6, $4, 7, 1), (3, 501, 1, 1, $2, $6, $4, 8, 2), (3, 502, 0, 2, $3, $5, $4, null, 77)`,
      [who(0xb1), who(0xb2), who(0xb3), who(0xa1), who(0xa2), who(0xa3)],
    );
    await sql(
      `insert into internal_calls (block_number, tx_index, trace_address, call_type, from_address, to_address, value, gas, gas_used, error) values
        (2, 2, '{0}', 'call', $1, $2, 1, 100, 60, null), (2, 2, '{0,1}', 'create', $2, $3, 0, 90, 50, null), (2, 3, '{0}', 'call', $1, $1, 3, null, null, null),
        (3, 0, '{0,1}', 'call', $3, $1, 4, 20, 20, 'out of gas')`,
      [who(0xa1), who(0xa2), who(0xa3)],
    );
    // Transactions: A sent two in block 2, received one in block 3 and sent one to itself; one in block 3 made C (it has no `to`); the fees of blocks 2 and 3 are A's.
    await sql("update transactions set from_address = $1 where block_number = 2 and tx_index in (0, 1)", [who(0xa1)]);
    await sql("update transactions set to_address = $1 where block_number = 3 and tx_index = 0", [who(0xa1)]);
    await sql("update transactions set from_address = $1, to_address = $1 where block_number = 3 and tx_index = 2", [who(0xa1)]);
    await sql("update transactions set to_address = null, created_contract = $1 where block_number = 3 and tx_index = 1", [who(0xa3)]);
    await sql("update blocks set fee_recipient = $1, priority_fees = number * 1000 where number in (2, 3)", [who(0xa1)]);
    await setCursor(3);
  });
  afterAll(async () => { await db?.drop(); });

  describe("the door", () => {
    it("answers at /api and at /v2/api, with chainid given or not, and ignores apikey", async () => {
      balances.set(A, 12345n);
      const want = { status: "1", message: "OK", result: "12345" };
      for (const target of [`/api?module=account&action=balance&address=${A}`, `/v2/api?chainid=${CHAIN_ID}&module=account&action=balance&address=${A}`, `/api?chainid=${CHAIN_ID}&module=account&action=balance&address=${A}&apikey=any`]) {
        expect(shape(await get(target))).toEqual(want);
      }
    });

    it("refuses a chainid that is not this chain's, and a module, action or request it does not know, in Etherscan's words", async () => {
      expect(shape(await get(`/v2/api?chainid=1&module=account&action=balance&address=${A}`))).toEqual(NOTOK(TEXTS.chainid));
      expect(TEXTS.chainid).toMatch(/^Missing or unsupported chainid parameter/);
      expect(shape(await get("/api?module=nope&action=balance"))).toEqual(NOTOK("Error! Missing Or invalid Module name"));
      expect(shape(await get("/api?action=balance"))).toEqual(NOTOK("Error! Missing Or invalid Module name"));
      expect(shape(await get("/api?module=account&action=nope"))).toEqual(NOTOK("Error! Missing Or invalid Action name"));
      expect(shape(await get("/api?module=account"))).toEqual(NOTOK("Error! Missing Or invalid Action name"));
      expect(shape(await get("/api"))).toEqual(NOTOK("Error! Missing Or invalid Module name"));
      // Etherscan's paid or other-chain actions are not served, and say so.
      for (const action of ["balancehistory", "addresstokenbalance", "fundedby"]) expect(shape(await get(`/api?module=account&action=${action}&address=${A}`))).toEqual(NOTOK("not supported on Ostia"));
    });

    it("takes the request as a query or as a form, on GET and on POST, and nothing else", async () => {
      balances.set(B, 777n);
      const want = { status: "1", message: "OK", result: "777" };
      expect(shape(await post("/api", `module=account&action=balance&address=${B}&apikey=x`))).toEqual(want);
      expect(shape(await post(`/v2/api?chainid=${CHAIN_ID}`, `module=account&action=balance&address=${B}`))).toEqual(want);
      // The action's name is read in any case, as Etherscan's tools spell them.
      expect(shape(await get(`/api?module=Account&action=BALANCE&address=${B}`))).toEqual(want);
      const put = await api()("PUT", "/api?module=account&action=balance");
      expect(put.status).toBe(405);
    });

    it("is off, with its own answer, when the explorer has no database", async () => {
      const off = await createApi({ config: config(), reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool) })("GET", "/v2/api?module=account&action=balance");
      expect(off.status).toBe(404);
    });
  });

  describe("balance and balancemulti: reth at the newest final block, never the database's copy", () => {
    it("reads each balance from reth at the final head", async () => {
      balances.set(A, 12345n);
      balances.set(C, 3n);
      asked.length = 0;
      expect(shape(await get(`/api?module=account&action=balance&address=${A.toUpperCase().replace("0X", "0x")}&tag=latest`))).toEqual({ status: "1", message: "OK", result: "12345" });
      expect(asked).toEqual([[A, 3]]);
      asked.length = 0;
      // Recorded answer of balancemulti: accounts in the order asked, lowercase, balances as strings.
      expect(shape(await get(`/api?module=account&action=balancemulti&address=${A},${C}&tag=latest`))).toEqual({
        status: "1", message: "OK", result: [{ account: A, balance: "12345" }, { account: C, balance: "3" }],
      });
      expect(asked.sort()).toEqual([[A, 3], [C, 3]].sort());
      // The database's copy of A's balance is 999 and is not what is answered.
      expect((await sql("select coin_balance::text as b from addresses where address = $1", [who(0xa1)])).rows[0].b).toBe("999");
    });

    it("answers `finalized` and `safe` as `latest`, and refuses any other tag", async () => {
      for (const tag of ["finalized", "safe"]) expect(shape(await get(`/api?module=account&action=balance&address=${A}&tag=${tag}`)).result).toBe("12345");
      expect(shape(await get(`/api?module=account&action=balance&address=${A}&tag=pending`))).toEqual(NOTOK(TEXTS.tag));
    });

    it("tokenbalance reads the holder's balance of the token from reth at the final head (recorded answer)", async () => {
      tokens.set(`${T1}:${A}`, 1000000000000000000000n);
      tokenAsked.length = 0;
      expect(shape(await get(`/api?module=account&action=tokenbalance&contractaddress=${T1}&address=${A}&tag=latest`))).toEqual({ status: "1", message: "OK", result: "1000000000000000000000" });
      expect(tokenAsked).toEqual([[T1, A, 3]]);
      expect(shape(await get(`/api?module=account&action=tokenbalance&contractaddress=${T1}&address=${B}`))).toEqual({ status: "1", message: "OK", result: "0" });
      expect(shape(await get(`/api?module=account&action=tokenbalance&address=${A}`))).toEqual(NOTOK(TEXTS.tokenWho));
      expect(shape(await get(`/api?module=account&action=tokenbalance&contractaddress=nope&address=${A}`))).toEqual(NOTOK(TEXTS.address));
      expect(shape(await get(`/api?module=account&action=tokenbalance&contractaddress=${T1}&address=nope`))).toEqual(NOTOK(TEXTS.address));
      expect(shape(await get(`/api?module=account&action=tokenbalance&contractaddress=${T1}&address=${A}&tag=pending`))).toEqual(NOTOK(TEXTS.tag));
    });

    it("refuses a bad address, more than 20 addresses, and a chain with no final block", async () => {
      expect(shape(await get("/api?module=account&action=balance&address=0x12"))).toEqual(NOTOK("Error! Invalid address format"));
      expect(shape(await get("/api?module=account&action=balance"))).toEqual(NOTOK("Error! Invalid address format"));
      expect(shape(await get(`/api?module=account&action=balancemulti&address=${A},0x12`))).toEqual(NOTOK("Error! Invalid address format"));
      const many = Array.from({ length: MAX_BALANCES + 1 }, () => A).join(",");
      expect(shape(await get(`/api?module=account&action=balancemulti&address=${many}`))).toEqual(NOTOK(TEXTS.tooManyAddresses));
      expect(shape(await get(`/api?module=account&action=balancemulti&address=${many.split(",").slice(1).join(",")}`)).result).toHaveLength(MAX_BALANCES);
      const empty = await makeDatabase(true);
      try {
        const none = createApi({ config: config(), reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(empty.pool), etherscanRest: createEtherscanRest(empty.pool) });
        expect(shape(await none("GET", `/api?module=account&action=balance&address=${A}`))).toEqual(NOTOK(TEXTS.noFinal));
        expect(shape(await none("GET", `/api?module=account&action=txlist&address=${A}`))).toEqual(NO_ROWS);
      } finally { await empty.drop(); }
    });
  });

  describe("txlist", () => {
    it("lists an address's transactions in Etherscan's shape (recorded answer)", async () => {
      const a = shape(await get(`/api?module=account&action=txlist&address=${A}&startblock=0&endblock=99999999&page=1&offset=2&sort=asc`));
      expect(a.status).toBe("1");
      expect(a.message).toBe("OK");
      expect(a.result).toHaveLength(2);
      const row = (await sql("select gas_limit::text as g, cumulative_gas_used::text as c, gas_used::text as u, effective_gas_price::text as p, nonce::text as n, value::text as v, input, method_id, status, from_address, to_address from transactions where block_number = 2 and tx_index = 0")).rows[0];
      const hex = (b: Buffer | null) => (b === null ? "" : "0x" + b.toString("hex"));
      expect(a.result[0]).toEqual({
        blockNumber: "2", timeStamp: await stamp(2), hash: await txHash(2, 0), nonce: row.n, blockHash: await blockHash(2), transactionIndex: "0", from: A, to: hex(row.to_address), value: row.v,
        gas: row.g, gasPrice: row.p, isError: row.status === 1 ? "0" : "1", txreceipt_status: String(row.status), input: hex(row.input), contractAddress: "", cumulativeGasUsed: row.c, gasUsed: row.u,
        confirmations: "2", methodId: row.method_id === null ? "0x" : hex(row.method_id), functionName: "",
      });
      expect(Object.keys(a.result[0])).toEqual([
        "blockNumber", "timeStamp", "hash", "nonce", "blockHash", "transactionIndex", "from", "to", "value", "gas", "gasPrice", "isError", "txreceipt_status", "input", "contractAddress",
        "cumulativeGasUsed", "gasUsed", "confirmations", "methodId", "functionName",
      ]);
    });

    it("lists what A sent, received and sent to itself, once each, oldest first or newest first", async () => {
      const asc = shape(await get(`/api?module=account&action=txlist&address=${A}`)).result;
      expect(asc.map((t: any) => `${t.blockNumber}:${t.transactionIndex}`)).toEqual(["2:0", "2:1", "3:0", "3:2"]); // eslint-disable-line @typescript-eslint/no-explicit-any
      const desc = shape(await get(`/api?module=account&action=txlist&address=${A}&sort=desc`)).result;
      expect(desc.map((t: any) => `${t.blockNumber}:${t.transactionIndex}`)).toEqual(["3:2", "3:0", "2:1", "2:0"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    it("returns the transaction that created a contract when the address is that contract", async () => {
      const r = shape(await get(`/api?module=account&action=txlist&address=${C}`)).result;
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ blockNumber: "3", transactionIndex: "1", hash: await txHash(3, 1), to: "", contractAddress: C });
      // The one that made it sees it too, with the contract it made.
      const maker = (await sql("select from_address from transactions where block_number = 3 and tx_index = 1")).rows[0].from_address as Buffer;
      const m = shape(await get(`/api?module=account&action=txlist&address=0x${maker.toString("hex")}`)).result;
      expect(m.find((t: any) => t.transactionIndex === "1" && t.blockNumber === "3")).toMatchObject({ contractAddress: C }); // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    it("pages as Etherscan does: page and offset, startblock and endblock, and the window of 10,000", async () => {
      const key = (r: any[]) => r.map((t) => `${t.blockNumber}:${t.transactionIndex}`); // eslint-disable-line @typescript-eslint/no-explicit-any
      const q = (extra: string) => get(`/api?module=account&action=txlist&address=${A}&${extra}`);
      expect(key(shape(await q("page=1&offset=3")).result)).toEqual(["2:0", "2:1", "3:0"]);
      expect(key(shape(await q("page=2&offset=3")).result)).toEqual(["3:2"]);
      expect(key(shape(await q("page=2&offset=2&sort=desc")).result)).toEqual(["2:1", "2:0"]);
      expect(key(shape(await q("startblock=3&endblock=3")).result)).toEqual(["3:0", "3:2"]);
      expect(key(shape(await q("startblock=3&endblock=latest")).result)).toEqual(["3:0", "3:2"]);
      expect(key(shape(await q("startblock=2&endblock=2&sort=desc")).result)).toEqual(["2:1", "2:0"]);
      // A block beyond the newest final one is the newest final one: nothing is served that is not final.
      expect(key(shape(await q("endblock=99999999")).result)).toHaveLength(4);
      expect(shape(await q("page=3&offset=3"))).toEqual(NO_ROWS);
      expect(shape(await q("startblock=9&endblock=3"))).toEqual(NO_ROWS);
      expect(shape(await get(`/api?module=account&action=txlist&address=${h(0xee)}`))).toEqual(NO_ROWS);
      // The window: page x offset up to 10,000 is served, one more is Etherscan's refusal, which words it in the message.
      expect(shape(await q("page=1&offset=10000")).status).toBe("1");
      expect(shape(await q("page=2&offset=5000"))).toEqual(NO_ROWS); // inside the window, past the fixture's few rows
      const window = { status: "0", message: "Result window is too large, PageNo x Offset size must be less than or equal to 10000", result: null };
      expect(shape(await q("page=2&offset=5001"))).toEqual(window);
      expect(shape(await q("page=10001&offset=1"))).toEqual(window);
      expect(shape(await q("offset=10001"))).toEqual(window);
      expect(shape(await q("page=2"))).toEqual(window); // no offset: the 10,000 rows of one page
    });

    it("refuses what it cannot read: a page, an offset, a sort or a block that is not a number", async () => {
      const q = (extra: string) => get(`/api?module=account&action=txlist&address=${A}&${extra}`);
      for (const bad of ["page=0", "page=-1", "page=x", "offset=0", "offset=1.5"]) expect(shape(await q(bad))).toEqual(NOTOK(TEXTS.paging));
      expect(shape(await q("sort=up"))).toEqual(NOTOK(TEXTS.sort));
      for (const bad of ["startblock=x", "endblock=-1", "endblock=0x10"]) expect(shape(await q(bad))).toEqual(NOTOK(TEXTS.blocks));
    });
  });

  describe("txlistinternal", () => {
    it("lists an address's internal calls in Etherscan's shape (recorded answer)", async () => {
      const r = shape(await get(`/api?module=account&action=txlistinternal&address=${B}`)).result;
      // B is the callee of A's call and the caller of the creation that made C.
      expect(r).toEqual([
        {
          blockNumber: "2", timeStamp: await stamp(2), hash: await txHash(2, 2), from: A, to: B, value: "1", contractAddress: "", input: "", type: "call", gas: "100", gasUsed: "60", traceId: "0", isError: "0", errCode: "",
        },
        {
          blockNumber: "2", timeStamp: await stamp(2), hash: await txHash(2, 2), from: B, to: "", value: "0", contractAddress: C, input: "", type: "create", gas: "90", gasUsed: "50", traceId: "0_1", isError: "0", errCode: "",
        },
      ]);
    });

    it("lists a transaction's internal calls by its hash, and a range of blocks without an address", async () => {
      const byTx = shape(await get(`/api?module=account&action=txlistinternal&txhash=${await txHash(2, 2)}`)).result;
      expect(byTx.map((c: any) => c.traceId)).toEqual(["0", "0_1"]); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(shape(await get(`/api?module=account&action=txlistinternal&txhash=${await txHash(2, 2)}&sort=desc`)).result.map((c: any) => c.traceId)).toEqual(["0_1", "0"]); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(shape(await get(`/api?module=account&action=txlistinternal&txhash=0x${"cd".repeat(32)}`))).toEqual(NO_ROWS);
      const range = shape(await get("/api?module=account&action=txlistinternal&startblock=3&endblock=3")).result;
      expect(range).toHaveLength(1);
      expect(range[0]).toMatchObject({ blockNumber: "3", from: C, to: A, value: "4", isError: "1", errCode: "out of gas" });
      expect(shape(await get("/api?module=account&action=txlistinternal&startblock=1&endblock=99999999&page=2&offset=2")).result).toHaveLength(2);
    });

    it("refuses a bad hash, and a request that names no address, hash or block range", async () => {
      expect(shape(await get("/api?module=account&action=txlistinternal&txhash=0x12"))).toEqual(NOTOK(TEXTS.txhash));
      expect(shape(await get("/api?module=account&action=txlistinternal"))).toEqual(NOTOK(TEXTS.txlistinternal));
      expect(shape(await get("/api?module=account&action=txlistinternal&startblock=1"))).toEqual(NOTOK(TEXTS.txlistinternal));
    });
  });

  describe("tokentx, tokennfttx and token1155tx", () => {
    it("lists ERC-20 transfers in Etherscan's shape (recorded answer), by address and by token", async () => {
      const r = shape(await get(`/api?module=account&action=tokentx&address=${B}`)).result;
      expect(r).toHaveLength(2);
      const nonce = (await sql("select nonce::text as n, gas_limit::text as g, effective_gas_price::text as p, gas_used::text as u, cumulative_gas_used::text as c from transactions where block_number = 2 and tx_index = 0")).rows[0];
      expect(r[0]).toEqual({
        blockNumber: "2", timeStamp: await stamp(2), hash: await txHash(2, 0), nonce: nonce.n, blockHash: await blockHash(2), from: A, contractAddress: T1, to: B, value: "10", tokenName: "Test Token", tokenSymbol: "TT",
        tokenDecimal: "6", transactionIndex: "0", gas: nonce.g, gasPrice: nonce.p, gasUsed: nonce.u, cumulativeGasUsed: nonce.c, input: "deprecated", confirmations: "2",
      });
      // A sent and received: the transfer to itself is listed once.
      expect(shape(await get(`/api?module=account&action=tokentx&address=${A}`)).result.map((t: any) => t.value)).toEqual(["10", "20", "5"]); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(shape(await get(`/api?module=account&action=tokentx&contractaddress=${T1}&sort=desc`)).result.map((t: any) => t.value)).toEqual(["5", "20", "10"]); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(shape(await get(`/api?module=account&action=tokentx&contractaddress=${T1}&address=${B}`)).result.map((t: any) => t.value)).toEqual(["10", "20"]); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(shape(await get(`/api?module=account&action=tokentx&contractaddress=${T1}&address=${C}`))).toEqual(NO_ROWS);
      // ERC-721 and ERC-1155 are not in the ERC-20 list, and the reverse.
      expect(shape(await get(`/api?module=account&action=tokentx&contractaddress=${T3}`))).toEqual(NO_ROWS);
    });

    it("lists ERC-721 transfers with their id, and ERC-1155 transfers with their id and value (recorded answers)", async () => {
      const nft = shape(await get(`/api?module=account&action=tokennfttx&address=${A}`)).result;
      expect(nft).toHaveLength(1);
      expect(nft[0]).toMatchObject({ blockNumber: "3", from: B, to: A, contractAddress: T3, tokenID: "77", tokenName: "Punks", tokenSymbol: "PNK", tokenDecimal: "0", transactionIndex: "2", input: "deprecated" });
      expect(Object.keys(nft[0])).toEqual([
        "blockNumber", "timeStamp", "hash", "nonce", "blockHash", "from", "contractAddress", "to", "tokenID", "tokenName", "tokenSymbol", "tokenDecimal", "transactionIndex", "gas", "gasPrice", "gasUsed",
        "cumulativeGasUsed", "input", "confirmations",
      ]);
      const many = shape(await get(`/api?module=account&action=token1155tx&address=${A}`)).result;
      expect(many.map((t: any) => [t.tokenID, t.tokenValue])).toEqual([["1", "7"], ["2", "8"]]); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(many[0]).toMatchObject({ blockNumber: "3", from: C, to: A, contractAddress: T2, tokenName: "Gadget", tokenSymbol: "", transactionIndex: "1", confirmations: "1" });
      expect(Object.keys(many[0])).toEqual([
        "blockNumber", "timeStamp", "hash", "nonce", "blockHash", "from", "contractAddress", "to", "tokenID", "tokenValue", "tokenName", "tokenSymbol", "transactionIndex", "gas", "gasPrice", "gasUsed",
        "cumulativeGasUsed", "input", "confirmations",
      ]);
      expect(shape(await get(`/api?module=account&action=token1155tx&address=${A}&page=2&offset=1`)).result.map((t: any) => t.tokenID)).toEqual(["2"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    it("needs an address or a token, and refuses a bad one", async () => {
      expect(shape(await get("/api?module=account&action=tokentx"))).toEqual(NOTOK(TEXTS.tokenWho));
      expect(shape(await get("/api?module=account&action=tokentx&address=0x1"))).toEqual(NOTOK("Error! Invalid address format"));
      expect(shape(await get(`/api?module=account&action=tokentx&address=${A}&contractaddress=0x1`))).toEqual(NOTOK("Error! Invalid address format"));
    });
  });

  describe("getminedblocks", () => {
    it("lists the blocks an address received the fees of, with the fees as the reward (recorded answer)", async () => {
      const r = shape(await get(`/api?module=account&action=getminedblocks&address=${A}&blocktype=blocks`)).result;
      expect(r).toEqual([{ blockNumber: "2", timeStamp: await stamp(2), blockReward: "2000" }, { blockNumber: "3", timeStamp: await stamp(3), blockReward: "3000" }]);
      expect(shape(await get(`/api?module=account&action=getminedblocks&address=${A}&sort=desc&page=1&offset=1`)).result.map((b: any) => b.blockNumber)).toEqual(["3"]); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(shape(await get(`/api?module=account&action=getminedblocks&address=${B}`))).toEqual(NO_ROWS);
      expect(shape(await get(`/api?module=account&action=getminedblocks&address=${A}&blocktype=uncles`))).toEqual(NO_ROWS);
      expect(shape(await get(`/api?module=account&action=getminedblocks&address=${A}&blocktype=x`))).toEqual(NOTOK(TEXTS.blocktype));
    });
  });

  describe("what stage 2 has not reached", () => {
    it("is not listed: a derived list stops at the derive cursor, while the transactions go to the final head", async () => {
      await setCursor(2);
      try {
        expect(shape(await get(`/api?module=account&action=txlistinternal&address=${A}`)).result.map((c: any) => c.blockNumber)).toEqual(["2", "2"]); // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(shape(await get(`/api?module=account&action=tokentx&address=${A}`)).result.map((t: any) => t.blockNumber)).toEqual(["2", "2"]); // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(shape(await get(`/api?module=account&action=token1155tx&address=${A}`))).toEqual(NO_ROWS);
        expect(shape(await get(`/api?module=account&action=txlist&address=${A}`)).result).toHaveLength(4);
        // Confirmations are counted from the final head, as everywhere.
        expect(shape(await get(`/api?module=account&action=tokentx&address=${A}`)).result[0].confirmations).toBe("2");
      } finally { await setCursor(3); }
    });
  });

  describe("transaction: getstatus and gettxreceiptstatus", () => {
    const failedAndOk = async () => {
      const bad = (await sql("select block_number, tx_index from transactions where status = 0 order by block_number, tx_index limit 1")).rows[0];
      const good = (await sql("select block_number, tx_index from transactions where status = 1 order by block_number, tx_index limit 1")).rows[0];
      return { bad: await txHash(bad.block_number, bad.tx_index), good: await txHash(good.block_number, good.tx_index) };
    };

    it("answers a transaction's success or revert from its stored row (recorded answers)", async () => {
      const { bad, good } = await failedAndOk();
      expect(shape(await get(`/api?module=transaction&action=getstatus&txhash=${good}`))).toEqual({ status: "1", message: "OK", result: { isError: "0", errDescription: "" } });
      expect(shape(await get(`/api?module=transaction&action=getstatus&txhash=${bad}`))).toEqual({ status: "1", message: "OK", result: { isError: "1", errDescription: "Reverted" } });
      expect(shape(await get(`/api?module=transaction&action=gettxreceiptstatus&txhash=${good}`))).toEqual({ status: "1", message: "OK", result: { status: "1" } });
      expect(shape(await get(`/api?module=transaction&action=gettxreceiptstatus&txhash=${bad.toUpperCase().replace("0X", "0x")}`))).toEqual({ status: "1", message: "OK", result: { status: "0" } });
    });

    it("answers no error and an empty receipt status for a hash that is not in a final block, and refuses a malformed hash", async () => {
      const unknown = "0x" + "ee".repeat(32);
      expect(shape(await get(`/api?module=transaction&action=getstatus&txhash=${unknown}`))).toEqual({ status: "1", message: "OK", result: { isError: "0", errDescription: "" } });
      expect(shape(await get(`/api?module=transaction&action=gettxreceiptstatus&txhash=${unknown}`))).toEqual({ status: "1", message: "OK", result: { status: "" } });
      for (const action of ["getstatus", "gettxreceiptstatus"]) {
        expect(shape(await get(`/api?module=transaction&action=${action}&txhash=0x12`))).toEqual(NOTOK(TEXTS.txhash));
        expect(shape(await get(`/api?module=transaction&action=${action}`))).toEqual(NOTOK(TEXTS.txhash));
      }
    });
  });

  describe("block: getblockreward, getblocknobytime and getblockcountdown", () => {
    it("getblockreward: the fees are the reward, the miner is the fee recipient, no uncles (recorded answer)", async () => {
      const a = shape(await get("/api?module=block&action=getblockreward&blockno=2"));
      expect(a).toEqual({ status: "1", message: "OK", result: { blockNumber: "2", timeStamp: await stamp(2), blockMiner: A, blockReward: "2000", uncles: null, uncleInclusionReward: "0" } });
      expect(Object.keys(a.result)).toEqual(["blockNumber", "timeStamp", "blockMiner", "blockReward", "uncles", "uncleInclusionReward"]);
      expect(shape(await get("/api?module=block&action=getblockreward&blockno=999"))).toEqual(NOTOK(TEXTS.noBlock));
      expect(shape(await get("/api?module=block&action=getblockreward&blockno=x"))).toEqual(NOTOK(TEXTS.blockno));
      expect(shape(await get("/api?module=block&action=getblockreward"))).toEqual(NOTOK(TEXTS.blockno));
    });

    it("getblocknobytime: the closest block before or after a time, as a string", async () => {
      const t2 = Number(await stamp(2)), t3 = Number(await stamp(3));
      const at = async (ts: number, closest: string) => shape(await get(`/api?module=block&action=getblocknobytime&timestamp=${ts}&closest=${closest}`));
      expect(await at(t2, "before")).toEqual({ status: "1", message: "OK", result: "2" });
      expect(await at(t2, "after")).toEqual({ status: "1", message: "OK", result: "2" });
      expect(await at(t3 + 1000, "before")).toEqual({ status: "1", message: "OK", result: "3" });
      expect(await at(t3 + 1000, "after")).toEqual(NOTOK(TEXTS.noClosest));
      expect(await at(1, "before")).toEqual(NOTOK(TEXTS.noClosest));
      expect((await at(1, "after")).result).toBe("1");
      expect(shape(await get("/api?module=block&action=getblocknobytime&timestamp=abc&closest=before"))).toEqual(NOTOK(TEXTS.timestamp));
      expect(shape(await get("/api?module=block&action=getblocknobytime&timestamp=5&closest=near"))).toEqual(NOTOK(TEXTS.closest));
      expect(shape(await get("/api?module=block&action=getblocknobytime&timestamp=5"))).toEqual(NOTOK(TEXTS.closest));
    });

    it("getblockcountdown: NOTOK with no run or under on_demand; counted by the interval of a fixed rhythm", async () => {
      const runs: string[] = [];
      const run = async (id: string, strategy: string, at: string, settings: object) => {
        await sql("insert into producer_runs (run_id, started_at, strategy, settings, source_commit) values ($1, $2, $3, $4, 'abc1234')", [id, at, strategy, JSON.stringify(settings)]);
        runs.push(id);
      };
      try {
        expect(shape(await get("/api?module=block&action=getblockcountdown&blockno=10"))).toEqual(NOTOK(TEXTS.noRhythm));
        await run("00000000-0000-4000-8000-0000000000a1", "on_demand", "2030-01-01T00:00:00Z", { gather_ms: 0 });
        expect(shape(await get("/api?module=block&action=getblockcountdown&blockno=10"))).toEqual(NOTOK(TEXTS.noRhythm));
        await run("00000000-0000-4000-8000-0000000000a2", "fixed_rhythm", "2030-01-02T00:00:00Z", { interval_ms: 2000 });
        expect(shape(await get("/api?module=block&action=getblockcountdown&blockno=10"))).toEqual({
          status: "1", message: "OK", result: { CurrentBlock: "3", CountdownBlock: "10", RemainingBlock: "7", EstimateTimeInSec: "14" },
        });
        expect(shape(await get("/api?module=block&action=getblockcountdown&blockno=3"))).toEqual(NOTOK(TEXTS.passed));
        expect(shape(await get("/api?module=block&action=getblockcountdown&blockno=x"))).toEqual(NOTOK(TEXTS.blockno));
      } finally {
        for (const id of runs) await sql("delete from producer_runs where run_id = $1", [id]);
      }
    });
  });

  describe("logs: getLogs", () => {
    const Z = h(0xc1);
    const t = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
    const T11 = t(0x11), T12 = t(0x12), T21 = t(0x21), T22 = t(0x22);
    const logsUrl = (q: string) => `/api?module=logs&action=getLogs&${q}`;
    const keys = async (q: string) => (shape(await get(logsUrl(q))).result as { blockNumber: string; logIndex: string }[]).map((l) => `${Number(l.blockNumber)}:${l.logIndex === "0x" ? 0 : Number(l.logIndex)}`);

    beforeAll(async () => {
      await sql(
        `insert into logs (block_number, log_index, tx_index, address, topic0, topic1, data) values
          (3, 900, 0, $1, $2, $4, '\\x0102'), (3, 901, 1, $1, $2, $5, '\\x'), (2, 900, 0, $1, $3, $4, '\\x03')`,
        [who(0xc1), Buffer.from(T11.slice(2), "hex"), Buffer.from(T12.slice(2), "hex"), Buffer.from(T21.slice(2), "hex"), Buffer.from(T22.slice(2), "hex")],
      );
    });
    afterAll(async () => { await sql("delete from logs where address = $1", [who(0xc1)]); });

    it("answers a log in Etherscan's shape, hex quantities and all, oldest first (recorded answer)", async () => {
      const a = shape(await get(logsUrl(`address=${Z}&fromBlock=0&toBlock=latest`)));
      expect(a.status).toBe("1");
      expect(a.message).toBe("OK");
      expect(a.result).toHaveLength(3);
      const row = (await sql("select t.hash, t.effective_gas_price::text as price, t.gas_used::text as used, b.hash as bh, extract(epoch from b.timestamp)::bigint as ts from transactions t join blocks b on b.number = t.block_number where t.block_number = 3 and t.tx_index = 0")).rows[0];
      const q = (n: bigint | string | number) => (BigInt(n) === 0n ? "0x" : "0x" + BigInt(n).toString(16));
      expect(a.result[1]).toEqual({
        address: Z, topics: [T11, T21], data: "0x0102", blockNumber: "0x3", blockHash: "0x" + row.bh.toString("hex"), timeStamp: q(row.ts), gasPrice: q(row.price), gasUsed: q(row.used),
        logIndex: "0x384", transactionHash: "0x" + row.hash.toString("hex"), transactionIndex: "0x",
      });
      expect(Object.keys(a.result[1])).toEqual(["address", "topics", "data", "blockNumber", "blockHash", "timeStamp", "gasPrice", "gasUsed", "logIndex", "transactionHash", "transactionIndex"]);
      expect(await keys(`address=${Z}`)).toEqual(["2:900", "3:900", "3:901"]);
    });

    it("filters by block range, by topics and by the topic operators", async () => {
      expect(await keys(`address=${Z}&fromBlock=3&toBlock=3`)).toEqual(["3:900", "3:901"]);
      expect(await keys(`address=${Z}&fromBlock=0&toBlock=2`)).toEqual(["2:900"]);
      expect(await keys(`address=${Z}&topic0=${T11}`)).toEqual(["3:900", "3:901"]);
      expect(await keys(`address=${Z}&topic0=${T11.toUpperCase().replace("0X", "0x")}&topic1=${T21}&topic0_1_opr=and`)).toEqual(["3:900"]);
      expect(await keys(`address=${Z}&topic0=${T11}&topic1=${T21}`)).toEqual(["3:900"]); // and, when no operator is given
      expect(await keys(`address=${Z}&topic0=${T11}&topic1=${T21}&topic0_1_opr=or`)).toEqual(["2:900", "3:900", "3:901"]);
      expect(await keys(`address=${Z}&topic1=${T22}`)).toEqual(["3:901"]);
      expect(await keys(`address=${Z}&topic0=${T12}&topic2=${T21}&topic0_2_opr=or`)).toEqual(["2:900"]);
      // A topic0 alone is bound enough (no address), and a range of the first blocks is bound enough with no address or topic0.
      expect(await keys(`topic0=${T11}`)).toEqual(["3:900", "3:901"]);
      expect(await keys(`topic1=${T22}&fromBlock=0&toBlock=latest`)).toEqual(["3:901"]);
      expect(shape(await get(logsUrl(`address=${Z}&topic0=${t(0x99)}`)))).toEqual({ status: "0", message: "No records found", result: [] });
    });

    it("reads fromBlock=latest as the newest final block, as it reads toBlock=latest, and not as block 0", async () => {
      expect(await keys(`address=${Z}&fromBlock=latest&toBlock=latest`)).toEqual(["3:900", "3:901"]); // block 2's log is older
      expect(await keys(`address=${Z}&fromBlock=latest`)).toEqual(["3:900", "3:901"]);
      expect(shape(await get(logsUrl(`address=${Z}&fromBlock=latest&toBlock=2`)))).toEqual({ status: "0", message: "No records found", result: [] });
    });

    it("pages with page and offset, and holds a page to 1,000 logs and page x offset to 10,000", async () => {
      expect(await keys(`address=${Z}&page=1&offset=2`)).toEqual(["2:900", "3:900"]);
      expect(await keys(`address=${Z}&page=2&offset=2`)).toEqual(["3:901"]);
      expect(shape(await get(logsUrl(`address=${Z}&page=3&offset=2`)))).toEqual({ status: "0", message: "No records found", result: [] });
      expect(await keys(`address=${Z}&offset=5000`)).toHaveLength(3); // a page is cut at 1,000
      expect(shape(await get(logsUrl(`address=${Z}&page=11&offset=1000`)))).toEqual({ status: "0", message: TEXTS.window, result: null });
      expect(shape(await get(logsUrl(`address=${Z}&page=0`)))).toEqual(NOTOK(TEXTS.paging));
      expect(shape(await get(logsUrl(`address=${Z}&offset=0`)))).toEqual(NOTOK(TEXTS.paging));
    });

    it("refuses a bad address, topic, operator or block, and a search with no address or topic0 over more than 10,000 blocks", async () => {
      expect(shape(await get(logsUrl("address=0x12")))).toEqual(NOTOK(TEXTS.address));
      expect(shape(await get(logsUrl(`address=${Z}&topic0=0x12`)))).toEqual(NOTOK(TEXTS.topic));
      expect(shape(await get(logsUrl(`address=${Z}&topic0=${T11}&topic1=${T21}&topic0_1_opr=xor`)))).toEqual(NOTOK(TEXTS.topicOp));
      expect(shape(await get(logsUrl(`address=${Z}&fromBlock=x`)))).toEqual(NOTOK(TEXTS.blocks));
      expect(shape(await get(logsUrl(`address=${Z}&fromBlock=9&toBlock=5`)))).toEqual({ status: "0", message: "No records found", result: [] });
      // Make the chain 20,000 blocks long (a copy of block 3; removed again below), so that the range is wide.
      await sql("insert into blocks select 20000, $1::bytea, parent_hash, timestamp, fee_recipient, gas_limit, gas_used, base_fee_per_gas, burnt_fees, priority_fees, 0, 0, size_bytes, state_root, transactions_root, receipts_root, extra_data, 0, null, update_id, record_time, attempt_id, indexed_at from blocks where number = 3", [Buffer.alloc(32, 0x5a)]);
      try {
        expect(shape(await get(logsUrl(`topic1=${T21}`)))).toEqual(NOTOK(TEXTS.logsWide));
        expect(shape(await get(logsUrl(`topic0=${T11}&topic1=${T21}&topic0_1_opr=or`)))).toEqual(NOTOK(TEXTS.logsWide)); // or-ed, so topic0 no longer narrows
        expect(await keys(`topic0=${T11}`)).toEqual(["3:900", "3:901"]);
        expect(await keys(`address=${Z}`)).toEqual(["2:900", "3:900", "3:901"]);
        expect(shape(await get(logsUrl(`topic1=${T21}&fromBlock=10001`)))).toEqual({ status: "0", message: "No records found", result: [] });
      } finally { await sql("delete from blocks where number = 20000"); }
    });
  });

  it("answers a read it cannot make with its own NOTOK, and a limit with Etherscan's word, both at HTTP 200", async () => {
    const broken = { balanceAt: async () => { const { RethError } = await import("../reth.ts"); throw new RethError("down"); } } as unknown as Reth;
    const a = await createApi({ config: config(), reth: broken, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), etherscanRest: createEtherscanRest(pool) })("GET", `/api?module=account&action=balance&address=${A}`);
    expect(shape(a)).toEqual(NOTOK(TEXTS.broken));
  });
});
