import { afterEach, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi, FIELDS, NOT_FOUND } from "./api.ts";
import { createChainDb, type ChainDb } from "./chain-db.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "./db/testing.ts";
import { loadConfig } from "./config.ts";
import { createLedger } from "./ledger.ts";
import { createFaucet } from "./faucet.ts";
import type { FaucetStore } from "./faucet-store.ts";
import { createTracker } from "./tracker.ts";
import type { Tracked } from "./tracker.ts";
import { ALLOWED_METHODS, createReth, RethError } from "./reth.ts";
import { FakeChain, hashOf, txHash, updateIdOf } from "../test/fake-chain.ts";
import { FAKE_CONFIRMER, FAKE_OPERATOR, FAKE_READER, startFakeLedger, type FakeLedger } from "../test/fake-ledger.ts";
import { seedBlocks } from "../test/seed-chain.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const TOKEN = "0x" + "ca".repeat(20), ALICE = "0x" + "9a".repeat(20), BOB = "0x" + "5b".repeat(20), POOL_TX = "0x" + "ab".repeat(32);
const TRANSFER = "0xa9059cbb" + "0".repeat(24) + "5b".repeat(20) + (10n * 10n ** 18n).toString(16).padStart(64, "0");
const FAUCET_KEY = generatePrivateKey(), FAUCET_ADDRESS = privateKeyToAccount(FAUCET_KEY).address.toLowerCase();
const settings = "programVK=0x" + "cd".repeat(32) + "\nrootC=0x" + "ef".repeat(32) + "\n";

let reth: FakeReth | undefined, ledger: FakeLedger | undefined;
const databases: TestDatabase[] = [];
afterEach(async () => { await reth?.close(); await ledger?.close(); for (const d of databases.splice(0)) await d.drop(); });

/** What reth says about transaction `i` of block `n`, and what the indexer stored of it. */
const txOf = (_n: number, _i: number) => ({ from: ALICE, to: TOKEN, value: 0n, nonce: 1, type: 2, gas: 0x186a0, input: TRANSFER });

/** reth's methods for the pages: the chain's own handlers, `latest`, full transactions, and the lookups by hash. */
function handlers(chain: FakeChain, finalized: () => number) {
  const tx = (n: number, i: number) => ({
    hash: txHash(n, i), blockNumber: "0x" + n.toString(16), blockHash: hashOf(n), transactionIndex: "0x" + i.toString(16), from: ALICE, to: TOKEN,
    value: "0x0", nonce: "0x1", type: "0x2", gas: "0x186a0", input: TRANSFER,
  });
  const pool = { ...tx(1, 0), hash: POOL_TX, blockNumber: null, blockHash: null, transactionIndex: null };
  const base = chain.rethHandlers;
  const find = (h: string) => chain.blocks.flatMap((b, n) => (b.transactions as string[]).flatMap((x, i) => (x === h ? [[n, i] as const] : [])))[0];
  const read = (b: { number: string; transactions: string[] } | undefined, full: unknown) => (!b ? null : full ? { ...b, transactions: b.transactions.map((_, i) => tx(Number(b.number), i)) } : b);
  return {
    ...base,
    eth_getBlockByNumber: (p: unknown[]) => read(chain.blocks[p[0] === "latest" ? chain.blocks.length - 1 : p[0] === "finalized" ? finalized() : Number(p[0])] as never, p[1]),
    eth_getBlockByHash: (p: unknown[]) => read(chain.blocks.find((b) => b.hash === p[0]) as never, p[1]),
    eth_getTransactionByHash: (p: unknown[]) => { const f = find(p[0] as string); return f ? tx(...f) : p[0] === POOL_TX ? pool : null; },
    eth_getTransactionReceipt: (p: unknown[]) => { const f = find(p[0] as string); return f ? chain.receipts[f[0]]![f[1]] : null; },
    eth_getBalance: (p: unknown[]) => "0x" + (p[0] === FAUCET_ADDRESS ? 1000n * 10n ** 18n : 5n * 10n ** 17n).toString(16),
    eth_gasPrice: "0x3b9aca07",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_sendRawTransaction: (p: unknown[]) => keccak256(p[0] as Hex),
    eth_getTransactionCount: () => "0x3",
    eth_getCode: (p: unknown[]) => (chain.tokens.has(p[0] as string) ? "0x6080" : "0x"),
  };
}

/** Adds a `leaked` field to every object it holds, as a careless pass-through of the index's or the config's own objects would send it on. */
const leaky = <T>(x: T): T => (Array.isArray(x) ? (x.map(leaky) as T) : x && typeof x === "object" ? ({ ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, leaky(v)])), leaked: "x" } as T) : x);

interface Options { tracker?: ReturnType<typeof createTracker>; leak?: boolean; faucet?: boolean; store?: FaucetStore; indexed?: number; empty?: boolean; finalized?: number | "unreadable"; missFirstBlockRead?: boolean; checksWritten?: boolean }

/**
 * `indexed` is the newest block the database holds, for an indexer that is behind Canton; `empty` is a database the indexer has not written to at all.
 * `finalized` is what reth's finalized tag says: the newest block Canton holds unless given, or "unreadable" for a reth that cannot answer for the tag.
 */
