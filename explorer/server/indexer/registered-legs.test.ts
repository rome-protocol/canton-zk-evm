/** The legs of registered gateways, indexed from the logs stage 1 wrote and checked against each gateway's own `legs[N]`, on the pinned PostgreSQL. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { CHAIN_ID, GATEWAY, PARTICIPANT, PINS, expectedLegHash, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createLedger, CUSTODY_ENDPOINTS } from "../ledger.ts";
import { FAKE_GATEWAY, registered, startFakeLedger, zkChain, type FakeLedger } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { custodyOnce } from "./custody.ts";
import { registeredLegsHealth, registeredLegsOnce } from "./registered-legs.ts";
import { legsSlot } from "./legs.ts";

const GW2 = "0x" + "b1".repeat(20), VAULT = "0x" + "b2".repeat(20), STRAY = "0x" + "b3".repeat(20), TOKEN = "0x" + "d1".repeat(20), ALICE = "0x" + "a1".repeat(20);
const ID1 = "0x" + "11".repeat(32), ID2 = "0x" + "22".repeat(32), ID3 = "0x" + "33".repeat(32);
const PARTY = "alice::1220" + "ab".repeat(32);
const fakes: FakeLedger[] = [];
const opened: Indexer[] = [];
afterEach(async () => { while (fakes.length) await fakes.pop()!.close(); });
const inDb = (fn: (pool: Pool) => Promise<void>) => withDatabase(async (pool) => {
  try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
});
async function indexed(pool: Pool, shapes: BlockShape[]): Promise<SyntheticChain> {
  await migrate(pool);
  const chain = makeChain(shapes);
  chain.reads.rethHead = shapes.length;
  chain.ledger.ledgerHead = shapes.length;
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  await indexer.runOnce();
  return chain;
}
async function registry(pool: Pool, chain: SyntheticChain, entries = [registered(GW2, "Gateway"), registered(VAULT, "Vault")]): Promise<void> {
  const f = await startFakeLedger([], { ledgerEnd: 999, active: [zkChain(entries)] });
  fakes.push(f);
  await custodyOnce(pool, createLedger(f.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), chain.reads, 500, PARTICIPANT, CHAIN_ID);
}
const legRows = async (pool: Pool) => (await pool.query("select block_number::int as block, leg_index as i, kind, encode(leg_id, 'hex') as id, encode(account, 'hex') as account, amount::text, party, encode(gateway, 'hex') as gateway from gateway_legs order by block_number, leg_index")).rows;
const c10 = async (pool: Pool) => (await pool.query("select status, detail from health_checks where check_id = 'C10'")).rows[0] as { status: string; detail: string | null };
/** The word a registered gateway's `legs[n]` holds for its one leg. */
const hashOf = (kind: number, id: string, account: string, amount: bigint, party = "") => expectedLegHash(kind, id, TOKEN, account, amount, party);

