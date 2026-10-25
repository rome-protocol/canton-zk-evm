/** The custody read, on the pinned PostgreSQL, against a stand-in Ledger API that answers as the gateway's view. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { createLedger } from "../ledger.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { FAKE_GATEWAY, FAKE_REGISTRY, gatewayToken, holding, startFakeLedger, type ActiveContract, type FakeLedger } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { custodyOnce } from "./custody.ts";

const TKB = "0x" + "d1".repeat(20), TKC = "0x" + "d2".repeat(20);
const SOMEONE = "alice::1220" + "ab".repeat(32);
const fakes: FakeLedger[] = [];
const opened: Indexer[] = [];
afterEach(async () => {
  while (fakes.length) await fakes.pop()!.close();
});
/** The database of one test, dropped after the indexers the test opened have given back their connections. */
const inDb = (fn: (pool: Pool) => Promise<void>) => withDatabase(async (pool) => {
  try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
});
const gatewayLedger = async (active: ActiveContract[], ledgerEnd = 40) => {
  const f = await startFakeLedger([], { ledgerEnd, active });
  fakes.push(f);
  return { fake: f, ledger: createLedger(f.url, 2000, FAKE_GATEWAY, 100) };
};
const rows = async (pool: Pool) => (await pool.query("select encode(evm_token, 'hex') as evm, instrument_admin, instrument_id, custody::text, holdings, ledger_offset::int as ledger_offset, read_at from gateway_tokens order by evm_token")).rows;

describe.skipIf(!TEST_URL)("the gateway's custody, as the indexer keeps it", () => {
  checkRequired();

  it("writes a row for each registered token, with the offset it was read at, and nothing for a gateway with no token", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      expect(await custodyOnce(pool, (await gatewayLedger([holding(1, FAKE_GATEWAY, "5")])).ledger, 500)).toEqual({ tokens: 0, offset: 40 });
      expect(await rows(pool)).toEqual([]);
      const { ledger } = await gatewayLedger([gatewayToken(TKB), gatewayToken(TKC, FAKE_REGISTRY, "TKC"), holding(1, FAKE_GATEWAY, "100"), holding(2, FAKE_GATEWAY, "0.5"), holding(3, SOMEONE, "7")]);
      expect(await custodyOnce(pool, ledger, 500)).toEqual({ tokens: 2, offset: 40 });
      expect(await rows(pool)).toMatchObject([
        { evm: "d1".repeat(20), instrument_admin: FAKE_REGISTRY, instrument_id: "TKB", custody: "1005000000000", holdings: 2, ledger_offset: 40 },
        { evm: "d2".repeat(20), instrument_admin: FAKE_REGISTRY, instrument_id: "TKC", custody: "0", holdings: 0, ledger_offset: 40 },
      ]);
    });
  });

  it("keeps the rows to the tokens of the last read: a token's change is written, one that is no longer registered is dropped", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), gatewayToken(TKC, FAKE_REGISTRY, "TKC"), holding(1, FAKE_GATEWAY, "1")], 40)).ledger, 500);
      const first = await rows(pool);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(2, FAKE_GATEWAY, "2")], 55)).ledger, 500);
      const after = await rows(pool);
      expect(after).toMatchObject([{ evm: "d1".repeat(20), custody: "30000000000", holdings: 2, ledger_offset: 55 }]);
      expect(after[0]!.read_at.getTime()).toBeGreaterThanOrEqual(first[0]!.read_at.getTime());
      await custodyOnce(pool, (await gatewayLedger([], 60)).ledger, 500);
      expect(await rows(pool)).toEqual([]);
    });
  });

  it("leaves the last rows as they are when Canton cannot be read, or its answer cannot be stood behind, and says so", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")])).ledger, 500);
      const before = await rows(pool);
      const down = await startFakeLedger([], { httpStatus: 503, active: [] });
      fakes.push(down);
      await expect(custodyOnce(pool, createLedger(down.url, 2000, FAKE_GATEWAY), 500)).rejects.toThrow(/cannot read Canton/);
      await expect(custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1", FAKE_REGISTRY, "TKB", null, "unreadable")])).ledger, 500)).rejects.toThrow(/custody/);
      expect(await rows(pool)).toEqual(before);
    });
  });

  it("stores no party id but the instrument's admin, and no owner or contract id of a holding", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(2, SOMEONE, "9")])).ledger, 500);
      const text = JSON.stringify((await pool.query("select * from gateway_tokens")).rows);
      expect(text).toContain(FAKE_REGISTRY);
      for (const secret of [FAKE_GATEWAY, SOMEONE, "00000001", "00000002"]) expect(text).not.toContain(secret);
    });
  });

  it("is read again by the running indexer on its own, and not at all without a custody ledger", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      const chain = makeChain([{ txs: 1 }]);
      const { fake, ledger } = await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "3")]);
      const make = (custody?: { ledger: typeof ledger; ms: number }) => {
        const ix = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", pollMs: 20, checkMs: 50, ...(custody ? { custody } : {}) });
        opened.push(ix);
        return ix;
      };
      const plain = make();
      await plain.open();
      let halt = plain.start();
      await new Promise((ok) => setTimeout(ok, 300));
      await halt();
      await opened.splice(opened.indexOf(plain), 1)[0]!.close();   // gives back the lock, so that the second indexer can take it
      expect(fake.requests).toHaveLength(0);
      expect(await rows(pool)).toEqual([]);
      const reading = make({ ledger, ms: 50 });
      await reading.open();
      halt = reading.start();
      try {
        for (let i = 0; i < 100 && (await rows(pool)).length === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
        expect(await rows(pool)).toMatchObject([{ evm: "d1".repeat(20), custody: "30000000000", holdings: 1 }]);
        const reads = fake.requests.filter((r) => r.path === "/v2/state/active-contracts").length;
        for (let i = 0; i < 100 && fake.requests.filter((r) => r.path === "/v2/state/active-contracts").length === reads; i++) await new Promise((ok) => setTimeout(ok, 50));
        expect(fake.requests.filter((r) => r.path === "/v2/state/active-contracts").length).toBeGreaterThan(reads);
      } finally {
        await halt();
      }
    });
  });
});