const REFRESHED = ["C4", "C5", "derive_lag", "C10"];
/** The refreshed checks, ok, looked at `age` ago; a row that is there is replaced. */
const writeFreshChecks = (pool: import("pg").Pool, age = "0 seconds") =>
  pool.query(`insert into health_checks (check_id, status, changed_at, checked_at) select c, 'ok', now() - interval '${age}', now() - interval '${age}' from unnest($1::text[]) as c
    on conflict (check_id) do update set status = 'ok', checked_at = excluded.checked_at, changed_at = excluded.changed_at`, [REFRESHED]);

async function boot(chain: FakeChain, { tracker, leak = false, faucet = false, store, indexed = Infinity, empty = false, finalized, missFirstBlockRead = false, checksWritten = true }: Options = {}) {
  let finalizedAt = 0;
  const base = handlers(chain, () => finalizedAt);
  reth = await startFakeReth(finalized === "unreadable" ? { ...base, eth_getBlockByNumber: (p: unknown[]) => { if (p[0] === "finalized") throw new Error("finalized is not served"); return base.eth_getBlockByNumber(p); } } : base);
  ledger = await startFakeLedger(chain.items);
  const real = loadConfig({ READER_PARTY: FAKE_READER, PINS_FILE: "guest.txt" }, () => settings);
  const config = leak ? leaky(real) : real;
  const r = createReth(reth.url, 2000), l = createLedger(ledger.url, 2000, FAKE_READER);
  const db = await makeDatabase(true);
  databases.push(db);
  const records = await l.records(0, await l.ledgerEnd());
  finalizedAt = typeof finalized === "number" ? finalized : Math.max(0, ...records.map((x) => x.number));
  if (!empty) await seedBlocks(db.pool, records.filter((x) => x.number <= indexed).map((record) => ({ record, raw: chain.blocks[record.number]!, receipts: chain.receipts[record.number]! })), txOf, real.pins);
  // A running indexer has written its four refreshed checks (checkOnce, every 2 s) as well as its records: without them the status is red.
  if (!empty && checksWritten) await writeFreshChecks(db.pool);
  const built = createChainDb(db.pool);
  const chainDb0: ChainDb = leak
    ? {
        head: async () => leaky(await built.head()), latest: async (n) => leaky(await built.latest(n)), block: async (k) => leaky(await built.block(k)), blockTxs: async (n) => leaky(await built.blockTxs(n)),
        tx: async (h) => leaky(await built.tx(h)), blockOfUpdate: built.blockOfUpdate, createdBy: async (a) => leaky(await built.createdBy(a)), finalOf: built.finalOf, lifecycleOf: built.lifecycleOf, inFlight: built.inFlight,
        indexer: async () => leaky(await built.indexer()), genesisReferenced: built.genesisReferenced, indexFacts: built.indexFacts,
      }
    : built;
  // The indexer commits a block between the route's first look in the database and its second: the first read of a block by number misses, the rest are true.
  let missed = !missFirstBlockRead;
  const chainDb: ChainDb = { ...chainDb0, block: async (k) => { if (!missed) { missed = true; return undefined; } return chainDb0.block(k); } };
  const key = faucet ? FAUCET_KEY : null;
  const faucetTracker = { track: (_raw: string, _hash: string, _from: string, _nonce: number, _via?: string) => {}, state: (_hash: string): Tracked | undefined => undefined };
  const faucetOf = createFaucet({ key, chainId: real.chainId, ...real.faucet, captcha: null, reth: r, ...(store ? { store } : {}), tracker: { track: (...a) => faucetTracker.track(...a), state: (h) => faucetTracker.state(h) } });
  const api = createApi({ config, reth: r, ledger: l, chain: chainDb, tracker, faucet: faucetOf });
  return { api, pool: db.pool, get: (target: string) => api("GET", target), faucet: faucetOf, tracker: faucetTracker };
}