describe.skipIf(!TEST_URL)("the legs of registered gateways", () => {
  checkRequired();

  it("indexes the legs of each registered gateway after the first gateway's in the block, checks each against its own legs[N], and leaves other contracts alone", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, [
        { txs: 1, leg: 1, extra: [{ gateway: GW2, kind: 2, id: ID1, token: TOKEN, account: ALICE, amount: 7n, party: PARTY }] },
        { txs: 1 },
        { txs: 1, extra: [{ gateway: GW2, kind: 3, id: ID2, token: TOKEN, account: VAULT, amount: 9n }, { gateway: STRAY, kind: 3, id: ID3, token: TOKEN, account: ALICE, amount: 1n }] },
        { txs: 1 },
      ]);
      chain.reads.storage[`${GW2}:${legsSlot(1)}`] = hashOf(2, ID1, ALICE, 7n, PARTY);
      chain.reads.storage[`${GW2}:${legsSlot(3)}`] = hashOf(3, ID2, VAULT, 9n);
      expect(await legRows(pool)).toMatchObject([{ block: 1, i: 0, kind: 1, gateway: null }]);
      await registry(pool, chain);
      expect(await registeredLegsOnce(pool, chain.reads)).toEqual({ legs: 2, blocks: 4 });
      expect(await legRows(pool)).toEqual([
        { block: 1, i: 0, kind: 1, id: "01".repeat(32), account: "00000000000000000000000000000000000a11ce", amount: "42", party: null, gateway: null },
        { block: 1, i: 1, kind: 2, id: "11".repeat(32), account: "a1".repeat(20), amount: "7", party: PARTY, gateway: "b1".repeat(20) },
        { block: 3, i: 0, kind: 3, id: "22".repeat(32), account: "b2".repeat(20), amount: "9", party: null, gateway: "b1".repeat(20) },
      ]);
      expect((await c10(pool)).status).toBe("ok");
      // caught up: nothing is done again
      expect(await registeredLegsOnce(pool, chain.reads)).toEqual({ legs: 0, blocks: 0 });
      expect(await legRows(pool)).toHaveLength(3);
    });
  });

  it("says degraded, naming the gateway, when its legs do not give the hash reth stores, and still writes them", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, [{ txs: 1, extra: [{ gateway: GW2, kind: 3, id: ID2, token: TOKEN, account: ALICE, amount: 9n }] }]);
      chain.reads.storage[`${GW2}:${legsSlot(1)}`] = "0x" + "ee".repeat(32);
      await registry(pool, chain);
      await registeredLegsOnce(pool, chain.reads);
      expect(await c10(pool)).toMatchObject({ status: "degraded", detail: expect.stringContaining(`the registered gateway ${GW2}'s legs[1]`) });
      expect(await legRows(pool)).toHaveLength(1);
    });
  });

  it("says degraded, naming the gateway and the block, when one of its Leg logs cannot be decoded, and goes on without that block's legs", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, [{ txs: 1, extra: [{ gateway: GW2, kind: 3, id: ID2, token: TOKEN, account: ALICE, amount: 9n }] }, { txs: 1 }]);
      await pool.query("update logs set data = $2 where address = $1 and block_number = 1", [Buffer.from(GW2.slice(2), "hex"), Buffer.from("1234", "hex")]);
      await registry(pool, chain);
      await registeredLegsOnce(pool, chain.reads);
      expect(await c10(pool)).toMatchObject({ status: "degraded", detail: expect.stringContaining(`the registered gateway ${GW2}`) });
      const value = (await pool.query("select value from health_checks where check_id = 'C10'")).rows[0].value;
      expect(value).toEqual({ block: 1, gateway: GW2 });
      expect(await legRows(pool)).toEqual([]);
    });
  });

  it("says how far behind the head the slowest registered gateway's leg index is, and degraded past the limit; and nothing when none is registered", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, [{ txs: 1 }, { txs: 1 }, { txs: 1 }, { txs: 1 }]);
      expect(await registeredLegsHealth(pool)).toBeNull();
      await registry(pool, chain);
      expect(await registeredLegsHealth(pool, 2)).toMatchObject({ id: "registered_legs", status: "degraded", value: { gateways: 1, head: 4, behind: 4, legsCursor: 0 }, detail: expect.stringContaining("4 blocks behind") });
      await registeredLegsOnce(pool, chain.reads, 3);
      expect(await registeredLegsHealth(pool, 2)).toMatchObject({ status: "ok", value: { behind: 1, legsCursor: 3 } });
      await registeredLegsOnce(pool, chain.reads);
      expect(await registeredLegsHealth(pool, 2)).toMatchObject({ status: "ok", value: { behind: 0, legsCursor: 4 }, detail: null });
    });
  });

  it("goes on from its cursor in batches, and indexes nothing for a gateway that is not registered or a vault", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, [
        { txs: 1, extra: [{ gateway: GW2, kind: 3, id: ID1, token: TOKEN, account: ALICE, amount: 1n }, { gateway: VAULT, kind: 3, id: ID3, token: TOKEN, account: ALICE, amount: 1n }] },
        { txs: 1 },
        { txs: 1, extra: [{ gateway: GW2, kind: 3, id: ID2, token: TOKEN, account: ALICE, amount: 2n }] },
      ]);
      chain.reads.storage[`${GW2}:${legsSlot(1)}`] = hashOf(3, ID1, ALICE, 1n);
      chain.reads.storage[`${GW2}:${legsSlot(3)}`] = hashOf(3, ID2, ALICE, 2n);
      await registry(pool, chain);
      expect(await registeredLegsOnce(pool, chain.reads, 2)).toEqual({ legs: 1, blocks: 2 });
      expect(await registeredLegsOnce(pool, chain.reads, 2)).toEqual({ legs: 1, blocks: 1 });
      expect((await legRows(pool)).map((r) => [r.block, r.id.slice(0, 2)])).toEqual([[1, "11"], [3, "22"]]);
      expect((await c10(pool)).status).toBe("ok");
    });
  });
});
