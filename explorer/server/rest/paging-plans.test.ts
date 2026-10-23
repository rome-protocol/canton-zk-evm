import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createAccountRest } from "./account-rest.ts";
import { ensurePartitions } from "../db/partitions.ts";
import { createChainRest } from "./chain-rest.ts";

/**
 * A keyset page must cost its own rows, not the table: the comparison on the key is an index condition. The queries are the real ones, recorded as the
 * routes' code sends them, and each is explained with sequential scans off (the tables here are empty, so the planner's own pick says nothing).
 */
describe.skipIf(!TEST_URL)("the keyset pages read through an index", () => {
  checkRequired();
  let db: TestDatabase, pool: Pool;
  const seen: { sql: string; values: unknown[] }[] = [];
  const recording = (): Pool => ({ query: (sql: string, values?: unknown[]) => { seen.push({ sql, values: values ?? [] }); return pool.query(sql, values); } }) as unknown as Pool;

  beforeAll(async () => { db = await makeDatabase(true); pool = db.pool; });
  afterAll(async () => { await db?.drop(); });

  async function plan(match: RegExp): Promise<string> {
    const q = seen.filter((s) => match.test(s.sql)).at(-1);
    expect(q, String(match)).toBeDefined();
    const c = await pool.connect();
    try {
      await c.query("set enable_seqscan = off");
      return (await c.query(`explain ${q!.sql}`, q!.values)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    } finally { c.release(); }
  }
  const addr = "0x" + "ab".repeat(20);

  it("Canton updates: the key is compared on the record time itself", async () => {
    await createChainRest(recording()).updates([1700000000000000, "u1"], 10);
    expect(await plan(/from canton_updates u join/)).toMatch(/Index Cond: \(ROW\(record_time, update_id\) </);
  });

  it("Canton updates around one: each side is a range on the record time index, not a scan", async () => {
    await createChainRest(recording()).around(1700000000000000, "u1", 3);
    const newer = await plan(/\(u\.record_time, u\.update_id\) > /);
    expect(newer).toMatch(/Index Cond: \(ROW\(record_time, update_id\) >/);
    expect(newer).not.toMatch(/Seq Scan on canton_updates/);
    const older = await plan(/\(u\.record_time, u\.update_id\) < /);
    expect(older).toMatch(/Index Cond: \(ROW\(record_time, update_id\) </);
  });

  it("the transactions list pages through the index of its filter", async () => {
    const chain = createChainRest(recording());
    await ensurePartitions(pool, { head: 100 });
    // The filters' indexes are partial, so the predicate is not a Filter line: a scan with no Filter on the filter's column and not on the primary key is a scan of the filter's own index.
    const own = (p: string) => { expect(p).toMatch(/Index Scan using transactions_p\d+_block_number_tx_index_idx/); expect(p).not.toMatch(/transactions_p\d+_pkey|Filter: \(?(status|method_id)/); };
    await chain.txs([50, 3], 10, "failed");
    own(await plan(/t\.status = 0/));
    await chain.txs([50, 3], 10, "calls");
    own(await plan(/t\.method_id is not null/));
  });

  it("the blocks list pages through the index of its filter", async () => {
    const chain = createChainRest(recording());
    await chain.blocks(50, 10, "empty");
    expect(await plan(/b\.tx_count = 0 and b\.number > 0/)).toMatch(/blocks_empty_idx/);
    await chain.blocks(50, 10, "transactions");
    expect(await plan(/b\.tx_count > 0/)).toMatch(/blocks_with_txs_idx/);
  });

  it("the feed of every token's transfers reads the partial index of its standard, or the primary key, with no sort and no filter on the transfers", async () => {
    const accounts = createAccountRest(recording());
    // The route's own query (the key-page CTE, then the joins): the transfers are read through the index that holds exactly the rows of the standard, newest first.
    // The partial feed index of a partition is named after its columns (so told from the primary key by name, and by the predicate it makes a filter needless).
    const FEED = /Index Only Scan using token_transfers_p\d+_block_number_log_index_batch_index_idx\d*/;
    for (const [standard, where, idx] of [
      [null, "where true", /Index Only Scan Backward using token_transfers_p\d+_pkey/],
      ["ERC-20", "where x.token_id is null", FEED],
      ["ERC-721", "where x.amount is null", FEED],
      ["ERC-1155", "where x.amount is not null and x.token_id is not null", FEED],
    ] as const) {
      await accounts.allTransfers(standard, [5, 1, 0], 10);
      const p = await plan(new RegExp(`with k as \\(select x\\.block_number, x\\.log_index, x\\.batch_index from token_transfers x ${where.replace(/[.\\]/g, "\\$&")}\\s+and`));
      expect(p, String(standard)).toMatch(idx);
      expect(p, String(standard)).toMatch(/Index Cond: \(ROW\(block_number, log_index, batch_index\) </);
      expect(p, String(standard)).not.toMatch(/Sort Key|Seq Scan|^\s*Filter:/m);
    }
  });

  it("contracts by place, tokens by first transfer, and an address's holdings", async () => {
    const accounts = createAccountRest(recording());
    await accounts.contracts("newest", null, [5, 1, addr], 10);
    expect(await plan(/coalesce\(c\.creation_block, 0\) desc/)).toMatch(/Index Cond: \(ROW\(COALESCE\(creation_block/);
    await accounts.contracts("oldest", null, [5, 1, addr], 10);
    expect(await plan(/coalesce\(c\.creation_block, 0\) asc/)).toMatch(/Index Cond: \(ROW\(COALESCE\(creation_block/);
    await accounts.tokens("newest", [5, addr], 10);
    expect(await plan(/order by tk\.first_transfer_block desc/)).toMatch(/Index Cond: \(ROW\(first_transfer_block, address\) </);
    await accounts.holdings(addr, [addr, "0"], 10);
    expect(await plan(/b\.holder = \$1/)).toMatch(/token_balances_holdings_idx/);
  });

  it("an address's page of transactions reads each of its three keys, sent, received and created, through an index that is the page's own order", async () => {
    await ensurePartitions(pool, { head: 1 }); // the tables of a fresh database have no partition, and a plan over none says nothing
    const accounts = createAccountRest(recording());
    await accounts.addressTxs(addr, [5, 1], 10);
    const text = await plan(/with k as \(\(select block_number, tx_index from transactions where from_address/);
    for (const key of ["from_address", "to_address", "created_contract"]) expect(text, key).toMatch(new RegExp(`Index (Only )?Scan using \\w*${key}_block_number_tx_index_idx`));
    // not the primary key walked backwards with the address as a filter, which reads the whole table for an address that never created anything
    expect(text).not.toMatch(/Index Scan Backward using \w*_pkey/);
  });

  it("a contract's events page through an index that is the page's own order, with or without one kind of event", async () => {
    await ensurePartitions(pool, { head: 1 });
    const accounts = createAccountRest(recording());
    const topic = "0x" + "cd".repeat(32);
    await accounts.contractEvents(addr, null, [5, 1], 10);
    const all = await plan(/from logs l join transactions t/);
    expect(all).toMatch(/Index Scan using logs_p\d+_address_block_number_log_index_idx/);
    expect(all).toMatch(/Index Cond: .*ROW\(block_number, log_index\) </s);
    await accounts.contractEvents(addr, topic, [5, 1], 10);
    const kind = await plan(/from logs l join transactions t/);
    expect(kind).toMatch(/Index Scan using logs_p\d+_address_topic0_block_number_log_index_idx/);
    expect(kind).toMatch(/Index Cond: .*topic0 = .*ROW\(block_number, log_index\) </s);
  });

  it("the lists sorted on a count or a balance page by their own index, with the address as the tie-breaker", async () => {
    const accounts = createAccountRest(recording());
    await accounts.addresses("balance", [5, addr], 10);
    expect(await plan(/order by a\.coin_balance desc, a\.address desc/)).toMatch(/Index Cond: \(ROW\(coin_balance, address\) </);
    await accounts.addresses("txs", [5, addr], 10);
    expect(await plan(/order by \(a\.sent_count \+ a\.received_count\) desc, a\.address desc/)).toMatch(/Index Cond: \(ROW\(\(sent_count \+ received_count\), address\) </);
    await accounts.contracts("interactions", null, [5, addr], 10);
    expect(await plan(/order by c\.interaction_count desc, c\.address desc/)).toMatch(/Index Cond: \(ROW\(interaction_count, address\) </);
    await accounts.tokens("holders", [5, addr], 10);
    expect(await plan(/order by tk\.holder_count desc, tk\.address desc/)).toMatch(/Index Cond: \(ROW\(holder_count, address\) </);
    await accounts.tokens("transfers", [5, addr], 10);
    expect(await plan(/order by tk\.transfer_count desc, tk\.address desc/)).toMatch(/Index Cond: \(ROW\(transfer_count, address\) </);
    // The same lists kept to one standard read the index of that standard, as the real query (with its join to the contract) runs.
    for (const [sort, col, idx] of [["holders", "holder_count", "tokens_standard_holder_count_idx"], ["transfers", "transfer_count", "tokens_standard_transfer_count_idx"], ["newest", "first_transfer_block", "tokens_standard_first_transfer_idx"]] as const) {
      await accounts.tokens(sort, [5, addr], 10, "ERC-721");
      const p = await plan(new RegExp(`tk\\.standard = \\$4 order by tk\\.${col} desc`));
      expect(p, sort).toContain(idx);
      expect(p, sort).not.toMatch(/Sort Key|Seq Scan on tokens/);
    }
    // Kept to the tokens the gateway wrapped: the partial index of the sort, and with a standard too (its rows are few, so the standard is a filter on them).
    for (const [sort, col, idx] of [["holders", "holder_count", "tokens_gateway_holder_count_idx"], ["transfers", "transfer_count", "tokens_gateway_transfer_count_idx"], ["newest", "first_transfer_block", "tokens_gateway_first_transfer_idx"]] as const) {
      await accounts.tokens(sort, [5, addr], 10, null, true);
      const p = await plan(new RegExp(`and tk\\.gateway_wrapped order by tk\\.${col} desc`));
      expect(p, sort).toContain(idx);
      expect(p, sort).not.toMatch(/Sort Key|Seq Scan on tokens|Filter:/);
      await accounts.tokens(sort, [5, addr], 10, "ERC-20", true);
      const both = await plan(new RegExp(`tk\\.standard = \\$4 and tk\\.gateway_wrapped order by tk\\.${col} desc`));
      expect(both, sort).toMatch(/Index Scan using tokens_(gateway|standard)_\w+_idx on tokens/);
      expect(both, sort).not.toMatch(/Sort Key|Seq Scan on tokens/);
    }
    // The last page: the same indexes, read backward, for the list and for each standard and the gateway's.
    for (const [sort, col, idx, std] of [["holders", "holder_count", "tokens_standard_holder_count_idx", "tokens_gateway_holder_count_idx"], ["transfers", "transfer_count", "tokens_standard_transfer_count_idx", "tokens_gateway_transfer_count_idx"], ["newest", "first_transfer_block", "tokens_standard_first_transfer_idx", "tokens_gateway_first_transfer_idx"]] as const) {
      await accounts.tokens(sort, [5, addr], 10, null, false, "asc");
      const all = await plan(new RegExp(`order by tk\\.${col} asc, tk\\.address asc`));
      expect(all, sort).toMatch(new RegExp(`Index Scan Backward using tokens_\\w*${col === "first_transfer_block" ? "first_transfer" : col}\\w*idx on tokens`));
      expect(all, sort).toMatch(/Index Cond: \(ROW\(\w+, address\) >/);
      expect(all, sort).not.toMatch(/Sort Key|Seq Scan on tokens/);
      await accounts.tokens(sort, [5, addr], 10, "ERC-721", false, "asc");
      const one = await plan(new RegExp(`tk\\.standard = \\$4 order by tk\\.${col} asc`));
      expect(one, sort).toContain(idx);
      expect(one, sort).not.toMatch(/Sort Key|Seq Scan on tokens/);
      await accounts.tokens(sort, [5, addr], 10, null, true, "asc");
      const g = await plan(new RegExp(`and tk\\.gateway_wrapped order by tk\\.${col} asc`));
      expect(g, sort).toContain(std);
      expect(g, sort).not.toMatch(/Sort Key|Seq Scan on tokens/);
    }
    await accounts.holders(addr, ["7", addr, "0"], 10);
    expect(await plan(/order by b\.value desc, b\.holder desc, b\.token_id desc/)).toMatch(/Index Cond: .*ROW\(value, holder, token_id\) </s);
  });
});
