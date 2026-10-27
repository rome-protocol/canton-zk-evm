/** The legs in a block's and a transaction's answer, and the swaps list and page, over what the indexer and the gateway party's read wrote. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi } from "./api.ts";
import { createChainDb } from "./chain-db.ts";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "./db/testing.ts";
import { createIndexer, type Indexer } from "./indexer/indexer.ts";
import { venueOnce } from "./indexer/venue.ts";
import { createLedger, CUSTODY_ENDPOINTS } from "./ledger.ts";
import { createAccountRest } from "./rest/account-rest.ts";
import { createChainRest } from "./rest/chain-rest.ts";
import { FIELDS, REST_FIELDS as F } from "./rest/fields.ts";
import type { Reth } from "./reth.ts";
import { CHAIN_ID, GATEWAY, PARTICIPANT, PINS, makeChain, type BlockShape, type SyntheticChain } from "../test/synthetic-chain.ts";
import { FAKE_GATEWAY, FAKE_REGISTRY, FAKE_SELLER, FAKE_VENUE, fundedClaimEvent, gatewayTokenEvent, startFakeLedger, transaction, venueTradeEvent, type FakeLedger } from "../test/fake-ledger.ts";
import type { Json } from "../test/fake-ledger.ts";

const TKB = "0x" + "d1".repeat(20);
const PAY = "a1".repeat(32), CLAIM = "b2".repeat(32), PAY2 = "a3".repeat(32), CLAIM2 = "b4".repeat(32);
const BUYER = "0x" + "e5".repeat(20), PAYEE = "0x" + "00".repeat(17) + "0a11ce";
// What the synthetic chain's payment leg pays by default (token 0xd000 to 0xa11ce, 42): a trade says the same, as the builder's check wants.
const ERC = "0x" + "00".repeat(18) + "d000";
const SQUATTER = "0x" + "ab".repeat(20);
const trade = { payId: PAY, claimId: CLAIM, token: ERC, payee: PAYEE, recipient: BUYER, amount: 42n, gatewayToken: "00tok1" };
const trade2 = { ...trade, payId: PAY2, claimId: CLAIM2 };
const claim = { claimId: CLAIM, recipient: BUYER, amount: "12.5", gatewayToken: "00tok1" };
const claim2 = { claimId: CLAIM2, recipient: BUYER, amount: "3", gatewayToken: "00tok1" };

const fakes: FakeLedger[] = [];
const opened: Indexer[] = [];
afterEach(async () => {
  while (fakes.length) await fakes.pop()!.close();
});
/** A database for one test: the indexer it opened is closed before the database is dropped. */
const inDb = (fn: (pool: Pool) => Promise<void>) => withDatabase(async (pool) => {
  try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
});

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;

/**
 * Seven blocks (the Canton records are at offsets 10 to 70): block 2 pays for a venue's trade, block 3 redeems its funded claim, block 4 is a withdrawal, block 5 a payment with no trade behind it,
 * block 6 pays for a second trade whose claim nobody has redeemed, and block 7 is empty; `extra` blocks follow. The gateway party's read is done up to the newest block's record.
 */
async function served(pool: Pool, { read = true, extra = [] }: { read?: boolean; extra?: BlockShape[] } = {}) {
  await migrate(pool);
  const chain: SyntheticChain = makeChain([
    { txs: 2 }, { txs: 2, leg: 3, legId: "0x" + PAY }, { txs: 2, leg: 1, legId: "0x" + CLAIM, legToken: TKB, legAccount: BUYER, legAmount: 125000000000n }, { txs: 2, leg: 2 }, { txs: 2, leg: 3 },
    { txs: 2, leg: 3, legId: "0x" + PAY2 }, { txs: 0 }, ...extra,
  ]);
  chain.reads.rethHead = 7 + extra.length;
  chain.ledger.ledgerHead = 7 + extra.length;
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  await indexer.runOnce();
  if (read) {
    const items: Json[] = [
      transaction(5, "u-registered", [gatewayTokenEvent(5, "00tok1", TKB, FAKE_REGISTRY, "TKB")]),
      transaction(15, "u-offered", [venueTradeEvent(15, "00trade", trade), venueTradeEvent(15, "00trade2", trade2)]),
      transaction(20, chain.blocks[1]!.record.updateId, [fundedClaimEvent(20, "00claim", claim)]),
      transaction(60, chain.blocks[5]!.record.updateId, [fundedClaimEvent(60, "00claim2", claim2)]),
    ];
    const f = await startFakeLedger(items, { ledgerEnd: 999 });
    fakes.push(f);
    await venueOnce(pool, createLedger(f.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), PARTICIPANT, CHAIN_ID);
  }
  const reth = { code: async () => "0x6080", token: async () => null, block: async () => undefined, transaction: async () => null } as unknown as Reth;
  const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
  const api = createApi({ config, reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), rest: createChainRest(pool), accounts: createAccountRest(pool) });
  return { chain, get: async (target: string) => api("GET", target) };
}

const keys = (o: unknown) => Object.keys(o as object).sort();
const same = (o: unknown, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());

