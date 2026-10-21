import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { DEFAULT_PARTITION_WIDTH, PARTITIONED_TABLES, ensurePartitions, partitionName } from "./partitions.ts";
import { TEST_URL, checkRequired, withDatabase } from "./testing.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

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
      await ensurePartitions(pool, { head: 5000, width: 1000 });
    });
  });

  it("uses the recorded width when none is asked for, and records the default only when nothing is recorded", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      await ensurePartitions(pool, { head: 0, width: 1000 });
      // No width: the recorded 1000 is used, not the default.
      const more = await ensurePartitions(pool, { head: 5000 });
      expect(more).toHaveLength(PARTITIONED_TABLES.length * 5);
      expect((await pool.query("select value from meta where key = 'partition_width'")).rows[0].value).toBe("1000");
      expect(await bounds(pool, "logs")).toHaveLength(8);
    });
  });

  it("lets two maintenance runs start together: both succeed and each partition is made once", async () => {
    await withDatabase(async (pool) => {
      await migrate(pool);
      const [a, b] = await Promise.all([ensurePartitions(pool, { head: 3_000_000 }), ensurePartitions(pool, { head: 3_000_000 })]);
      const per = 3_000_000 / DEFAULT_PARTITION_WIDTH + 1 + 2;
      expect([a.length, b.length].sort((x, y) => x - y)).toEqual([0, PARTITIONED_TABLES.length * per]);
      expect(await bounds(pool, "transactions")).toHaveLength(per);
    });
  });

  it("lets two runs of the command start together on a fresh database", async () => {
    await withDatabase(async (pool, url) => {
      const run = () => new Promise<{ code: number | null; out: string }>((resolve) => {
        execFile(process.execPath, [cli, "migrate", "--head", "3000000"], { env: { ...process.env, EXPLORER_DATABASE_URL: url } }, (err, stdout, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
      });
      const results = await Promise.all([run(), run()]);
      expect(results.map((r) => r.out)).toEqual(results.map(() => expect.not.stringContaining("already exists")));
      expect(results.map((r) => r.code)).toEqual([0, 0]);
      expect(await bounds(pool, "transactions")).toHaveLength(3_000_000 / DEFAULT_PARTITION_WIDTH + 1 + 2);
    });
  }, 60_000);

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
