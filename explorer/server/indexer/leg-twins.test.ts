/** The twin legs of a block, as the explorer tells them: a payment into a registered vault is a lock, a payment out of one is a release. On the pinned PostgreSQL. */
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { CHAIN_ID, GATEWAY, PARTICIPANT, PINS, makeChain, type BlockShape, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createLedger, CUSTODY_ENDPOINTS } from "../ledger.ts";
import { FAKE_GATEWAY, registered, startFakeLedger, zkChain, type FakeLedger } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { custodyOnce } from "./custody.ts";
import { registeredLegsOnce } from "./registered-legs.ts";
import { blockLegs, txLegs, RELEASED_TOPIC } from "./leg-canton.ts";
import { legsSlot } from "./legs.ts";
import { createAccountRest } from "../rest/account-rest.ts";
import { createChainRest } from "../rest/chain-rest.ts";

const GW2 = "0x" + "b1".repeat(20), VAULT = "0x" + "b2".repeat(20), OTHER_VAULT = "0x" + "b4".repeat(20), TOKEN = "0x" + "d1".repeat(20), SIX = "0x" + "d2".repeat(20), ALICE = "0x" + "a1".repeat(20);
const ID1 = "0x" + "11".repeat(32), ID2 = "0x" + "22".repeat(32), ID3 = "0x" + "33".repeat(32), ID4 = "0x" + "44".repeat(32);
const word = (a: string) => "0x" + "00".repeat(12) + a.slice(2);
const released = (vault: string, id: string, token: string, to: string) => ({ address: vault, topics: [RELEASED_TOPIC, id, word(token), word(to)], data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }], [1n, "ref"]) });
const fakes: FakeLedger[] = [];
const opened: Indexer[] = [];
afterEach(async () => { while (fakes.length) await fakes.pop()!.close(); });
const inDb = (fn: (pool: Pool) => Promise<void>) => withDatabase(async (pool) => {
  try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
});
const pay = (id: string, token: string, account: string, amount: bigint) => ({ gateway: GW2, kind: 3, id, token, account, amount });
async function setUp(pool: Pool, shapes: BlockShape[]): Promise<SyntheticChain> {
  await migrate(pool);
  const chain = makeChain(shapes);
  chain.reads.rethHead = shapes.length;
  chain.ledger.ledgerHead = shapes.length;
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  await indexer.runOnce();
  await pool.query("insert into bytecodes (code_hash, code, size) values ($1, $2, 2) on conflict do nothing", [Buffer.alloc(32, 0x5a), Buffer.from("6080", "hex")]);
  for (const [t, dec] of [[TOKEN, 18], [SIX, 6]] as const) {
    await pool.query("insert into contracts (address, origin, runtime_code_hash, name) values ($1, 'genesis', $2, 'T')", [Buffer.from(t.slice(2), "hex"), Buffer.alloc(32, 0x5a)]);
    await pool.query("insert into tokens (address, standard, name, symbol, decimals, first_transfer_block, metadata_status) values ($1, 'ERC-20', 'T', 'T', $2, 1, 'read')", [Buffer.from(t.slice(2), "hex"), dec]);
  }
  const f = await startFakeLedger([], { ledgerEnd: 999, active: [zkChain([registered(GW2, "Gateway"), registered(VAULT, "Vault", "c2")])] });
  fakes.push(f);
  await custodyOnce(pool, createLedger(f.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS), chain.reads, 500, PARTICIPANT, CHAIN_ID);
  for (const n of [1, 2, 3]) chain.reads.storage[`${GW2}:${legsSlot(n)}`] = "0x" + "00".repeat(32);
  await registeredLegsOnce(pool, chain.reads);
  return chain;
}

