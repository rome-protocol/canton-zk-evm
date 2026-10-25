/** The custody read, on the pinned PostgreSQL, against a stand-in Ledger API that answers as the gateway's view. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { createLedger, CUSTODY_ENDPOINTS, type Ledger } from "../ledger.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { FAKE_GATEWAY, FAKE_REGISTRY, gatewayToken, holding, startFakeLedger, type ActiveContract, type FakeLedger } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { custodyOnce } from "./custody.ts";

const TKB = "0x" + "d1".repeat(20), TKC = "0x" + "d2".repeat(20);
const SUPPLY = "0x18160ddd";
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
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
const gatewayLedger = async (active: ActiveContract[]) => {
  const f = await startFakeLedger([], { ledgerEnd: 999, active });
  fakes.push(f);
  return { fake: f, ledger: createLedger(f.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS) };
};
/** A database with the first `n` blocks of a synthetic chain indexed (their Canton records are at offsets 10, 20, ...; `chainLength` blocks exist, the first `n` are final), and the chain's reth with every token's supply set. */
async function indexed(pool: Pool, n: number, supply: Record<string, bigint> = {}, chainLength = n): Promise<{ chain: SyntheticChain; indexer: Indexer }> {
  await migrate(pool);
  const chain = makeChain(Array.from({ length: chainLength }, () => ({ txs: 0 })));
  chain.reads.rethHead = n;
  chain.ledger.ledgerHead = n;
  for (const [t, v] of Object.entries(supply)) chain.reads.callResults[`${t}:${SUPPLY}`] = word(v);
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  await indexer.runOnce();
  return { chain, indexer };
}
const rows = async (pool: Pool) => (await pool.query("select encode(evm_token, 'hex') as evm, instrument_admin, instrument_id, custody::text, holdings, supply::text, supply_block::int as supply_block, ledger_offset::int as ledger_offset, read_at from gateway_tokens order by evm_token")).rows;

