/** The Canton side of the swaps, on the pinned PostgreSQL, against a stand-in Ledger API that answers as the gateway's view. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { createLedger, CUSTODY_ENDPOINTS, type Ledger } from "../ledger.ts";
import { CHAIN_ID, GATEWAY, PARTICIPANT, PINS, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { FAKE_GATEWAY, FAKE_REGISTRY, FAKE_SELLER, FAKE_VENUE, fundedClaimEvent, gatewayTokenEvent, startFakeLedger, transaction, venueTradeEvent, type FakeLedger } from "../../test/fake-ledger.ts";
import type { Json } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { blockLegs, txLegs } from "./leg-canton.ts";
import { venueOnce as venueAt } from "./venue.ts";

const TKB = "0x" + "d1".repeat(20);
const PAY = "a1".repeat(32), CLAIM = "b2".repeat(32);
const BUYER = "0x" + "e5".repeat(20), PAYEE = "0x" + "00".repeat(17) + "0a11ce";
// What the synthetic chain's payment leg pays by default (token 0xd000 to 0xa11ce, 42): the trade says the same, as the builder's check wants.
const ERC = "0x" + "00".repeat(18) + "d000";
const trade = { payId: PAY, claimId: CLAIM, token: ERC, payee: PAYEE, recipient: BUYER, amount: 42n, gatewayToken: "00tok1" };
const SQUATTER = "0x" + "ab".repeat(20);
const claim = { claimId: CLAIM, recipient: BUYER, amount: "12.5", gatewayToken: "00tok1" };

const fakes: FakeLedger[] = [];
const opened: Indexer[] = [];
afterEach(async () => {
  while (fakes.length) await fakes.pop()!.close();
});
const inDb = (fn: (pool: Pool) => Promise<void>) => withDatabase(async (pool) => {
  try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
});
const venueOnce = (pool: Pool, ledger: Pick<Ledger, "venuePages">, participant: string = PARTICIPANT) => venueAt(pool, ledger, participant, CHAIN_ID);
const gatewayLedger = async (items: Json[], pageSize = 100) => {
  const f = await startFakeLedger(items, { ledgerEnd: 999 });
  fakes.push(f);
  return { fake: f, ledger: createLedger(f.url, 2000, FAKE_GATEWAY, pageSize, null, CUSTODY_ENDPOINTS) };
};

/**
 * Five blocks (the Canton records are at offsets 10 to 50): block 2 records the payment of a venue's trade, block 3 the deposit that redeems its funded claim, block 4 a withdrawal,
 * and block 5 a payment that no Canton trade is behind. The first `n` are indexed.
 */
