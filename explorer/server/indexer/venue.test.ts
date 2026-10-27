/** The Canton side of the swaps, on the pinned PostgreSQL, against a stand-in Ledger API that answers as the gateway's view. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { createLedger, CUSTODY_ENDPOINTS, type Ledger } from "../ledger.ts";
import { CHAIN_ID, GATEWAY, PARTICIPANT, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { FAKE_GATEWAY, FAKE_REGISTRY, FAKE_SELLER, FAKE_VENUE, fundedClaimEvent, gatewayTokenEvent, startFakeLedger, transaction, venueTradeEvent, type FakeLedger } from "../../test/fake-ledger.ts";
import type { Json } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { blockLegs, txLegs } from "./leg-canton.ts";
import { venueOnce as venueAt } from "./venue.ts";

const TKB = "0x" + "d1".repeat(20);
const PAY = "a1".repeat(32), CLAIM = "b2".repeat(32);
const BUYER = "0x" + "e5".repeat(20), PAYEE = "0x" + "f6".repeat(20);
const trade = { payId: PAY, claimId: CLAIM, token: "0x" + "d2".repeat(20), payee: PAYEE, recipient: BUYER, amount: 2_500_000n, gatewayToken: "00tok1" };
const claim = { claimId: CLAIM, recipient: BUYER, amount: "12.5", gatewayToken: "00tok1" };

const fakes: FakeLedger[] = [];
const opened: Indexer[] = [];
afterEach(async () => {
  while (fakes.length) await fakes.pop()!.close();
});
const inDb = (fn: (pool: Pool) => Promise<void>) => withDatabase(async (pool) => {
  try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
});
const venueOnce = (pool: Pool, ledger: Pick<Ledger, "venuePages">, participant: string = PARTICIPANT) => venueAt(pool, ledger, participant);
const gatewayLedger = async (items: Json[], pageSize = 100) => {
  const f = await startFakeLedger(items, { ledgerEnd: 999 });
  fakes.push(f);
  return { fake: f, ledger: createLedger(f.url, 2000, FAKE_GATEWAY, pageSize, null, CUSTODY_ENDPOINTS) };
};

/**
 * Five blocks (the Canton records are at offsets 10 to 50): block 2 records the payment of a venue's trade, block 3 the deposit that redeems its funded claim, block 4 a withdrawal,
 * and block 5 a payment that no Canton trade is behind. The first `n` are indexed.
 */
async function indexed(pool: Pool, n: number): Promise<{ chain: SyntheticChain; indexer: Indexer }> {
  await migrate(pool);
  const chain = makeChain([{ txs: 2 }, { txs: 2, leg: 3, legId: "0x" + PAY }, { txs: 2, leg: 1, legId: "0x" + CLAIM }, { txs: 2, leg: 2 }, { txs: 2, leg: 3 }]);
  chain.reads.rethHead = n;
  chain.ledger.ledgerHead = n;
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  await indexer.runOnce();
  return { chain, indexer };
}
/** What the gateway party sees: the token registered long before, the trade offered before block 2, and the claim that block 2's own update created. */
const items = (chain: SyntheticChain): Json[] => [
  transaction(5, "u-registered", [gatewayTokenEvent(5, "00tok1", TKB, FAKE_REGISTRY, "TKB")]),
  transaction(15, "u-offered", [venueTradeEvent(15, "00trade", trade)]),
  transaction(20, chain.blocks[1]!.record.updateId, [fundedClaimEvent(20, "00claim", claim)]),
];
const count = async (pool: Pool, table: string) => Number((await pool.query(`select count(*) as n from ${table}`)).rows[0].n);

