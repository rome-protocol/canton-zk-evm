import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createAccountRest } from "./account-rest.ts";
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

  it("contracts by place, tokens by first transfer, and an address's holdings", async () => {
    const accounts = createAccountRest(recording());
    await accounts.contracts("newest", null, [5, 1, addr], 10);
    expect(await plan(/coalesce\(c\.creation_block, 0\) desc/)).toMatch(/Index Cond: \(ROW\(COALESCE\(creation_block/);
    await accounts.contracts("oldest", null, [5, 1, addr], 10);
    expect(await plan(/coalesce\(c\.creation_block, 0\) asc/)).toMatch(/Index Cond: \(ROW\(COALESCE\(creation_block/);
    await accounts.tokens("newest", [5, addr], 10);
    expect(await plan(/order by first_transfer_block desc/)).toMatch(/Index Cond: \(ROW\(first_transfer_block, address\) </);
    await accounts.holdings(addr, [addr, "0"], 10);
    expect(await plan(/b\.holder = \$1/)).toMatch(/token_balances_holdings_idx/);
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
    expect(await plan(/order by holder_count desc, address desc/)).toMatch(/Index Cond: \(ROW\(holder_count, address\) </);
    await accounts.tokens("transfers", [5, addr], 10);
    expect(await plan(/order by transfer_count desc, address desc/)).toMatch(/Index Cond: \(ROW\(transfer_count, address\) </);
    await accounts.holders(addr, ["7", addr, "0"], 10);
    expect(await plan(/order by b\.value desc, b\.holder desc, b\.token_id desc/)).toMatch(/Index Cond: .*ROW\(value, holder, token_id\) </s);
  });
});
