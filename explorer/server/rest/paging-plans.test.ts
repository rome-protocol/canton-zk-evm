import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createAccountRest } from "./account-rest.ts";
import { ensurePartitions } from "../db/partitions.ts";
import { createChainRest } from "./chain-rest.ts";
import { createTwinsRest } from "./twins-rest.ts";

/**
 * A keyset page must cost its own rows, not the table: the comparison on the key is an index condition. The queries are the real ones, recorded as the
 * routes' code sends them, and each is explained with sequential and bitmap scans off (the tables here are empty, so the planner's own pick says nothing).
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
      // set local inside a transaction that is rolled back: no pooled client keeps the settings
      await c.query("begin");
      await c.query("set local enable_seqscan = off");
      await c.query("set local enable_bitmapscan = off");
      return (await c.query(`explain ${q!.sql}`, q!.values)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    } finally { await c.query("rollback").catch(() => undefined); c.release(); }
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

  it("the contract list's last page reads the same indexes backward, in each sort and with the verified filter", async () => {
    const accounts = createAccountRest(recording());
    // Newest from the other end reads oldest first and oldest from the other end reads newest first: the one index of the place, both ways. The most-interactions index is read backward.
    await accounts.contracts("newest", null, [5, 1, addr], 10, "asc");
    const newest = await plan(/coalesce\(c\.creation_block, 0\) asc, coalesce\(c\.creation_tx_index, 0\) asc, c\.address asc/);
    expect(newest).toMatch(/Index Cond: \(ROW\(COALESCE\(creation_block/);
    expect(newest).not.toMatch(/Seq Scan|Sort Key/);
    await accounts.contracts("oldest", null, [5, 1, addr], 10, "asc");
    const oldest = await plan(/coalesce\(c\.creation_block, 0\) desc, coalesce\(c\.creation_tx_index, 0\) desc, c\.address desc/);
    expect(oldest).toMatch(/Index Cond: \(ROW\(COALESCE\(creation_block/);
    expect(oldest).not.toMatch(/Seq Scan|Sort Key/);
    await accounts.contracts("interactions", null, [5, addr], 10, "asc");
    const busy = await plan(/order by c\.interaction_count asc, c\.address asc/);
    expect(busy).toMatch(/Index Scan Backward using contracts_interaction_count_address_idx on contracts/);
    expect(busy).toMatch(/Index Cond: \(ROW\(interaction_count, address\) >/);
    expect(busy).not.toMatch(/Seq Scan|Sort Key/);
    await accounts.contracts("interactions", true, [5, addr], 10, "asc");
    expect(await plan(/order by c\.interaction_count asc, c\.address asc/)).not.toMatch(/Seq Scan|Sort Key/);
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

  it("an address's facts read through indexes of their own: its funder, the contracts it made and how many", async () => {
    await ensurePartitions(pool, { head: 1 });
    const accounts = createAccountRest(recording());
    await accounts.address(addr);
    const facts = await plan(/left join lateral/);
    // The funder: the partial index of transactions that carried value (a second index on the address, named after the first's), read oldest first and stopped at one row,
    // with no filter on the rows read and no sort. The creations are counted from the index of the creator, without the table.
    expect(facts).toMatch(/Index Scan using transactions_p\d+_to_address_block_number_tx_index_idx\d+ on transactions_p\d+ t_\d+/);
    expect(facts).toMatch(/Index Only Scan using contracts_creator_place_idx on contracts k/);
    expect(facts).not.toMatch(/Seq Scan|Sort Key|^\s*Filter:/m);
    await accounts.contractsMadeBy(addr, [5, 1, addr], 10);
    const made = await plan(/where c\.creator = \$1/);
    expect(made).toMatch(/Index Scan using contracts_creator_place_idx on contracts c/);
    expect(made).toMatch(/Index Cond: \(\(creator = .*ROW\(COALESCE\(creation_block/);
    expect(made).not.toMatch(/Seq Scan|Sort Key|^\s*Filter:/m);
  });

  it("an address's token transfers of one token, of a standard, or of the NFT group read the index of the filter on both sides, with no filter on the rows read", async () => {
    await ensurePartitions(pool, { head: 1 });
    // Many ERC-20 transfers over many senders, and a few (spread thin, so that a token is far fewer than the rows of its address) of each other: with no rows the planner's pick of an index says nothing. The rows go in the way the
    // account tests put them in, and out again at the end.
    const rows = (token: number, amount: string, id: string, count: number) => pool.query(
      `insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount, token_id)
       select 1, $2::int + g, 0, 0, decode(repeat(lpad(to_hex($1::int), 2, '0'), 20), 'hex'), decode(repeat(lpad(to_hex(16 + g % 40), 2, '0'), 20), 'hex'), decode(repeat(lpad(to_hex(16 + (g + 7) % 40), 2, '0'), 20), 'hex'), ${amount}, ${id} from generate_series(1, $3::int) g`,
      [token, token * 100000, count],
    );
    await rows(0x31, "1", "null", 3000);
    await rows(0x32, "null", "g", 60);
    await rows(0x33, "1", "g", 60);
    await rows(0x34, "1", "null", 60);
    await pool.query("analyze token_transfers");
    try {
      await transferPlans();
    } finally {
      await pool.query("delete from token_transfers where block_number = 1");
    }
  });

  async function transferPlans(): Promise<void> {
    const accounts = createAccountRest(recording());
    const who = "0x" + "11".repeat(20), tok = "0x" + "34".repeat(20);
    // The partition that holds rows (the first) reads, on each side, an index-only scan of the index of the filter (the partial index of the standard, which the plan does not name, or the one of the token), with the address and the key as its index condition; the
    // other partitions are empty here, so what the planner picks for them says nothing. The one sort is the page's own, over at most two pages of keys.
    const sides = (p: string, index: string) => {
      for (const side of ["from", "to"]) {
        const line = p.split("\n").findIndex((l) => new RegExp(`Index Only Scan using token_transfers_p000000_${side}_${index}\\w* on token_transfers_p000000`).test(l));
        expect(line, `${side} ${index}\n${p}`).toBeGreaterThanOrEqual(0);
        expect(p.split("\n")[line + 2] ?? "").not.toMatch(/Filter:/);
        expect(p.split("\n")[line + 1]).toMatch(new RegExp(`Index Cond: \\(\\(${side}_address = .*ROW\\(block_number, log_index, batch_index\\) <`));
      }
      expect(p).not.toMatch(/Seq Scan on token_transfers/);
      expect(p.match(/Sort Key/g)?.length).toBe(1);
    };
    const cases: [{ token?: string; standard?: "ERC-20" | "ERC-721" | "ERC-1155" | "nft" }, string][] = [
      [{ token: tok }, "address_token"], [{ standard: "ERC-20" }, "address_block_number_log_"], [{ standard: "ERC-721" }, "address_block_number_log_"], [{ standard: "ERC-1155" }, "address_block_number_log_"], [{ standard: "nft" }, "address_block_number_log_"],
    ];
    for (const [filter, index] of cases) {
      await accounts.addressTransfers(who, [5, 1, 0], 10, filter);
      sides(await plan(/with k as \(\(select x\.block_number, x\.log_index, x\.batch_index from token_transfers x where x\.from_address/), index);
    }
  }

  it("a contract's event count, the contract list's counts and the facts joined to each listed contract read an index each, never the table whole", async () => {
    await ensurePartitions(pool, { head: 1 });
    const accounts = createAccountRest(recording());
    await accounts.eventCountOf(addr);
    const events = await plan(/select count\(\*\) as n from \(select 1 from logs where address = \$1 limit/);
    expect(events).toMatch(/Index Only Scan using logs_p\d+_address_\w*idx/);
    expect(events).not.toMatch(/Seq Scan|Sort Key|^\s*Filter:/m);
    expect(events).toMatch(/Index Cond: \(address = /);
    await accounts.contractCounts();
    const counts = await plan(/select \(select count\(\*\) from contracts\) as n/);
    expect(counts).toMatch(/Index Only Scan using contracts_verified_idx on contracts/);
    expect(counts).toMatch(/Index Only Scan using \w+ on contracts/);
    // A page of the list: the verified source, the creation's block, the account and the token each joined by its primary key (one row at most, whatever the page's size).
    await accounts.contracts("newest", true, [5, 1, addr], 10);
    const list = await plan(/coalesce\(c\.creation_block, 0\) desc/);
    for (const t of ["verified_sources", "blocks"]) expect(list, t).toMatch(new RegExp(`Index Scan using \\w+ on ${t}`));
    expect(list).not.toMatch(/Seq Scan|Sort Key/);
    await accounts.contracts("interactions", null, [5, addr], 10);
    expect(await plan(/order by c\.interaction_count desc/)).not.toMatch(/Seq Scan|Sort Key/);
    // The events' time: the block of each log is read by its primary key.
    await accounts.contractEvents(addr, null, [5, 1], 10);
    expect(await plan(/from logs l join transactions t/)).toMatch(/Index Scan using blocks_pkey on blocks/);
  });

  it("the transactions list oldest first reads the same indexes as newest first, in either direction of those indexes, with no sort and no filter", async () => {
    await ensurePartitions(pool, { head: 100 });
    const chain = createChainRest(recording());
    for (const [filter, where] of [["all", /order by t\.block_number asc/], ["failed", /t\.status = 0 order by t\.block_number asc/], ["calls", /t\.method_id is not null and t\.to_address is not null order by t\.block_number asc/]] as const) {
      await chain.txs([50, 3], 10, filter, false, "asc");
      const p = await plan(where);
      expect(p, filter).toMatch(/Index Scan (Backward )?using transactions_p\d+_(block_number_tx_index_idx\d*|pkey)/);
      expect(p, filter).toMatch(/Index Cond: \(ROW\(block_number, tx_index\) >/);
      expect(p, filter).not.toMatch(/Sort Key|Seq Scan|^\s*Filter: \(?(status|method_id)/m);
    }
  });

  it("the newest lock and release legs read twin_legs through its primary key backwards, directly under the limit, and take the rest by key in nested loops", async () => {
    await createTwinsRest(async (sql, values) => (await recording().query(sql, values as unknown[])).rows).legs(20);
    const p = await plan(/from \(select \* from twin_legs/);
    const lines = p.split("\n");
    // the node under the Limit (the Limit may sit under a Sort of the twenty rows) is the walk of twin_legs on its key
    const at = lines.findIndex((l) => /^\s*(->\s*)?Limit/.test(l));
    expect(at, p).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1], p).toMatch(/Index Scan Backward using twin_legs_pkey on twin_legs/);
    // the leg, its transaction, its block and its token are index lookups, each in a nested loop
    expect(p).toMatch(/Nested Loop/);
    expect(p).not.toMatch(/Hash Join|Merge Join|Materialize|Seq Scan|Bitmap/);
    expect(p).toMatch(/Index Scan using gateway_legs_pkey on gateway_legs/);
    expect(p).toMatch(/using blocks_pkey on blocks/);
    expect(p).toMatch(/using tokens_pkey on tokens/);
  });

  it("the newest lock and release legs read at most the limit of rows, however many payment legs the history holds and however old the locks are", async () => {
    const token = Buffer.alloc(20, 0xd1), vault = Buffer.alloc(20, 0xee);
    // several thousand payment legs that are no lock or release, and below all of them two thousand older locks and releases (the newest three at blocks 1998 to 2000), so the
    // backward walk of twin_legs' key is the planner's own choice with its default settings
    await pool.query(
      `insert into gateway_legs (block_number, leg_index, tx_index, log_index, kind, leg_id, token, account, amount)
       select 10000 + n, 0, 0, 0, 3, decode(lpad(to_hex(n), 64, '0'), 'hex'), $1, $2, 1 from generate_series(1, 6000) n`,
      [token, vault],
    );
    await pool.query(
      `insert into gateway_legs (block_number, leg_index, tx_index, log_index, kind, leg_id, token, account, amount)
       select n, 0, 0, 0, 3, decode(lpad(to_hex(1000000 + n), 64, '0'), 'hex'), $1, $2, 1 from generate_series(1, 2000) n`,
      [token, vault],
    );
    await pool.query("insert into twin_legs (block_number, leg_index, is_release) select n, 0, n = 2000 from generate_series(1, 2000) n");
    await pool.query("analyze gateway_legs");
    await pool.query("analyze twin_legs");
    try {
      const rest = createTwinsRest(async (sql, values) => (await recording().query(sql, values as unknown[])).rows);
      // the rows come back newest first, a release told from a lock by what was written
      const newest = await rest.legs(20);
      expect(newest).toHaveLength(20);
      expect(newest.slice(0, 3).map((l) => [l.block, l.twin])).toEqual([[2000, "release"], [1999, "lock"], [1998, "lock"]]);
      for (const limit of [2, 20]) {
        await rest.legs(limit);
        const q = seen.filter((s) => /from \(select \* from twin_legs/.test(s.sql)).at(-1)!;
        const out = (await pool.query(`explain (analyze, format json) ${q.sql}`, q.values)).rows[0]["QUERY PLAN"][0].Plan;
        // every node's rows over all its loops: the legs' table is read for the rows of twin_legs only
        const walk = (n: any, f: (n: any) => void) => { f(n); for (const c of n.Plans ?? []) walk(c, f); }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const read: Record<string, number> = {};
        walk(out, (n) => { if (n["Relation Name"]) read[n["Relation Name"]] = (read[n["Relation Name"]] ?? 0) + n["Actual Rows"] * n["Actual Loops"]; });
        expect(read["twin_legs"], JSON.stringify(read)).toBeLessThanOrEqual(limit);
        expect(read["gateway_legs"], JSON.stringify(read)).toBeLessThanOrEqual(limit);
      }
    } finally {
      await pool.query("delete from twin_legs");
      await pool.query("delete from gateway_legs");
    }
  });
});