describe.skipIf(!TEST_URL)("the twin legs", () => {
  checkRequired();

  it("shows a payment into a registered vault as a lock and a payment the vault released as a release, with the twin's instrument and amount, and every other payment as a payment", async () => {
    await inDb(async (pool) => {
      await setUp(pool, [
        { txs: 1, extra: [pay(ID1, TOKEN, VAULT, 5n * 10n ** 18n), pay(ID4, SIX, VAULT, 2_500_000n), pay(ID3, TOKEN, OTHER_VAULT, 4n)] },
        { txs: 1, extra: [pay(ID2, TOKEN, ALICE, 3n * 10n ** 18n), pay(ID3, TOKEN, ALICE, 1n)], extraLogs: [released(VAULT, ID2, TOKEN, ALICE)] },
        { txs: 1, leg: 1 },
      ]);
      const [lock, sixLock, plain] = await blockLegs(pool, 1);
      expect(lock).toMatchObject({ kind: "lock", legId: ID1, account: VAULT, amount: (5n * 10n ** 18n).toString(),
        canton: { role: "lock", amount: "50000000000", instrument: { admin: FAKE_GATEWAY, id: "erc20:" + "d1".repeat(20) }, recipient: VAULT, settledUpdateId: expect.any(String) } });
      // 6 decimals are scaled up to the twin's 10
      expect(sixLock).toMatchObject({ kind: "lock", canton: { role: "lock", amount: "25000000000", instrument: { id: "erc20:" + "d2".repeat(20) } } });
      // a payment to an address that is not a registered vault is a plain payment
      expect(plain).toMatchObject({ kind: "payment", canton: null });
      const [rel, other] = await blockLegs(pool, 2);
      expect(rel).toMatchObject({ kind: "release", legId: ID2, account: ALICE, canton: { role: "release", amount: "30000000000", instrument: { id: "erc20:" + "d1".repeat(20) }, recipient: ALICE } });
      // a payment to the same payee with no Released event of a vault is somebody paying from their own tokens
      expect(other).toMatchObject({ kind: "payment", legId: ID3, canton: null });
      // the first gateway's legs are told as before
      expect(await blockLegs(pool, 3)).toMatchObject([{ kind: "deposit", canton: null }]);
    });
  });

  it("tells the twin legs of a transaction the same way", async () => {
    await inDb(async (pool) => {
      const chain = await setUp(pool, [{ txs: 1, extra: [pay(ID1, TOKEN, VAULT, 10n ** 18n)] }, { txs: 1 }, { txs: 1 }]);
      const hash = chain.blocks[0]!.block.transactions[0]!.hash;
      expect(await txLegs(pool, hash)).toMatchObject([{ kind: "lock", legId: ID1, canton: { role: "lock", amount: "10000000000" } }]);
    });
  });

  it("shows no amount while the token's decimals are not read, and nothing is a twin leg while no vault is registered", async () => {
    await inDb(async (pool) => {
      await setUp(pool, [{ txs: 1, extra: [pay(ID1, TOKEN, VAULT, 10n ** 18n)] }, { txs: 1 }, { txs: 1 }]);
      await pool.query("update tokens set decimals = null");
      expect((await blockLegs(pool, 1))[0]).toMatchObject({ kind: "lock", canton: { role: "lock", amount: null } });
      await pool.query("delete from canton_registry where kind = 'vault'");
      expect((await blockLegs(pool, 1))[0]).toMatchObject({ kind: "payment", canton: null });
    });
  });

  it("lists the twin legs in the legs list and by id, and counts the registered gateways' legs in the block's legs count", async () => {
    await inDb(async (pool) => {
      await setUp(pool, [
        { txs: 1, leg: 1, extra: [pay(ID1, TOKEN, VAULT, 5n * 10n ** 18n)] },
        { txs: 1, extra: [pay(ID2, TOKEN, ALICE, 3n * 10n ** 18n)], extraLogs: [released(VAULT, ID2, TOKEN, ALICE)] },
        { txs: 1 },
      ]);
      const accounts = createAccountRest(pool), chain = createChainRest(pool);
      expect((await accounts.legs(null, 10)).map((l) => [l.block, l.legIndex, l.kind])).toEqual([[2, 0, "release"], [1, 1, "lock"], [1, 0, "deposit"]]);
      expect(await accounts.leg(ID1)).toMatchObject({ kind: "lock", account: VAULT });
      expect(await accounts.leg(ID2)).toMatchObject({ kind: "release", account: ALICE });
      expect((await chain.blockExtras(1))?.legsCount).toBe(2);
      expect((await chain.blocks(null, 10)).map((b) => b.legsCount)).toEqual([0, 1, 2]);
      expect((await chain.blockLegs(1, null, 10)).map((l) => [l.kind, l.canton?.role ?? null])).toEqual([["deposit", null], ["lock", "lock"]]);
    });
  });
  it("gives a twin token its supply (locks less releases) next to what the vaults hold, bounded to the newest legs, and nothing for any other token", async () => {
    await inDb(async (pool) => {
      await setUp(pool, [
        { txs: 1, extra: [pay(ID1, TOKEN, VAULT, 5n * 10n ** 18n), pay(ID4, SIX, VAULT, 2_500_000n)] },
        { txs: 1, extra: [pay(ID2, TOKEN, ALICE, 3n * 10n ** 18n)], extraLogs: [released(VAULT, ID2, TOKEN, ALICE)] },
        { txs: 1 },
      ]);
      const held = (t: string, h: string, v: bigint) => pool.query("insert into token_balances (token, holder, value, updated_block) values ($1, $2, $3, 2)", [Buffer.from(t.slice(2), "hex"), Buffer.from(h.slice(2), "hex"), v.toString()]);
      await held(TOKEN, VAULT, 2n * 10n ** 18n);
      await held(TOKEN, ALICE, 3n * 10n ** 18n);
      const accounts = createAccountRest(pool);
      // 5 locked, 3 released: the twin has 2 in issue, and the vault holds 2 (Alice's balance is not the vault's)
      expect((await accounts.token(TOKEN))?.twin).toEqual({ supply: (2n * 10n ** 18n).toString(), vaultBalance: (2n * 10n ** 18n).toString(), locks: 1, releases: 1, partial: false });
      expect((await accounts.token(SIX))?.twin).toEqual({ supply: "2500000", vaultBalance: "0", locks: 1, releases: 0, partial: false });
      // a balance held by an address that is not a registered vault is not the vault's
      await held(SIX, OTHER_VAULT, 1n);
      expect((await accounts.token(SIX))?.twin?.vaultBalance).toBe("0");
      await pool.query("delete from canton_registry where kind = 'vault'");
      expect((await accounts.token(TOKEN))?.twin).toBeNull();
    });
  });
});
