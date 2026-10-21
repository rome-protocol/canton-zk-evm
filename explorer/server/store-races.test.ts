import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "./db/testing.ts";
import { createFaucet, type Faucet, type Ticket } from "./faucet.ts";
import { clientHasher, databaseFaucetStore } from "./faucet-store.ts";
import { advisoryLeader, FAUCET_LOCK, TRACKER_LOCK, type Leader } from "./leader.ts";
import { createReth } from "./reth.ts";
import { createTracker, type Entry } from "./tracker.ts";
import { databaseTrackerStore } from "./tracker-store.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";
import type { Pool } from "pg";

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
  dir = mkdtempSync(join(tmpdir(), "races-"));
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  await db.drop();
});

/** A pool whose connections run `before` ahead of every statement that matches, so a test can change things while a write is in flight. */
function spied(pool: Pool, match: RegExp, before: (sql: string) => void | Promise<void>): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "connect") {
        return async () => {
          const c = await target.connect();
          return new Proxy(c, {
            get(ct, cp) {
              if (cp === "query") return async (sql: unknown, ...rest: unknown[]) => { if (typeof sql === "string" && match.test(sql)) await before(sql); return (ct.query as (...a: unknown[]) => unknown)(sql, ...rest); };
              const v = (ct as never as Record<string | symbol, unknown>)[cp];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(ct) : v;
            },
          });
        };
      }
      const v = (target as never as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const d = TEST_URL ? describe : describe.skip;

d("a change made while a write is in flight is not lost", () => {
  it("the tracker's store writes the entry's final state at the next save", async () => {
    const e: Entry = { hash: hashOf(1), raw: "0x" + "02".repeat(30), from: addr(7), nonce: 0, state: "pending", reason: null, block: null, blockHash: null, updateId: null, attempts: 1, refused: 0, addedAt: 1000, lastSendAt: 1000, settledAt: null, via: "rpc" };
    let armed = true;
    const store = databaseTrackerStore(spied(db.pool, /insert into tracked_transactions/, () => {
      if (!armed) return;
      armed = false;
      e.state = "final"; e.block = 5; e.settledAt = 2000; e.raw = null; // the poll moves the entry while the insert is on its way
    }), 100);
    await store.load();
    await store.save([e]);
    await store.save([e]);
    const row = (await db.pool.query("select state, open, raw is null as no_raw from tracked_transactions")).rows[0];
    expect(row).toEqual({ state: "final", open: false, no_raw: true });
    expect((await db.pool.query("select state from tx_lifecycle")).rows[0]).toEqual({ state: "final" });
  });

  it("the faucet's store writes the ticket's final state at the next save", async () => {
    const t: Ticket = { id: "ab".repeat(12), to: addr(9), ip: null, at: 1000, status: "queued", hash: null, block: null, reason: null, tries: 0 };
    let armed = true;
    const store = databaseFaucetStore(spied(db.pool, /insert into faucet_requests/, () => {
      if (!armed) return;
      armed = false;
      t.status = "failed"; t.reason = "the coins ran out";
    }), COIN);
    await store.load({ now: 2000, addressMs: 1000, ipMs: 1000, max: 100 });
    await store.save([t], () => ({ addresses: [], ips: [], hourly: [] }));
    await store.save([t], () => ({ addresses: [], ips: [], hourly: [] }));
    expect((await db.pool.query("select state, reason, counts from faucet_requests")).rows[0]).toEqual({ state: "failed", reason: "the coins ran out", counts: false });
  });
});

d("the faucet on a shared database", () => {
  const fakeFor = async (raws: string[]): Promise<FakeReth> => {
    const fake = await startFakeReth({
      eth_getTransactionCount: () => "0x" + (3 + raws.length).toString(16),
      eth_getBlockByNumber: () => ({ number: "0x1", hash: hashOf(1), parentHash: hashOf(0), timestamp: "0x1", gasUsed: "0x0", gasLimit: "0x1c9c380", baseFeePerGas: "0x7", miner: addr(0), stateRoot: hashOf(2), transactions: [] }),
      eth_gasPrice: "0x3b9aca07", eth_maxPriorityFeePerGas: "0x3b9aca00", eth_getBalance: () => "0x" + (10n ** 30n).toString(16),
      eth_getTransactionByHash: () => null,
      eth_sendRawTransaction: (p: unknown[]) => { raws.push(p[0] as string); return keccak256(p[0] as Hex); },
    });
    closers.push(() => fake.close());
    return fake;
  };
  async function faucetOn(reth: { url: string }, pool: Pool = db.pool, leader?: (real: Leader) => Leader, balance?: () => string): Promise<Faucet> {
    const real = createReth(reth.url, 5000);
    const real_ = advisoryLeader({ connectionString: db.url }, FAUCET_LOCK);
    const f = createFaucet({
      key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 100000, batch: 5, queueMax: 5000, stateFile: null, captcha: null,
      reth: balance ? { ...real, balance: async () => BigInt(balance()) } : real,
      store: databaseFaucetStore(pool, COIN), leader: leader ? leader(real_) : real_, clientKeyHash: clientHasher(Buffer.alloc(32, 9)),
    });
    await f.ready();
    closers.push(() => f.close());
    return f;
  }
  const paid = (raws: string[]) => raws.map((r) => parseTransaction(r as Hex).to);

  it("a hand-over between a follower's read and its lock pays each request once", async () => {
    const raws: string[] = [];
    const fake = await fakeFor(raws);
    const a = await faucetOn(fake);
    let armed = false, a2: Promise<void> | null = null;
    const b = await faucetOn(fake, db.pool, (real) => ({
      isLeader: async () => {
        if (armed) { armed = false; await a.process(); await a.close(); a2 = Promise.resolve(); } // the old leader pays and gives the lock up inside the new one's pass
        return real.isLeader();
      },
      release: () => real.release(),
    }));
    await a.process(); // a takes the lead
    for (let i = 1; i <= 3; i++) expect((await b.request(addr(i), { ip: `8.8.${i}.1` })).status).toBe(202);
    await b.process(); // one follower pass: b reads the three requests as queued
    armed = true;
    await b.process();
    for (let i = 0; i < 5; i++) await b.process();
    expect(a2).not.toBeNull();
    expect(raws.length).toBe(3);
    expect(new Set(paid(raws)).size).toBe(3);
  });

  it("does not send a batch whose signed bytes the database refused, and pays no one twice after a restart", async () => {
    const raws: string[] = [];
    const fake = await fakeFor(raws);
    let fail = false;
    const flaky = spied(db.pool, /insert into faucet_requests/, () => { if (fail) throw new Error("the database is down"); });
    const a = await faucetOn(fake, flaky);
    for (let i = 1; i <= 3; i++) expect((await a.request(addr(i), { ip: `8.8.${i}.1` })).status).toBe(202);
    await a.flush();
    fail = true;
    await a.process();
    expect(raws).toEqual([]); // nothing went out
    fail = false;
    await a.close();
    // A restart: the new instance has the requests queued, with no signed bytes, and pays each once.
    const b = await faucetOn(fake);
    for (let i = 0; i < 5; i++) await b.process();
    expect(paid(raws).sort()).toEqual([addr(1), addr(2), addr(3)]);
    const rows = (await db.pool.query("select state from faucet_requests")).rows;
    expect(rows.every((r) => r.state === "sent" || r.state === "final")).toBe(true);
  });

  it("gives a failed request's limits back on the instance that did not fail it", async () => {
    const raws: string[] = [];
    const fake = await fakeFor(raws);
    let coins = (10n ** 30n).toString();
    const a = await faucetOn(fake, db.pool, undefined, () => coins);
    const b = await faucetOn(fake);
    await a.process();
    coins = "0"; // the leader has no coins: it fails the request
    expect((await b.request(addr(5), { ip: "8.8.5.1" })).status).toBe(202);
    await b.process(); // b reads its own request
    await a.process(); // a reads it and fails it
    expect(raws).toEqual([]);
    await b.process(); // b reads the failure
    expect((await b.request(addr(5), { ip: "8.8.5.1" })).status).toBe(202); // the address and the client may ask again
  });
});

d("the tracker's leader follows a transaction a follower added again", () => {
  it("takes the row that reopens a transaction it holds as dropped", async () => {
    let t = 1_000_000;
    const calls: string[] = [];
    const make = async (name: string) => {
      const reth = {
        block: async () => ({ number: 1 }) as never,
        transaction: async (h: string) => { calls.push(`${name}:${h}`); return { hash: h, blockNumber: null, blockHash: null } as never; },
        rpc: async () => "0x0", sendRaw: async () => hashOf(0),
      };
      const tr = createTracker({ reth, index: { byNumber: () => undefined }, store: databaseTrackerStore(db.pool, 100), leader: advisoryLeader({ connectionString: db.url }, TRACKER_LOCK), saveMs: 10, pollMs: 60000, maxPendingMs: 1000, now: () => t });
      await tr.ready();
      closers.push(() => tr.close());
      return tr;
    };
    const a = await make("a"), b = await make("b");
    const raw = "0x" + "02".repeat(30);
    a.track(raw, hashOf(1), addr(7), 0, "rpc");
    await a.flush();
    await a.poll();
    t += 5000;
    await a.poll(); // a stops following it
    expect(a.state(hashOf(1))?.state).toBe("dropped");
    await a.flush();
    await b.poll(); // b learns that it is dropped
    expect(b.state(hashOf(1))?.state).toBe("dropped");
    b.track(raw, hashOf(1), addr(7), 0, "rpc"); // the wallet sends the same bytes again, through b
    await b.flush();
    calls.length = 0;
    await a.poll();
    expect(a.state(hashOf(1))?.state).toBe("pending");
    await a.poll();
    expect(calls.filter((c) => c.startsWith("a:"))).not.toEqual([]);
  });
});