describe.skipIf(!TEST_URL)("the legs and the swaps in the answers", () => {
  checkRequired();

  it("gives a block its legs, with the Canton side of a swap's, in the fields of the allowlists, on both block routes", async () => {
    await inDb(async (pool) => {
      const { chain, get } = await served(pool);
      const settling = chain.blocks[1]!.record.updateId;
      for (const path of ["/api/block/2", "/api/blocks/2"]) {
        const { status, body } = await get(path);
        expect(status).toBe(200);
        const legs = (body as { legs: Record<string, unknown>[] }).legs;
        expect(legs).toHaveLength(1);
        same(legs[0], FIELDS.blockLeg);
        same(legs[0]!.canton, FIELDS.legCanton);
        same((legs[0]!.canton as { instrument: object }).instrument, FIELDS.legInstrument);
        expect(legs[0]).toMatchObject({
          block: 2, kind: "payment", legId: "0x" + PAY, txHash: chain.blocks[1]!.block.transactions[0]!.hash, updateId: settling,
          canton: { role: "venue-trade", amount: "125000000000", instrument: { admin: FAKE_REGISTRY, id: "TKB" }, settledUpdateId: settling, recipient: BUYER },
        });
      }
      expect((await get("/api/blocks/3")).body).toMatchObject({ legs: [{ kind: "deposit", canton: { role: "funded-claim" } }] });
      expect((await get("/api/blocks/4")).body).toMatchObject({ legs: [{ kind: "withdrawal", canton: null }] });
      expect((await get("/api/blocks/5")).body).toMatchObject({ legs: [{ kind: "payment", canton: null }] });
      expect((await get("/api/blocks/7")).body).toMatchObject({ legs: [] });
      expect((await get("/api/blocks/1")).body).toMatchObject({ legs: [] });
    });
  });

  it("gives a transaction the legs it caused, and none to one that caused none", async () => {
    await inDb(async (pool) => {
      const { chain, get } = await served(pool);
      const [first, second] = chain.blocks[1]!.block.transactions;
      for (const path of ["/api/tx/", "/api/txs/"]) {
        const a = await get(path + first!.hash);
        expect(a.status).toBe(200);
        expect((a.body as { legs: unknown[] }).legs).toEqual([expect.objectContaining({ kind: "payment", legId: "0x" + PAY, canton: expect.objectContaining({ role: "venue-trade" }) })]);
        same((a.body as { legs: object[] }).legs[0], FIELDS.blockLeg);
        expect((await get(path + second!.hash)).body).toMatchObject({ legs: [] });
      }
    });
  });

  it("lists the swaps newest first, in pages, and a payment that no trade is behind is not one", async () => {
    await inDb(async (pool) => {
      const { chain, get } = await served(pool);
      const { status, body } = await get("/api/swaps");
      expect(status).toBe(200);
      const page = body as { items: Record<string, any>[]; next: string | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(keys(page)).toEqual([...F.page].sort());
      expect(page.items.map((s) => [s.payId, s.status, s.payment.block, s.claim?.block ?? null])).toEqual([["0x" + PAY2, "settled", 6, null], ["0x" + PAY, "claimed", 2, 3]]);
      expect(page.next).toBeNull();
      for (const s of page.items) {
        same(s, F.swap); same(s.offer, F.swapOffer); same(s.evm, F.swapEvm); same(s.canton, F.swapCanton); same(s.payment, F.swapPayment);
        same(s.canton.instrument, FIELDS.legInstrument);
      }
      same(page.items[1]!.claim, F.swapClaim);
      expect(page.items[0]!.payment.updateId).toBe(chain.blocks[5]!.record.updateId);
      // Paged by one.
      const first = (await get("/api/swaps?limit=1")).body as typeof page;
      expect(first.items.map((s) => s.payId)).toEqual(["0x" + PAY2]);
      expect(first.next).not.toBeNull();
      const second = (await get(`/api/swaps?limit=1&before=${encodeURIComponent(first.next!)}`)).body as typeof page;
      expect(second.items.map((s) => s.payId)).toEqual(["0x" + PAY]);
      expect(second.next).toBeNull();
    });
  });

  it("serves one swap: both sides, the payment's block with its update id and record time, and the claim's block", async () => {
    await inDb(async (pool) => {
      const { chain, get } = await served(pool);
      const { status, body } = await get(`/api/swaps/0x${PAY}`);
      expect(status).toBe(200);
      const pay = chain.blocks[1]!, redeem = chain.blocks[2]!;
      expect(body).toEqual({
        payId: "0x" + PAY, claimId: "0x" + CLAIM, status: "claimed", offer: { updateId: "u-offered" },
        evm: { token: "0x" + "00".repeat(18) + "d000", symbol: null, decimals: null, payer: expect.stringMatching(/^0x[0-9a-f]{40}$/), payee: "0x" + "00".repeat(17) + "0a11ce", amount: "42" },
        canton: { amount: "125000000000", instrument: { admin: FAKE_REGISTRY, id: "TKB" }, recipient: BUYER, updateId: pay.record.updateId },
        payment: { block: 2, txHash: pay.block.transactions[0]!.hash, legIndex: 0, updateId: pay.record.updateId, recordTime: pay.record.recordTime },
        claim: { block: 3, txHash: redeem.block.transactions[0]!.hash, legIndex: 0, updateId: redeem.record.updateId, recordTime: redeem.record.recordTime },
      });
      expect((await get(`/api/swaps/0x${PAY2}`)).body).toMatchObject({ status: "settled", claim: null, payment: { block: 6 } });
    });
  });

  it("serves a swap whose funded claim has not been read yet, without the Canton amount, and not yet claimed", async () => {
    await inDb(async (pool) => {
      const { get } = await served(pool, { read: false });
      // Without the gateway party's read there is no trade: nothing is a swap.
      expect((await get("/api/swaps")).body).toEqual({ items: [], next: null });
      expect((await get(`/api/swaps/0x${PAY}`)).status).toBe(404);
      await pool.query(
        "insert into canton_venue_trades (pay_id, claim_id, token, payee, recipient, evm_amount, gateway_token, offered_update_id, payment_block, payment_leg_index) values (decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'), decode($4, 'hex'), decode($5, 'hex'), 42, 'x', 'u', 2, 0)",
        [PAY, CLAIM, "00".repeat(18) + "d000", "00".repeat(17) + "0a11ce", "e5".repeat(20)],
      );
      expect((await get(`/api/swaps/0x${PAY}`)).body).toMatchObject({ status: "settled", claim: null, canton: { amount: null, instrument: null, recipient: BUYER, updateId: null } });
    });
  });

  it("does not take a deposit for the redemption of a claim, nor a payment for a trade's, when it is not what the builder settles", async () => {
    await inDb(async (pool) => {
      // Block 8 is a deposit under the second claim's id for another address, block 9 a payment under the first payment id that pays another amount, block 10 a deposit for the second claim's recipient in its token but not for its amount.
      const { get } = await served(pool, { extra: [{ txs: 1, leg: 1, legId: "0x" + CLAIM2, legToken: TKB, legAccount: SQUATTER }, { txs: 1, leg: 3, legId: "0x" + PAY, legAmount: 41n },
        { txs: 1, leg: 1, legId: "0x" + CLAIM2, legToken: TKB, legAccount: BUYER }] });
      expect((await get("/api/blocks/8")).body).toMatchObject({ legs: [{ kind: "deposit", canton: null }] });
      expect((await get("/api/blocks/9")).body).toMatchObject({ legs: [{ kind: "payment", canton: null }] });
      expect((await get("/api/blocks/10")).body).toMatchObject({ legs: [{ kind: "deposit", canton: null }] });
      const list = (await get("/api/swaps")).body as { items: { payId: string; status: string; claim: unknown; payment: { block: number } }[] };
      expect(list.items.map((s) => [s.payId, s.status, s.claim, s.payment.block])).toEqual([["0x" + PAY2, "settled", null, 6], ["0x" + PAY, "claimed", expect.anything(), 2]]);
      expect((await get(`/api/swaps/0x${PAY2}`)).body).toMatchObject({ status: "settled", claim: null });
    });
  });

  it("gives a block's answer its first 50 legs, and pages through all of them with the Canton side of each", async () => {
    await inDb(async (pool) => {
      const { get } = await served(pool);
      await pool.query(
        "insert into gateway_legs (block_number, leg_index, tx_index, log_index, kind, leg_id, token, account, amount) select 7, g, 0, g, 3, decode(lpad(to_hex(g), 64, '0'), 'hex'), decode(repeat('01', 20), 'hex'), decode(repeat('02', 20), 'hex'), 5 from generate_series(0, 59) g",
      );
      for (const path of ["/api/block/7", "/api/blocks/7"]) expect(((await get(path)).body as { legs: unknown[] }).legs).toHaveLength(50);
      const all = (await get("/api/blocks/7/legs?limit=100")).body as { items: Record<string, unknown>[] };
      expect(all.items).toHaveLength(60);
      same(all.items[0], F.leg);
      expect(all.items[0]!.canton).toBeNull();
      const paid = (await get("/api/blocks/2/legs")).body as { items: Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
      same(paid.items[0]!.canton, FIELDS.legCanton);
      same(paid.items[0]!.canton.instrument, FIELDS.legInstrument);
      expect(paid.items[0]).toMatchObject({ kind: "payment", legId: "0x" + PAY, canton: { role: "venue-trade", recipient: BUYER } });
    });
  });

  it("refuses an id that is not one, and answers 404 for one that names no swap; no Canton party is in any answer", async () => {
    await inDb(async (pool) => {
      const { get } = await served(pool);
      expect((await get("/api/swaps/xyz")).status).toBe(400);
      expect((await get(`/api/swaps/${PAY}`)).status).toBe(400);
      expect((await get("/api/swaps/0x" + "00".repeat(32))).status).toBe(404);
      const all = JSON.stringify([(await get("/api/swaps")).body, (await get("/api/blocks/2")).body, (await get("/api/blocks/3")).body, (await get(`/api/swaps/0x${PAY}`)).body]);
      for (const party of [FAKE_VENUE, FAKE_SELLER]) expect(all).not.toContain(party);
    });
  });
});