const chain = () => {
  const c = new FakeChain();
  c.tokens.set(TOKEN, ["Token A", "TKA", 18]);
  c.add({ txs: 0 });
  c.add({ txs: 1, creates: TOKEN });
  c.add({ txs: 1, onCanton: false }); // made by reth, not on Canton yet
  return c;
};
const keys = (o: unknown) => Object.keys(o as object).sort();
const same = (o: unknown, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every object in an answer carries exactly its listed fields, the nested ones too. */
function checkFields(kind: "status" | "block" | "tx" | "address", body: unknown) {
  const b = body as Obj;
  same(b, FIELDS[kind]);
  if (kind === "status") {
    same(b.coin, FIELDS.coin); same(b.pins, FIELDS.pins); same(b.faucet, FIELDS.faucet);
    expect(typeof b.publicRpc).toBe("boolean");
    if (b.final) same(b.final, FIELDS.final);
    if (b.proving) same(b.proving, FIELDS.proving);
    if (b.signers) same(b.signers, FIELDS.signers);
    for (const l of b.latest) same(l, FIELDS.latest);
  } else if (kind === "block") {
    if (b.canton) {
      same(b.canton, FIELDS.canton);
      if (b.canton.proof) { same(b.canton.proof, FIELDS.proof); for (const f of ["programVK", "rootC", "blockHash"]) same(b.canton.proof[f], FIELDS.fact); }
    }
    for (const t of b.transactions) { same(t, FIELDS.blockTx); if (t.transfer) same(t.transfer, FIELDS.transfer); }
  } else if (kind === "tx") {
    if (b.lifecycle) same(b.lifecycle, FIELDS.lifecycle);
    if (b.block) same(b.block, FIELDS.txBlock);
    if (b.transfer) same(b.transfer, FIELDS.transfer);
    for (const l of b.logs) same(l, FIELDS.log);
  } else {
    if (b.token) same(b.token, FIELDS.token);
    if (b.createdBy) same(b.createdBy, FIELDS.createdBy);
  }
}

checkRequired();

/** One of each answer, with a log on the transaction in block 2. */
const answers = (chain: FakeChain): ["status" | "block" | "tx" | "address", string][] => {
  chain.receipts[2]![0]!.logs = [{ address: TOKEN, topics: ["0x" + "dd".repeat(32)], data: "0x01" }];
  return [
    ["status", "/api/status"], ["block", "/api/block/0"], ["block", "/api/block/1"], ["block", "/api/block/2"], ["block", "/api/block/3"],
    ["tx", `/api/tx/${txHash(2, 0)}`], ["tx", `/api/tx/${txHash(3, 0)}`], ["tx", `/api/tx/${POOL_TX}`],
    ["address", `/api/address/${TOKEN}`], ["address", `/api/address/${BOB}`],
  ];
};

describe.skipIf(!TEST_URL)("status and health", () => {
  it("says it is starting, not failed, while the indexer has written nothing", async () => {
    const { status, body } = await (await boot(chain(), { empty: true })).get("/api/status");
    checkFields("status", body);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, starting: true, problems: [], evm: true, canton: true, final: null, proving: { number: 3 }, latest: [], signers: null });
  });

  it("says what the indexer's failed checks say, and that it has not merely started", async () => {
    const { get, pool } = await boot(chain());
    await pool.query("insert into health_checks (check_id, status, detail, changed_at, checked_at) values ('C3', 'down', 'block 3: the record does not hash to reth''s transactions', now(), now()), ('C9', 'ok', null, now(), now())");
    const { status, body } = await get("/api/status");
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, starting: false, problems: ["C3: block 3: the record does not hash to reth's transactions"], final: { number: 2 } });
  });

  it("tells how far the index and stage 2 are: the head, the lag behind Canton, the derive cursor, and the chain instance", async () => {
    const { get, pool } = await boot(chain(), { indexed: 1 });
    await pool.query("insert into cursors (stream, position, updated_at) values ('derive', 0, now()) on conflict (stream) do update set position = 0");
    await pool.query("insert into meta (key, value) values ('chain_instance', 'instance-1') on conflict (key) do update set value = excluded.value");
    expect((await get("/api/status")).body).toMatchObject({ indexHead: 1, indexLag: 1, deriveCursor: 0, chainInstance: "instance-1" });
    const { get: caughtUp } = await boot(chain());
    expect((await caughtUp("/api/status")).body).toMatchObject({ indexHead: 2, indexLag: 0 });
  });

  it("says a block that is final on Canton but not in the database yet is final and not indexed yet, and a block that is not on Canton as being proven", async () => {
    const { get } = await boot(chain(), { indexed: 1 });
    expect((await get("/api/status")).body).toMatchObject({ final: { number: 1 }, proving: { number: 3 }, latest: [{ number: 1 }] });
    const behind = await get("/api/block/2");
    checkFields("block", behind.body);
    expect(behind.body).toMatchObject({ status: "unindexed", number: 2, hash: hashOf(2), canton: null, txCount: 1, transactions: [{ hash: txHash(2, 0) }] });
    expect((await get(`/api/tx/${txHash(2, 0)}`)).body).toMatchObject({ status: "unindexed", state: "unindexed", block: { number: 2, hash: hashOf(2), updateId: null }, success: true });
    expect((await get("/api/block/3")).body).toMatchObject({ status: "proving", number: 3, canton: null });
    expect((await get(`/api/tx/${txHash(3, 0)}`)).body).toMatchObject({ status: "proving", state: "proving", block: { number: 3, updateId: null } });
    expect((await get(`/api/block/${hashOf(2)}`)).body).toMatchObject({ status: "unindexed", number: 2 });
  });

  it("does not name a block as being proven when Canton already holds it: the indexer is behind, and the status says so by its problems", async () => {
    const { get } = await boot(chain(), { indexed: 1, finalized: 3 });
    const { body } = await get("/api/status");
    expect(body).toMatchObject({ final: { number: 1 }, proving: null });
    checkFields("status", body);
  });

  it("serves a block as final when the indexer wrote it while the route was asking reth, and not as 404", async () => {
    const { get } = await boot(chain(), { missFirstBlockRead: true });
    const r = await get("/api/block/2");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "final", number: 2, hash: hashOf(2) });
    // A block that is nowhere is still 404 after the second look.
    expect((await get("/api/block/99")).status).toBe(404);
  });

  it("does not call a block final when reth's finalized block cannot be read: it only says it is being proven", async () => {
    const { get } = await boot(chain(), { indexed: 1, finalized: "unreadable" });
    expect((await get("/api/block/2")).body).toMatchObject({ status: "proving", number: 2 });
    expect((await get(`/api/tx/${txHash(2, 0)}`)).body).toMatchObject({ status: "proving" });
  });

  describe("an indexer that has stopped", () => {
    const writeChecks = writeFreshChecks;

    it("is fine while its checks are fresh", async () => {
      const { get, pool } = await boot(chain());
      await writeChecks(pool, "1 second");
      const { status, body } = await get("/api/status");
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, problems: [] });
    });

    it("answers 503 and names the checks that have not been refreshed, even when every row says ok", async () => {
      const { get, pool } = await boot(chain());
      await writeChecks(pool, "2 hours");
      const { status, body } = await get("/api/status");
      expect(status).toBe(503);
      const { ok: isOk, starting, problems } = body as { ok: boolean; starting: boolean; problems: string[] };
      expect(isOk).toBe(false);
      expect(starting).toBe(false);
      expect(problems).toHaveLength(4);
      expect(problems[0]).toMatch(/^C10: the indexer has not checked in 7\d{3} s$/);
      expect(problems.some((p) => /^C5: the indexer has not checked in 7\d{3} s$/.test(p))).toBe(true);
    });

    it("answers 503 and names each refreshed check that has no row, when the indexer has written a record but has not checked yet (a rebuild from an export leaves it so)", async () => {
      const { get } = await boot(chain(), { checksWritten: false });
      const { status, body } = await get("/api/status");
      expect(status).toBe(503);
      expect(body).toMatchObject({ ok: false, starting: false, problems: ["C4: the indexer has not checked yet", "C5: the indexer has not checked yet", "derive_lag: the indexer has not checked yet", "C10: the indexer has not checked yet"] });
    });

    it("counts a row as stale after about three of the indexer's two-second intervals, and no sooner", async () => {
      const { get, pool } = await boot(chain());
      await writeChecks(pool, "4 seconds");
      expect((await get("/api/status")).status).toBe(200);
      await pool.query("update health_checks set checked_at = now() - interval '8 seconds'");
      expect((await get("/api/status")).status).toBe(503);
    });

    it("does not count a check that is only written when it fails as stale: an old ok row of C1 is an indexer that never failed", async () => {
      const { get, pool } = await boot(chain());
      await writeChecks(pool, "1 second");
      await pool.query("insert into health_checks (check_id, status, changed_at, checked_at) values ('C1', 'ok', now() - interval '2 hours', now() - interval '2 hours')");
      expect((await get("/api/status")).status).toBe(200);
    });

    it("answers 200 for degraded rows, which it names in `problems`, and 503 only for a row that is down or no longer refreshed (design 6.5)", async () => {
      const { get, pool } = await boot(chain());
      await writeChecks(pool, "1 second");
      // what an indexer with no journal and no status file writes: all four are degraded, and the blocks are still indexed
      await pool.query(
        `insert into health_checks (check_id, status, detail, changed_at, checked_at) values
           ('journal', 'degraded', 'no journal folder is set', now(), now()), ('producer_alive', 'degraded', 'no producer status file is set', now(), now()),
           ('producer_state', 'degraded', 'no producer status file is set', now(), now()), ('C8', 'degraded', 'there is no producer journal loaded', now(), now())`,
      );
      const degraded = await get("/api/status");
      expect(degraded.status).toBe(200);
      expect(degraded.body).toMatchObject({ ok: false, starting: false });
      expect((degraded.body as Obj).problems).toEqual([
        "C8: there is no producer journal loaded", "journal: no journal folder is set", "producer_alive: no producer status file is set", "producer_state: no producer status file is set",
      ]);
      // /healthz is the same answer, and what the container's health check reads
      expect((await get("/healthz")).status).toBe(200);
      // one row down turns it 503; the others stay named
      await pool.query("insert into health_checks (check_id, status, detail, changed_at, checked_at) values ('C7', 'down', 'stopped', now(), now())");
      expect((await get("/api/status")).status).toBe(503);
    });

    it("keeps the check's own words for a check that has failed and is being refreshed", async () => {
      const { get, pool } = await boot(chain());
      await writeChecks(pool, "1 second");
      await pool.query("update health_checks set status = 'degraded', detail = 'the index is 3 blocks behind' where check_id = 'C5'");
      expect(((await get("/api/status")).body as Obj).problems).toEqual(["C5: the index is 3 blocks behind"]);
    });
  });

  it("goes red and names the database when it cannot be read", async () => {
    const { get, pool } = await boot(chain());
    await pool.query("alter table blocks rename to blocks_moved");
    const { status, body } = await get("/api/status");
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, evm: true, final: null, latest: [] });
    expect(JSON.stringify((body as Obj).problems)).toMatch(/database/);
    const block = await get("/api/block/2");
    expect(block.status).toBe(502);
    expect(JSON.stringify(block.body)).not.toMatch(/127\.0\.0\.1|postgres|relation/);
  });

  it("says what is final and what is being proven, with the settings the pages need", async () => {
    const { get } = await boot(chain());
    const { status, body } = await get("/api/status");
    expect(status).toBe(200);
    checkFields("status", body);
    expect(body).toMatchObject({
      latest: [
        { number: 2, hash: hashOf(2), txCount: 1, updateId: updateIdOf(2) },
        { number: 1, hash: hashOf(1), txCount: 0, updateId: updateIdOf(1) },
      ],
      chainId: 770101, coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: "0x" + "cd".repeat(32), file: "guest.txt" }, ok: true, evm: true, canton: true,
      final: { number: 2, hash: hashOf(2) }, proving: { number: 3, hash: hashOf(3) }, signers: { operator: FAKE_OPERATOR, confirmer: FAKE_CONFIRMER }, faucet: { on: false },
    });
  });

  it("lists the newest ten final blocks, newest first, and no more", async () => {
    const c = new FakeChain();
    c.tokens.set(TOKEN, ["Token A", "TKA", 18]);
    for (let i = 0; i < 12; i++) c.add({ txs: 0 });
    const { body } = await (await boot(c)).get("/api/status");
    const latest = (body as Obj).latest as Obj[];
    expect(latest.map((x) => x.number)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(latest[0]).toEqual({ number: 12, hash: hashOf(12), timestamp: 1_000_096, txCount: 0, updateId: updateIdOf(12), recordTime: expect.stringMatching(/^2026-10-04T/) });
  });

  it("has an empty list before any block is final", async () => {
    const c = new FakeChain();
    expect(((await (await boot(c)).get("/api/status")).body as Obj).latest).toEqual([]);
  });

  it("goes red, with the same answer on both routes, when reth cannot be reached", async () => {
    const { api, get } = await boot(chain());
    await reth!.close();
    const status = await get("/api/status"), health = await api("GET", "/healthz");
    expect(status.body).toMatchObject({ ok: false, evm: false, canton: true });
    expect(health).toEqual({ status: 503, body: status.body });
  });
});

