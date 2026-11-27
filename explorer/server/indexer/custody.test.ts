/** The custody read, on the pinned PostgreSQL, against a stand-in Ledger API that answers as the gateway's view. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { createLedger, CUSTODY_ENDPOINTS, type HoldingChange, type Ledger } from "../ledger.ts";
import { createReceiptsRest } from "../receipts.ts";
import { custodyMatched } from "../rest/twins-rest.ts";
import { CHAIN_ID, GATEWAY, PARTICIPANT, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { FAKE_GATEWAY, FAKE_REGISTRY, archivedEvent, gatewayToken, holding, holdingEvent, payoutEvent, startFakeLedger, transaction, type ActiveContract, type FakeLedger } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { custodyOnce as custodyAt } from "./custody.ts";

const TKB = "0x" + "d1".repeat(20), TKC = "0x" + "d2".repeat(20);
const SUPPLY = "0x18160ddd";
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const SOMEONE = "alice::1220" + "ab".repeat(32);
/** The custody read as the indexer makes it, by default as the participant the synthetic chain reports. */
const custodyOnce = (pool: Pool, ledger: Pick<Ledger, "gatewayTokens" | "holdingPages" | "chainRegistry">, reads: SyntheticChain["reads"], limit: number, participant: string = PARTICIPANT, ledgerEnd: (() => Promise<number>) | null = null) => custodyAt(pool, ledger, reads, limit, participant, null, ledgerEnd);
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
      const first = await gatewayLedger([holding(1, FAKE_GATEWAY, "100"), holding(3, SOMEONE, "7")]);
      expect(await custodyOnce(pool, first.ledger, chain.reads, 500)).toMatchObject({ tokens: 0, offset: 30, block: 3 });
      expect(first.fake.requests.filter((r) => r.path.endsWith("active-contracts")).map((r) => (r.body as { activeAtOffset: number }).activeAtOffset)).toEqual([30]);
      expect(first.fake.requests.filter((r) => r.path === "/v2/updates").map((r) => (r.body as { endInclusive: number }).endInclusive)).toEqual([30, 30, 30, 30]);   // the holdings' walk and the statuses' walk, each up to B's offset (no ledger end given), each ended by an empty answer
      expect(await rows(pool)).toEqual([]);
      const { ledger } = await gatewayLedger([gatewayToken(TKB), gatewayToken(TKC, FAKE_REGISTRY, "TKC")]);
      // The holdings were walked by the first read, up to offset 30: a registered token that comes later is set against them.
      expect(await custodyOnce(pool, ledger, chain.reads, 500)).toMatchObject({ tokens: 2, offset: 30, block: 3 });
      expect(await rows(pool)).toMatchObject([
        { evm: "d1".repeat(20), instrument_admin: FAKE_REGISTRY, instrument_id: "TKB", custody: "1000000000000", holdings: 1, supply: "1005000000", supply_block: 3, ledger_offset: 30 },
        { evm: "d2".repeat(20), instrument_admin: FAKE_REGISTRY, instrument_id: "TKC", custody: "0", holdings: 0, supply: "0", supply_block: 3, ledger_offset: 30 },
      ]);
    });
  });

  it("writes nothing while no block is indexed, and says no supply for a token that did not answer", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await indexed(pool, 0, {}, 2);
      const { ledger, fake } = await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")]);
      expect(await custodyOnce(pool, ledger, chain.reads, 500)).toMatchObject({ tokens: 0, offset: 0, block: null });
      expect(fake.requests).toHaveLength(0);
      chain.reads.rethHead = 2;
      chain.ledger.ledgerHead = 2;
      await indexer.runOnce();
      await custodyOnce(pool, ledger, chain.reads, 500);
      expect(await rows(pool)).toMatchObject([{ evm: "d1".repeat(20), custody: "10000000000", supply: null, supply_block: 2, ledger_offset: 20 }]);
    });
  });

  it("reads at a block of the participant now read: after a reader move the older participant's offset is not used, the last rows stay, and nothing is asked of Canton", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 2, { [TKB]: 1_005_000_000n });
      const { ledger, fake } = await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")]);
      await custodyOnce(pool, ledger, chain.reads, 500);
      const before = await rows(pool);
      expect(before).toMatchObject([{ supply_block: 2, ledger_offset: 20 }]);
      const asked = fake.requests.length;
      // the reader moved: the participant that holds every indexed record is no longer the one read, and the new one has no block yet
      await pool.query("update canton_participants set moved_out_at = now()");
      await pool.query("insert into canton_participants (participant_id, first_offset, moved_in_at) values ('new-participant', 0, now())");
      expect(await custodyOnce(pool, ledger, chain.reads, 500)).toMatchObject({ tokens: 0, offset: 0, block: null });
      expect(fake.requests).toHaveLength(asked);
      expect(await rows(pool)).toEqual(before);
    });
  });

  it("reads nothing while the participant the reader reports is not the one of the newest block, and never reads an older block after a move A -> B -> A", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 2, { [TKB]: 1_005_000_000n });
      const { ledger, fake } = await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")]);
      await custodyOnce(pool, ledger, chain.reads, 500);
      const before = await rows(pool);
      const asked = fake.requests.length;
      // LEDGER_URL points at another participant, and the database has not been moved: nothing is read at the old participant's offset
      expect(await custodyOnce(pool, ledger, chain.reads, 500, "other-participant")).toMatchObject({ tokens: 0, offset: 0, block: null });
      // A -> B: B has one block; A <- B: the reader is back at A, which has no newer block than B's
      await pool.query("update canton_participants set moved_out_at = now()");
      const [b] = (await pool.query("insert into canton_participants (participant_id, first_offset, moved_in_at) values ('participant-b', 0, now()) returning id")).rows;
      const [last] = (await pool.query("select update_id from blocks order by number desc limit 1")).rows;
      await pool.query("update canton_updates set participant = $1 where update_id = $2", [b.id, last.update_id]);
      await pool.query("update canton_participants set moved_out_at = now() where participant_id = 'participant-b'");
      await pool.query("update canton_participants set first_offset = 0, last_offset = null, moved_in_at = now(), moved_out_at = null where participant_id = $1", [PARTICIPANT]);
      expect(await custodyOnce(pool, ledger, chain.reads, 500)).toMatchObject({ tokens: 0, offset: 0, block: null });
      expect(fake.requests).toHaveLength(asked);
      expect(await rows(pool)).toEqual(before);
    });
  });

  it("reads the custody and the supply at the same block, so a deposit that lands between two reads never shows as a difference", async () => {
    await inDb(async (pool) => {
      // Each block holds one deposit of 10 units. The world is what Canton and reth know at the head: a stand-in Canton answers the custody at any offset it is
      // asked for, as the active contracts at that offset would be, and reth answers the supply at any block.
      const units = 10n ** 10n;
      let head = 2;
      const { chain, indexer } = await indexed(pool, 2, {}, 3);
      const asked: number[] = [];
      // Each deposit is a holding created at the offset of its block: the walk up to an offset is what Canton knew then.
      const canton = {
        gatewayTokens: async () => [{ evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB" }],
        holdingPages: async function* (after: number, upTo: number) {
          asked.push(upTo);
          for (let n = Math.max(after / 10 + 1, 1); n * 10 <= Math.min(upTo, head * 10); n++) {
            yield { offset: n * 10, changes: [{ kind: "created" as const, contractId: `cid${n}`, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB", amount: 10n * units }] };
          }
        },
      } as unknown as Pick<Ledger, "gatewayTokens" | "holdingPages" | "chainRegistry">;
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
      expect(asked).toEqual([20, 20, 20, 20]);   // two reads, each the holdings' walk and the statuses' walk, both at B
      // Once the explorer has indexed block 3, the read is at block 3 and both numbers have the deposit.
      chain.reads.rethHead = 3;
      chain.ledger.ledgerHead = 3;
      await indexer.runOnce();
      await custodyOnce(pool, canton, reth, 500);
      expect(await diff()).toEqual({ custody: 30_000_000n, supply: 30_000_000n, block: 3, offset: 30 });
    });
  });

  it("keeps the rows to the tokens of the last read: one that is no longer registered is dropped", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 2, { [TKB]: 1n, [TKC]: 1n });
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), gatewayToken(TKC, FAKE_REGISTRY, "TKC"), holding(1, FAKE_GATEWAY, "1")])).ledger, chain.reads, 500);
      const first = await rows(pool);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")])).ledger, chain.reads, 500);
      const after = await rows(pool);
      expect(after).toMatchObject([{ evm: "d1".repeat(20), custody: "10000000000", holdings: 1, ledger_offset: 20 }]);
      expect(after[0]!.read_at.getTime()).toBeGreaterThanOrEqual(first[0]!.read_at.getTime());
      await custodyOnce(pool, (await gatewayLedger([])).ledger, chain.reads, 500);
      expect(await rows(pool)).toEqual([]);
    });
  });

  it("leaves the last rows as they are when Canton cannot be read, or its answer cannot be stood behind, and says so", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await indexed(pool, 1, { [TKB]: 1n }, 2);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")])).ledger, chain.reads, 500);
      const before = await rows(pool);
      const down = await startFakeLedger([], { httpStatus: 503, active: [] });
      fakes.push(down);
      await expect(custodyOnce(pool, createLedger(down.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), chain.reads, 500)).rejects.toThrow(/cannot read Canton/);
      // The next block's update brings a holding with no view: the walk fails, and nothing is written.
      chain.reads.rethHead = 2; chain.ledger.ledgerHead = 2;
      await indexer.runOnce();
      const bad = await startFakeLedger([transaction(15, "u15", [holdingEvent(holding(2, FAKE_GATEWAY, "1", FAKE_REGISTRY, "TKB", null, "unreadable"))])], { ledgerEnd: 999, active: [gatewayToken(TKB)] });
      fakes.push(bad);
      await expect(custodyOnce(pool, createLedger(bad.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), chain.reads, 500)).rejects.toThrow(/custody/);
      expect(await rows(pool)).toEqual(before);
    });
  });

  it("brings the holdings up to the offset of each block by the walk of the updates: a holding created since is added and an archived one is gone, in the same total as the supply at that block", async () => {
    await inDb(async (pool) => {
      const { chain, indexer } = await indexed(pool, 1, { [TKB]: 1n }, 3);
      const world = await startFakeLedger([
        transaction(15, "u15", [holdingEvent(holding(2, FAKE_GATEWAY, "4"))]), transaction(25, "u25", [archivedEvent(holding(1, FAKE_GATEWAY, "1").contractId)]),
      ], { ledgerEnd: 999, active: [gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")] });
      fakes.push(world);
      const ledger = createLedger(world.url, 2000, FAKE_GATEWAY, 1, null, CUSTODY_ENDPOINTS);
      await custodyOnce(pool, ledger, chain.reads, 500);
      expect(await rows(pool)).toMatchObject([{ custody: "10000000000", holdings: 1, ledger_offset: 10 }]);
      chain.reads.rethHead = 2; chain.ledger.ledgerHead = 2;
      await indexer.runOnce();
      await custodyOnce(pool, ledger, chain.reads, 500);
      expect(await rows(pool)).toMatchObject([{ custody: "50000000000", holdings: 2, ledger_offset: 20 }]);
      chain.reads.rethHead = 3; chain.ledger.ledgerHead = 3;
      await indexer.runOnce();
      await custodyOnce(pool, ledger, chain.reads, 500);
      expect(await rows(pool)).toMatchObject([{ custody: "40000000000", holdings: 1, ledger_offset: 30 }]);
      // Nothing of a holding but the sums: the table of holdings keeps a hash, an instrument and an amount, no owner and no contract id.
      const kept = JSON.stringify((await pool.query("select * from gateway_holdings")).rows);
      for (const secret of [FAKE_GATEWAY, "00000002"]) expect(kept).not.toContain(secret);
    });
  });

  it("is not stopped by the twin holdings of any number of users: with a list maximum far below their count, the custody is still read, and again at the next block", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 2, { [TKB]: 1n });
      const twins = Array.from({ length: 700 }, (_, i) => holding(1000 + i, SOMEONE, "1", FAKE_GATEWAY, "TWIN"));
      const { ledger } = await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "2"), ...twins]);
      await custodyOnce(pool, ledger, chain.reads, 500);
      expect(await rows(pool)).toMatchObject([{ custody: "20000000000", holdings: 1, ledger_offset: 20 }]);
      expect(Number((await pool.query("select count(*) from gateway_holdings")).rows[0].count)).toBe(1);
    });
  });

  it("walks again from the start when the participant read is another one, and forgets what the older walk kept", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 1, { [TKB]: 1n });
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")])).ledger, chain.reads, 500);
      await pool.query("insert into meta (key, value) values ('holdings_participant', 'older') on conflict (key) do update set value = excluded.value");
      await pool.query("insert into gateway_holdings (contract_hash, instrument_admin, instrument_id, amount) values ($1, 'x', 'y', 5)", [Buffer.alloc(32, 7)]);
      await custodyOnce(pool, (await gatewayLedger([gatewayToken(TKB), holding(3, FAKE_GATEWAY, "3")])).ledger, chain.reads, 500);
      expect(await rows(pool)).toMatchObject([{ custody: "30000000000", holdings: 1 }]);
      expect(Number((await pool.query("select count(*) from gateway_holdings")).rows[0].count)).toBe(1);
    });
  });

  it("goes on with the custody when the chain record cannot be read, and says what failed", async () => {
    await inDb(async (pool) => {
      const { chain } = await indexed(pool, 1, { [TKB]: 1n });
      const { ledger } = await gatewayLedger([gatewayToken(TKB), holding(1, FAKE_GATEWAY, "1")]);
      const broken = { ...ledger, chainRegistry: async () => { throw new Error("the chain record cannot be read"); } } as unknown as Pick<Ledger, "gatewayTokens" | "holdingPages" | "chainRegistry">;
      const got = await custodyAt(pool, broken, chain.reads, 500, PARTICIPANT, CHAIN_ID);
      expect(got).toMatchObject({ tokens: 1, registryError: "the chain record cannot be read" });
      expect(await rows(pool)).toMatchObject([{ custody: "10000000000", holdings: 1 }]);
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
  describe("the receipts and payouts the gateway has open", () => {
    const UNITS = 10n ** 10n, RECIPIENT = "e1".repeat(20), DEPOSIT = "ab".repeat(32), PAYOUT = "cd".repeat(32), AT = "2026-11-23T10:00:00Z";
    const tokens = [
      { contractId: "tokB", evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB" },
      { contractId: "tokC", evmToken: TKC, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKC" },
    ];
    const hold = (contractId: string, instrumentId: string, units: bigint): HoldingChange => ({ kind: "created", contractId, instrumentAdmin: FAKE_REGISTRY, instrumentId, amount: units * UNITS });
    const standing = async (pool: Pool) => (await pool.query("select encode(evm_token, 'hex') as evm, custody::text, supply::text, open_receipts::text, open_payouts::text from gateway_tokens order by evm_token")).rows;
    const stands = (r: { custody: string; supply: string; open_receipts: string; open_payouts: string }) => custodyMatched(r.custody, r.supply, 6, (BigInt(r.open_receipts) + BigInt(r.open_payouts)).toString());
    const ledgerOf = (walk: [number, HoldingChange[]][], known = tokens) => ({
      gatewayTokens: async () => known,
      holdingPages: async function* (after: number, upTo: number) { for (const [offset, changes] of walk) if (offset > after && offset <= upTo) yield { offset, changes }; },
    }) as unknown as Pick<Ledger, "gatewayTokens" | "holdingPages" | "chainRegistry">;

    it("counts them into each token's custody check, lists a deposit for its recipient and a payout by its id, and follows a payout to paid", async () => {
      await inDb(async (pool) => {
        const { chain, indexer } = await indexed(pool, 2, { [TKB]: 8_000_000n, [TKC]: 0n }, 3);
        const rest = createReceiptsRest(async (sql, values) => (await pool.query(sql, values as unknown[])).rows);
        const walk: [number, HoldingChange[]][] = [[10, [
          hold("h1", "TKB", 10n), hold("h2", "TKC", 3n),
          { kind: "receipt", contractId: "r1", gatewayToken: "tokB", depositId: DEPOSIT, recipient: RECIPIENT, amount: 2n * UNITS, createdAt: AT },
          { kind: "payout", contractId: "p1", gatewayToken: "tokC", payoutId: PAYOUT, amount: 3n * UNITS, createdAt: AT },
          { kind: "offer", contractId: "o1", payoutId: PAYOUT, executeBefore: "2026-11-24T10:00:00Z" },
        ]]];
        const ledger = ledgerOf(walk);
        await custodyOnce(pool, ledger, chain.reads, 500);
        // TKB: 10 held = 8 in issue + 2 accepted and not yet claimed. TKC: 3 held = 0 in issue + 3 burned and not yet paid.
        const first = await standing(pool);
        expect(first).toMatchObject([{ open_receipts: "20000000000", open_payouts: "0" }, { open_receipts: "0", open_payouts: "30000000000" }]);
        expect(first.map(stands)).toEqual([true, true]);
        const listed = await rest.deposits("0x" + RECIPIENT);
        expect(listed).toMatchObject([{ depositId: "0x" + DEPOSIT, symbol: null, instrumentId: "TKB", amount: "20000000000", amountDecimals: 10, createdAt: "2026-11-23T10:00:00.000Z" }]);
        expect(listed[0]!.token).toBe(TKB);
        expect(await rest.deposits("0x" + "e2".repeat(20))).toEqual([]);
        const offered = await rest.payout("0x" + PAYOUT);
        expect(offered).toMatchObject({ status: "offered", instrumentId: "TKC", amount: "30000000000", until: "2026-11-24T10:00:00.000Z", paidAt: null });
        expect(offered!.token).toBe(TKC);
        // The claim is recorded (the receipt is archived and the supply is 10), and the payout is paid (its offer and it are archived, and the custody leaves).
        walk.push([30, [{ kind: "archived", contractId: "r1", at: AT }, { kind: "archived", contractId: "o1", at: AT }, { kind: "archived", contractId: "p1", at: "2026-11-24T09:00:00Z" }, { kind: "archived", contractId: "h2", at: AT }]]);
        chain.reads.callResults[`${TKB}:${SUPPLY}`] = word(10_000_000n);
        chain.reads.rethHead = 3; chain.ledger.ledgerHead = 3;
        await indexer.runOnce();
        await custodyOnce(pool, ledger, chain.reads, 500);
        const second = await standing(pool);
        expect(second).toMatchObject([{ custody: "100000000000", open_receipts: "0", open_payouts: "0" }, { custody: "0", open_receipts: "0", open_payouts: "0" }]);
        expect(second.map(stands)).toEqual([true, true]);
        expect(await rest.deposits("0x" + RECIPIENT)).toEqual([]);
        expect(await rest.payout("0x" + PAYOUT)).toMatchObject({ status: "paid", until: null, paidAt: "2026-11-24T09:00:00.000Z" });
        expect(await rest.payout("0x" + "ee".repeat(32))).toBeNull();
        // Only hashes of the contracts are kept.
        const kept = JSON.stringify([(await pool.query("select * from gateway_receipts")).rows, (await pool.query("select * from gateway_payouts")).rows, (await pool.query("select * from gateway_offers")).rows]);
        for (const secret of ["r1", "p1", "o1", "tokB", "tokC"]) expect(kept).not.toContain(`"${secret}"`);
      });
    });

    it("skips a receipt and a payout of a token that is not registered, and reads on", async () => {
      await inDb(async (pool) => {
        const { chain } = await indexed(pool, 1, { [TKB]: 1n });
        const stray: HoldingChange = { kind: "receipt", contractId: "r9", gatewayToken: "nope", depositId: DEPOSIT, recipient: RECIPIENT, amount: UNITS, createdAt: AT };
        const strayPayout: HoldingChange = { kind: "payout", contractId: "p9", gatewayToken: "nope", payoutId: PAYOUT, amount: UNITS, createdAt: AT };
        await custodyOnce(pool, ledgerOf([[10, [stray, strayPayout]]]), chain.reads, 500);
        expect(Number((await pool.query("select count(*) from gateway_receipts")).rows[0].count)).toBe(0);
        expect(Number((await pool.query("select count(*) from gateway_payouts")).rows[0].count)).toBe(0);
      });
    });
  });
  describe("a payout's status follows the ledger end, and the backing check stays at the newest block", () => {
    const UNITS = 10n ** 10n, RECIPIENT = "e1".repeat(20), RECIPIENT2 = "e2".repeat(20), DEPOSIT = "ab".repeat(32), DEPOSIT2 = "ac".repeat(32), PAYOUT = "cd".repeat(32), PAYOUT2 = "ce".repeat(32), AT = "2026-11-23T10:00:00Z", PAID = "2026-11-27T04:33:37Z";
    const tokens = [
      { contractId: "tokB", evmToken: TKB, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKB" },
      { contractId: "tokC", evmToken: TKC, instrumentAdmin: FAKE_REGISTRY, instrumentId: "TKC" },
    ];
    const hold = (contractId: string, instrumentId: string, units: bigint): HoldingChange => ({ kind: "created", contractId, instrumentAdmin: FAKE_REGISTRY, instrumentId, amount: units * UNITS });
    const standing = async (pool: Pool) => (await pool.query("select encode(evm_token, 'hex') as evm, custody::text, supply::text, supply_block::int as block, ledger_offset::int as ledger_offset, open_receipts::text, open_payouts::text from gateway_tokens order by evm_token")).rows;
    const stands = (r: { custody: string; supply: string; open_receipts: string; open_payouts: string }) => custodyMatched(r.custody, r.supply, 6, (BigInt(r.open_receipts) + BigInt(r.open_payouts)).toString());
    const meta = async (pool: Pool, key: string) => (await pool.query("select value from meta where key = $1", [key])).rows[0]?.value as string | undefined;
    /** A Canton whose updates are `walk` (a page at an offset, and the changes of its update); `calls` lists each walk asked for, and `stop.at` makes a walk fail when it reaches that offset. */
    const cantonOf = (walk: [number, HoldingChange[]][], calls: [number, number][] = [], stop: { at: number | null } = { at: null }) => ({
      gatewayTokens: async () => tokens,
      holdingPages: async function* (after: number, upTo: number) {
        calls.push([after, upTo]);
        for (const [offset, changes] of walk) if (offset > after && offset <= upTo) {
          if (offset === stop.at) throw new Error("Canton went away");
          yield { offset, changes };
        }
      },
    }) as unknown as Pick<Ledger, "gatewayTokens" | "holdingPages" | "chainRegistry">;
    const opening: HoldingChange[] = [
      hold("h1", "TKB", 10n), hold("h2", "TKC", 3n),
      { kind: "receipt", contractId: "r1", gatewayToken: "tokB", depositId: DEPOSIT, recipient: RECIPIENT, amount: 2n * UNITS, createdAt: AT },
      { kind: "payout", contractId: "p1", gatewayToken: "tokC", payoutId: PAYOUT, amount: 3n * UNITS, createdAt: AT },
      { kind: "offer", contractId: "o1", payoutId: PAYOUT, executeBefore: "2026-11-28T10:00:00Z" },
    ];

    it("sets a payout paid in the next custody pass, with no new block, while the custody, the supply and the backing check stay at the block", async () => {
      await inDb(async (pool) => {
        const { chain, indexer } = await indexed(pool, 2, { [TKB]: 8_000_000n, [TKC]: 0n }, 3);
        const rest = createReceiptsRest(async (sql, values) => (await pool.query(sql, values as unknown[])).rows);
        const walk: [number, HoldingChange[]][] = [[10, opening]];
        const canton = cantonOf(walk);
        await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => 20);
        expect(await rest.payout("0x" + PAYOUT)).toMatchObject({ status: "offered", paidAt: null });
        // Canton pays it, takes the receipt's claim and the holding away at offset 25, after the newest block's offset 20. No block is made.
        walk.push([25, [{ kind: "archived", contractId: "o1", at: PAID }, { kind: "archived", contractId: "p1", at: PAID }, { kind: "archived", contractId: "r1", at: PAID }, { kind: "archived", contractId: "h2", at: PAID }]]);
        await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => 25);
        expect(await rest.payout("0x" + PAYOUT)).toMatchObject({ status: "paid", until: null, paidAt: "2026-11-27T04:33:37.000Z" });
        expect(await rest.deposits("0x" + RECIPIENT)).toEqual([]);
        expect(Number((await pool.query("select count(*) from gateway_offers")).rows[0].count)).toBe(0);
        // The backing check is as it was at the block (offset 20): the payout and the receipt are open there and the holdings are whole.
        const at = await standing(pool);
        expect(at).toMatchObject([{ custody: "100000000000", open_receipts: "20000000000", open_payouts: "0", block: 2, ledger_offset: 20 }, { custody: "30000000000", open_receipts: "0", open_payouts: "30000000000", block: 2, ledger_offset: 20 }]);
        expect(at.map(stands)).toEqual([true, true]);
        // The next block (offset 30) brings the custody, the supply and the open amounts to the new state together.
        walk.push([30, []]);
        chain.reads.callResults[`${TKB}:${SUPPLY}`] = word(10_000_000n);
        chain.reads.rethHead = 3; chain.ledger.ledgerHead = 3;
        await indexer.runOnce();
        await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => 30);
        const later = await standing(pool);
        expect(later).toMatchObject([{ custody: "100000000000", open_receipts: "0", open_payouts: "0", block: 3 }, { custody: "0", open_receipts: "0", open_payouts: "0", block: 3 }]);
        expect(later.map(stands)).toEqual([true, true]);
        expect(Number((await pool.query("select count(*) from gateway_receipts")).rows[0].count)).toBe(0);
      });
    });

    it("lists a deposit and a payout made after the block at once, and counts neither in the backing check at the block", async () => {
      await inDb(async (pool) => {
        const { chain } = await indexed(pool, 2, { [TKB]: 8_000_000n, [TKC]: 0n }, 3);
        const rest = createReceiptsRest(async (sql, values) => (await pool.query(sql, values as unknown[])).rows);
        const walk: [number, HoldingChange[]][] = [[10, opening], [25, [
          hold("h3", "TKB", 1n), hold("h4", "TKC", 1n),
          { kind: "receipt", contractId: "r2", gatewayToken: "tokB", depositId: DEPOSIT2, recipient: RECIPIENT2, amount: UNITS, createdAt: PAID },
          { kind: "payout", contractId: "p2", gatewayToken: "tokC", payoutId: PAYOUT2, amount: UNITS, createdAt: PAID },
        ]]];
        await custodyOnce(pool, cantonOf(walk), chain.reads, 500, PARTICIPANT, async () => 25);
        expect(await rest.deposits("0x" + RECIPIENT2)).toMatchObject([{ depositId: "0x" + DEPOSIT2, amount: "10000000000" }]);
        expect(await rest.payout("0x" + PAYOUT2)).toMatchObject({ status: "waiting", amount: "10000000000" });
        const at = await standing(pool);
        expect(at).toMatchObject([{ custody: "100000000000", open_receipts: "20000000000", open_payouts: "0" }, { custody: "30000000000", open_receipts: "0", open_payouts: "30000000000" }]);
        expect(at.map(stands)).toEqual([true, true]);
      });
    });

    it("goes on from the page it reached after a walk that failed, and asks for the holdings only up to the block", async () => {
      await inDb(async (pool) => {
        const { chain } = await indexed(pool, 2, { [TKB]: 8_000_000n, [TKC]: 0n }, 3);
        const rest = createReceiptsRest(async (sql, values) => (await pool.query(sql, values as unknown[])).rows);
        const calls: [number, number][] = [], stop: { at: number | null } = { at: 22 };
        const canton = cantonOf([[12, opening], [22, [{ kind: "archived", contractId: "p1", at: PAID }]]], calls, stop);
        await expect(custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => 25)).rejects.toThrow(/Canton went away/);
        expect(await meta(pool, "status_offset")).toBe("12");
        expect(await rest.payout("0x" + PAYOUT)).toMatchObject({ status: "offered" });
        stop.at = null;
        await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => 25);
        expect(await meta(pool, "status_offset")).toBe("25");
        expect(await rest.payout("0x" + PAYOUT)).toMatchObject({ status: "paid" });
        // The holdings are asked for up to the block's offset (20) only, and the statuses up to the ledger end, the second time from page 12.
        expect(calls.filter(([, upTo]) => upTo === 20).length).toBeGreaterThan(0);
        expect(calls.filter(([, upTo]) => upTo === 25)).toEqual([[0, 25], [12, 25]]);
        expect(await meta(pool, "holdings_offset")).toBe("20");
      });
    });

    it("keeps to the block when the ledger end cannot be read or is behind it", async () => {
      await inDb(async (pool) => {
        const { chain } = await indexed(pool, 2, { [TKB]: 8_000_000n, [TKC]: 0n }, 3);
        const walk: [number, HoldingChange[]][] = [[10, opening], [25, [{ kind: "archived", contractId: "p1", at: PAID }]]];
        const canton = cantonOf(walk);
        await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => { throw new Error("no ledger end"); });
        await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => 5);
        expect(await meta(pool, "status_offset")).toBe("20");
        expect((await standing(pool)).length).toBe(2);
        expect((await pool.query("select paid_at from gateway_payouts")).rows).toEqual([{ paid_at: null }]);
      });
    });
    it("never takes the statuses back when the ledger end then cannot be read or is behind the cursor: no walk from 0, the payout stays paid", async () => {
      await inDb(async (pool) => {
        const { chain } = await indexed(pool, 2, { [TKB]: 8_000_000n, [TKC]: 0n }, 3);
        const rest = createReceiptsRest(async (sql, values) => (await pool.query(sql, values as unknown[])).rows);
        const calls: [number, number][] = [];
        const canton = cantonOf([[10, opening], [25, [{ kind: "archived", contractId: "p1", at: PAID }]]], calls);
        await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, async () => 25);
        expect(await meta(pool, "status_offset")).toBe("25");
        expect(await rest.payout("0x" + PAYOUT)).toMatchObject({ status: "paid", paidAt: "2026-11-27T04:33:37.000Z" });
        for (const end of [async () => { throw new Error("no ledger end"); }, async () => 22, null]) {
          calls.length = 0;
          await custodyOnce(pool, canton, chain.reads, 500, PARTICIPANT, end ?? undefined);
          expect(calls.filter(([after]) => after === 0)).toEqual([]);
          expect(calls.filter(([, upTo]) => upTo > 20)).toEqual([]);
          expect(await meta(pool, "status_offset")).toBe("25");
          expect(await rest.payout("0x" + PAYOUT)).toMatchObject({ status: "paid", paidAt: "2026-11-27T04:33:37.000Z" });
          expect((await pool.query("select count(*)::int as n from gateway_payouts")).rows).toEqual([{ n: 1 }]);
        }
      });
    });
    it("is wired into the running indexer: the reader's ledger end carries the statuses past the newest block", async () => {
      await inDb(async (pool) => {
        await migrate(pool);
        const chain = makeChain([{ txs: 0 }]);
        const fake = await startFakeLedger([
          transaction(5, "u5", [payoutEvent(5, "p1", { gatewayToken: "00" + TKB.slice(-8), payoutId: PAYOUT, amount: "3" })]),
          transaction(25, "u25", [archivedEvent("p1")], PAID),
        ], { ledgerEnd: 25, active: [gatewayToken(TKB)] });
        fakes.push(fake);
        const ledger = createLedger(fake.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS);
        chain.ledger.ledgerEnd = async () => 25;   // Canton is at 25; the one block's record is at 10
        const rest = createReceiptsRest(async (sql, values) => (await pool.query(sql, values as unknown[])).rows);
        const ix = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", pollMs: 20, checkMs: 50, custody: { ledger, ms: 50 } });
        opened.push(ix);
        await ix.open();
        const halt = ix.start();
        try {
          let got: Awaited<ReturnType<typeof rest.payout>> = null;
          for (let i = 0; i < 100 && got?.status !== "paid"; i++) { await new Promise((ok) => setTimeout(ok, 50)); got = await rest.payout("0x" + PAYOUT); }
          expect(got).toMatchObject({ status: "paid", paidAt: "2026-11-27T04:33:37.000Z" });
          expect(Number((await pool.query("select count(*) from blocks")).rows[0].count)).toBe(1);
        } finally {
          await halt();
        }
      });
    });
  });
});
