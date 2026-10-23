import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi, NOT_FOUND, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createIndexer } from "../indexer/indexer.ts";
import type { Reth } from "../reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createAccountRest } from "./account-rest.ts";
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
    same(contracts, F.derivedPage);
    for (const c of contracts.items) same(c, F.contractItem);
    const vault = body(await get(`/api/contracts/${K}`));
    same(vault, F.contractDetail);
    same(vault.proxy, F.proxy);
    same(vault.verification, F.verification);
    const source = body(await get(`/api/contracts/${K}/source`));
    same(source, F.source);
    for (const f of source.files) same(f, F.sourceFile);
    const tokens = body(await get("/api/tokens"));
    same(tokens, F.derivedPage);
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
});