describe.skipIf(!TEST_URL)("blocks", () => {
  it("gives a final block's two sides, and the record's three fields as hex, by number, hash or update", async () => {
    const { get } = await boot(chain());
    const { status, body } = await get("/api/block/2");
    expect(status).toBe(200);
    checkFields("block", body);
    expect(body).toMatchObject({
      status: "final", number: 2, hash: hashOf(2), txCount: 1, genesisReferenced: null,
      canton: { updateId: updateIdOf(2), hashesMatch: true, proofHex: "ee".repeat(1344), txsHex: "02".repeat(20), proof: { programVK: { ok: false } } },
      transactions: [{ hash: txHash(2, 0), from: ALICE, to: TOKEN, success: true, transfer: { symbol: "TKA", decimals: 18, to: BOB, value: (10n ** 19n).toString() } }],
    });
    expect((await get(`/api/block/${hashOf(2)}`)).body).toEqual(body);
    expect((await get(`/api/block/${hashOf(2).toUpperCase().replace("0X", "0x")}`)).body).toEqual(body); // case does not matter
  });

  it("gives a block being proven with no Canton side, and the genesis with its link to block 1", async () => {
    const { get } = await boot(chain());
    expect((await get("/api/block/3")).body).toMatchObject({ status: "proving", number: 3, canton: null });
    expect((await get("/api/block/0")).body).toMatchObject({ status: "genesis", number: 0, canton: null, genesisReferenced: true });
  });

  it("answers 404 for a block nobody has, and 400 for something that is not a block", async () => {
    const { get } = await boot(chain());
    expect((await get("/api/block/9")).status).toBe(404);
    expect((await get("/api/block/nope")).status).toBe(400);
  });
});

