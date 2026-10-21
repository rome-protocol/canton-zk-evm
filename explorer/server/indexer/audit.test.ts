/** C6, the audit of indexed blocks against reth, on the pinned PostgreSQL. */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { RethError } from "../reth.ts";
import { markNightly, nightlyDue, sampleNumbers } from "./audit.ts";
import { createIndexer, type Indexer } from "./indexer.ts";

describe("which blocks the audit looks at", () => {
  it("draws distinct blocks from 1 to the head, and all of them when the head is small", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const picked = sampleNumbers(1000, 20, random);
    expect(picked).toHaveLength(20);
    expect(new Set(picked).size).toBe(20);
    expect(picked.every((n) => n >= 1 && n <= 1000)).toBe(true);
    expect(sampleNumbers(12, 20, random)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(sampleNumbers(0, 20, random)).toEqual([]);
  });
});

const opened: Indexer[] = [];
async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    try {
      await fn(pool);
    } finally {
      for (const i of opened.splice(0)) await i.close().catch(() => undefined);
    }
  });
}

async function setup(pool: Pool, blocks: number) {
  await migrate(pool);
  const chain: SyntheticChain = makeChain(Array.from({ length: blocks }, (_, i) => ({ txs: 2 + (i % 3) })));
  let seed = 11;
  const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", random });
  opened.push(indexer);
  await indexer.open();
  await indexer.runOnce();
  // The synthetic blocks carry fixed times; the nightly audit goes by the clock.
  await pool.query("update blocks set timestamp = now()");
  return { chain, indexer };
}
const row = async (pool: Pool) => (await pool.query("select status, detail, value from health_checks where check_id = 'C6'")).rows[0];

describe.skipIf(!TEST_URL)("C6, the audit, on the pinned PostgreSQL", () => {
  checkRequired();

  it("is ok when 20 random blocks agree with reth, and says how many it looked at", async () => {
    await inDb(async (pool) => {
      const { indexer } = await setup(pool, 40);
      const r = await indexer.auditOnce("sample");
      expect(r.status).toBe("ok");
      expect((await row(pool)).value).toMatchObject({ kind: "sample", checked: 20, suspect: [] });
    });
  });

  it("names a block whose hash, transaction count, gas used or log count differs, and keeps looking at it until it agrees", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, 40);
      const b = (n: number) => chain.blocks[n - 1]!;
      const [hash26, txs12] = [b(26).block.hash, b(12).block.transactions];
      b(7).block.gasUsed += 1;
      b(12).block.transactions = txs12.slice(1);
      b(20).receipts[0]!.logs.push({ address: "0x" + "11".repeat(20), topics: [], data: "0x" });
      b(26).block.hash = "0x" + "ee".repeat(32);
      expect((await indexer.auditOnce("day")).status).toBe("degraded");
      const stored = await row(pool);
      expect(stored.value.suspect).toEqual([7, 12, 20, 26]);
      expect(stored.detail).toMatch(/^block 7 disagrees with reth: gas used \d+ in the index, \d+ in reth \(and 3 more: 12, 20, 26\)$/);
      expect(stored.value.mismatches.map((m: { block: number; what: string }) => m.what)).toEqual([
        expect.stringMatching(/^gas used/), expect.stringMatching(/transactions in the index/), expect.stringMatching(/logs in the index/), expect.stringMatching(/^hash /),
      ]);
      // A sample that misses them still looks at the blocks already named: only the blocks agreeing again turns the row ok.
      expect((await indexer.auditOnce("sample")).status).toBe("degraded");
      b(7).block.gasUsed -= 1;
      expect((await indexer.auditOnce("sample")).status).toBe("degraded");
      expect((await row(pool)).value.suspect).toEqual([12, 20, 26]);
      b(12).block.transactions = txs12;
      b(20).receipts[0]!.logs.pop();
      b(26).block.hash = hash26;
      expect((await indexer.auditOnce("sample")).status).toBe("ok");
      expect(await row(pool)).toMatchObject({ status: "ok", detail: null, value: { suspect: [] } });
    });
  });

  it("looks at the last 24 hours when it is the nightly run, and names a block reth no longer has", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, 30);
      await pool.query("update blocks set timestamp = now() - interval '3 days' where number <= 10");
      chain.blocks[4]!.block.gasUsed += 1; // block 5, outside the window
      expect((await indexer.auditOnce("day")).status).toBe("ok");
      expect((await row(pool)).value.checked).toBe(20);
      chain.reads.rethHead = 27;
      const r = await indexer.auditOnce("day");
      expect(r.status).toBe("degraded");
      expect((await row(pool)).value.suspect).toEqual([28, 29, 30]);
      expect((await row(pool)).detail).toMatch(/^block 28 disagrees with reth: reth does not have it \(and 2 more: 29, 30\)$/);
    });
  });

  it("says degraded, keeping what it had named, when reth cannot be read", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await setup(pool, 25);
      chain.blocks[2]!.block.gasUsed += 1;
      await indexer.auditOnce("day");
      chain.reads.receipts = async () => { throw new RethError("eth_getBlockReceipts: cannot reach reth (timeout)"); };
      const r = await indexer.auditOnce("sample");
      expect(r.status).toBe("degraded");
      expect((await row(pool)).detail).toMatch(/^the audit could not read reth: .*cannot reach reth/);
      expect((await row(pool)).value.suspect).toEqual([3]);
    });
  });

  it("runs the nightly audit once a day, after 03:00 UTC", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      expect(await nightlyDue(pool, new Date("2026-10-22T02:59:00Z"))).toBe(false);
      expect(await nightlyDue(pool, new Date("2026-10-22T03:00:00Z"))).toBe(true);
      await markNightly(pool, new Date("2026-10-22T03:00:10Z"));
      expect(await nightlyDue(pool, new Date("2026-10-22T14:00:00Z"))).toBe(false);
      expect(await nightlyDue(pool, new Date("2026-10-23T03:00:00Z"))).toBe(true);
    });
  });

  it("runs the sample audit by itself while the indexer runs, and the nightly one the first time after 03:00 UTC", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      const chain = makeChain([{ txs: 2 }, { txs: 2 }, { txs: 2 }]);
      const at = Date.parse("2026-10-22T03:30:00Z");
      const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", pollMs: 20, checkMs: 50, auditMs: 50, now: () => at });
      opened.push(indexer);
      await indexer.open();
      const halt = indexer.start();
      try {
        for (let i = 0; i < 100 && !(await pool.query("select 1 from meta where key = 'c6_nightly'")).rowCount; i++) await new Promise((ok) => setTimeout(ok, 50));
        expect((await pool.query("select value from meta where key = 'c6_nightly'")).rows).toEqual([{ value: "2026-10-22" }]);
        expect((await row(pool)).status).toBe("ok");
      } finally {
        await halt();
      }
    });
  });
});
