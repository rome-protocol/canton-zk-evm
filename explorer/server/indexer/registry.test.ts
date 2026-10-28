/** The chain record's registry of EVM contracts, as the custody read keeps it, on the pinned PostgreSQL against a stand-in Ledger API. */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { migrate } from "../db/migrate.ts";
import { createLedger, CUSTODY_ENDPOINTS, registryFrom } from "../ledger.ts";
import { CHAIN_ID, GATEWAY, PARTICIPANT, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { FAKE_GATEWAY, holding, registered, startFakeLedger, zkChain, type ActiveContract, type FakeLedger } from "../../test/fake-ledger.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { custodyOnce } from "./custody.ts";

const GW2 = "0x" + "b1".repeat(20), VAULT = "0x" + "b2".repeat(20), GW3 = "0x" + "b3".repeat(20);
const fakes: FakeLedger[] = [];
const opened: Indexer[] = [];
afterEach(async () => { while (fakes.length) await fakes.pop()!.close(); });
const inDb = (fn: (pool: Pool) => Promise<void>) => withDatabase(async (pool) => {
  try { await fn(pool); } finally { for (const i of opened.splice(0)) await i.close().catch(() => undefined); }
});
const ledgerOf = async (active: ActiveContract[]) => {
  const f = await startFakeLedger([], { ledgerEnd: 999, active });
  fakes.push(f);
  return createLedger(f.url, 2000, FAKE_GATEWAY, 100, null, CUSTODY_ENDPOINTS);
};
async function indexed(pool: Pool, n: number): Promise<SyntheticChain> {
  await migrate(pool);
  const chain = makeChain(Array.from({ length: n }, () => ({ txs: 0 })));
  chain.reads.rethHead = n;
  chain.ledger.ledgerHead = n;
  const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
  opened.push(indexer);
  await indexer.open();
  await indexer.runOnce();
  return chain;
}
const entries = async (pool: Pool) => (await pool.query("select encode(address, 'hex') as address, kind, encode(code_hash, 'hex') as hash, admin, legs_cursor::int as cursor, ledger_offset::int as ledger_offset from canton_registry order by address")).rows;
const item = (c: ActiveContract) => ({ contractEntry: { JsActiveContract: { createdEvent: { templateId: c.templateId, createArgument: c.createArgument, signatories: [] } } } });

describe("registryFrom", () => {
  it("reads the twins the chain record pins, with the decimals Canton mints them with, and refuses a pin that cannot be right", () => {
    const pin = (token: string, decimals: unknown) => ({ twinToken: token, twinDecimals: decimals, twinRules: "00ab" });
    const r = registryFrom([item(zkChain([], { twins: [pin("0x" + "c2".repeat(20), 6), pin("c1".repeat(20), "18")] }))], CHAIN_ID);
    expect(r?.twins).toEqual([{ token: "0x" + "c1".repeat(20), decimals: 18 }, { token: "0x" + "c2".repeat(20), decimals: 6 }]);
    expect(registryFrom([item(zkChain([]))], CHAIN_ID)?.twins).toEqual([]);
    expect(() => registryFrom([item(zkChain([], { twins: [pin("12", 6)] }))], CHAIN_ID)).toThrow(/token/);
    expect(() => registryFrom([item(zkChain([], { twins: [pin("c1".repeat(20), 37)] }))], CHAIN_ID)).toThrow(/decimals/);
    expect(() => registryFrom([item(zkChain([], { twins: [pin("c1".repeat(20), 6), pin("c1".repeat(20), 6)] }))], CHAIN_ID)).toThrow(/twice/);
  });
  it("reads the gateways and the vaults of the chain record, sorted by address", () => {
    const r = registryFrom([item(zkChain([registered(VAULT, "Vault", "c2"), registered(GW2, "Gateway")]))], CHAIN_ID);
    expect(r).toEqual({ gatewayParty: FAKE_GATEWAY, twins: [], contracts: [
      { address: GW2, codeHash: "0x" + "e1".repeat(32), kind: "gateway" }, { address: VAULT, codeHash: "0x" + "c2".repeat(32), kind: "vault" },
    ] });
  });
  it("takes no registry (None) as an empty one, and no chain record of the chain as null", () => {
    expect(registryFrom([item(zkChain(null))], CHAIN_ID)).toEqual({ gatewayParty: FAKE_GATEWAY, contracts: [], twins: [] });
    expect(registryFrom([item(zkChain([registered(GW2, "Gateway")], { chainId: "5" }))], CHAIN_ID)).toBeNull();
    expect(registryFrom([], CHAIN_ID)).toBeNull();
  });
  it("refuses what might be wrong: two chain records, a bad address, hash or kind, an entry twice", () => {
    expect(() => registryFrom([item(zkChain([])), item(zkChain([]))], CHAIN_ID)).toThrow(/two active chain records/);
    expect(() => registryFrom([item(zkChain([{ ...registered(GW2, "Gateway"), contractAddress: "AB" }]))], CHAIN_ID)).toThrow(/address/);
    expect(() => registryFrom([item(zkChain([{ ...registered(GW2, "Gateway"), contractCodeHash: "12" }]))], CHAIN_ID)).toThrow(/code hash/);
    expect(() => registryFrom([item(zkChain([{ ...registered(GW2, "Gateway"), contractKind: "Other" }]))], CHAIN_ID)).toThrow(/neither/);
    expect(() => registryFrom([item(zkChain([registered(GW2, "Gateway"), registered(GW2, "Vault")]))], CHAIN_ID)).toThrow(/twice/);
  });
});

describe.skipIf(!TEST_URL)("the registry in the custody read", () => {
  checkRequired();

  it("keeps the registry of the chain record, asks for the chain record only when it is told the chain, and starts a new gateway after the block of the read before", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, 3);
      const first = await ledgerOf([zkChain([registered(GW2, "Gateway"), registered(VAULT, "Vault", "c2")])]);
      expect(await custodyOnce(pool, first, chain.reads, 500, PARTICIPANT, CHAIN_ID)).toEqual({ tokens: 0, offset: 30, block: 3 });
      // no read was made before: a gateway registered long ago is read from its first leg
      expect(await entries(pool)).toEqual([
        { address: "b1".repeat(20), kind: "gateway", hash: "e1".repeat(32), admin: FAKE_GATEWAY, cursor: 0, ledger_offset: 30 },
        { address: "b2".repeat(20), kind: "vault", hash: "c2".repeat(32), admin: FAKE_GATEWAY, cursor: 0, ledger_offset: 30 },
      ]);
      // a gateway that appears later starts after the block of the read before, and the ones seen before keep their progress
      await pool.query("update canton_registry set legs_cursor = 2 where address = $1", [Buffer.from("b1".repeat(20), "hex")]);
      chain.reads.rethHead = 3;
      const second = await ledgerOf([zkChain([registered(GW2, "Gateway"), registered(VAULT, "Vault", "c2"), registered(GW3, "Gateway", "d4")])]);
      await custodyOnce(pool, second, chain.reads, 500, PARTICIPANT, CHAIN_ID);
      expect((await entries(pool)).map((e) => [e.address.slice(0, 2), e.cursor])).toEqual([["b1", 2], ["b2", 0], ["b3", 3]]);
      // the read without a chain asks for no chain record and changes nothing
      const quiet = await ledgerOf([zkChain([])]);
      await custodyOnce(pool, quiet, chain.reads, 500, PARTICIPANT);
      expect(await entries(pool)).toHaveLength(3);
    });
  });

  it("keeps the last registry when the gateway sees no chain record, and drops a row that is no longer in the record", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, 2);
      await custodyOnce(pool, await ledgerOf([zkChain([registered(GW2, "Gateway"), registered(VAULT, "Vault")])]), chain.reads, 500, PARTICIPANT, CHAIN_ID);
      await custodyOnce(pool, await ledgerOf([]), chain.reads, 500, PARTICIPANT, CHAIN_ID);
      expect(await entries(pool)).toHaveLength(2);
      await custodyOnce(pool, await ledgerOf([zkChain([registered(VAULT, "Vault")])]), chain.reads, 500, PARTICIPANT, CHAIN_ID);
      expect((await entries(pool)).map((e) => e.kind)).toEqual(["vault"]);
    });
  });

  it("reads the registry in a request of its own, so that more holdings than the custody limit cannot hide a gateway or a vault", async () => {
    await inDb(async (pool) => {
      const chain = await indexed(pool, 2);
      const many = Array.from({ length: 6 }, (_, i) => holding(i + 1, FAKE_GATEWAY, "5"));
      const ledger = await ledgerOf([zkChain([registered(GW2, "Gateway"), registered(VAULT, "Vault")], { twins: [{ twinToken: "c1".repeat(20), twinDecimals: 6, twinRules: "00ab" }] }), ...many]);
      // the custody read refuses a list as long as its limit, and says so ...
      await expect(custodyOnce(pool, ledger, chain.reads, 5, PARTICIPANT, CHAIN_ID)).rejects.toThrow(/custody cannot be read/);
      // ... but the registry, its own read, was kept
      expect((await entries(pool)).map((e) => e.kind)).toEqual(["gateway", "vault"]);
      expect((await pool.query("select encode(token, 'hex') as token, decimals from canton_twins")).rows).toEqual([{ token: "c1".repeat(20), decimals: 6 }]);
    });
  });
});