describe.skipIf(!TEST_URL)("transactions and addresses", () => {
  it("gives a transaction as Final, Being proven or Waiting, with the decoded token transfer and the fee", async () => {
    const { get } = await boot(chain());
    const final = await get(`/api/tx/${txHash(2, 0)}`);
    checkFields("tx", final.body);
    expect(final.body).toMatchObject({
      status: "final", block: { number: 2, updateId: updateIdOf(2) }, success: true, fee: String(0x5208 * 7), toToken: "TKA", transfer: { symbol: "TKA", to: BOB }, created: TOKEN,
    });
    expect((await get(`/api/tx/${txHash(3, 0)}`)).body).toMatchObject({ status: "proving", block: { number: 3, updateId: null } });
    expect((await get(`/api/tx/${POOL_TX}`)).body).toMatchObject({ status: "waiting", block: null, success: null, fee: null });
    expect((await get(`/api/tx/0x${"00".repeat(32)}`)).status).toBe(404);
  });

  it("gives each transaction a state: pending, proving or final, with no reason of its own", async () => {
    const { get } = await boot(chain());
    expect((await get(`/api/tx/${txHash(2, 0)}`)).body).toMatchObject({ state: "final", reason: null });
    expect((await get(`/api/tx/${txHash(3, 0)}`)).body).toMatchObject({ state: "proving", reason: null });
    expect((await get(`/api/tx/${POOL_TX}`)).body).toMatchObject({ state: "pending", reason: null });
  });

  it("says what the tracker knows about a transaction reth no longer holds, with the same fields: dropped, replaced, or being sent again", async () => {
    const lost = hashOf(0x70), gone = hashOf(0x71), sending = hashOf(0x72);
    const stand = createTracker({
      reth: { block: async () => ({ number: 2 }) as never, transaction: async () => null, rpc: async () => "0x9" as never, sendRaw: async () => { throw new RethError('eth_sendRawTransaction: reth answered "underpriced"', true); } },
      index: { byNumber: () => undefined }, retryMs: 0, maxRefusals: 1,
    });
    stand.track("0x01", lost, ALICE, 4); // the sender's count is 9: replaced
    stand.track("0x02", gone, ALICE, 12);
    stand.track("0x03", sending, ALICE, 12);
    await stand.poll(); // lost: replaced; the others: refused once, so dropped
    const { get } = await boot(chain(), { tracker: stand });
    const replaced = await get(`/api/tx/${lost}`);
    checkFields("tx", replaced.body);
    expect(replaced).toMatchObject({ status: 200, body: { hash: lost, status: "replaced", state: "replaced", from: ALICE, nonce: 4, value: null, block: null, logs: [] } });
    const dropped = await get(`/api/tx/${gone}`);
    checkFields("tx", dropped.body);
    expect(dropped.body).toMatchObject({ state: "dropped", reason: expect.stringContaining("underpriced") });
    expect((await get(`/api/tx/0x${"00".repeat(32)}`)).status).toBe(404);
    expect((await get(`/api/tx/${sending}`)).body).toMatchObject({ state: "dropped" });
  });

  it("shows a transaction that is only waiting to be sent again as pending, with the tracker's note", async () => {
    const hash = hashOf(0x73);
    const stand = createTracker({ reth: { block: async () => ({ number: 2 }) as never, transaction: async () => null, rpc: async () => "0x0" as never, sendRaw: async () => hashOf(0) }, index: { byNumber: () => undefined }, retryMs: 0 });
    stand.track("0x01", hash, ALICE, 1);
    await stand.poll();
    const { get } = await boot(chain(), { tracker: stand });
    expect((await get(`/api/tx/${hash}`)).body).toMatchObject({ status: "waiting", state: "pending", reason: expect.stringMatching(/sent to the chain again/) });
  });

  it("says in the status whether the public RPC is on", async () => {
    const { get } = await boot(chain());
    expect((await get("/api/status")).body).toMatchObject({ publicRpc: false });
  });

  it("gives an account, a token, and the transaction that made a contract", async () => {
    const { get } = await boot(chain());
    const account = await get(`/api/address/${BOB}`);
    checkFields("address", account.body);
    expect(account.body).toMatchObject({ address: BOB, kind: "account", balance: String(5n * 10n ** 17n), nonce: 3, token: null, createdBy: null });
    expect((await get(`/api/address/${TOKEN}`)).body).toMatchObject({ kind: "token", token: { symbol: "TKA" }, createdBy: { txHash: txHash(2, 0), block: 2 } });
    expect((await get("/api/address/0x12")).status).toBe(400);
  });
});