describe.skipIf(!TEST_URL)("the gateway's custody, as the indexer keeps it", () => {
  checkRequired();

  it("writes a row for each registered token, at the newest indexed block and the offset of its record, and nothing for a gateway with no token", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 3, { [TKB]: 1_005_000_000n, [TKC]: 0n });
      const first = await gatewayLedger([holding(1, FAKE_GATEWAY, "5")]);
      expect(await custodyOnce(pool, first.ledger, chain.reads, 500)).toEqual({ tokens: 0, offset: 30, block: 3 });
      expect(first.fake.requests.map((r) => (r.body as { activeAtOffset: number }).activeAtOffset)).toEqual([30]);
      expect(await rows(pool)).toEqual([]);
      const { ledger } = await gatewayLedger([gatewayToken(TKB), gatewayToken(TKC, FAKE_REGISTRY, "TKC"), holding(1, FAKE_GATEWAY, "100"), holding(2, FAKE_GATEWAY, "0.5"), holding(3, SOMEONE, "7")]);
      expect(await custodyOnce(pool, ledger, chain.reads, 500)).toEqual({ tokens: 2, offset: 30, block: 3 });
      expect(await rows(pool)).toMatchObject([
        { evm: "d1".repeat(20), instrument_admin: FAKE_REGISTRY, instrument_id: "TKB", custody: "1005000000000", holdings: 2, supply: "1005000000", supply_block: 3, ledger_offset: 30 },
        { evm: "d2".repeat(20), instrument_admin: FAKE_REGISTRY, instrument_id: "TKC", custody: "0", holdings: 0, supply: "0", supply_block: 3, ledger_offset: 30 },
      ]);
    });
  });

  it("writes nothing while no block is indexed, and says no supply for a token that did not answer", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await indexed(pool, 0, {}, 2);
      const { ledger, fake } = await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")]);
      expect(await custodyOnce(pool, ledger, chain.reads, 500)).toEqual({ tokens: 0, offset: 0, block: null });
      expect(fake.requests).toHaveLength(0);
      chain.reads.rethHead = 2;
      chain.ledger.ledgerHead = 2;
      await indexer.runOnce();
      await custodyOnce(pool, ledger, chain.reads, 500);
      expect(await rows(pool)).toMatchObject([{ evm: "d1".repeat(20), custody: "10000000000", supply: null, supply_block: 2, ledger_offset: 20 }]);
    });
  });

  it("reads the custody and the supply at the same block, so a deposit that lands between two reads never shows as a difference", async () => {
    await inDb(async (pool) => {
      // Each block holds one deposit of 10 units. The world is what Canton and reth know at the head: a stand-in Canton answers the custody at any offset it is
      // asked for, as the active contracts at that offset would be, and reth answers the supply at any block.
      const units = 10n ** 10n;
      let head = 2;
      const { chain, indexer } = await indexed(pool, 2, {}, 3);
      const depositsAtOffset = (offset: number) => Math.min(head, Math.floor(offset / 10));
      const asked: number[] = [];
      const canton = {
        gatewayCustody: async (_limit: number, offset: number) => {
          asked.push(offset);
          return { offset, tokens: [{ evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", custody: BigInt(depositsAtOffset(offset)) * 10n * units, holdings: depositsAtOffset(offset) }] };
        },
      } as unknown as Pick<Ledger, "gatewayCustody">;
      const reth = { call: async (_to: string, _input: string, block: number) => word(BigInt(Math.min(head, block)) * 10n * 10n ** 6n) } as unknown as SyntheticChain["reads"];
      const diff = async () => {
        const [r] = await rows(pool);
        return { custody: BigInt(r.custody) / 10n ** 4n, supply: BigInt(r.supply), block: r.supply_block, offset: r.ledger_offset };
      };
      await custodyOnce(pool, canton, reth, 500);
      expect(await diff()).toEqual({ custody: 20_000_000n, supply: 20_000_000n, block: 2, offset: 20 });
      // A third deposit lands: Canton and reth both know it, the explorer has indexed up to block 2 only. The next read is still at block 2: no difference.
      head = 3;
      await custodyOnce(pool, canton, reth, 500);
      expect(await diff()).toEqual({ custody: 20_000_000n, supply: 20_000_000n, block: 2, offset: 20 });
      expect(asked).toEqual([20, 20]);
      // Once the explorer has indexed block 3, the read is at block 3 and both numbers have the deposit.
      chain.reads.rethHead = 3;
      chain.ledger.ledgerHead = 3;
      await indexer.runOnce();
      await custodyOnce(pool, canton, reth, 500);
      expect(await diff()).toEqual({ custody: 30_000_000n, supply: 30_000_000n, block: 3, offset: 30 });
    });
  });

  it("keeps the rows to the tokens of the last read: a token's change is written, one that is no longer registered is dropped", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 2, { [TKB]: 1n, [TKC]: 1n });
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), gatewayToken(TKC, FAKE_REGISTRY, "TKC"), holding(1, FAKE_GATEWAY, "1")])).ledger, chain.reads, 500);
      const first = await rows(pool);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(2, FAKE_GATEWAY, "2")])).ledger, chain.reads, 500);
      const after = await rows(pool);
      expect(after).toMatchObject([{ evm: "d1".repeat(20), custody: "30000000000", holdings: 2, ledger_offset: 20 }]);
      expect(after[0]!.read_at.getTime()).toBeGreaterThanOrEqual(first[0]!.read_at.getTime());
      await custodyOnce(pool, (await gatewayLedger([])).ledger, chain.reads, 500);
      expect(await rows(pool)).toEqual([]);
    });
  });

  it("leaves the last rows as they are when Canton cannot be read, or its answer cannot be stood behind, and says so", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 1, { [TKB]: 1n });
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")])).ledger, chain.reads, 500);
      const before = await rows(pool);
      const down = await startFakeLedger([], { httpStatus: 503, active: [] });
      fakes.push(down);
      await expect(custodyOnce(pool, createLedger(down.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), chain.reads, 500)).rejects.toThrow(/cannot read Canton/);
      await expect(custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1", FAKE_REGISTRY, "TKB", null, "unreadable")])).ledger, chain.reads, 500)).rejects.toThrow(/custody/);
      expect(await rows(pool)).toEqual(before);
    });
  });

  it("stores no party id but the instrument's admin, and no owner or contract id of a holding", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 1);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1"), holding(2, SOMEONE, "9")])).ledger, chain.reads, 500);
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
