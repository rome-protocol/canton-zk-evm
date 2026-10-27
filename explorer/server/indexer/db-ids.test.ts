import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { checkIds, idsRow, type IdUse } from "./db-ids.ts";

checkRequired();

const use = (table: string, used: number, max = 32767): IdUse => ({ table, column: "id", used, max });

describe("db_ids: how much of each id column's range is used", () => {
  it("is ok at or under half of the fullest column, and has no detail", () => {
    const r = idsRow([use("canton_parties", 3), use("canton_templates", 16383), use("blocks", 1, 2147483647)]);
    expect(r.status).toBe("ok");
    expect(r.detail).toBeNull();
    expect(idsRow([]).status).toBe("ok");
  });

  it("is degraded above 50%, and the detail names the table and the percent", () => {
    const r = idsRow([use("canton_parties", 16384), use("canton_templates", 3)]);
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("canton_parties.id");
    expect(r.detail).toContain("50%");
    expect(idsRow([use("canton_parties", 29490)]).status).toBe("degraded");
  });

  it("is down above 90%, so that the uptime check on /api/health fires", () => {
    const r = idsRow([use("canton_templates", 29491), use("canton_parties", 3)]);
    expect(r.status).toBe("down");
    expect(r.detail).toContain("canton_templates.id");
    expect(r.detail).toContain("90%");
  });

  it("goes by the share of each column's own type: a large column with a big count is not a full one", () => {
    expect(idsRow([use("blocks", 1_000_000_000, 2147483647)]).status).toBe("ok");
    expect(idsRow([use("blocks", 1_200_000_000, 2147483647)]).status).toBe("degraded");
  });

  it("lists the highest few in the value, fullest first", () => {
    const r = idsRow([use("a", 1), use("b", 20000), use("c", 10000), use("d", 30000), use("e", 5)]);
    const value = r.value as { highest: { table: string }[]; counted: number };
    expect(value.highest.map((h) => h.table)).toEqual(["d", "b", "c"]);
    expect(value.counted).toBe(5);
  });
});

describe.skipIf(!TEST_URL)("db_ids against a real database", () => {
  it("reads the explorer's id columns, and follows a sequence that is spent", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      const fresh = await checkIds(pool);
      expect(fresh.status).toBe("ok");
      const tables = (fresh.value as { counted: number }).counted;
      expect(tables).toBeGreaterThan(3);
      const seq = (await pool.query("select pg_get_serial_sequence('canton_parties', 'id') as s")).rows[0].s as string;
      await pool.query("select setval($1, 20000)", [seq]);
      const warn = await checkIds(pool);
      expect(warn.status).toBe("degraded");
      expect(warn.detail).toContain("canton_parties.id");
      expect(warn.detail).toContain("61%");
      await pool.query("select setval($1, 30000)", [seq]);
      expect((await checkIds(pool)).status).toBe("down");
    });
  });
});