describe.skipIf(!TEST_URL)("search", () => {
  it("works out what was typed from its shape, and says what it takes when nothing is found", async () => {
    const { get } = await boot(chain());
    const path = async (q: string) => (await get(`/api/search?q=${encodeURIComponent(q)}`)).body;
    expect(await path(" 2 ")).toEqual({ path: "/block/2" });
    expect(await path(txHash(2, 0))).toEqual({ path: `/tx/${txHash(2, 0)}` });
    expect(await path(POOL_TX)).toEqual({ path: `/tx/${POOL_TX}` });
    expect(await path(hashOf(1))).toEqual({ path: `/block/${hashOf(1)}` });
    expect(await path(BOB)).toEqual({ path: `/address/${BOB}` });
    expect(await path(updateIdOf(2))).toEqual({ path: `/canton/${updateIdOf(2)}` });
    for (const q of ["", "9", "hello", "0x" + "00".repeat(32), "1220" + "00".repeat(32)]) expect(await get(`/api/search?q=${q}`)).toEqual({ status: 404, body: { error: NOT_FOUND } });
  });
});

describe.skipIf(!TEST_URL)("fields", () => {
  it("gives every object of every answer exactly its listed fields", async () => {
    const c = chain(), targets = answers(c), { get } = await boot(c);
    for (const [kind, target] of targets) checkFields(kind, (await get(target)).body);
  });

  it("builds each object field by field, so nothing an inner object carries is passed on", async () => {
    const c = chain(), targets = answers(c), { get } = await boot(c, { leak: true });
    for (const [kind, target] of targets) {
      const { body } = await get(target);
      expect(JSON.stringify(body)).not.toContain("leaked");
      checkFields(kind, body);
    }
  });
});

