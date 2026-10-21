import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { DEFAULT_PARTITION_WIDTH, PARTITIONED_TABLES, ensurePartitions, partitionName } from "./partitions.ts";
import { TEST_URL, checkRequired, withDatabase } from "./testing.ts";

describe("partitionName", () => {
  it("is the table and the partition's index", () => {
    expect(partitionName("logs", 3)).toBe("logs_p000003");
  });
});

describe.skipIf(!TEST_URL)("partition maintenance, on the pinned PostgreSQL", () => {
  checkRequired();

  async function bounds(pool: import("pg").Pool, table: string): Promise<string[]> {
    const { rows } = await pool.query<{ b: string }>(
      "select pg_get_expr(c.relpartbound, c.oid) as b from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent where p.relname = $1 order by c.relname",
      [table],
    );
    return rows.map((r) => r.b);
  }

  it("records the default width in meta and makes the head's partition and two ahead, for the five tables", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      const made = await ensurePartitions(pool, { head: 0 });
      expect(made).toHaveLength(PARTITIONED_TABLES.length * 3);
      expect((await pool.query("select value from meta where key = 'partition_width'")).rows[0].value).toBe("250000");
      for (const t of PARTITIONED_TABLES) {
        expect(await bounds(pool, t)).toEqual([
          "FOR VALUES FROM ('0') TO ('250000')",
          "FOR VALUES FROM ('250000') TO ('500000')",
          "FOR VALUES FROM ('500000') TO ('750000')",
        ]);
      }
    });
  });

  it("makes more as the head moves, never makes one twice, and makes every one from block 0", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      await ensurePartitions(pool, { head: 0 });
      expect(await ensurePartitions(pool, { head: 249_999 })).toEqual([]);
      const more = await ensurePartitions(pool, { head: 600_000 });
      // The head is in partition 2, so partitions 3 and 4 are new.
      expect(more.sort()).toEqual(PARTITIONED_TABLES.flatMap((t) => [partitionName(t, 3), partitionName(t, 4)]).sort());
      expect(await bounds(pool, "logs")).toHaveLength(5);
      expect(await ensurePartitions(pool, { head: 600_000 })).toEqual([]);
    });
  });

  it("keeps the width it recorded, and refuses another", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      await ensurePartitions(pool, { head: 0, width: 1000 });
      expect(await bounds(pool, "transactions")).toEqual(["FOR VALUES FROM ('0') TO ('1000')", "FOR VALUES FROM ('1000') TO ('2000')", "FOR VALUES FROM ('2000') TO ('3000')"]);
      await expect(ensurePartitions(pool, { head: 0, width: DEFAULT_PARTITION_WIDTH })).rejects.toThrow(/1000 blocks wide/);
      await expect(ensurePartitions(pool, { head: 5000 })).rejects.toThrow(/fixed once/);
      await ensurePartitions(pool, { head: 5000, width: 1000 });
    });
  });

  it("puts a row in the partition of its block number, and refuses a block beyond the last partition", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      await ensurePartitions(pool, { head: 0, width: 100 });
      const tx = (n: number) => pool.query(
        `insert into logs (block_number, log_index, tx_index, address, data) values ($1, 0, 0, '\\x00', '\\x') returning tableoid::regclass::text as part`, [n]);
      expect((await tx(99)).rows[0].part).toBe("logs_p000000");
      expect((await tx(100)).rows[0].part).toBe("logs_p000001");
      expect((await tx(299)).rows[0].part).toBe("logs_p000002");
      await expect(tx(300)).rejects.toThrow(/no partition/);
    });
  });

  it("rejects a head or width that is not a whole number of blocks", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      await expect(ensurePartitions(pool, { head: -1 })).rejects.toThrow(/block number/);
      await expect(ensurePartitions(pool, { head: 0, width: 0 })).rejects.toThrow(/whole number/);
    });
  });
});
