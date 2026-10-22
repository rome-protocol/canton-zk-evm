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
  const config = () => loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
  const reth = {
    balanceAt: async (a: string, n: number) => (asked.push([a, n]), balances.get(a) ?? 0n),
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
      expect(shape(await q("page=2&offset=5000")).status).toBe("1");
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

  it("answers a read it cannot make with its own NOTOK, and a limit with Etherscan's word, both at HTTP 200", async () => {
    const broken = { balanceAt: async () => { const { RethError } = await import("../reth.ts"); throw new RethError("down"); } } as unknown as Reth;
    const a = await createApi({ config: config(), reth: broken, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), etherscanRest: createEtherscanRest(pool) })("GET", `/api?module=account&action=balance&address=${A}`);
    expect(shape(a)).toEqual(NOTOK(TEXTS.broken));
  });
});