describe.skipIf(!TEST_URL)("the Canton side of the swaps, as the indexer keeps it", () => {
  checkRequired();

  it("keeps the trade, its claim and the registered token, and the cursor, and no party", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      const { ledger } = await gatewayLedger(items(chain));
      expect(await venueOnce(pool, ledger)).toEqual({ tokens: 1, trades: 1, claims: 1, offset: 50 });
      expect((await pool.query("select encode(pay_id, 'hex') as pay, encode(claim_id, 'hex') as claim, encode(token, 'hex') as token, encode(payee, 'hex') as payee, encode(recipient, 'hex') as recipient, evm_amount::text as amount, gateway_token, offered_update_id, offered_offset::int as at from canton_venue_trades")).rows)
        .toEqual([{ pay: PAY, claim: CLAIM, token: "d2".repeat(20), payee: "f6".repeat(20), recipient: "e5".repeat(20), amount: "2500000", gateway_token: "00tok1", offered_update_id: "u-offered", at: 15 }]);
      expect((await pool.query("select encode(claim_id, 'hex') as claim, encode(recipient, 'hex') as recipient, amount::text as amount, gateway_token, funded_offset::int as at from canton_funded_claims")).rows)
        .toEqual([{ claim: CLAIM, recipient: "e5".repeat(20), amount: "125000000000", gateway_token: "00tok1", at: 20 }]);
      expect((await pool.query("select encode(evm_token, 'hex') as evm, instrument_admin, instrument_id from canton_gateway_tokens")).rows).toEqual([{ evm: "d1".repeat(20), instrument_admin: FAKE_REGISTRY, instrument_id: "TKB" }]);
      expect((await pool.query("select participant_id, ledger_offset::int as at from canton_venue_cursor")).rows).toEqual([{ participant_id: PARTICIPANT, at: 50 }]);
      // Neither the venue's party nor the seller's is in any table, as text or as bytes.
      const text = await dump(pool);
      for (const party of [FAKE_VENUE, FAKE_SELLER]) {
        expect(text).not.toContain(party);
        expect(text).not.toContain(Buffer.from(party).toString("hex"));
      }
    });
  });

  it("marks the payment that settled a venue's trade and the deposit that redeemed its claim, with the Canton side's amount and instrument, and no other leg", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      await venueOnce(pool, (await gatewayLedger(items(chain))).ledger);
      const settling = chain.blocks[1]!.record.updateId, redeeming = chain.blocks[2]!.record.updateId;
      const hash = (b: number) => chain.blocks[b - 1]!.block.transactions[0]!.hash;
      const instrument = { admin: FAKE_REGISTRY, id: "TKB" };
      const common = { txIndex: 0, token: "0x" + "00".repeat(18) + "d000", account: "0x" + "00".repeat(17) + "0a11ce", amount: "42" };

      expect(await blockLegs(pool, 1)).toEqual([]);
      expect(await blockLegs(pool, 2)).toEqual([
        { block: 2, legIndex: 0, logIndex: expect.any(Number), kind: "payment", legId: "0x" + PAY, ...common, txHash: hash(2), updateId: settling,
          canton: { role: "venue-trade", amount: "125000000000", instrument, settledUpdateId: settling, recipient: BUYER } },
      ]);
      expect(await blockLegs(pool, 3)).toEqual([
        { block: 3, legIndex: 0, logIndex: expect.any(Number), kind: "deposit", legId: "0x" + CLAIM, ...common, txHash: hash(3), updateId: redeeming,
          canton: { role: "funded-claim", amount: "125000000000", instrument, settledUpdateId: settling, recipient: BUYER } },
      ]);
      // A withdrawal has nothing of the swap, and no Canton party in what is served; a payment with no trade behind it is a plain payment.
      expect(await blockLegs(pool, 4)).toEqual([expect.objectContaining({ kind: "withdrawal", canton: null })]);
      expect(Object.keys((await blockLegs(pool, 4))[0]!)).not.toContain("party");
      expect(await blockLegs(pool, 5)).toEqual([expect.objectContaining({ kind: "payment", legId: "0x" + "01".repeat(32), canton: null })]);
      // By the transaction, the same legs.
      expect(await txLegs(pool, hash(2))).toEqual(await blockLegs(pool, 2));
      expect(await txLegs(pool, "0x" + "00".repeat(32))).toEqual([]);
    });
  });

  it("marks a payment before its claim is read with the trade alone, and fills the Canton side in when the claim is read", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      await venueOnce(pool, (await gatewayLedger(items(chain).slice(0, 2))).ledger);
      expect((await blockLegs(pool, 2))[0]!.canton).toEqual({ role: "venue-trade", amount: null, instrument: { admin: FAKE_REGISTRY, id: "TKB" }, settledUpdateId: null, recipient: BUYER });
      expect((await blockLegs(pool, 3))[0]!.canton).toBeNull();
      await pool.query("delete from canton_venue_cursor");
      await venueOnce(pool, (await gatewayLedger(items(chain))).ledger);
      expect((await blockLegs(pool, 2))[0]!.canton).toMatchObject({ amount: "125000000000", settledUpdateId: chain.blocks[1]!.record.updateId });
      expect(await count(pool, "canton_venue_trades")).toBe(1);   // read twice, kept once
    });
  });

  it("goes on from the cursor, asks for nothing when it is there, and reads only up to the newest indexed block's record", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await indexed(pool, 1);
      const { fake, ledger } = await gatewayLedger(items(chain));
      expect(await venueOnce(pool, ledger)).toMatchObject({ tokens: 1, trades: 0, claims: 0, offset: 10 });
      const bounds = () => fake.requests.filter((r) => r.path === "/v2/updates").map((r) => [(r.body as Json).beginExclusive, (r.body as Json).endInclusive]);
      expect(bounds()).toEqual([[0, 10], [5, 10]]);
      expect(await venueOnce(pool, ledger)).toMatchObject({ offset: 10 });
      expect(fake.requests.filter((r) => r.path === "/v2/updates")).toHaveLength(2);
      chain.reads.rethHead = 5; chain.ledger.ledgerHead = 5;
      await indexer.runOnce();
      expect(await venueOnce(pool, ledger)).toEqual({ tokens: 0, trades: 1, claims: 1, offset: 50 });
      expect(bounds().slice(2)[0]).toEqual([10, 50]);
    });
  });

  it("keeps the pages it has written when a later page cannot be read, and starts again from the cursor", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      const bad = [items(chain)[0]!, transaction(15, "u-bad", [venueTradeEvent(15, "00trade", trade, { payId: "zz" })])];
      await expect(venueOnce(pool, (await gatewayLedger(bad, 1)).ledger)).rejects.toThrow(/venue trades cannot be read/);
      expect(await count(pool, "canton_gateway_tokens")).toBe(1);
      expect(await count(pool, "canton_venue_trades")).toBe(0);
      expect((await pool.query("select ledger_offset::int as at from canton_venue_cursor")).rows).toEqual([{ at: 5 }]);
      const { fake, ledger } = await gatewayLedger(items(chain), 1);
      expect(await venueOnce(pool, ledger)).toMatchObject({ trades: 1, claims: 1, offset: 50 });
      expect((fake.requests[0]!.body as Json).beginExclusive).toBe(5);
    });
  });

  it("reads nothing before a block is indexed, nor for a participant that is not the one now read, and starts from 0 after a move", async () => {
    await inDb(async (pool) => {
      await migrate(pool);
      const { ledger, fake } = await gatewayLedger([]);
      expect(await venueOnce(pool, ledger)).toEqual({ tokens: 0, trades: 0, claims: 0, offset: null });
      const { chain } = await indexed(pool, 5);
      expect(await venueOnce(pool, ledger, "PAR::someone-else::1220" + "cc".repeat(32))).toEqual({ tokens: 0, trades: 0, claims: 0, offset: null });
      expect(fake.requests).toEqual([]);
      // A cursor of another participant means nothing here: its offsets are not this participant's.
      await pool.query("insert into canton_venue_cursor (participant_id, ledger_offset, read_at) values ('PAR::earlier::1220' || repeat('dd', 32), 40, now())");
      const g = await gatewayLedger(items(chain));
      expect(await venueOnce(pool, g.ledger)).toMatchObject({ tokens: 1, trades: 1, claims: 1, offset: 50 });
      expect((g.fake.requests[0]!.body as Json).beginExclusive).toBe(0);
    });
  });
});

/** Every row of every table of the schema, as text. */
async function dump(pool: Pool): Promise<string> {
  const tables = (await pool.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1")).rows;
  const out: string[] = [];
  for (const { relname } of tables) {
    const rows = await pool.query(`select x::text as t from "${relname as string}" x`);
    for (const row of rows.rows) out.push(`${relname as string}: ${row.t as string}`);
  }
  return out.join("\n");
}
