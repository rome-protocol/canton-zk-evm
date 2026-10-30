import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createApi, NOT_FOUND, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { ensurePartitions } from "../db/partitions.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createIndexer } from "../indexer/indexer.ts";
import type { Reth } from "../reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createAccountRest, ERC20_TRANSFERS, NFT_TRANSFERS, transferCountSql } from "./account-rest.ts";
import { CACHE_CONTROL } from "./cache.ts";
import { PARTIAL_MATCH_NOTE } from "./account-rest.ts";
import { FIELDS, REST_FIELDS as F } from "./fields.ts";
import { NO_ADDRESS, NO_CONTRACT, NO_LEG, NO_TOKEN } from "./account-routes.ts";

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const keys = (o: object) => Object.keys(o).sort();
const same = (o: object, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());
const who = (n: number) => Buffer.alloc(20, n);
const h = (n: number) => "0x" + who(n).toString("hex");
// The addresses of the fixture: two accounts, a plain contract, a verified proxy, an ERC-20 token and an ERC-1155 token.
const A = h(0xa1), B = h(0xa2), C = h(0xa3), K = h(0xc1), T1 = h(0xb1), T2 = h(0xb2);
const NAMES: Record<string, string> = { [A]: "A", [B]: "B", [C]: "C", [K]: "K", [T1]: "T1", [T2]: "T2" };
const mine = (items: { address?: string; holder?: string }[]) => items.map((i) => NAMES[(i.address ?? i.holder) as string]).filter(Boolean);