const SHAPES: BlockShape[] = [{ txs: 2 }, { txs: 2, leg: 3, legId: "0x" + PAY }, { txs: 2, leg: 1, legId: "0x" + CLAIM, legToken: TKB, legAccount: BUYER, legAmount: 125000000000n }, { txs: 2, leg: 2 }, { txs: 2, leg: 3 }];
async function indexed(pool: Pool, n: number, shapes: BlockShape[] = SHAPES): Promise<{ chain: SyntheticChain; indexer: Indexer }> {
  await migrate(pool);
  const chain = makeChain(shapes);
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
      expect((await pool.query("select encode(pay_id, 'hex') as pay, encode(claim_id, 'hex') as claim, encode(token, 'hex') as token, encode(payee, 'hex') as payee, encode(recipient, 'hex') as recipient, evm_amount::text as amount, gateway_token, offered_update_id, payment_block::int as block, payment_leg_index as leg from canton_venue_trades")).rows)
        .toEqual([{ pay: PAY, claim: CLAIM, token: "00".repeat(18) + "d000", payee: "00".repeat(17) + "0a11ce", recipient: "e5".repeat(20), amount: "42", gateway_token: "00tok1", offered_update_id: "u-offered", block: 2, leg: 0 }]);
      expect((await pool.query("select encode(claim_id, 'hex') as claim, encode(recipient, 'hex') as recipient, amount::text as amount, gateway_token, funded_update_id from canton_funded_claims")).rows)
        .toEqual([{ claim: CLAIM, recipient: "e5".repeat(20), amount: "125000000000", gateway_token: "00tok1", funded_update_id: chain.blocks[1]!.record.updateId }]);
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
      const paid = { txIndex: 0, token: ERC, account: PAYEE, amount: "42" }, redeemed = { txIndex: 0, token: TKB, account: BUYER, amount: "125000000000" };

      expect(await blockLegs(pool, 1)).toEqual([]);
      expect(await blockLegs(pool, 2)).toEqual([
        { block: 2, legIndex: 0, logIndex: expect.any(Number), kind: "payment", legId: "0x" + PAY, ...paid, txHash: hash(2), updateId: settling,
          canton: { role: "venue-trade", amount: "125000000000", instrument, settledUpdateId: settling, recipient: BUYER } },
      ]);
      expect(await blockLegs(pool, 3)).toEqual([
        { block: 3, legIndex: 0, logIndex: expect.any(Number), kind: "deposit", legId: "0x" + CLAIM, ...redeemed, txHash: hash(3), updateId: redeeming,
          canton: { role: "funded-claim", amount: "125000000000", instrument, settledUpdateId: settling, recipient: BUYER } },
      ]);
      // A withdrawal has nothing of the swap, and no Canton party in what is served; a payment with no trade behind it is a plain payment.
      expect(await blockLegs(pool, 4)).toEqual([expect.objectContaining({ kind: "withdrawal", canton: null })]);
      expect(Object.keys((await blockLegs(pool, 4))[0]!)).not.toContain("party");
      expect(await blockLegs(pool, 5)).toEqual([expect.objectContaining({ kind: "payment", legId: "0x" + "01".repeat(32), canton: null })]);
      // By the transaction, the same legs.
      expect(await txLegs(pool, hash(2))).toEqual(await blockLegs(pool, 2));
      expect(await txLegs(pool, hash(2), 1)).toEqual((await blockLegs(pool, 2)).slice(0, 1));
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

  it("keeps one trade for each payment id and one claim for each claim id when a page creates them more than once (the trade an indexed payment pays, else the newest offer; the newest claim), and the read goes on past it", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      const OTHER = "0x" + "c7".repeat(20), NEWEST = "0x" + "c8".repeat(20);
      const settling = chain.blocks[1]!.record.updateId;
      // Two offers of the payment id in one update and a third in a later one, and two claims of the claim id, one in each of two updates, all in one page.
      const twice = [
        transaction(5, "u-registered", [gatewayTokenEvent(5, "00tok1", TKB, FAKE_REGISTRY, "TKB")]),
        transaction(15, "u-offered", [venueTradeEvent(15, "00trade", trade, { recipient: OTHER }), venueTradeEvent(15, "00trade-b", trade, { recipient: BUYER })]),
        transaction(16, "u-again", [venueTradeEvent(16, "00trade-c", trade, { recipient: NEWEST })]),
        transaction(19, "u-claimed", [fundedClaimEvent(19, "00claim-a", claim, { recipient: OTHER })]),
        transaction(20, settling, [fundedClaimEvent(20, "00claim", claim)]),
      ];
      const { ledger } = await gatewayLedger(twice);
      expect(await venueOnce(pool, ledger)).toMatchObject({ offset: 50 });
      expect((await pool.query("select encode(recipient, 'hex') as recipient, offered_update_id from canton_venue_trades")).rows).toEqual([{ recipient: "e5".repeat(20), offered_update_id: "u-offered" }]);
      // The payment of block 2 pays these terms: the later offer in u-again does not replace the row, and the newest of the two in one update is the one kept.
      expect((await pool.query("select encode(recipient, 'hex') as recipient, funded_update_id from canton_funded_claims")).rows).toEqual([{ recipient: "e5".repeat(20), funded_update_id: settling }]);
      // The read is not stuck: a trade created later is read, and the cursor is where the walk ended.
      expect((await pool.query("select ledger_offset::int as at from canton_venue_cursor")).rows).toEqual([{ at: 50 }]);
      // The same ids offered again by later pages (one update each) are kept once too.
      await pool.query("delete from canton_venue_cursor");
      const { ledger: onePerPage } = await gatewayLedger(twice, 1);
      expect(await venueOnce(pool, onePerPage)).toMatchObject({ offset: 50 });
      expect(await count(pool, "canton_venue_trades")).toBe(1);
      expect(await count(pool, "canton_funded_claims")).toBe(1);
    });
  });

  it("keeps the trade a payment settled when it is offered again, and takes the new terms of a trade that no payment has settled", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      const base = items(chain);
      await venueOnce(pool, (await gatewayLedger(base)).ledger);
      const matched = () => pool.query("select payment_block::int as block, payment_leg_index as leg, evm_amount::int as amount from canton_venue_trades").then((r) => r.rows);
      expect(await matched()).toEqual([{ block: 2, leg: 0, amount: 42 }]);
      // The gateway spends a payment id once: an offer under the spent id, the same or dearer, does not replace the trade that was paid, and block 2 stays the trade's payment.
      await pool.query("delete from canton_venue_cursor");
      await venueOnce(pool, (await gatewayLedger([...base, transaction(25, "u-again", [venueTradeEvent(25, "00trade-b", trade)])])).ledger);
      expect(await matched()).toEqual([{ block: 2, leg: 0, amount: 42 }]);
      await pool.query("delete from canton_venue_cursor");
      await venueOnce(pool, (await gatewayLedger([...base, transaction(25, "u-dearer", [venueTradeEvent(25, "00trade-c", { ...trade, amount: 43n })])])).ledger);
      expect(await matched()).toEqual([{ block: 2, leg: 0, amount: 42 }]);
      expect(await blockLegs(pool, 2)).toEqual([expect.objectContaining({ kind: "payment", canton: expect.objectContaining({ role: "venue-trade" }) })]);
      // A new or rebuilt database walks from the start and reads the paid offer and a later, dearer re-offer together: the payment is indexed, so the re-offer does not replace the trade.
      await pool.query("delete from canton_venue_trades");
      await pool.query("delete from canton_venue_cursor");
      await venueOnce(pool, (await gatewayLedger([...base, transaction(25, "u-dearer", [venueTradeEvent(25, "00trade-c", { ...trade, amount: 43n })])])).ledger);
      expect(await matched()).toEqual([{ block: 2, leg: 0, amount: 42 }]);
      // A trade that no indexed payment pays takes the newest offer: the payment of block 2 pays 7 here, so it is not the payment of either offer, and the dearer one is kept.
      await pool.query("update gateway_legs set amount = 7 where kind = 3 and block_number = 2");
      await pool.query("delete from canton_venue_trades");
      await pool.query("delete from canton_venue_cursor");
      await venueOnce(pool, (await gatewayLedger([...base, transaction(25, "u-dearer", [venueTradeEvent(25, "00trade-c", { ...trade, amount: 43n })])])).ledger);
      expect(await matched()).toEqual([{ block: null, leg: null, amount: 43 }]);
      expect(await blockLegs(pool, 2)).toEqual([expect.objectContaining({ kind: "payment", canton: null })]);
      await pool.query("update gateway_legs set amount = 42 where kind = 3 and block_number = 2");
      // A match that was lost is found again on the next read, which has nothing new to read, once the match starts from the first block again.
      await pool.query("update canton_venue_trades set evm_amount = 42");
      await pool.query("update canton_venue_cursor set matched_block = 0");
      await venueOnce(pool, (await gatewayLedger(base)).ledger);
      expect(await matched()).toEqual([{ block: 2, leg: 0, amount: 42 }]);
    });
  });

  it("looks for payments only in the blocks since the last match", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      const base = items(chain);
      await venueOnce(pool, (await gatewayLedger(base)).ledger);
      await pool.query("update canton_venue_trades set payment_block = null, payment_leg_index = null");
      // The cursor is past block 2 and nothing is new: the payment is not looked for again.
      await venueOnce(pool, (await gatewayLedger(base)).ledger);
      expect(await pool.query("select payment_block from canton_venue_trades").then((r) => r.rows)).toEqual([{ payment_block: null }]);
      expect(await pool.query("select matched_block::int as at from canton_venue_cursor").then((r) => r.rows)).toEqual([{ at: 5 }]);
    });
  });

  it("serves a deposit as the redemption of a claim only for the claim's recipient in the claim's token, and a payment as the trade's only when it pays the trade's terms", async () => {
    await inDb(async (pool) => {
      // Block 2 pays a different amount under the payment id, block 3 pays the trade's terms, block 4 is a deposit under the claim id that another address signed, block 5 one for the
      // recipient in another token, block 6 the recipient's own, block 7 one for the recipient in the token but for another amount.
      const { chain } = await indexed(pool, 7, [
        { txs: 2 }, { txs: 2, leg: 3, legId: "0x" + PAY, legAmount: 41n }, { txs: 2, leg: 3, legId: "0x" + PAY }, { txs: 2, leg: 1, legId: "0x" + CLAIM, legToken: TKB, legAccount: SQUATTER },
        { txs: 2, leg: 1, legId: "0x" + CLAIM, legToken: ERC, legAccount: BUYER, legAmount: 125000000000n }, { txs: 2, leg: 1, legId: "0x" + CLAIM, legToken: TKB, legAccount: BUYER, legAmount: 125000000000n },
        { txs: 2, leg: 1, legId: "0x" + CLAIM, legToken: TKB, legAccount: BUYER, legAmount: 42n },
      ]);
      const settling = chain.blocks[2]!.record.updateId;
      await venueOnce(pool, (await gatewayLedger([
        transaction(5, "u-registered", [gatewayTokenEvent(5, "00tok1", TKB, FAKE_REGISTRY, "TKB")]),
        transaction(15, "u-offered", [venueTradeEvent(15, "00trade", trade)]),
        transaction(30, settling, [fundedClaimEvent(30, "00claim", claim)]),
      ])).ledger);
      const roles = async () => (await Promise.all([2, 3, 4, 5, 6, 7].map((b) => blockLegs(pool, b)))).map((l) => l[0]!.canton?.role ?? null);
      expect(await roles()).toEqual([null, "venue-trade", null, null, "funded-claim", null]);
      expect((await blockLegs(pool, 3))[0]!.canton!.settledUpdateId).toBe(settling);
    });
  });

  it("reads only the contracts of this chain", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 5);
      const other = { chainId: "12" };
      expect(await venueOnce(pool, (await gatewayLedger([
        ...items(chain),
        transaction(16, "u-other", [gatewayTokenEvent(16, "00tokX", "0x" + "d3".repeat(20), FAKE_REGISTRY, "TKX", other), venueTradeEvent(16, "00tradeX", { ...trade, payId: "c3".repeat(32) }, other)]),
        transaction(21, "u-other-claim", [fundedClaimEvent(21, "00claimX", { ...claim, claimId: "c4".repeat(32) }, other)]),
      ])).ledger)).toEqual({ tokens: 1, trades: 1, claims: 1, offset: 50 });
      expect(await count(pool, "canton_gateway_tokens")).toBe(1);
      expect(await count(pool, "canton_venue_trades")).toBe(1);
      expect(await count(pool, "canton_funded_claims")).toBe(1);
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
