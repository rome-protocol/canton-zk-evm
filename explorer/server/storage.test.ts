import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.ts";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "./db/testing.ts";
import { createFaucet } from "./faucet.ts";
import { advisoryLeader, FAUCET_LOCK, TRACKER_LOCK } from "./leader.ts";
import { createReth } from "./reth.ts";
import { openStorage } from "./storage.ts";
import { createTracker, type Tracker } from "./tracker.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

checkRequired();
vi.setConfig({ testTimeout: 30000 });

const COIN = 10n ** 18n;
const KEY = generatePrivateKey();
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const hashOf = (n: number) => "0x" + n.toString(16).padStart(64, "0");

let db: TestDatabase;
let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  db = await makeDatabase(true);
  dir = mkdtempSync(join(tmpdir(), "storage-"));
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  await db.drop();
});

const d = TEST_URL ? describe : describe.skip;

/** A config that names the database, the faucet's key and its hash key, and the old files. */
function config(over: Record<string, string> = {}) {
  const clientKey = join(dir, "client.key");
  writeFileSync(clientKey, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  const pins = `programVK=0x${"ab".repeat(32)}\nrootC=0x${"cd".repeat(32)}\n`;
  return loadConfig({
    PINS_FILE: "/pins.txt", READER_PARTY: "reader::1220ab", EXPLORER_DATABASE_URL: db.url, FAUCET_KEY_FILE: "/faucet.key", FAUCET_CLIENT_KEY_FILE: clientKey, ...over,
  }, () => pins);
}

d("the old files move into the database once", () => {
  it("imports TRACKER_FILE, keeps rows that exist, renames the file, and imports nothing the second time", async () => {
    const file = join(dir, "tracker.json");
    const entry = (n: number, state: string) => ({
      hash: hashOf(n), raw: "0x" + "02".repeat(40), from: addr(7), nonce: n, state, reason: null, block: state === "final" ? 5 : null, blockHash: null, updateId: null,
      attempts: 1, refused: 0, addedAt: Date.now() - 5000, lastSendAt: Date.now() - 4000, settledAt: state === "final" ? Date.now() - 1000 : null,
    });
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry(1, "pending"), entry(2, "final")] }));
    const cfg = config({ TRACKER_FILE: file });
    const s = await openStorage(cfg, { migrate: false });
    closers.push(() => s.close());
    expect(s.imported.tracker).toBe(2);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.imported`)).toBe(true);
    const rows = (await db.pool.query("select encode(tx_hash,'hex') h, state, open, block_number from tracked_transactions order by nonce")).rows;
    expect(rows.map((r) => [r.state, r.open])).toEqual([["pending", true], ["final", false]]);
    const life = (await db.pool.query("select state, accepted_at is not null as accepted from tx_lifecycle order by nonce")).rows;
    expect(life).toEqual([{ state: "pending", accepted: true }, { state: "final", accepted: true }]);

    // A row the database holds is not overwritten by an older copy of it.
    await db.pool.query("update tracked_transactions set state = 'dropped', reason = 'later word' where nonce = 1");
    writeFileSync(file, JSON.stringify({ version: 1, entries: [entry(1, "pending")] }));
    const again = await openStorage(cfg, { migrate: false });
    closers.push(() => again.close());
    expect(await db.pool.query("select state from tracked_transactions where nonce = 1").then((r) => r.rows[0].state)).toBe("dropped");
  });

  it("imports FAUCET_STATE_FILE with client addresses as keyed hashes, and every limit still holds", async () => {
    const file = join(dir, "faucet.json");
    const now = Date.now();
    const ticket = (n: number, status: string, ip: string | null) => ({ id: n.toString(16).padStart(24, "0"), to: addr(n), ip, at: now - 5000, status, hash: null, block: null, reason: null, tries: 0 });
    writeFileSync(file, JSON.stringify({
      version: 1,
      // addr(99) and the client 7.7.7.7 have a limit and no ticket any more: the limit must come over too.
      addresses: [[addr(1), now - 5000], [addr(2), now - 5000], [addr(99), now - 6000]],
      ips: [["1.2.3.4", now - 5000], ["2001:db8:0:1::/64", now - 5000], ["7.7.7.7", now - 6000]],
      hourly: [now - 5000, now - 5000, now - 6000, now - 6000],
      tickets: [ticket(1, "queued", "1.2.3.4"), ticket(2, "final", "2001:db8:0:1::/64")],
    }));
    const cfg = config({ FAUCET_STATE_FILE: file });
    const s = await openStorage(cfg, { migrate: false });
    closers.push(() => s.close());
    expect(s.imported.faucet).toBe(2);
    expect(existsSync(`${file}.imported`)).toBe(true);

    // No client address is in the database as it was, in any column.
    const dump = JSON.stringify((await db.pool.query("select ticket::text, encode(address,'hex') a, encode(client_key,'hex') k, reason from faucet_requests")).rows);
    for (const raw of ["1.2.3.4", "2001:db8", "7.7.7.7"]) expect(dump).not.toContain(raw);
    const key = (await db.pool.query("select encode(client_key,'hex') k from faucet_requests where address = $1", [Buffer.from(addr(1).slice(2), "hex")])).rows[0].k;
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    const reth = createReth("http://127.0.0.1:1", 100);
    const f = createFaucet({ key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 100000, batch: 10, queueMax: 100, stateFile: null, captcha: null, reth, ...s.faucet });
    await f.ready();
    expect(f.queued()).toBe(1); // the queued request came over
    const refused = async (address: string, ip: string) => (await f.request(address, { ip })).status;
    expect(await refused(addr(1), "9.9.9.9")).toBe(429); // the address's turn
    expect(await refused(addr(98), "1.2.3.4")).toBe(429); // the client's turn, by its hash
    expect(await refused(addr(97), "2001:db8:0:1:aaaa::1")).toBe(429); // an IPv6 client, by its /64
    expect(await refused(addr(99), "9.9.9.9")).toBe(429); // a limit with no ticket
    expect(await refused(addr(96), "7.7.7.7")).toBe(429);
    expect(await refused(addr(95), "9.9.9.9")).toBe(202);
    await f.close();
  });

  it("does nothing when there is no old file, and files stay as they are when no database is set", async () => {
    const s = await openStorage(config(), { migrate: false });
    closers.push(() => s.close());
    expect(s.imported).toEqual({ tracker: 0, faucet: 0 });
    const none = await openStorage(loadConfig({ PINS_FILE: "/p", READER_PARTY: "r", TRACKER_FILE: join(dir, "t.json") }, () => `programVK=0x${"ab".repeat(32)}\nrootC=0x${"cd".repeat(32)}\n`));
    expect(none.tracker).toEqual({});
    expect(none.faucet).toEqual({});
  });

  it("refuses a hash key that others can read, and one that is not 64 hex digits", async () => {
    const cfg = config();
    chmodSync(cfg.faucet.clientKeyFile!, 0o644);
    await expect(openStorage(cfg, { migrate: false })).rejects.toThrow(/owner only/);
    writeFileSync(cfg.faucet.clientKeyFile!, "abc\n", { mode: 0o600 });
    chmodSync(cfg.faucet.clientKeyFile!, 0o600);
    await expect(openStorage(cfg, { migrate: false })).rejects.toThrow(/64 hex/);
    expect(readdirSync(dir)).toContain("client.key");
  });
});

d("two instances share one database", () => {
  async function tracker(name: string, calls: string[]) {
    const { databaseTrackerStore } = await import("./tracker-store.ts");
    const lead = advisoryLeader({ connectionString: db.url }, TRACKER_LOCK);
    const reth = {
      block: async () => ({ number: 1 }) as never,
      transaction: async (h: string) => { calls.push(`${name}:${h}`); return { hash: h, blockNumber: null, blockHash: null } as never; },
      rpc: async () => "0x0",
      sendRaw: async () => hashOf(0),
    };
    const t = createTracker({ reth, index: { byNumber: () => undefined }, store: databaseTrackerStore(db.pool, 100), leader: lead, saveMs: 10, pollMs: 60000 });
    await t.ready();
    closers.push(() => t.close());
    return t;
  }

  it("runs the tracker's loop on one instance only, shows the other's list on both, and hands the loop over when the leader stops", async () => {
    const calls: string[] = [];
    const a = await tracker("a", calls);
    const b = await tracker("b", calls);
    a.track("0x" + "02".repeat(30), hashOf(1), addr(7), 0, "rpc");
    await a.flush();
    await a.poll();
    await b.poll();
    expect(calls.filter((c) => c.startsWith("a:"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("b:"))).toHaveLength(0); // the follower does not look at reth
    expect(b.state(hashOf(1))?.state).toBe("pending"); // and still knows the transaction

    // Acceptance is in tx_lifecycle, in the API's columns, with its door.
    const life = (await db.pool.query("select accepted_via, accepted_at is not null as accepted, encode(sender,'hex') s, nonce::int n, state from tx_lifecycle")).rows;
    expect(life).toEqual([{ accepted_via: "rpc", accepted: true, s: addr(7).slice(2), n: 0, state: "pending" }]);

    await a.close(); // gives the lead up
    await b.poll();
    expect(calls.filter((c) => c.startsWith("b:"))).toHaveLength(1); // now b follows the transaction on reth
  });

  it("a transaction added on the follower is followed by the leader", async () => {
    const calls: string[] = [];
    const a = await tracker("a", calls);
    const b = await tracker("b", calls);
    await a.poll();
    b.track("0x" + "02".repeat(30), hashOf(3), addr(8), 4, "faucet");
    await b.flush();
    await a.poll();
    await a.poll();
    expect(calls).toContain(`a:${hashOf(3)}`);
    expect(calls.filter((c) => c.startsWith("b:"))).toEqual([]);
    expect((await db.pool.query("select accepted_via from tx_lifecycle")).rows).toEqual([{ accepted_via: "faucet" }]);
  });

  async function faucetOn(reth: { url: string }, sent: string[]) {
    const { databaseFaucetStore, clientHasher } = await import("./faucet-store.ts");
    const real = createReth(reth.url, 5000);
    const f = createFaucet({
      key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 100000, batch: 5, queueMax: 5000, stateFile: null, captcha: null,
      reth: { ...real, sendRaw: async (raw: string) => { sent.push(raw); return real.sendRaw(raw); } },
      store: databaseFaucetStore(db.pool, COIN), leader: advisoryLeader({ connectionString: db.url }, FAUCET_LOCK), clientKeyHash: clientHasher(Buffer.alloc(32, 9)),
    });
    await f.ready();
    closers.push(() => f.close());
    return f;
  }

  it("runs the faucet's worker on one instance only, takes every request from either, and pays each address once", async () => {
    const raws: string[] = [];
    const fake: FakeReth = await startFakeReth({
      eth_getTransactionCount: () => "0x" + (3 + raws.length).toString(16),
      eth_getBlockByNumber: () => ({ number: "0x1", hash: hashOf(1), parentHash: hashOf(0), timestamp: "0x1", gasUsed: "0x0", gasLimit: "0x1c9c380", baseFeePerGas: "0x7", miner: addr(0), stateRoot: hashOf(2), transactions: [] }),
      eth_gasPrice: "0x3b9aca07", eth_maxPriorityFeePerGas: "0x3b9aca00", eth_getBalance: () => "0x" + (10n ** 30n).toString(16),
      eth_getTransactionByHash: () => null,
      eth_sendRawTransaction: (p: unknown[]) => { raws.push(p[0] as string); return keccak256(p[0] as Hex); },
    });
    closers.push(() => fake.close());
    const sentA: string[] = [], sentB: string[] = [];
    const a = await faucetOn(fake, sentA);
    const b = await faucetOn(fake, sentB);
    for (let i = 1; i <= 12; i++) expect((await (i % 2 ? a : b).request(addr(i), { ip: `8.8.${i}.1` })).status).toBe(202);
    // The same address and the same client, through the other instance: the limits are checked against both instances' requests.
    expect((await b.request(addr(1), { ip: "8.8.100.1" })).status).toBe(429);
    expect((await a.request(addr(50), { ip: "8.8.2.1" })).status).toBe(429);
    for (let i = 0; i < 20; i++) { await a.process(); await b.process(); }
    expect(sentB).toEqual([]); // b never leads while a does
    const tos = raws.map((r) => parseTransaction(r as Hex).to);
    expect(new Set(tos).size).toBe(12);
    expect(tos.length).toBe(12);
    expect(raws.map((r) => parseTransaction(r as Hex).nonce)).toEqual(Array.from({ length: 12 }, (_, i) => 3 + i));

    // The leader goes away with requests waiting: the other takes the worker and pays each of them once.
    for (let i = 20; i < 30; i++) expect((await b.request(addr(i), { ip: `8.9.${i}.1` })).status).toBe(202);
    await a.close();
    for (let i = 0; i < 20; i++) await b.process();
    expect(sentB.length).toBeGreaterThan(0);
    const tos2 = raws.map((r) => parseTransaction(r as Hex).to);
    expect(tos2.length).toBe(22);
    expect(new Set(tos2).size).toBe(22);
  });
});