describe.skipIf(!TEST_URL)("the faucet routes", () => {
  const ask = (api: Awaited<ReturnType<typeof boot>>["api"], address: unknown, ip?: string, extra: object = {}) => api("POST", "/api/faucet", JSON.stringify({ address, ...extra }), ip);

  it("takes a request with 202 and answers with a ticket, its place in line, the address and the amount, and nothing else", async () => {
    const { api } = await boot(chain(), { faucet: true });
    const answer = await ask(api, BOB);
    expect(answer.status).toBe(202);
    same(answer.body, FIELDS.faucetQueued);
    expect(answer.body).toMatchObject({ position: 1, to: BOB, amount: (10n ** 18n).toString() });
    expect((answer.body as Obj).ticket).toMatch(/^[0-9a-f]{24}$/);
  });

  it("answers a ticket's status with exactly its fields: queued with a place, then sent with the transaction, then final with the block", async () => {
    const { api, faucet, tracker } = await boot(chain(), { faucet: true });
    const id = ((await ask(api, BOB)).body as Obj).ticket as string;
    const queued = await api("GET", `/api/faucet/ticket/${id}`);
    expect(queued.status).toBe(200);
    same(queued.body, FIELDS.faucetTicket);
    expect(queued.body).toEqual({ ticket: id, status: "queued", position: 1, to: BOB, amount: (10n ** 18n).toString(), hash: null, state: null, block: null, reason: null });
    let tracked: Tracked | undefined;
    tracker.track = (_raw, _hash, from, nonce) => { tracked = { state: "pending", reason: null, from, nonce, block: null, updateId: null, attempts: 1 }; };
    tracker.state = () => tracked;
    await faucet.process();
    const sent = (await api("GET", `/api/faucet/ticket/${id}`)).body as Obj;
    expect(sent).toMatchObject({ status: "sent", position: null, state: "pending", block: null });
    expect(sent.hash).toMatch(/^0x[0-9a-f]{64}$/);
    Object.assign(tracked!, { state: "final", block: 3 });
    expect((await api("GET", `/api/faucet/ticket/${id}`)).body).toMatchObject({ status: "final", block: 3, hash: sent.hash });
  });

  it("finds a ticket another instance wrote, through the store", async () => {
    const id = "cd".repeat(12);
    const store: FaucetStore = {
      load: () => ({ addresses: [], ips: [], hourly: [], tickets: [] }), save: async () => true,
      find: async (x) => (x === id ? { id, to: BOB, ip: null, at: 1, status: "sent", hash: "0x" + "11".repeat(32), block: null, reason: null, tries: 0 } : null),
    };
    const { api } = await boot(chain(), { faucet: true, store });
    const found = await api("GET", `/api/faucet/ticket/${id}`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ ticket: id, status: "sent", to: BOB });
    expect((await api("GET", "/api/faucet/ticket/" + "ab".repeat(12))).status).toBe(404);
  });

  it("answers 404 to a ticket that is not known, 405 to other methods on it, and 404 to longer paths", async () => {
    const { api } = await boot(chain(), { faucet: true });
    expect((await api("GET", "/api/faucet/ticket/" + "ab".repeat(12))).status).toBe(404);
    expect((await api("POST", "/api/faucet/ticket/" + "ab".repeat(12), "{}")).status).toBe(405);
    expect((await api("GET", "/api/faucet/ticket/a/b")).status).toBe(404);
    expect((await api("GET", "/api/faucet/ticket")).status).toBe(404);
  });

  it("answers 429 with Retry-After for an address that was served and for a client that asked a moment ago, saying which", async () => {
    const { api } = await boot(chain(), { faucet: true });
    await ask(api, BOB, "9.9.9.9");
    const again = await ask(api, BOB, "8.8.8.8");
    expect(again).toMatchObject({ status: 429, headers: { "Retry-After": expect.stringMatching(/^\d+$/) } });
    expect(Object.keys(again.body as object)).toEqual(["error", "reason"]);
    expect(again.body).toMatchObject({ reason: "address" });
    const close = await ask(api, ALICE, "9.9.9.9");
    expect(close).toMatchObject({ status: 429, body: { reason: "ip" } });
  });

  it("answers 400 to a body that is not JSON, to no address, and to a bad address", async () => {
    const { api } = await boot(chain(), { faucet: true });
    for (const body of ["not json", "", "[]", "null", "5", "{}", JSON.stringify({ address: 5 }), JSON.stringify({ address: "0x12" })]) {
      expect((await api("POST", "/api/faucet", body)).status).toBe(400);
    }
    expect((await api("POST", "/api/faucet")).status).toBe(400);
  });

  it("answers 503 when the faucet is off, whatever is asked", async () => {
    const { api } = await boot(chain());
    expect((await ask(api, BOB)).status).toBe(503);
    expect((await api("POST", "/api/faucet", "not json")).status).toBe(503);
    expect((await api("POST", "/api/faucet")).body).toEqual({ error: "The faucet is off." });
  });

  it("shows, on GET, whether it is on, its address and balance, and what it gives, with exactly its fields", async () => {
    const on = await (await boot(chain(), { faucet: true })).get("/api/faucet");
    expect(on.status).toBe(200);
    same(on.body, FIELDS.faucetInfo);
    expect(on.body).toEqual({ on: true, address: FAUCET_ADDRESS, balance: (1000n * 10n ** 18n).toString(), amount: (10n ** 18n).toString(), perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 5000, queue: 0, captcha: null });
    await reth?.close(); await ledger?.close();
    const off = await (await boot(chain())).get("/api/faucet");
    expect(off.body).toEqual({ on: false, address: null, balance: null, amount: (10n ** 18n).toString(), perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 5000, queue: 0, captcha: null });
  });

  it("says in the status whether the faucet is on", async () => {
    expect(((await (await boot(chain(), { faucet: true })).get("/api/status")).body as Obj).faucet).toEqual({ on: true });
    await reth?.close(); await ledger?.close();
    expect(((await (await boot(chain())).get("/api/status")).body as Obj).faucet).toEqual({ on: false });
  });

  it("answers 405 to other methods", async () => {
    const { api } = await boot(chain(), { faucet: true });
    for (const m of ["PUT", "DELETE", "PATCH"]) expect((await api(m, "/api/faucet")).status).toBe(405);
    expect((await api("POST", "/api/faucet/extra", "{}")).status).toBe(404);
  });

  it("never lets the key into an answer", async () => {
    const { api } = await boot(chain(), { faucet: true });
    const text = JSON.stringify([await ask(api, BOB), await ask(api, BOB), await api("GET", "/api/faucet"), await api("GET", "/api/status")]);
    expect(text).not.toContain(FAUCET_KEY.slice(2));
  });
});