describe.skipIf(!TEST_URL)("the REST routes of accounts, contracts, tokens and legs", () => {
  checkRequired();
  let db: TestDatabase, pool: Pool, chain: ReturnType<typeof makeChain>;
  const balances = new Map<string, bigint>();
  const asked: [string, number][] = [];
  const get = async (target: string): Promise<Answer> => {
    const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
    const reth = {
      code: async () => "0x6080", token: async () => null, block: async () => undefined, transaction: async () => null,
      balanceAt: async (a: string, n: number) => (asked.push([a, n]), balances.get(a) ?? 0n),
    } as unknown as Reth;
    return createApi({ config, reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), accounts: createAccountRest(pool) })("GET", target);
  };
  const body = (a: Answer) => a.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const setCursor = (n: number) => pool.query("update cursors set position = $1 where stream = 'derive'", [n]);
  const txHash = (block: number, i: number) => chain.blocks[block - 1]!.block.transactions[i]!.hash;
  const sql = (text: string, values: unknown[] = []) => pool.query(text, values);
  /** Every page of a list, walked with a small limit: the rows in order, and that no row came twice. */
  async function walk(path: string, param: "before" | "after", limit: number): Promise<Record<string, any>[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const out: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let next: string | null = null;
    for (let turns = 0; turns < 200; turns++) {
      const a = await get(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}${next ? `&${param}=${next}` : ""}`);
      expect(a.status).toBe(200);
      const p = body(a);
      out.push(...p.items);
      next = p.next;
      if (!next) break;
    }
    expect(new Set(out.map((r) => JSON.stringify(r))).size).toBe(out.length);
    return out;
  }

  beforeAll(async () => {
    db = await makeDatabase();
    pool = db.pool;
    await migrate(pool);
    chain = makeChain([{ txs: 0 }, { txs: 5, leg: 2 }, { txs: 7 }]);
    const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }
    // The rows these routes read, written as stages 1 and 2 and the check of balances write them, for addresses of the fixture's own.
    const big = (n: number) => (BigInt(n) * 10n ** 24n).toString();
    await sql(
      `insert into addresses (address, first_seen_block, last_active_block, sent_count, received_count, internal_count, token_transfer_count, is_contract, coin_balance, coin_balance_block) values
        ($1, 1, 3, 1005, 2, 4, 3, false, $4, 3), ($2, 1, 3, 1, 1001, 2, 1, false, $5, 3), ($3, 2, 3, 0, 1009, 0, 0, true, $6, 3)`,
      [who(0xa1), who(0xa2), who(0xa3), big(1), big(5), big(3)],
    );
    await sql("insert into bytecodes (code_hash, code, size) values ($1, $2, 2), ($3, $4, 3)", [Buffer.alloc(32, 1), Buffer.from("6080", "hex"), Buffer.alloc(32, 2), Buffer.from("608060", "hex")]);
    await sql(
      `insert into contracts (address, origin, creator, creation_block, creation_tx_index, runtime_code_hash, name, interaction_count, last_interaction_block) values
        ($1, 'create', $5, 2, 2, $6, null, 500, 3), ($2, 'create', $5, 3, 1, $7, 'Vault', 700, 3), ($3, 'create', $5, 2, 0, $6, 'Test Token', 100, 3), ($4, 'genesis', null, null, null, $6, 'Gadget', 50, 3)`,
      [who(0xa3), who(0xc1), who(0xb1), who(0xb2), who(0xa1), Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    );
    const [v] = (await sql(
      `insert into verified_sources (address, runtime_code_hash, language, compiler_version, code_format, contract_path, contract_name, optimizer_enabled, optimizer_runs, evm_version, settings, sources, abi, constructor_args, license, match_type, verified_at)
       values ($1, $2, 'solidity', 'v0.8.30+commit.73712a01', 'solidity-standard-json-input', 'src/b.sol', 'Vault', true, 200, 'osaka', '{"viaIR": true}', '{"src/b.sol": "contract Vault {}", "src/a.sol": "contract A {}"}', '[{"type":"function","name":"f"}]', $3, 'MIT', 'full', '2026-10-20T10:00:00Z') returning id`,
      [who(0xc1), Buffer.alloc(32, 2), Buffer.from("00ff", "hex")],
    )).rows;
    await sql("update contracts set verified_source = $1, match_type = 'full' where address = $2", [v.id, who(0xc1)]);
    await sql("insert into proxies (proxy, kind, implementation, checked_block) values ($1, 'eip1967', $2, 3)", [who(0xc1), who(0xa3)]);
    await sql(
      `insert into tokens (address, standard, name, symbol, decimals, total_supply, total_supply_block, holder_count, transfer_count, first_transfer_block, metadata_status) values
        ($1, 'ERC-20', 'Test Token', 'TT', 6, 1000, 3, 2, 3, 2, 'read'), ($2, 'ERC-1155', 'Gadget', 'GDG', null, null, null, 3, 2, 3, 'read')`,
      [who(0xb1), who(0xb2)],
    );
    await sql(
      `insert into token_balances (token, holder, token_id, value, updated_block) values ($1, $3, 0, 40, 3), ($1, $4, 0, 60, 3), ($2, $3, 1, 2, 3), ($2, $3, 2, 5, 3), ($2, $4, 1, 1, 3)`,
      [who(0xb1), who(0xb2), who(0xa1), who(0xa2)],
    );
    // Transfers in blocks 2 and 3, on transactions that exist; one of them from an account to itself, which an address lists once.
    await sql(
      `insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) values
        (2, 500, 0, 0, $1, $3, $4, 10, null), (2, 501, 0, 0, $1, $4, $3, 20, null), (3, 500, 0, 0, $1, $3, $3, 5, null),
        (3, 501, 0, 1, $2, $5, $3, 7, 1), (3, 501, 1, 1, $2, $5, $3, 8, 2)`,
      [who(0xb1), who(0xb2), who(0xa1), who(0xa2), who(0xa3)],
    );
    await sql(
      `insert into internal_calls (block_number, tx_index, trace_address, call_type, from_address, to_address, value) values
        (2, 2, '{}', 'call', $1, $2, 1), (2, 2, '{0}', 'call', $2, $1, 2), (2, 3, '{}', 'call', $1, $1, 3), (3, 0, '{0,1}', 'call', $3, $1, 4)`,
      [who(0xa1), who(0xa2), who(0xa3)],
    );
    await sql("insert into coin_balance_history (address, block_number, value) values ($1, 1, 10), ($1, 2, 20), ($1, 3, 30)", [who(0xa1)]);
    // Transactions of A: sent in block 2 (twice), received in block 3, a creation of A, and one sent to itself.
    await sql("update transactions set from_address = $1 where block_number = 2 and tx_index in (0, 1)", [who(0xa1)]);
    await sql("update transactions set to_address = $1 where block_number = 3 and tx_index = 0", [who(0xa1)]);
    await sql("update transactions set created_contract = $1 where block_number = 3 and tx_index = 1", [who(0xa1)]);
    await sql("update transactions set from_address = $1, to_address = $1 where block_number = 3 and tx_index = 2", [who(0xa1)]);
    await setCursor(3);
  });
  afterAll(async () => { await db?.drop(); });

  it("builds every answer from the allowlists", async () => {
    const list = body(await get("/api/addresses"));
    same(list, F.derivedPage);
    for (const a of list.items) same(a, F.addressItem);
    same(body(await get(`/api/addresses/${A}`)), F.addressDetail);
    const token = body(await get(`/api/addresses/${T1}`));
    same(token.token, FIELDS.token);
    same(token.createdBy, ["txHash", "block"]);
    const txs = body(await get(`/api/addresses/${A}/txs`));
    same(txs, F.page);
    for (const t of txs.items) same(t, F.txItem);
    const calls = body(await get(`/api/addresses/${A}/internal`));
    same(calls, F.derivedPage);
    expect(calls.items).toHaveLength(4);
    for (const c of calls.items) same(c, F.addressInternal);
    const moved = body(await get(`/api/addresses/${A}/token-transfers`));
    for (const t of moved.items) same(t, F.tokenTransferItem);
    const held = body(await get(`/api/addresses/${A}/tokens`));
    expect(held.items).toHaveLength(3);
    for (const x of held.items) same(x, F.holding);
    const coins = body(await get(`/api/addresses/${A}/coin-history`));
    for (const x of coins.items) same(x, F.coinPoint);
    const contracts = body(await get("/api/contracts"));
    same(contracts, F.contractPage);
    for (const c of contracts.items) same(c, F.contractItem);
    const vault = body(await get(`/api/contracts/${K}`));
    same(vault, F.contractDetail);
    same(vault.proxy, F.proxy);
    same(vault.verification, F.verification);
    const source = body(await get(`/api/contracts/${K}/source`));
    same(source, F.source);
    for (const f of source.files) same(f, F.sourceFile);
    const tokens = body(await get("/api/tokens"));
    same(tokens, F.tokenPage);
    for (const t of tokens.items) same(t, F.tokenItem);
    same(body(await get(`/api/tokens/${T1}`)), F.tokenDetail);
    const holders = body(await get(`/api/tokens/${T2}/holders`));
    same(holders, F.derivedPage);
    for (const x of holders.items) same(x, F.holder);
    for (const t of body(await get(`/api/tokens/${T1}/transfers`)).items) same(t, F.tokenTransferItem);
    const legs = body(await get("/api/legs"));
    same(legs, F.page);
    expect(legs.items).toHaveLength(1);
    same(legs.items[0], F.legItem);
    same(body(await get(`/api/legs/${legs.items[0].legId}`)), F.legItem);
    const found = body(await get("/api/search?q=vault"));
    same(found, F.search);
    for (const m of found.matches) same(m, F.searchMatch);
  });

  it("reads an address's balance from reth at the newest final block, and the list from the database's copy", async () => {
    balances.set(A, 424242n);
    asked.length = 0;
    const one = body(await get(`/api/addresses/${A}`));
    expect(one.balance).toBe("424242");
    expect(one.balanceBlock).toBe(3);
    expect(asked).toEqual([[A, 3]]);
    // The copy in the database is for lists only, and it is as of a block of its own.
    const list = body(await get("/api/addresses?sort=balance")).items as { address: string; balance: string; balanceBlock: number }[];
    const copy = list.find((x) => x.address === A)!;
    expect(copy.balance).toBe((10n ** 24n).toString());
    expect(copy.balanceBlock).toBe(3);
    expect(one.balance).not.toBe(copy.balance);
    // An address nothing has touched is still answered, from reth.
    balances.set(h(0xee), 7n);
    const fresh = body(await get(`/api/addresses/${h(0xee)}`));
    expect(fresh).toMatchObject({ kind: "account", balance: "7", sentCount: 0, firstSeenBlock: null, token: null, createdBy: null });
    same(fresh, F.addressDetail);
    const detail = body(await get(`/api/addresses/${A}`));
    expect(detail).toMatchObject({ kind: "account", sentCount: 1005, receivedCount: 2, internalCount: 4, tokenTransferCount: 3, firstSeenBlock: 1, lastActiveBlock: 3 });
  });

  it("lists addresses by balance or by transactions, and says what it takes", async () => {
    expect(mine(body(await get("/api/addresses?sort=balance")).items)).toEqual(["B", "C", "A"].sort((x, y) => ({ B: 5, C: 3, A: 1 }[y]! - { B: 5, C: 3, A: 1 }[x]!)));
    expect(mine(body(await get("/api/addresses?sort=txs")).items)).toEqual(["C", "A", "B"]);
    expect(mine(body(await get("/api/addresses")).items)).toEqual(mine(body(await get("/api/addresses?sort=balance")).items));
    const kinds = Object.fromEntries((body(await get("/api/addresses?sort=txs")).items as { address: string; kind: string }[]).map((x) => [x.address, x.kind]));
    expect(kinds).toMatchObject({ [A]: "account", [C]: "contract" });
    expect(await get("/api/addresses?sort=newest")).toMatchObject({ status: 400 });
    expect(await get("/api/addresses/0x12")).toEqual({ status: 400, body: { error: NO_ADDRESS } });
  });

  it("pages every list by keyset, in a stable order, without a repeat or a gap", async () => {
    for (const path of ["/api/addresses?sort=balance", "/api/addresses?sort=txs", "/api/contracts?sort=interactions", "/api/contracts?sort=newest", "/api/contracts?sort=oldest", "/api/tokens?sort=holders",
      "/api/tokens?sort=transfers", "/api/tokens?sort=newest", `/api/tokens/${T1}/holders`, `/api/tokens/${T2}/holders`, `/api/tokens/${T1}/transfers`, `/api/addresses/${A}/txs`, `/api/addresses/${A}/internal`,
      `/api/addresses/${A}/token-transfers`, `/api/addresses/${A}/coin-history`, "/api/legs"]) {
      const whole = (await walk(path, "before", 100)).map((r) => JSON.stringify(r));
      for (const limit of [1, 2]) expect((await walk(path, "before", limit)).map((r) => JSON.stringify(r)), `${path} at ${limit}`).toEqual(whole);
    }
    const holdings = (await walk(`/api/addresses/${A}/tokens`, "after", 100)).map((r) => [r.token, r.tokenId]);
    expect(holdings).toEqual([[T1, "0"], [T2, "1"], [T2, "2"]]);
    expect((await walk(`/api/addresses/${A}/tokens`, "after", 1)).map((r) => [r.token, r.tokenId])).toEqual(holdings);
    expect((await walk(`/api/addresses/${A}/txs`, "before", 100)).map((t) => [t.block, t.index])).toEqual([[3, 2], [3, 1], [3, 0], [2, 1], [2, 0]]);
    expect((await walk(`/api/addresses/${A}/internal`, "before", 1)).map((c) => [c.block, c.txIndex, c.traceAddress])).toEqual([[3, 0, [0, 1]], [2, 3, []], [2, 2, [0]], [2, 2, []]]);
    expect((await walk(`/api/addresses/${A}/token-transfers`, "before", 100)).map((t) => [t.block, t.logIndex, t.batchIndex])).toEqual([[3, 501, 1], [3, 501, 0], [3, 500, 0], [2, 501, 0], [2, 500, 0]]);
    expect((await walk(`/api/addresses/${A}/coin-history`, "before", 1)).map((c) => [c.block, c.balance])).toEqual([[3, "30"], [2, "20"], [1, "10"]]);
    expect((await walk(`/api/tokens/${T2}/holders`, "before", 1)).map((x) => [NAMES[x.holder], x.tokenId, x.value])).toEqual([["A", "2", "5"], ["A", "1", "2"], ["B", "1", "1"]]);
    expect(mine(await walk("/api/contracts?sort=interactions", "before", 1))).toEqual(["K", "C", "T1", "T2"]);
    expect(mine(await walk("/api/contracts?sort=newest", "before", 1))).toEqual(["K", "C", "T1", "T2"]);
    expect(mine(await walk("/api/contracts?sort=oldest", "before", 1))).toEqual(["T2", "T1", "C", "K"]);
    expect(mine(await walk("/api/tokens?sort=holders", "before", 1))).toEqual(["T2", "T1"].map((x) => x.replace("T2", "T1").replace(/^T1$/, "T1")).length === 2 ? ["T2", "T1"] : []);
    expect(mine(await walk("/api/tokens?sort=transfers", "before", 1))).toEqual(["T1", "T2"]);
    expect(mine(await walk("/api/tokens?sort=newest", "before", 1))).toEqual(["T2", "T1"]);
  });

  it("keeps an address's transactions to the ones it sent or the ones it received, and gives them as a bounded CSV", async () => {
    const at = async (target: string) => (body(await get(target)).items as { block: number; index: number }[]).map((t) => [t.block, t.index]);
    expect(await at(`/api/addresses/${A}/txs?direction=sent`)).toEqual([[3, 2], [2, 1], [2, 0]]);
    // Received is what it was the recipient of, and the contract creations that made it.
    expect(await at(`/api/addresses/${A}/txs?direction=received`)).toEqual([[3, 2], [3, 1], [3, 0]]);
    expect(await at(`/api/addresses/${A}/txs?direction=all`)).toEqual(await at(`/api/addresses/${A}/txs`));
    // The filter pages like the list: by the same key, from the same cursor.
    const first = body(await get(`/api/addresses/${A}/txs?direction=sent&limit=2`));
    expect(first.items).toHaveLength(2);
    expect(await at(`/api/addresses/${A}/txs?direction=sent&limit=2&before=${first.next}`)).toEqual([[2, 0]]);
    expect(await at(`/api/addresses/${B}/txs?direction=sent`)).toEqual([]);
    for (const bad of ["direction=out", "direction=", "direction=SENT", "format=json"]) expect((await get(`/api/addresses/${A}/txs?${bad}`)).status, bad).toBe(400);
    const csv = await get(`/api/addresses/${A}/txs?format=csv&direction=sent`);
    expect(csv.status).toBe(200);
    expect(csv.headers?.["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers?.["content-disposition"]).toBe(`attachment; filename="transactions-${A}.csv"`);
    expect(csv.headers?.["cache-control"]).toBe(CACHE_CONTROL.list);
    const lines = String(csv.body).trim().split("\r\n");
    expect(lines[0]).toBe("hash,block,index,time,from,to,created_contract,method_id,value_wei,gas_used,gas_price_wei,success,direction");
    expect(lines.slice(1).map((l) => l.split(",").slice(1, 3))).toEqual([["3", "2"], ["2", "1"], ["2", "0"]]);
    expect(lines.slice(1).map((l) => l.split(",")[12])).toEqual(["sent", "sent", "sent"]);
    // Without a direction a transaction an address sent to itself is one row, called sent; a receive and a creation are received.
    const both = String(( await get(`/api/addresses/${A}/txs?format=csv`)).body).trim().split("\r\n");
    expect(both.slice(1).map((l) => l.split(",").slice(1, 3).join(":") + ":" + l.split(",")[12])).toEqual(["3:2:sent", "3:1:received", "3:0:received", "2:1:sent", "2:0:sent"]);
    // With a direction, the column is that direction: a transaction sent to itself is listed under received and reads received.
    const received = String((await get(`/api/addresses/${A}/txs?format=csv&direction=received`)).body).trim().split("\r\n");
    expect(received.slice(1).map((l) => l.split(",")[12])).toEqual(["received", "received", "received"]);
    // A limit under the page's cap gives that many rows; the file never holds more than the cap of 1,000 even when asked for more.
    expect((String((await get(`/api/addresses/${A}/txs?format=csv&limit=2`)).body).trim().split("\r\n")).length - 1).toBe(2);
    expect((await get(`/api/addresses/${A}/txs?format=csv&limit=abc`)).status).toBe(400);
    expect((await get(`/api/addresses/0x12/txs?format=csv`)).status).toBe(400);
  });

  it("refuses a key that is not the list's, a limit that is not a count, and a sort or filter it does not know", async () => {
    for (const bad of [`/api/addresses/${A}/txs?before=5`, `/api/addresses/${A}/txs?before=a:b`, `/api/addresses/${A}/internal?before=2:2:0`, "/api/contracts?sort=interactions&before=1:2:3", "/api/legs?before=x",
      `/api/addresses/${A}/txs?limit=0`, "/api/contracts?sort=popular", "/api/contracts?verified=maybe", "/api/tokens?sort=newest&limit=-1", `/api/addresses/${A}/tokens?after=1`]) {
      expect((await get(bad)).status, bad).toBe(400);
    }
    expect(body(await get(`/api/addresses/${A}/txs?limit=1000`)).items.length).toBeLessThanOrEqual(100);
  });

  it("filters the contract list by whether it is verified", async () => {
    expect(mine(body(await get("/api/contracts?verified=true")).items)).toEqual(["K"]);
    expect(mine(body(await get("/api/contracts?verified=false")).items)).toEqual(["C", "T1", "T2"]);
    const all = body(await get("/api/contracts?sort=interactions")).items as { address: string; verified: boolean; name: string | null; matchType: string | null; codeSize: number }[];
    expect(all.find((c) => c.address === K)).toMatchObject({ verified: true, name: "Vault", matchType: "full", codeSize: 3 });
    expect(all.find((c) => c.address === C)).toMatchObject({ verified: false, matchType: null });
  });

  it("gives each contract in the list its token standard, its balance and its counts, and none for what the index has not seen", async () => {
    const all = body(await get("/api/contracts?sort=interactions")).items as { address: string }[];
    expect(all.find((c) => c.address === C)).toMatchObject({ standard: null, balance: "3000000000000000000000000", balanceBlock: 3, txCount: 1009, internalCount: 0 });
    expect(all.find((c) => c.address === T1)).toMatchObject({ standard: "ERC-20" });
    expect(all.find((c) => c.address === K)).toMatchObject({ standard: null, balance: null, balanceBlock: null, txCount: 0, internalCount: 0 });
    expect(body(await get(`/api/contracts/${C}`))).toMatchObject({ balance: "3000000000000000000000000", txCount: 1009 });
  });

  it("answers the proxy of an implementation authority (T-REX, ONCHAINID) with its implementation, and the authority in `beacon`", async () => {
    await sql("insert into proxies (proxy, kind, implementation, beacon, checked_block) values ($1, 'trex', $2, $3, 3)", [who(0xb2), who(0xa3), who(0xa4)]);
    try {
      expect(body(await get(`/api/contracts/${h(0xb2)}`))).toMatchObject({ proxy: { kind: "trex", implementation: h(0xa3), beacon: h(0xa4), checkedBlock: 3 } });
    } finally {
      await sql("delete from proxies where proxy = $1", [who(0xb2)]);
    }
  });

  it("answers a contract with its code, proxy and verification, and its source with every file", async () => {
    const vault = body(await get(`/api/contracts/${K}`));
    expect(vault).toMatchObject({
      address: K, name: "Vault", origin: "create", creator: A, creationBlock: 3, creationTxHash: txHash(3, 1), codeSize: 3, code: "0x608060", verified: true, matchType: "full",
      proxy: { kind: "eip1967", implementation: C, beacon: null, checkedBlock: 3 },
      verification: { language: "solidity", compilerVersion: "v0.8.30+commit.73712a01", contractName: "Vault", optimizerEnabled: true, optimizerRuns: 200, evmVersion: "osaka", license: "MIT", verifiedAt: "2026-10-20T10:00:00.000Z" },
    });
    const plain = body(await get(`/api/contracts/${C}`));
    expect(plain).toMatchObject({ proxy: null, verification: null, verified: false });
    expect(body(await get(`/api/contracts/${h(0xb2)}`))).toMatchObject({ origin: "genesis", creator: null, creationBlock: null, creationTxHash: null });
    const source = body(await get(`/api/contracts/${K}/source`));
    expect(source.files).toEqual([{ path: "src/a.sol", content: "contract A {}" }, { path: "src/b.sol", content: "contract Vault {}" }]);
    expect(source).toMatchObject({ verified: true, contractPath: "src/b.sol", settings: { viaIR: true }, abi: [{ type: "function", name: "f" }], constructorArgs: "0x00ff" });
    // Not verified: the same fields, empty.
    const empty = body(await get(`/api/contracts/${C}/source`));
    same(empty, F.source);
    expect(empty).toMatchObject({ verified: false, files: [], abi: null, settings: null, language: null, matchType: null });
    expect(await get(`/api/contracts/${h(0x01)}`)).toEqual({ status: 404, body: { error: NO_CONTRACT } });
    expect(await get(`/api/contracts/${h(0x01)}/source`)).toEqual({ status: 404, body: { error: NO_CONTRACT } });
  });

  it("warns about a partial match, on the contract and on its source, and about nothing else", async () => {
    expect(body(await get(`/api/contracts/${K}/source`)).matchNote).toBeNull();
    expect(body(await get(`/api/contracts/${K}`)).verification.matchNote).toBeNull();
    expect(body(await get(`/api/contracts/${C}/source`)).matchNote).toBeNull();
    await pool.query("update verified_sources set match_type = 'partial' where address = $1", [Buffer.from(K.slice(2), "hex")]);
    try {
      const source = body(await get(`/api/contracts/${K}/source`));
      expect(source).toMatchObject({ matchType: "partial", matchNote: PARTIAL_MATCH_NOTE });
      expect(body(await get(`/api/contracts/${K}`)).verification.matchNote).toBe(PARTIAL_MATCH_NOTE);
      expect(PARTIAL_MATCH_NOTE).toBe("Partial match: the metadata differs from this compile. Code that reads its own or another contract's code (type(X).creationCode/runtimeCode, codecopy, extcodecopy, address(this).code) may act differently from this source's compile; only a full match is byte-for-byte.");
    } finally {
      await pool.query("update verified_sources set match_type = 'full' where address = $1", [Buffer.from(K.slice(2), "hex")]);
    }
  });

  it("lists the logs a contract wrote, newest first, with their transaction and method, and keeps one event kind on a topic", async () => {
    const [any] = (await sql("select address from logs group by address order by count(*) desc limit 1")).rows;
    expect(any).toBeDefined();
    const W = "0x" + (any.address as Buffer).toString("hex");
    const all = await walk(`/api/contracts/${W}/events`, "before", 2);
    expect(all.length).toBeGreaterThan(0);
    same(body(await get(`/api/contracts/${W}/events`)), F.page);
    for (const e of all) { same(e, F.contractEvent); expect(e.address).toBe(W); }
    const order = all.map((e) => [e.block, e.logIndex]);
    expect(order).toEqual([...order].sort((x, y) => y[0] - x[0] || y[1] - x[1]));
    const topic = all[0]!.topics[0];
    const kept = await walk(`/api/contracts/${W}/events?topic0=${topic}`, "before", 2);
    expect(kept.length).toBe(all.filter((e) => e.topics[0] === topic).length);
    expect((await get(`/api/contracts/${W}/events?topic0=0x12`)).status).toBe(400);
    expect(body(await get(`/api/contracts/${h(0x99)}/events`)).items).toEqual([]);
  });

  it("marks the logs of a contract-creation transaction as a creation, with no method, because the first bytes of its input are init code", async () => {
    const [made] = (await sql("select block_number, tx_index from transactions where to_address is null order by block_number, tx_index limit 1")).rows;
    const [call] = (await sql("select block_number, tx_index from transactions where to_address is not null and method_id is not null order by block_number, tx_index limit 1")).rows;
    expect(made).toBeDefined();
    expect(call).toBeDefined();
    const W = Buffer.alloc(20, 0x5e), topic = Buffer.alloc(32, 0x77);
    try {
      for (const [i, r] of [made, call].entries()) {
        await sql("insert into logs (block_number, log_index, tx_index, address, topic0, data) values ($1, $2, $3, $4, $5, $6)", [r.block_number, 900 + i, r.tx_index, W, topic, Buffer.alloc(0)]);
      }
      const items = body(await get(`/api/contracts/0x${W.toString("hex")}/events`)).items as { block: number; txIndex: number; creation: boolean; method: string | null }[];
      expect(items).toHaveLength(2);
      for (const e of items) same(e, F.contractEvent);
      const at = (r: { block_number: string; tx_index: number }) => items.find((e) => e.block === Number(r.block_number) && e.txIndex === r.tx_index)!;
      expect(at(made)).toMatchObject({ creation: true, method: null });
      expect(at(call)).toMatchObject({ creation: false, method: expect.stringMatching(/^0x[0-9a-f]{8}$/) });
    } finally {
      await sql("delete from logs where address = $1", [W]);
    }
  });

  it("answers a token with its numbers, and names the ones it does not hold", async () => {
    expect(body(await get(`/api/tokens/${T1}`))).toMatchObject({ standard: "ERC-20", name: "Test Token", symbol: "TT", decimals: 6, totalSupply: "1000", holderCount: 2, transferCount: 3, firstTransferBlock: 2, balanceMode: "derived" });
    expect(body(await get(`/api/tokens/${T2}`))).toMatchObject({ standard: "ERC-1155", decimals: null, totalSupply: null, gatewayWrapped: false });
    const moved = body(await get(`/api/tokens/${T1}/transfers`)).items as { txHash: string; block: number; amount: string }[];
    expect(moved.map((t) => [t.block, t.amount])).toEqual([[3, "5"], [2, "20"], [2, "10"]]);
    expect(moved[0]!.txHash).toBe(txHash(3, 0));
    for (const p of [`/api/tokens/${h(0x01)}`, `/api/tokens/${h(0x01)}/holders`, `/api/tokens/${h(0x01)}/transfers`, `/api/tokens/${C}`]) expect(await get(p), p).toEqual({ status: 404, body: { error: NO_TOKEN } });
    expect(await get("/api/tokens/zz")).toMatchObject({ status: 400 });
  });

  it("lists the gateway's legs and one leg by its id", async () => {
    const legs = body(await get("/api/legs")).items as { block: number; txHash: string; legId: string; kind: string }[];
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ block: 2, kind: "withdrawal", txHash: txHash(2, 0) });
    expect(body(await get(`/api/legs/${legs[0]!.legId}`))).toEqual(legs[0]);
    expect(await get(`/api/legs/0x${"00".repeat(32)}`)).toEqual({ status: 404, body: { error: NO_LEG } });
    expect(await get("/api/legs/0x12")).toMatchObject({ status: 400 });
  });

  it("names the Canton party a withdrawal paid, and none on any other leg", async () => {
    const legs = body(await get("/api/legs")).items as { kind: string; party: string | null; legId: string }[];
    expect(legs[0]).toMatchObject({ kind: "withdrawal", party: "alice::1220" + "ab".repeat(32) });
    expect(body(await get(`/api/legs/${legs[0]!.legId}`)).party).toBe(legs[0]!.party);
    // A deposit leg has no party column value (the EVM event of a deposit does not name one), so the answer says null, not a missing field.
    await sql("insert into gateway_legs (block_number, leg_index, tx_index, log_index, kind, leg_id, token, account, amount, party) values (3, 0, 0, 0, 1, $1, $2, $3, 5, null)", [Buffer.alloc(32, 7), who(0xb1), who(0xa1)]);
    try {
      const all = body(await get("/api/legs")).items as { kind: string; party: string | null }[];
      expect(all.map((l) => [l.kind, l.party === null])).toEqual([["deposit", true], ["withdrawal", false]]);
      same(all[0]!, F.legItem);
    } finally { await sql("delete from gateway_legs where leg_id = $1", [Buffer.alloc(32, 7)]); }
  });

  it("shows a token's custody on Canton with the registered instrument, and null for a token the gateway did not register", async () => {
    expect(body(await get(`/api/tokens/${T1}`)).canton).toBeNull();
    await sql("insert into gateway_tokens (evm_token, instrument_admin, instrument_id, custody, holdings, supply, supply_block, ledger_offset, read_at) values ($1, 'registry::1220ff', 'TKB', 1230000000000, 3, 123000000, 7, 77, '2026-10-25T10:00:00Z')", [who(0xb1)]);
    try {
      const t = body(await get(`/api/tokens/${T1}`));
      same(t, F.tokenDetail);
      same(t.canton, F.cantonCustody);
      expect(t.canton).toEqual({ instrumentAdmin: "registry::1220ff", instrumentId: "TKB", custody: "1230000000000", custodyDecimals: 10, holdings: 3, supply: "123000000", supplyBlock: 7, ledgerOffset: 77, readAt: "2026-10-25T10:00:00.000Z" });
      expect(body(await get(`/api/tokens/${T2}`)).canton).toBeNull();
      // The list does not carry it: one read of the table is for the one token's page.
      for (const i of body(await get("/api/tokens")).items) expect(i).not.toHaveProperty("canton");
    } finally { await sql("delete from gateway_tokens where evm_token = $1", [who(0xb1)]); }
    expect(body(await get(`/api/tokens/${T1}`)).canton).toBeNull();
  });

  it("shows the twin line of a token a registered vault holds, from the kept totals, with the block they are counted to; null otherwise", async () => {
    expect(body(await get(`/api/tokens/${T1}`)).twin).toBeNull();
    await sql("insert into canton_registry (address, kind, code_hash, admin, ledger_offset) values ($1, 'vault', $2, 'gw::1220ab', 5)", [who(0xc1), Buffer.alloc(32, 1)]);
    await sql("insert into twin_totals (token, locked, released, locks, releases, vault_balance) values ($1, 900, 400, 3, 1, 480)", [who(0xb1)]);
    await sql("insert into meta (key, value) values ('twin_totals_block', '3') on conflict (key) do update set value = excluded.value");
    try {
      const t = body(await get(`/api/tokens/${T1}`));
      same(t, F.tokenDetail);
      same(t.twin, F.twinSupply);
      expect(t.twin).toEqual({ supply: "500", vaultBalance: "480", locks: 3, releases: 1, through: 3 });
      expect(t.twin).not.toHaveProperty("partial");
      expect(body(await get(`/api/tokens/${T2}`)).twin).toBeNull();
      for (const i of body(await get("/api/tokens")).items) expect(i).not.toHaveProperty("twin");
    } finally {
      await sql("delete from twin_totals where token = $1", [who(0xb1)]);
      await sql("delete from canton_registry where address = $1", [who(0xc1)]);
      await sql("delete from meta where key = 'twin_totals_block'");
    }
    expect(body(await get(`/api/tokens/${T1}`)).twin).toBeNull();
  });

  it("serves the twins page from the kept registry, sums and custody read, with every object held to its allowlist; empty with no registry", async () => {
    const empty = body(await get("/api/twins"));
    same(empty, F.twins);
    expect(empty).toEqual({ through: null, vaults: [], twins: [], canton: [], legs: [] });
    await sql("insert into canton_registry (address, kind, code_hash, admin, ledger_offset) values ($1, 'vault', $2, 'gw::1220ab', 5)", [who(0xc1), Buffer.alloc(32, 1)]);
    await sql("insert into canton_twins (token, decimals, ledger_offset) values ($1, 6, 5)", [who(0xb1)]);
    await sql("insert into twin_totals (token, locked, released, locks, releases, vault_balance) values ($1, 900, 400, 3, 1, 500)", [who(0xb1)]);
    await sql("insert into meta (key, value) values ('twin_totals_block', '3') on conflict (key) do update set value = excluded.value");
    await sql("insert into gateway_tokens (evm_token, instrument_admin, instrument_id, custody, holdings, supply, supply_block, ledger_offset, read_at) values ($1, 'registry::1220ff', 'TKB', 1230000000000, 3, 123000000, 7, 77, '2026-10-25T10:00:00Z')", [who(0xb2)]);
    try {
      const t = body(await get("/api/twins"));
      same(t, F.twins);
      expect(t.through).toBe(3);
      expect(t.vaults).toEqual([{ address: h(0xc1), codeHash: "0x" + "01".repeat(32) }]);
      same(t.vaults[0], F.twinVault);
      expect(t.twins).toHaveLength(1);
      same(t.twins[0], F.twinLine);
      expect(t.twins[0]).toMatchObject({ token: T1, decimals: 6, supply: "500", vaultBalance: "500", matched: true, locks: 3, releases: 1, through: 3 });
      expect(t.canton).toHaveLength(1);
      same(t.canton[0], F.twinCanton);
      expect(t.canton[0]).toMatchObject({ token: T2, instrumentId: "TKB", custody: "1230000000000", custodyDecimals: 10, holdings: 3, supply: "123000000", supplyBlock: 7, ledgerOffset: 77 });
      expect(t.legs.length).toBeLessThanOrEqual(20);
      for (const l of t.legs) { same(l, F.twinLeg); expect(["lock", "release"]).toContain(l.twin); }
      expect((await get("/api/twins")).headers?.["cache-control"]).toBe(CACHE_CONTROL.composite);
    } finally {
      await sql("delete from gateway_tokens where evm_token = $1", [who(0xb2)]);
      await sql("delete from twin_totals where token = $1", [who(0xb1)]);
      await sql("delete from canton_twins where token = $1", [who(0xb1)]);
      await sql("delete from canton_registry where address = $1", [who(0xc1)]);
      await sql("delete from meta where key = 'twin_totals_block'");
    }
  });

  it("caches a list for a second and what can still change for a few seconds with a tag, and a miss for nothing", async () => {
    const lists = ["/api/addresses", "/api/addresses?sort=txs", `/api/addresses/${A}/txs`, `/api/addresses/${A}/internal`, `/api/addresses/${A}/token-transfers`, `/api/addresses/${A}/coin-history`, "/api/contracts", "/api/tokens",
      `/api/tokens/${T1}/holders`, `/api/tokens/${T1}/transfers`, "/api/legs", `/api/search?q=${A}`];
    const composites = [`/api/addresses/${A}`, `/api/addresses/${A}/tokens`, `/api/contracts/${K}`, `/api/contracts/${K}/source`, `/api/contracts/${C}/source`, `/api/tokens/${T1}`, `/api/legs/${body(await get("/api/legs")).items[0].legId}`];
    for (const [paths, rule] of [[lists, "list"], [composites, "composite"]] as const) {
      for (const p of paths) {
        const a = await get(p);
        expect(a.status, p).toBe(200);
        expect(a.headers?.["cache-control"], p).toBe(CACHE_CONTROL[rule]);
        expect(a.headers?.etag, p).toMatch(/^"[0-9a-f]{32}"$/);
        expect((await get(p)).headers?.etag, p).toBe(a.headers?.etag);
      }
    }
    // No composite answer of these routes is held for a year: what verification, stage 2 or a later block changes is in every one.
    for (const p of [...lists, ...composites]) expect((await get(p)).headers?.["cache-control"]).not.toContain("immutable");
    for (const p of [`/api/contracts/${h(1)}`, `/api/tokens/${h(1)}`, "/api/addresses/0x1", "/api/contracts?sort=x"]) {
      const miss = await get(p);
      expect(miss.status).toBeGreaterThanOrEqual(400);
      expect(miss.headers?.["cache-control"]).toBeUndefined();
    }
    expect((await get(`/api/addresses/${A}`)).headers?.etag).not.toBe((await get(`/api/addresses/${B}`)).headers?.etag);
  });

  it("says 'not derived yet' while stage 2 is behind stage 1, and that it has caught up when it has", async () => {
    await setCursor(1);
    try {
      for (const p of ["/api/addresses", `/api/addresses/${A}`, `/api/addresses/${A}/internal`, `/api/addresses/${A}/token-transfers`, `/api/addresses/${A}/tokens`, "/api/contracts", `/api/contracts/${K}`,
        "/api/tokens", `/api/tokens/${T1}`, `/api/tokens/${T1}/holders`, `/api/tokens/${T1}/transfers`]) {
        expect(body(await get(p)).derived, p).toBe(false);
      }
      // The legs and the address's transactions are stage 1 facts: they are there as soon as the block is final.
      expect(body(await get("/api/legs")).items).toHaveLength(1);
      expect(body(await get(`/api/addresses/${A}/txs`)).items.length).toBeGreaterThan(0);
    } finally {
      await setCursor(3);
    }
    for (const p of ["/api/addresses", `/api/addresses/${A}`, "/api/contracts", `/api/tokens/${T1}`]) expect(body(await get(p)).derived, p).toBe(true);
  });

  it("orders the holders by the number of their balance, not by its digits, and pages through them once each", async () => {
    const extra = [9, 10, 100, 2].map((v, i) => [who(0xd0 + i), v] as const);
    for (const [h, v] of extra) await sql("insert into token_balances (token, holder, token_id, value, updated_block) values ($1, $2, 0, $3, 3)", [who(0xb1), h, v]);
    try {
      for (const limit of [1, 2, 100]) expect((await walk(`/api/tokens/${T1}/holders`, "before", limit)).map((x) => x.value), `at ${limit}`).toEqual(["100", "60", "40", "10", "9", "2"]);
    } finally {
      for (const [h] of extra) await sql("delete from token_balances where token = $1 and holder = $2", [who(0xb1), h]);
    }
  });

  it("answers 400 to a key that the database would refuse", async () => {
    for (const bad of ["/api/addresses?sort=balance&before=zz:" + A, `/api/addresses/${A}/tokens?after=${T1}:zz`, `/api/addresses/${A}/tokens?after=0xzz${"00".repeat(19)}:0`, "/api/contracts?before=5:9999999999:" + A, `/api/tokens/${T1}/holders?before=1:zz:0`]) {
      expect((await get(bad)).status, bad).toBe(400);
    }
  });

  it("does not say a contract or a token is absent while stage 2 has not reached its block", async () => {
    const X = "0x" + "e7".repeat(20);
    const calls = [`/api/contracts/${X}`, `/api/contracts/${X}/source`, `/api/tokens/${X}`, `/api/tokens/${X}/holders`, `/api/tokens/${X}/transfers`];
    for (const p of calls) {
      const a = await get(p);
      expect(a.status, p).toBe(404);
      expect(body(a).derived, p).toBeUndefined();
    }
    await setCursor(1);
    try {
      for (const p of calls) {
        const a = await get(p);
        expect(a.status, p).toBe(404);
        expect(Object.keys(body(a)), p).toEqual(["error"]);
        expect(body(a).error, p).toContain("stage 2 is at block 1");
        expect(a.headers?.["cache-control"]).toBeUndefined();
      }
    } finally {
      await setCursor(3);
    }
  });

  it("searches the start of a token's name or symbol, or a verified contract's name, as text, and leaves the other shapes as they were", async () => {
    const path = async (q: string) => body(await get(`/api/search?q=${encodeURIComponent(q)}`));
    expect(await path("  Test T ")).toMatchObject({ path: `/token/${T1}`, matches: [{ kind: "token", name: "Test Token", symbol: "TT", address: T1, path: `/token/${T1}` }] });
    expect((await path("gdg")).matches.map((m: { address: string }) => m.address)).toEqual([T2]);
    // A contract that is not a token is found by name only once it is verified.
    expect(await path("vau")).toMatchObject({ path: `/address/${K}`, matches: [{ kind: "contract", name: "Vault", symbol: null, address: K }] });
    expect(await path("gad")).toMatchObject({ path: `/token/${T2}` });
    // The text is not a pattern: a percent sign and an underscore name themselves.
    for (const q of ["%%", "_e", "te_t", "v%"]) expect(await get(`/api/search?q=${encodeURIComponent(q)}`)).toEqual({ status: 404, body: { error: NOT_FOUND } });
    expect(await get("/api/search?q=")).toEqual({ status: 404, body: { error: NOT_FOUND } });
    expect(await get(`/api/search?q=${"x".repeat(80)}`)).toEqual({ status: 404, body: { error: NOT_FOUND } });
    expect(await path(A)).toEqual({ path: `/address/${A}`, matches: [] });
    expect(await path("9")).toEqual(await get("/api/search?q=9").then(body));
  });
  it("names many addresses at once: a token by its name, symbol and standard, a verified contract by its name, and an address nothing is known of by nothing", async () => {
    const nobody = h(0x77);
    const a = await get(`/api/labels?addresses=${T1},${K},${T2},${nobody},${C},${T1}`);
    expect(a.status).toBe(200);
    expect(a.headers?.["cache-control"]).toBe(CACHE_CONTROL.list);
    same(body(a), ["items"]);
    for (const l of body(a).items) same(l, F.label);
    // In the order asked, each address once.
    expect(body(a).items).toEqual([
      { address: T1, name: "Test Token", symbol: "TT", kind: "token", standard: "ERC-20", decimals: 6, verified: false },
      { address: K, name: "Vault", symbol: null, kind: "contract", standard: null, decimals: null, verified: true },
      { address: T2, name: "Gadget", symbol: "GDG", kind: "token", standard: "ERC-1155", decimals: null, verified: false },
      { address: nobody, name: null, symbol: null, kind: null, standard: null, decimals: null, verified: false },
      { address: C, name: null, symbol: null, kind: "contract", standard: null, decimals: null, verified: false },
    ]);
  });

  it("calls an address an account only when the index holds it, and a contract a final creation names even before stage 2 derives it", async () => {
    const fresh = h(0x78);
    const [t] = (await pool.query("select block_number, tx_index from transactions where block_number = 3 and tx_index = 5")).rows;
    await pool.query("update transactions set created_contract = $3 where block_number = $1 and tx_index = $2", [t.block_number, t.tx_index, Buffer.from(fresh.slice(2), "hex")]);
    try {
      const items = body(await get(`/api/labels?addresses=${B},${fresh},${h(0x79)}`)).items;
      expect(items.map((l: { address: string; kind: string | null }) => [l.address, l.kind])).toEqual([[B, "account"], [fresh, "contract"], [h(0x79), null]]);
    } finally {
      await pool.query("update transactions set created_contract = null where block_number = $1 and tx_index = $2", [t.block_number, t.tx_index]);
    }
  });

  it("leaves the token moves out of an address's CSV, which does not write them", async () => {
    const reads = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => /token_transfers/.test(String(typeof c[0] === "string" ? c[0] : (c[0] as { text?: string }).text))).length;
    const spy = vi.spyOn(pool, "query");
    try {
      expect((await get(`/api/addresses/${A}/txs?format=csv`)).status).toBe(200);
      expect(reads(spy)).toBe(0);
      spy.mockClear();
      expect((await get(`/api/addresses/${A}/txs`)).status).toBe(200);
      expect(reads(spy)).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("takes at most 100 addresses to label, each a lowercase 0x address, and at least one", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0")).join(",");
    expect((await get(`/api/labels?addresses=${many(100)}`)).status).toBe(200);
    expect(body(await get(`/api/labels?addresses=${many(100)}`)).items).toHaveLength(100);
    for (const query of ["", "?addresses=", `?addresses=${many(101)}`, `?addresses=${A},nope`, `?addresses=0x${"A".repeat(40)}`, `?addresses=${A},,${B}`]) {
      const a = await get(`/api/labels${query}`);
      expect(a.status, query.slice(0, 40)).toBe(400);
      expect(a.headers?.["cache-control"]).toBeUndefined();
    }
  });

  it("gives each transaction of an address the token moves of its logs: the count, and the first move with its standard", async () => {
    const txs = body(await get(`/api/addresses/${A}/txs`)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const at = (b: number, i: number) => txs.find((t) => t.hash === txHash(b, i))!;
    for (const t of txs) {
      same(t, F.txItem);
      same(t.tokenMoves, F.tokenMoves);
      if (t.tokenMoves.first) same(t.tokenMoves.first, F.tokenMove);
    }
    expect(at(2, 0).tokenMoves).toEqual({ count: 2, more: false, first: { token: T1, amount: "10", tokenId: null, standard: "ERC-20", decimals: 6 } });
    // A batch: two moves of one token, the first with its id.
    expect(at(3, 1).tokenMoves).toEqual({ count: 2, more: false, first: { token: T2, amount: "7", tokenId: "1", standard: "ERC-1155", decimals: null } });
    expect(at(2, 1).tokenMoves).toEqual({ count: 0, more: false, first: null });
  });

  it("says a token move is not known for a block stage 2 has not reached, rather than that there is none", async () => {
    await setCursor(2);
    try {
      const txs = body(await get(`/api/addresses/${A}/txs`)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const t of txs) {
        if (t.block === 3) expect(t.tokenMoves).toBeNull();
        else expect(t.tokenMoves).not.toBeNull();
      }
      expect(txs.some((t) => t.block === 3)).toBe(true);
    } finally {
      await setCursor(3);
    }
  });

  it("reads the token moves of a page in one query, not one for each row", async () => {
    const seen: string[] = [];
    const spy = { query: (text: string, values?: unknown[]) => (seen.push(text), pool.query(text, values)) } as unknown as Pool;
    const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
    const reth = { code: async () => "0x6080", token: async () => null, block: async () => undefined, transaction: async () => null, balanceAt: async () => 0n } as unknown as Reth;
    const api = createApi({ config, reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), accounts: createAccountRest(spy) });
    const a = await api("GET", `/api/addresses/${A}/txs?limit=100`);
    expect((a.body as { items: unknown[] }).items.length).toBeGreaterThan(3);
    expect(seen.filter((t) => /from token_transfers/.test(t))).toHaveLength(1);
  });

  describe("token transfers: method, time and standard, the all-tokens feed, and the filters", () => {
    const ERC721 = h(0xb3);
    const ids = (items: { block: number; logIndex: number; batchIndex: number }[]) => items.map((t) => [t.block, t.logIndex, t.batchIndex]);
    const whole = [[3, 501, 1], [3, 501, 0], [3, 500, 0], [2, 501, 0], [2, 500, 0]];

    it("gives each transfer the method and time of its transaction and the standard of its token, in one query", async () => {
      const seen: string[] = [];
      const spy = { query: (text: string, values?: unknown[]) => (seen.push(text), pool.query(text, values)) } as unknown as Pool;
      const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
      const reth = { code: async () => "0x6080", token: async () => null, block: async () => undefined, transaction: async () => null, balanceAt: async () => 0n } as unknown as Reth;
      const api = createApi({ config, reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), accounts: createAccountRest(spy) });
      for (const path of [`/api/addresses/${A}/token-transfers?limit=100`, `/api/tokens/${T1}/transfers?limit=100`, "/api/token-transfers?limit=100"]) {
        seen.length = 0;
        const a = await api("GET", path);
        expect(a.status).toBe(200);
        expect((a.body as { items: unknown[] }).items.length).toBeGreaterThan(1);
        expect(seen.filter((t) => /from token_transfers/.test(t)), path).toHaveLength(1);
      }
      const rows = (await sql(
        `select x.block_number, x.log_index, x.batch_index, t.method_id, t.to_address, extract(epoch from b.timestamp)::bigint as ts, tk.standard
         from token_transfers x join transactions t on t.block_number = x.block_number and t.tx_index = x.tx_index join blocks b on b.number = x.block_number join tokens tk on tk.address = x.token`,
      )).rows;
      expect(rows).toHaveLength(5);
      const moved = body(await get(`/api/addresses/${A}/token-transfers`)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(moved).toHaveLength(5);
      for (const t of moved) {
        same(t, F.tokenTransferItem);
        const r = rows.find((x) => x.block_number == t.block && x.log_index === t.logIndex && x.batch_index === t.batchIndex)!;
        // A creation's first four bytes of input are code, not a method: none is given.
        expect(t.methodId).toBe(r.to_address === null || r.method_id === null ? null : "0x" + r.method_id.toString("hex"));
        expect(t.timestamp).toBe(Number(r.ts));
        expect(t.standard).toBe(r.standard);
        expect(t.creation).toBe(r.to_address === null);
      }
      expect(moved.map((t) => t.standard)).toEqual(["ERC-1155", "ERC-1155", "ERC-20", "ERC-20", "ERC-20"]);
      expect(moved.some((t) => t.methodId !== null)).toBe(true);
      expect(moved.every((t) => typeof t.timestamp === "number" && t.timestamp > 0)).toBe(true);
    });

    it("says no method for a transaction that created a contract, and no standard for a token it does not know", async () => {
      const [was] = (await sql("select to_address, created_contract from transactions where block_number = 2 and tx_index = 0")).rows;
      await sql("update transactions set to_address = null, created_contract = $1 where block_number = 2 and tx_index = 0", [who(0xc2)]);
      await sql("delete from tokens where address = $1", [who(0xb1)]);
      try {
        const t = (body(await get(`/api/addresses/${A}/token-transfers`)).items as Record<string, any>[]).find((x) => x.block === 2 && x.logIndex === 500)!; // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(t.methodId).toBeNull();
        expect(t.creation).toBe(true);
        expect(t.standard).toBeNull();
        // The same row on the feed carries the flag too; a call does not.
        const f = (body(await get("/api/token-transfers?limit=100")).items as Record<string, any>[]).filter((x) => x.block === 2 && x.logIndex === 500); // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(f.map((x) => x.creation)).toEqual([true]);
        expect((body(await get(`/api/addresses/${A}/token-transfers`)).items as Record<string, any>[]).filter((x) => x.block !== 2 || x.txIndex !== 0).every((x) => x.creation === false)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
      } finally {
        await sql("update transactions set to_address = $1, created_contract = $2 where block_number = 2 and tx_index = 0", [was.to_address, was.created_contract]);
        await sql(
          "insert into tokens (address, standard, name, symbol, decimals, total_supply, total_supply_block, holder_count, transfer_count, first_transfer_block, metadata_status) values ($1, 'ERC-20', 'Test Token', 'TT', 6, 1000, 3, 2, 3, 2, 'read')",
          [who(0xb1)],
        );
      }
    });

    it("lists the transfers of every token, newest first, as one derived keyset-paged list", async () => {
      const feed = body(await get("/api/token-transfers"));
      same(feed, F.derivedPage);
      expect(feed.derived).toBe(true);
      for (const t of feed.items) same(t, F.tokenTransferItem);
      expect(ids(feed.items)).toEqual(whole);
      for (const limit of [1, 2]) expect(ids(await walk("/api/token-transfers", "before", limit) as never)).toEqual(whole);
      expect((await get("/api/token-transfers?limit=0")).status).toBe(400);
      expect((await get("/api/token-transfers?before=nonsense")).status).toBe(400);
    });

    it("is behind the derived mark and cached like the other derived lists", async () => {
      await setCursor(1);
      try {
        expect(body(await get("/api/token-transfers")).derived).toBe(false);
      } finally { await setCursor(3); }
      expect((await get("/api/token-transfers")).headers?.["cache-control"]).toBe(CACHE_CONTROL.list);
    });

    it("filters the feed by standard, each standard on its own rows", async () => {
      const std = async (s: string) => body(await get(`/api/token-transfers?standard=${s}`)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(ids(await std("ERC-20") as never)).toEqual([[3, 500, 0], [2, 501, 0], [2, 500, 0]]);
      expect(ids(await std("ERC-1155") as never)).toEqual([[3, 501, 1], [3, 501, 0]]);
      expect(await std("ERC-721")).toEqual([]);
      await sql("insert into contracts (address, origin, creator, creation_block, creation_tx_index, runtime_code_hash, name) values ($1, 'create', $2, 2, 0, $3, 'Nft')", [who(0xb3), who(0xa1), Buffer.alloc(32, 1)]);
      await sql("insert into tokens (address, standard, name, symbol, holder_count, transfer_count, first_transfer_block, metadata_status) values ($1, 'ERC-721', 'Nft', 'NFT', 1, 1, 3, 'read')", [who(0xb3)]);
      await sql("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) values (3, 502, 0, 2, $1, $2, $3, null, 9)", [who(0xb3), who(0xa1), who(0xa2)]);
      try {
        const nft = await std("ERC-721");
        expect(ids(nft as never)).toEqual([[3, 502, 0]]);
        expect(nft[0]).toMatchObject({ token: ERC721, tokenId: "9", amount: null, standard: "ERC-721" });
        expect(ids(body(await get("/api/token-transfers")).items)).toEqual([[3, 502, 0], ...whole]);
        const walked = await walk("/api/token-transfers?standard=ERC-20", "before", 1);
        expect(ids(walked as never)).toEqual([[3, 500, 0], [2, 501, 0], [2, 500, 0]]);
        // ?standard= on an address's transfers and on a token's own transfers
        expect(ids(body(await get(`/api/addresses/${A}/token-transfers?standard=ERC-721`)).items)).toEqual([[3, 502, 0]]);
      } finally {
        await sql("delete from token_transfers where block_number = 3 and log_index = 502");
        await sql("delete from tokens where address = $1", [who(0xb3)]);
        await sql("delete from contracts where address = $1", [who(0xb3)]);
      }
      expect(await get("/api/token-transfers?standard=ERC20")).toMatchObject({ status: 400 });
      expect(await get("/api/token-transfers?standard=")).toMatchObject({ status: 400 });
    });

    it("filters an address's transfers by token and by standard, and both together", async () => {
      const path = (q: string) => `/api/addresses/${A}/token-transfers?${q}`;
      const list = async (q: string) => ids(body(await get(path(q))).items);
      expect(await list(`token=${T1}`)).toEqual([[3, 500, 0], [2, 501, 0], [2, 500, 0]]);
      expect(await list(`token=${T2}`)).toEqual([[3, 501, 1], [3, 501, 0]]);
      expect(await list("standard=ERC-20")).toEqual([[3, 500, 0], [2, 501, 0], [2, 500, 0]]);
      expect(await list("standard=ERC-1155")).toEqual([[3, 501, 1], [3, 501, 0]]);
      expect(await list("standard=ERC-721")).toEqual([]);
      expect(await list(`token=${T1}&standard=ERC-20`)).toEqual([[3, 500, 0], [2, 501, 0], [2, 500, 0]]);
      expect(await list(`token=${T1}&standard=ERC-1155`)).toEqual([]);
      expect(await list(`token=${h(0xee)}`)).toEqual([]);
      for (const q of [`token=${T1}`, "standard=ERC-20", `token=${T2}&standard=ERC-1155`]) {
        const all = ids((await walk(path(q), "before", 100)) as never);
        for (const limit of [1, 2]) expect(ids((await walk(path(q), "before", limit)) as never), q).toEqual(all);
      }
      for (const q of ["token=0x12", "token=nonsense", "standard=erc-20", "standard=ERC-999"]) expect(await get(path(q)), q).toMatchObject({ status: 400 });
    });

    it("answers the new queries from an index of their own, in order, without filtering rows after the read", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local enable_seqscan = off");
        await client.query("set local enable_bitmapscan = off");
        // Many ERC-20 transfers, a few of the other standards, spread over many senders: what the partial indexes are for. Rolled back with the rest.
        const [first] = (await client.query("select block_number, tx_index from token_transfers order by block_number limit 1")).rows;
        await client.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) select $1, 20000 + g, 0, $2, $3, case when g % 40 = 0 then $4::bytea else decode(repeat(lpad(to_hex(16 + g % 40), 2, '0'), 20), 'hex') end, $5, g, null from generate_series(1, 4000) g", [first.block_number, first.tx_index, who(0xb1), who(0xa1), who(0xa2)]);
        await client.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) select $1, 30000 + g, 0, $2, $3, case when g % 40 = 0 then $4::bytea else decode(repeat(lpad(to_hex(16 + g % 40), 2, '0'), 20), 'hex') end, $5, null, g from generate_series(1, 120) g", [first.block_number, first.tx_index, who(0xb3), who(0xa1), who(0xa2)]);
        await client.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) select $1, 40000 + g, 0, $2, $3, case when g % 40 = 0 then $4::bytea else decode(repeat(lpad(to_hex(16 + g % 40), 2, '0'), 20), 'hex') end, $5, g, g from generate_series(1, 120) g", [first.block_number, first.tx_index, who(0xb2), who(0xa1), who(0xa2)]);
        await client.query("analyze token_transfers");
        const plan = async (text: string, values: unknown[]) => (await client.query(`explain ${text}`, values)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        // Ordered by the index, so no sort; the predicate is the index's own, so no filter on the rows read; and every partition by an index.
        const indexed = (p: string) => { expect(p).toMatch(/Index (Only )?Scan/); expect(p).not.toMatch(/Seq Scan|Sort Key|Filter:/); };
        const feedOf = (cond: string) => `select x.block_number from token_transfers x where ${cond} and ($1::bigint is null or (x.block_number, x.log_index, x.batch_index) < ($1::bigint, $2::int, $3::int)) order by x.block_number desc, x.log_index desc, x.batch_index desc limit 51`;
        const rare = ["x.amount is null", "x.amount is not null and x.token_id is not null"];
        for (const key of [[null, null, null], [3, 501, 0]]) {
          indexed(await plan(feedOf("true"), key));
          for (const cond of rare) indexed(await plan(feedOf(cond), key));
          expect(await plan(feedOf("x.token_id is null"), key)).toMatch(/Index Scan/);
        }
        const side = (extra: string) => `select x.block_number from token_transfers x where x.from_address = $1 ${extra} and (x.block_number, x.log_index, x.batch_index) < (3, 501, 0) order by x.block_number desc, x.log_index desc, x.batch_index desc limit 51`;
        expect(await plan(side("and x.token = $2"), [who(0xa1), who(0xb1)])).toMatch(/from_address_token/);
        // (An address's transfers of one standard are the 0028 indexes' shape, which that migration's own queries use.)
        await client.query("rollback");
      } finally { client.release(); }
    });
  });
  describe("tokens: the standard filter, the counts, who made each, and the supply of a holding; token transfers as CSV", () => {
    const tokenKeys = [...F.derivedPage, "total", "counts", "gatewayCount"];
    const ts = async (block: number) => Number((await sql("select extract(epoch from timestamp)::bigint as ts from blocks where number = $1", [block])).rows[0].ts);

    it("tells the list's total and each standard's count, which a filter does not change, and keeps to the standard asked", async () => {
      const all = body(await get("/api/tokens"));
      same(all, tokenKeys);
      expect(all.counts).toEqual({ "ERC-20": 1, "ERC-721": 0, "ERC-1155": 1 });
      expect(all.total).toBe(2);
      const only = body(await get("/api/tokens?standard=ERC-1155"));
      same(only, tokenKeys);
      expect(only.items.map((t: { address: string }) => NAMES[t.address])).toEqual(["T2"]);
      expect(only.total).toBe(1);
      expect(only.counts).toEqual(all.counts);
      const none = body(await get("/api/tokens?standard=ERC-721"));
      expect(none.items).toEqual([]);
      expect(none.total).toBe(0);
      expect(none.counts).toEqual(all.counts);
      expect((await get("/api/tokens?standard=ERC-99")).status).toBe(400);
      expect((await get("/api/tokens?standard=erc-20")).status).toBe(400);
    });

    it("counts the tokens wrapped by the gateway, keeps the list to them with gateway=true, and leaves the other counts alone", async () => {
      const before = body(await get("/api/tokens"));
      expect(before.gatewayCount).toBe(0);
      expect(body(await get("/api/tokens?gateway=true")).items).toEqual([]);
      expect(body(await get("/api/tokens?gateway=true")).total).toBe(0);
      await sql("update tokens set gateway_wrapped = true where address = $1", [who(0xb2)]);
      try {
        const all = body(await get("/api/tokens"));
        expect(all.gatewayCount).toBe(1);
        expect(all.counts).toEqual(before.counts);
        expect(all.total).toBe(2);
        const g = body(await get("/api/tokens?gateway=true"));
        same(g, tokenKeys);
        expect(mine(g.items)).toEqual(["T2"]);
        expect(g.total).toBe(1);
        expect(g.gatewayCount).toBe(1);
        expect(g.counts).toEqual(before.counts);
        // With a standard: the gateway tokens of that standard, and their own total.
        expect(mine(body(await get("/api/tokens?gateway=true&standard=ERC-1155")).items)).toEqual(["T2"]);
        const none = body(await get("/api/tokens?gateway=true&standard=ERC-20"));
        expect(none.items).toEqual([]);
        expect(none.total).toBe(0);
        for (const sort of ["holders", "transfers", "newest"]) expect(mine(await walk(`/api/tokens?gateway=true&sort=${sort}`, "before", 1)), sort).toEqual(["T2"]);
      } finally { await sql("update tokens set gateway_wrapped = false where address = $1", [who(0xb2)]); }
      for (const v of ["false", "1", "TRUE", ""]) expect((await get(`/api/tokens?gateway=${v}`)).status, v).toBe(400);
    });

    it("pages the list oldest first with order=asc and after, for its last page, in each order and with each filter", async () => {
      for (const sort of ["holders", "transfers", "newest"]) {
        const desc = mine(await walk(`/api/tokens?sort=${sort}`, "before", 1));
        expect(desc).toHaveLength(2);
        expect(mine(await walk(`/api/tokens?sort=${sort}&order=asc`, "after", 1)), sort).toEqual([...desc].reverse());
        expect(mine(await walk(`/api/tokens?sort=${sort}&order=asc&standard=ERC-20`, "after", 1)), sort).toEqual(["T1"]);
        // The key that closes a page asks for the page after it, the way it was walked.
        const first = body(await get(`/api/tokens?sort=${sort}&order=asc&limit=1`));
        expect(first.next).not.toBeNull();
        expect(body(await get(`/api/tokens?sort=${sort}&order=asc&limit=1&after=${first.next}`)).items).toHaveLength(1);
      }
      for (const path of ["/api/tokens?order=up", "/api/tokens?order=ASC", "/api/tokens?order=asc&before=3:1", "/api/tokens?after=2:1", "/api/tokens?order=asc&after=x"]) {
        expect((await get(path)).status, path).toBe(400);
      }
    });

    it("pages the contract list from its other end with order=asc and after, for its last page, in each sort and with each filter", async () => {
      for (const sort of ["interactions", "newest", "oldest"]) {
        const own = mine(await walk(`/api/contracts?sort=${sort}`, "before", 1));
        expect(own, sort).toHaveLength(4);
        expect(mine(await walk(`/api/contracts?sort=${sort}&order=asc`, "after", 1)), sort).toEqual([...own].reverse());
        expect(mine(await walk(`/api/contracts?sort=${sort}&order=asc&verified=true`, "after", 1)), sort).toEqual(["K"]);
        expect(mine(await walk(`/api/contracts?sort=${sort}&order=asc&verified=false`, "after", 1)), sort).toEqual(mine(await walk(`/api/contracts?sort=${sort}&verified=false`, "before", 1)).reverse());
        // The key that closes a page asks for the page after it, the way it was walked.
        const first = body(await get(`/api/contracts?sort=${sort}&order=asc&limit=1`));
        expect(first.next).not.toBeNull();
        expect(body(await get(`/api/contracts?sort=${sort}&order=asc&limit=1&after=${first.next}`)).items).toHaveLength(1);
      }
      for (const path of ["/api/contracts?order=up", "/api/contracts?order=ASC", "/api/contracts?order=asc&before=3:1", "/api/contracts?after=2:1", "/api/contracts?order=asc&after=x", "/api/contracts?sort=newest&order=asc&after=1:2"]) {
        expect((await get(path)).status, path).toBe(400);
      }
    });

    it("pages a filtered list by keyset in each order, without a repeat or a gap", async () => {
      for (const sort of ["holders", "transfers", "newest"]) {
        for (const standard of ["ERC-20", "ERC-1155"]) {
          const got = await walk(`/api/tokens?sort=${sort}&standard=${standard}`, "before", 1);
          expect(mine(got), `${sort} ${standard}`).toEqual([standard === "ERC-20" ? "T1" : "T2"]);
        }
      }
    });

    it("gives each token who made it, in which block and when, and whether its source is verified", async () => {
      const items = body(await get("/api/tokens")).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const t of items) same(t, F.tokenItem);
      const t1 = items.find((t) => NAMES[t.address] === "T1")!, t2 = items.find((t) => NAMES[t.address] === "T2")!;
      expect(t1).toMatchObject({ creator: A, creationBlock: 2, verified: false });
      expect(t1.createdAt).toBe(new Date((await ts(2)) * 1000).toISOString());
      // A token of the genesis state was made by nothing the explorer saw: none of the three is made up.
      expect(t2).toMatchObject({ creator: null, creationBlock: null, createdAt: null, verified: false });
      const [was] = (await sql("select verified_source from contracts where address = $1", [who(0xb2)])).rows;
      const [src] = (await sql("select verified_source from contracts where address = $1", [who(0xc1)])).rows;
      await sql("update contracts set verified_source = $1 where address = $2", [src.verified_source, who(0xb2)]);
      try {
        const now = body(await get(`/api/tokens?standard=ERC-1155`)).items[0];
        expect(now.verified).toBe(true);
        same(body(await get(`/api/tokens/${T2}`)), F.tokenDetail);
        expect(body(await get(`/api/tokens/${T2}`))).toMatchObject({ verified: true, creator: null });
      } finally { await sql("update contracts set verified_source = $1 where address = $2", [was.verified_source, who(0xb2)]); }
    });

    it("gives each holding the token's total supply and decimals, null where the token has none", async () => {
      const items = body(await get(`/api/addresses/${A}/tokens`)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(items).toHaveLength(3);
      for (const x of items) same(x, F.holding);
      expect(items.filter((x) => x.token === T1).map((x) => [x.totalSupply, x.decimals])).toEqual([["1000", 6]]);
      expect(items.filter((x) => x.token === T2).map((x) => [x.totalSupply, x.decimals])).toEqual([[null, null], [null, null]]);
    });

    it("gives an address's token transfers and a token's as a bounded CSV, with the columns of the list", async () => {
      const header = "tx_hash,block,log_index,batch_index,time,method_id,creation,token,standard,from,to,amount,token_id";
      const mineCsv = await get(`/api/addresses/${A}/token-transfers?format=csv`);
      expect(mineCsv.status).toBe(200);
      expect(mineCsv.headers?.["content-type"]).toBe("text/csv; charset=utf-8");
      expect(mineCsv.headers?.["content-disposition"]).toBe(`attachment; filename="token-transfers-${A}.csv"`);
      const lines = String(mineCsv.body).split("\r\n");
      expect(lines[0]).toBe(header);
      expect(lines.at(-1)).toBe("");
      const json = (body(await get(`/api/addresses/${A}/token-transfers`)).items) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(lines.length - 2).toBe(json.length);
      const j0 = json[0]!, first = lines[1]!.split(",");
      expect(first.slice(0, 4)).toEqual([j0.txHash, String(j0.block), String(j0.logIndex), String(j0.batchIndex)]);
      expect(first[4]).toBe(new Date(j0.timestamp * 1000).toISOString());
      expect(first[6]).toBe(String(j0.creation));
      expect(first.slice(7, 13)).toEqual([j0.token, j0.standard, j0.from, j0.to, j0.amount ?? "", j0.tokenId ?? ""]);
      // The filters of the list apply to the file.
      const t1 = String((await get(`/api/addresses/${A}/token-transfers?format=csv&token=${T1}`)).body).split("\r\n");
      expect(t1.length - 2).toBe(json.filter((t) => t.token === T1).length);
      const erc = String((await get(`/api/addresses/${A}/token-transfers?format=csv&standard=ERC-1155`)).body).split("\r\n");
      expect(erc.length - 2).toBe(json.filter((t) => t.standard === "ERC-1155").length);
      // A token's own file, up to the limit asked and not past the cap, with no paging.
      const tokenCsv = await get(`/api/tokens/${T1}/transfers?format=csv&limit=2`);
      expect(tokenCsv.headers?.["content-disposition"]).toBe(`attachment; filename="token-transfers-${T1}.csv"`);
      expect(String(tokenCsv.body).split("\r\n")).toHaveLength(4);
      expect(String(tokenCsv.body).split("\r\n").slice(1, 3).every((l) => l.split(",")[7] === T1)).toBe(true);
      expect(String((await get(`/api/tokens/${T1}/transfers?format=csv`)).body).split("\r\n")).toHaveLength(5);
      // What it cannot say stays honest: a file has no `derived` flag, so it carries one in a header.
      expect(mineCsv.headers?.["x-derived"]).toBe("true");
    });

    it("refuses a CSV format it does not know, a token it does not hold, and a limit that is not a count", async () => {
      expect((await get(`/api/addresses/${A}/token-transfers?format=xml`)).status).toBe(400);
      expect((await get(`/api/tokens/${T1}/transfers?format=xml`)).status).toBe(400);
      expect((await get(`/api/tokens/${h(0xee)}/transfers?format=csv`)).status).toBe(404);
      expect((await get(`/api/addresses/${A}/token-transfers?format=csv&standard=nope`)).status).toBe(400);
      expect((await get(`/api/addresses/${A}/token-transfers?format=csv&limit=0`)).status).toBe(400);
    });

    it("answers the standard filter from an index of its own, in order, without filtering rows after the read", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local enable_seqscan = off");
        const plan = async (text: string, values: unknown[]) => (await client.query("explain " + text, values)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        const list = (col: string) => `select address from tokens where standard = $1 and ($2::bigint is null or (${col}, address) < ($2::bigint, $3::bytea)) order by ${col} desc, address desc limit 26`;
        for (const col of ["holder_count", "transfer_count", "first_transfer_block"]) {
          for (const key of [[null, null], [5, who(0xb1)]]) {
            const p = await plan(list(col), ["ERC-20", ...key]);
            expect(p, col).toMatch(/Index (Only )?Scan/);
            expect(p, col).not.toMatch(/Seq Scan|Sort Key|Filter:/);
          }
        }
        await client.query("rollback");
      } finally { client.release(); }
    });
  });

  describe("address facts, the contracts an address made, and the NFT group of its transfers", () => {
    const F1 = h(0xf1), ts = (block: number) => 1_790_000_000 + block * 3;
    const idsOf = (items: { block: number; logIndex: number; batchIndex: number }[]) => items.map((t) => [t.block, t.logIndex, t.batchIndex]);

    it("gives the creation count and the times of the first and the last block an address was seen in", async () => {
      const detail = body(await get(`/api/addresses/${A}`));
      same(detail, F.addressDetail);
      expect(detail).toMatchObject({ createdCount: 3, createdCountCapped: false, firstSeenBlock: 1, firstSeenTimestamp: ts(1), lastActiveBlock: 3, lastActiveTimestamp: ts(3) });
      expect(body(await get(`/api/addresses/${B}`))).toMatchObject({ createdCount: 0 });
      // An address nothing has touched says what it does not know: no times, no funder, and no contracts made.
      expect(body(await get(`/api/addresses/${h(0xee)}`))).toMatchObject({ createdCount: 0, createdCountCapped: false, firstSeenTimestamp: null, lastActiveTimestamp: null, fundedBy: null });
      expect(Object.keys(body(await get(`/api/addresses/${h(0xee)}`)))).toContain("createdCountCapped");
    });

    it("counts the transfers of an address in each list from the partial indexes of its two sides, never from a scan of the table", async () => {
      // A database of its own, with every index production has, and the rows committed and vacuumed: rows written in an open transaction are not yet all-visible, and
      // the planner then gives an index-only read of the partial index no advantage over a general index of the address with a filter. The partial indexes are there so that
      // a count of one list reads the rows of that list alone, and not the rows of the other list of the same address read and thrown away: an address with many NFT
      // transfers and few ERC-20 ones is counted in its ERC-20 list from the ERC-20 rows, and the other way round.
      const own = await makeDatabase(true);
      try {
        await ensurePartitions(own.pool, { head: 1 });
        const client = await own.pool.connect();
        try {
          const BLOCK = 1, TX = 0;
          let at = 20000;
          // n rows in one list, with the address on the side given, the other side a spread of 40 addresses; log indexes of its own, so that no row repeats another.
          const put = async (side: "from_address" | "to_address", address: Buffer, token: Buffer, n: number, nft: boolean, amount: boolean) => {
            const other = "decode(repeat(lpad(to_hex(16 + g % 40), 2, '0'), 20), 'hex')";
            const [a, b] = side === "from_address" ? ["$4::bytea", other] : [other, "$4::bytea"];
            await client.query(`insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) select $1, ${at} + g, 0, $2, $3, ${a}, ${b}, ${amount ? "g" : "null"}, ${nft ? "g" : "null"} from generate_series(1, ${n}) g`, [BLOCK, TX, token, address]);
            at += n + 1;
          };
          const MOSTLY_NFT = who(0xd1), MOSTLY_ERC20 = who(0xd2);
          for (const side of ["from_address", "to_address"] as const) {
            await put(side, MOSTLY_NFT, who(0xb2), 1500, true, true);
            await put(side, MOSTLY_NFT, who(0xb3), 500, true, false);
            await put(side, MOSTLY_NFT, who(0xb1), 20, false, true);
            await put(side, MOSTLY_ERC20, who(0xb1), 2000, false, true);
            await put(side, MOSTLY_ERC20, who(0xb2), 20, true, true);
            await put(side, MOSTLY_ERC20, who(0xb3), 20, true, false);
          }
          // The background: the many senders and receivers of a real table, so that no address is a large part of it.
          await client.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) select $1, 90000 + g, 0, $2, $3, decode(repeat(lpad(to_hex(16 + g % 97), 2, '0'), 20), 'hex'), decode(repeat(lpad(to_hex(16 + g % 89), 2, '0'), 20), 'hex'), g, null from generate_series(1, 30000) g", [BLOCK, TX, who(0xb1)]);
          await client.query("vacuum analyze token_transfers");
          await client.query("set enable_seqscan = off");
          await client.query("set enable_bitmapscan = off");
          // The partition that holds the rows (the others, ahead of the head, are empty and planned as empty ones are).
          const part = String((await client.query("select tableoid::regclass::text as p from token_transfers limit 1")).rows[0].p);
          const definition = async (name: string) => String((await client.query("select indexdef from pg_indexes where indexname = $1", [name])).rows[0].indexdef);
          for (const [filter, list, predicate, address, count] of [
            [ERC20_TRANSFERS, "erc20", /WHERE \(token_id IS NULL\)$/, MOSTLY_NFT, 40], [NFT_TRANSFERS, "nft", /WHERE \(token_id IS NOT NULL\)$/, MOSTLY_ERC20, 80],
          ] as const) {
            const text = `select ${transferCountSql(filter).replace(/\$3/g, "10000")} as n from (select $1::bytea as address) q`;
            const p = (await client.query("explain " + text, [address])).rows.map((r) => r["QUERY PLAN"]).join("\n");
            expect(p, list).not.toMatch(/Seq Scan/);
            // The predicate is left to the index: no row of the other list is read and filtered away after the read, on either side.
            expect(p, list).not.toMatch(/Filter: \(token_id/);
            for (const col of ["from_address", "to_address"]) {
              // An index read by the address (index-only or not), of the partial index of this list. The partition's index has a name of its own, so it is checked by its definition.
              const node = new RegExp(`Index (?:Only )?Scan using (\\S+) on ${part} [^\\n]*\\n\\s*Index Cond: \\(${col} =`).exec(p);
              expect(node, `${list} ${col}\n${p}`).not.toBeNull();
              const def = await definition(node![1]!);
              expect(def, `${list} ${col}`).toMatch(predicate);
              expect(def, `${list} ${col}`).toMatch(new RegExp(`USING btree \\(${col}[,)]`));
            }
            // Every read of the partition that holds the rows is of a partial index of this list that starts with an address: none is a walk of the feed index in block order.
            for (const m of p.matchAll(new RegExp(`Index (?:Only )?Scan using (\\S+) on ${part} `, "g"))) {
              const def = await definition(m[1]!);
              expect(def, `${list} ${m[1]}`).toMatch(predicate);
              expect(def, `${list} ${m[1]}`).toMatch(/USING btree \((from|to)_address[,)]/);
            }
            // And the count is right: the rows of this list on the two sides of the address, each counted once.
            const [row] = (await client.query(text, [address])).rows;
            expect(Number(row.n), list).toBe(count);
          }
        } finally { client.release(); }
      } finally { await own.drop(); }
    });

    it("stops counting the contracts an address made at a ceiling, and says so", async () => {
      const capped = createAccountRest(pool);
      expect(await capped.address(A, 2)).toMatchObject({ createdCount: 2, createdCountCapped: true });
      expect(await capped.address(A, 3)).toMatchObject({ createdCount: 3, createdCountCapped: false });
    });

    it("counts the token transfers and the NFT transfers an address lists, each up to a ceiling, and is silent past it", async () => {
      // A is in 3 ERC-20 transfers (one of them to itself, listed once) and 2 NFT transfers: the counts are those of the two lists, not the counter of both together.
      const detail = body(await get(`/api/addresses/${A}`));
      same(detail, F.addressDetail);
      expect(detail).toMatchObject({ erc20TransferCount: 3, nftTransferCount: 2 });
      expect(body(await get(`/api/addresses/${B}`))).toMatchObject({ erc20TransferCount: 2, nftTransferCount: 0 });
      expect(body(await get(`/api/addresses/${h(0xee)}`))).toMatchObject({ erc20TransferCount: 0, nftTransferCount: 0 });
      const capped = createAccountRest(pool);
      expect(await capped.address(A, 10, 3)).toMatchObject({ erc20TransferCount: 3, nftTransferCount: 2 });
      expect(await capped.address(A, 10, 2)).toMatchObject({ erc20TransferCount: null, nftTransferCount: 2 });
      expect(await capped.address(A, 10, 1)).toMatchObject({ erc20TransferCount: null, nftTransferCount: null });
    });

    it("says who funded an address only when its first incoming transaction with value is in the block it first appeared in", async () => {
      const [before] = (await sql("select from_address, to_address, value::text as value, status from transactions where block_number = 3 and tx_index = 6")).rows;
      const fund = (value: number, status: number) => sql("update transactions set from_address = $1, to_address = $2, value = $3, status = $4 where block_number = 3 and tx_index = 6", [who(0xa2), who(0xf1), value, status]);
      await sql("insert into addresses (address, first_seen_block, last_active_block, sent_count, received_count, is_contract) values ($1, 3, 3, 0, 1, false)", [who(0xf1)]);
      try {
        await fund(5, 1);
        const funded = body(await get(`/api/addresses/${F1}`)).fundedBy;
        same(funded, F.funding);
        expect(funded).toEqual({ from: B, txHash: txHash(3, 6), block: 3, timestamp: ts(3), value: "5" });
        // A call that moved no value, or a failed one, funded nothing.
        await fund(0, 1);
        expect(body(await get(`/api/addresses/${F1}`)).fundedBy).toBeNull();
        await fund(5, 0);
        expect(body(await get(`/api/addresses/${F1}`)).fundedBy).toBeNull();
        // The address was there before that transaction (a genesis balance, an internal call): the index cannot name its funder.
        await fund(5, 1);
        await sql("update addresses set first_seen_block = 2 where address = $1", [who(0xf1)]);
        expect(body(await get(`/api/addresses/${F1}`)).fundedBy).toBeNull();
      } finally {
        await sql("delete from addresses where address = $1", [who(0xf1)]);
        await sql("update transactions set from_address = $1, to_address = $2, value = $3, status = $4 where block_number = 3 and tx_index = 6", [before.from_address, before.to_address, before.value, before.status]);
      }
    });

    it("lists the contracts an address made, newest first, one page after another", async () => {
      const path = `/api/addresses/${A}/contracts`;
      const answer = body(await get(path));
      same(answer, F.derivedPage);
      for (const c of answer.items) same(c, F.contractItem);
      expect(mine(answer.items)).toEqual(["K", "C", "T1"]);
      expect(answer.items.every((c: { creator: string }) => c.creator === A)).toBe(true);
      expect(mine((await walk(path, "before", 1)) as never)).toEqual(["K", "C", "T1"]);
      expect(mine((await walk(path, "before", 2)) as never)).toEqual(["K", "C", "T1"]);
      // A genesis contract has no creator, and an address that made none has an empty list.
      expect(body(await get(`/api/addresses/${B}/contracts`)).items).toEqual([]);
      expect(body(await get(`/api/addresses/${h(0xee)}/contracts`)).items).toEqual([]);
      expect(await get(`/api/addresses/0x12/contracts`)).toEqual({ status: 400, body: { error: NO_ADDRESS } });
      expect(await get(`${path}?before=nonsense`)).toMatchObject({ status: 400 });
      expect(await get(`${path}?limit=0`)).toMatchObject({ status: 400 });
    });

    it("keeps the transfers of ERC-721 and ERC-1155 together under standard=nft, in one list with one cursor", async () => {
      await sql("insert into contracts (address, origin, creator, creation_block, creation_tx_index, runtime_code_hash, name) values ($1, 'create', $2, 2, 0, $3, 'Nft')", [who(0xb3), who(0xa1), Buffer.alloc(32, 1)]);
      await sql("insert into tokens (address, standard, name, symbol, holder_count, transfer_count, first_transfer_block, metadata_status) values ($1, 'ERC-721', 'Nft', 'NFT', 1, 1, 3, 'read')", [who(0xb3)]);
      await sql("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id) values (3, 502, 0, 2, $1, $2, $3, null, 9)", [who(0xb3), who(0xa1), who(0xa2)]);
      try {
        const path = (q: string) => `/api/addresses/${A}/token-transfers?${q}`;
        const nft = [[3, 502, 0], [3, 501, 1], [3, 501, 0]];
        expect(idsOf(body(await get(path("standard=nft"))).items)).toEqual(nft);
        expect(body(await get(path("standard=nft"))).items.map((t: { standard: string }) => t.standard)).toEqual(["ERC-721", "ERC-1155", "ERC-1155"]);
        for (const limit of [1, 2]) expect(idsOf((await walk(path("standard=nft"), "before", limit)) as never)).toEqual(nft);
        expect(idsOf(body(await get(path(`standard=nft&token=${T2}`))).items)).toEqual([[3, 501, 1], [3, 501, 0]]);
        expect(idsOf(body(await get(path("standard=ERC-20"))).items)).toEqual([[3, 500, 0], [2, 501, 0], [2, 500, 0]]);
        const csv = String((await get(path("standard=nft&format=csv"))).body).split("\r\n");
        expect(csv.length - 2).toBe(nft.length);
        // The group is for an address's list: the all-token feed takes the three standards.
        expect(await get("/api/token-transfers?standard=nft")).toMatchObject({ status: 400 });
        expect(await get(path("standard=nfts"))).toMatchObject({ status: 400 });
      } finally {
        await sql("delete from token_transfers where block_number = 3 and log_index = 502");
        await sql("delete from tokens where address = $1", [who(0xb3)]);
        await sql("delete from contracts where address = $1", [who(0xb3)]);
      }
    });

    it("tells a creation from a call with no input in the CSV of token transfers", async () => {
      const rowsOf = async () => String((await get(`/api/addresses/${A}/token-transfers?format=csv`)).body).split("\r\n").slice(1, -1).map((l) => l.split(","));
      const [was] = (await sql("select to_address, created_contract from transactions where block_number = 2 and tx_index = 0")).rows;
      // A call: every row says false.
      expect((await rowsOf()).map((c) => c[6])).toEqual((await rowsOf()).map(() => "false"));
      // A transaction that created a contract: its transfers say true, and only those, as the JSON's `creation` does.
      await sql("update transactions set to_address = null, created_contract = $1 where block_number = 2 and tx_index = 0", [who(0xc2)]);
      try {
        const csv = await rowsOf();
        const json = body(await get(`/api/addresses/${A}/token-transfers`)).items as { block: number; logIndex: number; batchIndex: number; creation: boolean }[];
        expect(csv.map((c) => c[6])).toEqual(json.map((t) => String(t.creation)));
        const made = csv.filter((c) => c[1] === "2" && c[2] === "500");
        expect(made.length).toBeGreaterThan(0);
        for (const c of made) expect(c[6]).toBe("true");
        expect(csv.filter((c) => c[6] === "true").length).toBe(json.filter((t) => t.creation).length);
      } finally {
        await sql("update transactions set to_address = $1, created_contract = $2 where block_number = 2 and tx_index = 0", [was.to_address, was.created_contract]);
      }
    });
  });

  describe("contract facts: the event count and times, the list's totals and who made each, and how a source was verified", () => {
    const ts = async (block: number) => Number((await sql("select extract(epoch from timestamp)::bigint as ts from blocks where number = $1", [block])).rows[0].ts);
    const count = async (where = "true") => Number((await sql(`select count(*) as n from contracts where ${where}`)).rows[0].n);

    it("tells the list's total and the count of each filter, which a filter does not change, and keeps to the filter asked", async () => {
      const all = await count(), verified = await count("verified_source is not null");
      expect(all).toBeGreaterThanOrEqual(4);
      expect(verified).toBe(1);
      const first = body(await get("/api/contracts"));
      same(first, F.contractPage);
      expect(first).toMatchObject({ total: all, counts: { all, verified, notVerified: all - verified } });
      expect(body(await get("/api/contracts?verified=true"))).toMatchObject({ total: verified, counts: { all, verified, notVerified: all - verified } });
      expect(body(await get("/api/contracts?verified=false"))).toMatchObject({ total: all - verified, counts: { all, verified, notVerified: all - verified } });
      // Each sort says the same, and the count comes from the table whole, not from the page.
      for (const sort of ["interactions", "newest", "oldest"]) expect(body(await get(`/api/contracts?sort=${sort}&limit=1`))).toMatchObject({ total: all, counts: { all } });
    });

    it("gives each contract in the list the compiler of its source and when it was made, and neither for what has none", async () => {
      const items = body(await get("/api/contracts?sort=interactions")).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const c of items) same(c, F.contractItem);
      const at = (a: string) => items.find((c) => c.address === a)!;
      expect(at(K)).toMatchObject({ compilerVersion: "v0.8.30+commit.73712a01", creationBlock: 3 });
      expect(at(K).createdAt).toBe(new Date((await ts(3)) * 1000).toISOString());
      expect(at(C)).toMatchObject({ compilerVersion: null, creationBlock: 2 });
      expect(at(C).createdAt).toBe(new Date((await ts(2)) * 1000).toISOString());
      // A contract of the genesis state was made by nothing the explorer saw.
      expect(at(h(0xb2))).toMatchObject({ compilerVersion: null, creationBlock: null, createdAt: null });
      expect(body(await get(`/api/addresses/${A}/contracts`)).items.every((c: Record<string, unknown>) => "createdAt" in c && "compilerVersion" in c)).toBe(true);
    });

    it("counts a contract's events, and times each", async () => {
      const txs = (await sql("select block_number, tx_index from transactions order by block_number, tx_index")).rows;
      expect(new Set(txs.map((t) => t.block_number)).size).toBeGreaterThan(1);
      const topic = Buffer.alloc(32, 0x79), W = who(0xc1);
      try {
        for (const [i, t] of [txs[0], txs[txs.length - 1], txs[txs.length - 1]].entries()) {
          await sql("insert into logs (block_number, log_index, tx_index, address, topic0, data) values ($1, $2, $3, $4, $5, ''::bytea)", [t.block_number, 3000 + i, t.tx_index, W, topic]);
        }
        const detail = body(await get(`/api/contracts/${K}`));
        expect(detail).toMatchObject({ eventCount: 3, eventCountCapped: false });
        same(detail, F.contractDetail);
        expect(body(await get(`/api/contracts/${C}`))).toMatchObject({ eventCount: 0, eventCountCapped: false });
        const items = body(await get(`/api/contracts/${K}/events`)).items as { block: number; timestamp: number }[];
        expect(items).toHaveLength(3);
        expect(new Set(items.map((e) => e.block)).size).toBe(2);
        for (const e of items) expect(e.timestamp).toBe(await ts(e.block));
      } finally { await sql("delete from logs where address = $1 and topic0 = $2", [W, topic]); }
    });

    it("stops counting a contract's events at a ceiling, and says so", async () => {
      const W = Buffer.alloc(20, 0x5f), topic = Buffer.alloc(32, 0x78);
      const [tx] = (await sql("select block_number, tx_index from transactions order by block_number, tx_index limit 1")).rows;
      await sql("insert into bytecodes (code_hash, code, size) values ($1, $2, 2) on conflict do nothing", [Buffer.alloc(32, 1), Buffer.from("6080", "hex")]);
      await sql("insert into contracts (address, origin, runtime_code_hash, interaction_count) values ($1, 'genesis', $2, 0)", [W, Buffer.alloc(32, 1)]);
      try {
        await sql("insert into logs (block_number, log_index, tx_index, address, topic0, data) select $2, 2000 + g, $3, $1, $4, ''::bytea from generate_series(1, 5) g", [W, tx.block_number, tx.tx_index, topic]);
        expect(body(await get(`/api/contracts/0x${W.toString("hex")}`))).toMatchObject({ eventCount: 5, eventCountCapped: false });
        const capped = createAccountRest(pool);
        expect(await capped.eventCountOf(`0x${W.toString("hex")}`, 3)).toEqual({ count: 3, capped: true });
        expect(await capped.eventCountOf(`0x${W.toString("hex")}`, 5)).toEqual({ count: 5, capped: false });
      } finally {
        await sql("delete from logs where address = $1", [W]);
        await sql("delete from contracts where address = $1", [W]);
      }
    });

    it("serves how a source was verified and the tool named, and null for a source from before it was kept", async () => {
      expect(body(await get(`/api/contracts/${K}`)).verification).toMatchObject({ method: null, tool: null });
      expect(body(await get(`/api/contracts/${K}/source`))).toMatchObject({ method: null, tool: null });
      await sql("update verified_sources set method = 'etherscan', tool = 'forge' where address = $1", [who(0xc1)]);
      try {
        expect(body(await get(`/api/contracts/${K}`)).verification).toMatchObject({ method: "etherscan", tool: "forge" });
        expect(body(await get(`/api/contracts/${K}/source`))).toMatchObject({ method: "etherscan", tool: "forge" });
        same(body(await get(`/api/contracts/${K}/source`)), F.source);
        await sql("update verified_sources set method = 'api', tool = null where address = $1", [who(0xc1)]);
        expect(body(await get(`/api/contracts/${K}`)).verification).toMatchObject({ method: "api", tool: null });
      } finally { await sql("update verified_sources set method = null, tool = null where address = $1", [who(0xc1)]); }
    });
  });
});