describe.skipIf(!TEST_URL)("the rest of the routes", () => {
  it("answers 404 or 405 elsewhere", async () => {
    const { api } = await boot(chain());
    expect((await api("POST", "/api/status")).status).toBe(405);
    expect((await api("GET", "/api/nothing")).status).toBe(404);
  });

  it("answers 404 for names that every object has, and never reads them as routes", async () => {
    const { api } = await boot(chain());
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(await api("GET", `/api/${name}`)).toEqual({ status: 404, body: { error: "No such route." } });
      expect((await api("GET", `/api/${name}/x`)).status).toBe(404);
    }
  });

  it("answers 400 for a target that is not a path, and does not throw", async () => {
    const { api } = await boot(chain());
    for (const target of ["//", "///", "//x/api/status"]) expect((await api("GET", target)).status).toBe(400);
  });

  it("answers 502, naming nothing internal, when reth fails mid-request", async () => {
    const { get } = await boot(chain());
    await reth!.close();
    const { status, body } = await get(`/api/tx/${txHash(2, 0)}`);
    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|fetch/);
  });
});

describe.skipIf(!TEST_URL)("tokens that no block created", () => {
  const unheld = () => {
    const c = new FakeChain();
    c.tokens.set(TOKEN, ["Token A", "TKA", 18]);
    c.add({ txs: 3 }); // three transfers to a token that no block created
    return c;
  };
  const tokenCalls = () => reth!.calls.filter((m) => m === "eth_call").length;

  it("asks reth for the token once, however many transfers of a block go to it, and once more for nothing", async () => {
    const { get } = await boot(unheld());
    const first = (await get("/api/block/1")).body as Obj;
    expect(first.transactions.map((t: Obj) => t.transfer.symbol)).toEqual(["TKA", "TKA", "TKA"]);
    expect(tokenCalls()).toBe(3); // name, symbol, decimals: one set, not three
    await get("/api/block/1");
    await get(`/api/tx/${txHash(1, 0)}`);
    expect(tokenCalls()).toBe(3);
  });

  it("keeps a token's details for as long as the process runs, and asks again after a failed read", async () => {
    const c = unheld();
    const { get } = await boot(c);
    const symbol = async () => ((await get("/api/block/1")).body as Obj).transactions[0].transfer.symbol;
    expect(await symbol()).toBe("TKA");
    c.tokens.set(TOKEN, ["Token B", "TKB", 18]);
    expect(await symbol()).toBe("TKA");
  });
});

describe.skipIf(!TEST_URL)("what the server touches", () => {
  it("calls only listed methods on reth and only the ledger end on Canton: the block records are the indexer's to read", async () => {
    const { get, api } = await boot(chain(), { faucet: true });
    ledger!.requests.length = 0; // what the test's own fixture read is not the server's
    await api("POST", "/api/faucet", JSON.stringify({ address: BOB }));
    for (const t of ["/api/faucet", "/api/status", "/api/block/2", "/api/block/3", "/api/block/0", `/api/tx/${txHash(2, 0)}`, `/api/address/${TOKEN}`, `/api/search?q=${hashOf(1)}`]) await get(t);
    expect(reth!.calls.length).toBeGreaterThan(5);
    for (const m of reth!.calls) expect(ALLOWED_METHODS.has(m)).toBe(true);
    const seen = ledger!.requests.map((r) => `${r.method} ${r.path}`);
    expect(new Set(seen)).toEqual(new Set(["GET /v2/state/ledger-end"]));
  });

  it("never lets a party id other than the two signers into any answer", async () => {
    const { get } = await boot(chain());
    const search = `/api/search?q=${encodeURIComponent(updateIdOf(2))}`;
    for (const t of ["/api/status", "/api/block/0", "/api/block/1", "/api/block/2", "/api/block/3", `/api/tx/${txHash(2, 0)}`, `/api/address/${TOKEN}`, search, `/api/search?q=${BOB}`, `/api/search?q=${"1220" + "00".repeat(32)}`]) {
      const text = JSON.stringify((await get(t)).body);
      expect(text).not.toMatch(/builder::|reader::/);
    }
  });
});
