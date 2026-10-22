import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATABASE_MODE, makeDatabase, type TestDatabase } from "./db/testing.ts";
import { RethError } from "./reth.ts";
import { createTracker, type Tracker } from "./tracker.ts";
import { databaseTrackerStore } from "./tracker-store.ts";

const hashOf = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const SENDER = "0x" + "aa".repeat(20);
const rawOf = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(40);

interface Chain {
  finalized: number;
  /** Where each transaction is: a block number, or null for the pool. A transaction not here is nowhere. */
  where: Map<string, number | null>;
  /** The sender's count as of the finalized block. */
  nonce: number;
  down: boolean;
  /** What reth says to a resend: accept (default), or throw this refusal. */
  send: (raw: string) => void;
  sent: string[];
  /** When true, the Canton index does not hold the finalized blocks yet. */
  indexLag?: boolean;
}

function fakeChain(): Chain {
  return { finalized: 0, where: new Map(), nonce: 0, down: false, send: () => {}, sent: [] };
}

async function make(chain: Chain, o: { file?: string; max?: number; maxBytes?: number; maxPerSender?: number; saveMs?: number; retryMs?: number; maxRefusals?: number; maxAttempts?: number; maxPendingMs?: number } = {}): Promise<{ tracker: Tracker; clock: { now: number } }> {
  const clock = { now: 1000 };
  const reach = () => { if (chain.down) throw new RethError("cannot reach reth (down)"); };
  const reth = {
    block: async () => { reach(); return { number: chain.finalized } as never; },
    transaction: async (h: string) => {
      reach();
      if (!chain.where.has(h)) return null;
      const n = chain.where.get(h)!;
      return { hash: h, blockNumber: n, blockHash: n === null ? null : hashOf(n) } as never;
    },
    rpc: async (method: string, params: unknown[]) => {
      reach();
      expect(method).toBe("eth_getTransactionCount");
      expect(params[1]).toBe("0x" + chain.finalized.toString(16));
      return "0x" + chain.nonce.toString(16);
    },
    sendRaw: async (raw: string) => {
      reach();
      chain.sent.push(raw);
      try { chain.send(raw); } catch (e) { throw new RethError(`eth_sendRawTransaction: reth answered "${String(e)}"`, true); }
      return hashOf(0);
    },
  };
  const index = { byNumber: (n: number) => (n <= chain.finalized && !chain.indexLag ? ({ hash: hashOf(n), updateId: "1220" + String(n).padStart(2, "0").repeat(32) } as never) : undefined) };
  // Run with EXPLORER_TEST_STORE=database, the list is kept in the database where these tests say `file`.
  const { file, ...rest } = o;
  const tracker = createTracker({ reth, index, now: () => clock.now, retryMs: 5000, ...(DATABASE_MODE ? { store: databaseTrackerStore(db!.pool, rest.max ?? 10000) } : { file }), ...rest });
  await tracker.ready();
  return { tracker, clock };
}

let dir: string;
let db: TestDatabase | undefined;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tracker-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  if (DATABASE_MODE) db = await makeDatabase(true);
});
afterEach(async () => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.useRealTimers(); await db?.drop(); db = undefined; });

describe("the tracker", () => {
  it("starts a transaction as pending and knows nothing of another", async () => {
    const { tracker } = await make(fakeChain());
    tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", from: SENDER, nonce: 3, attempts: 1, block: null, reason: null });
    expect(tracker.state(hashOf(2))).toBeUndefined();
  });

  it("follows a transaction from the pool, into a block that is being proven, to a final block with its Canton update", async () => {
    const chain = fakeChain();
    const { tracker } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    chain.where.set(hashOf(1), null);
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("pending");
    chain.where.set(hashOf(1), 4);
    chain.finalized = 3;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "proving", block: 4 });
    chain.finalized = 4;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "final", block: 4, updateId: "1220" + "04".repeat(32), reason: null });
    expect(chain.sent).toEqual([]);
  });

  it("stops looking at a final transaction", async () => {
    const chain = fakeChain();
    const { tracker } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    chain.where.set(hashOf(1), 1);
    chain.finalized = 1;
    await tracker.poll();
    chain.where.delete(hashOf(1)); // reth restarted and forgot it: it is still final here
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("final");
    expect(chain.sent).toEqual([]);
  });

  it("sends a transaction that is nowhere again, with the same bytes, and counts the attempt", async () => {
    const chain = fakeChain();
    const { tracker, clock } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    chain.where.set(hashOf(1), 5); // in a block that Canton then refuses; reth goes back and does not put it back
    chain.finalized = 4;
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("proving");
    chain.where.delete(hashOf(1));
    clock.now += 8000;
    await tracker.poll();
    expect(chain.sent).toEqual([rawOf(1)]);
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", attempts: 2, block: null });
    expect(tracker.state(hashOf(1))?.reason).toMatch(/sent to the chain again/);
    chain.where.set(hashOf(1), null);
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", reason: null });
  });

  it("sends again no more than once in the retry time", async () => {
    const chain = fakeChain();
    const { tracker, clock } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    clock.now += 6000;
    await tracker.poll();
    clock.now += 1000;
    await tracker.poll();
    expect(chain.sent).toHaveLength(1);
    clock.now += 5000;
    await tracker.poll();
    expect(chain.sent).toHaveLength(2);
  });

  it("says replaced when the sender's finalized count is past the nonce and the transaction is in no block", async () => {
    const chain = fakeChain();
    const { tracker } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    chain.nonce = 4;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "replaced" });
    expect(tracker.state(hashOf(1))?.reason).toMatch(/nonce 3/);
    expect(chain.sent).toEqual([]);
  });

  it("does not call a transaction replaced when it is in a final block, whatever the sender's count", async () => {
    const chain = fakeChain();
    const { tracker } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    chain.nonce = 9;
    chain.finalized = 2;
    chain.where.set(hashOf(1), 2);
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("final");
  });

  it("drops a transaction after too many refusals in a row, with the reason from reth", async () => {
    const chain = fakeChain();
    chain.send = () => { throw "insufficient funds for gas"; };
    const { tracker, clock } = await make(chain, { maxRefusals: 3 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    for (let i = 0; i < 3; i++) {
      clock.now += 6000;
      expect(tracker.state(hashOf(1))?.state).toBe("pending");
      await tracker.poll();
    }
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "dropped" });
    expect(tracker.state(hashOf(1))?.reason).toContain("insufficient funds");
    expect(chain.sent).toHaveLength(3);
    clock.now += 6000;
    await tracker.poll();
    expect(chain.sent).toHaveLength(3); // settled: not looked at again
  });

  it("counts a send that reth says it knows already as accepted", async () => {
    const chain = fakeChain();
    chain.send = () => { throw "already known"; };
    const { tracker, clock } = await make(chain, { maxRefusals: 1 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    clock.now += 6000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", attempts: 2 });
  });

  it("counts, for the health row, the transactions it follows and those it gave up on in the last hour, and says that it leads", async () => {
    const chain = fakeChain();
    const { tracker, clock } = await make(chain, { maxAttempts: 2 });
    expect(tracker.isLeading()).toBe(true);
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    tracker.track(rawOf(2), hashOf(2), SENDER, 1);
    expect(tracker.stats()).toEqual({ open: 2, droppedLastHour: 0 });
    chain.where.set(hashOf(2), null); // 2 stays in the pool; 1 keeps going missing
    for (let i = 0; i < 2; i++) { clock.now += 6000; await tracker.poll(); }
    expect(tracker.stats()).toEqual({ open: 1, droppedLastHour: 1 });
    chain.where.set(hashOf(2), 1); chain.finalized = 1; // 2 is final, so only the one given up on is left
    clock.now += 3600_000 + 1; await tracker.poll();
    expect(tracker.stats()).toEqual({ open: 0, droppedLastHour: 0 });
  });

  it("drops a transaction that keeps going missing after it is accepted again each time", async () => {
    const chain = fakeChain();
    const { tracker, clock } = await make(chain, { maxAttempts: 3 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    for (let i = 0; i < 3; i++) { clock.now += 6000; await tracker.poll(); }
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "dropped", attempts: 3 });
    expect(tracker.state(hashOf(1))?.reason).toMatch(/3 times/);
  });

  it("learns nothing while reth cannot be reached, and counts no failed send", async () => {
    const chain = fakeChain();
    const { tracker, clock } = await make(chain, { maxRefusals: 1 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    chain.down = true;
    clock.now += 6000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", attempts: 1, reason: null });
    chain.down = false;
    chain.where.set(hashOf(1), null);
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("pending");
  });

  it("holds at most `max` transactions and drops the oldest settled one first", async () => {
    const chain = fakeChain();
    const { tracker } = await make(chain, { max: 3 });
    for (const n of [1, 2, 3]) tracker.track(rawOf(n), hashOf(n), SENDER, n);
    chain.finalized = 1;
    chain.where.set(hashOf(2), 1); // 2 is final; 1 and 3 are not
    await tracker.poll();
    tracker.track(rawOf(4), hashOf(4), SENDER, 4);
    expect(tracker.size()).toBe(3);
    expect(tracker.state(hashOf(2))).toBeUndefined();
    expect(tracker.state(hashOf(1))).toBeDefined();
    tracker.track(rawOf(5), hashOf(5), SENDER, 5); // none settled now: the oldest open one is marked dropped, then it goes
    expect(tracker.size()).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(hashOf(1)));
  });

  it("never forgets an open transaction silently: when it must make room, it marks the oldest dropped, with the reason and its bytes gone", async () => {
    const { tracker } = await make(fakeChain(), { max: 2, maxBytes: 1_000_000 });
    for (const n of [1, 2, 3]) tracker.track(rawOf(n), hashOf(n), SENDER, n);
    const dropped = [1, 2, 3].map((n) => tracker.state(hashOf(n))).filter((t) => t?.state === "dropped");
    expect(tracker.size()).toBe(2);
    expect(dropped.every((t) => /too many unconfirmed/.test(t!.reason ?? ""))).toBe(true);
    expect(tracker.state(hashOf(3))?.state).toBe("pending");
  });

  it("refuses a transaction before it is sent when the byte budget or the sender's limit is full, and takes a re-broadcast of one it follows", async () => {
    const { tracker } = await make(fakeChain(), { maxBytes: rawOf(1).length * 2, maxPerSender: 2 });
    expect(tracker.admit(rawOf(1), hashOf(1), SENDER)).toBeNull();
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    tracker.track(rawOf(2), hashOf(2), SENDER, 1);
    expect(tracker.admit(rawOf(3), hashOf(3), SENDER)).toMatch(/waiting to be confirmed/); // sender is at 2
    expect(tracker.admit(rawOf(3), hashOf(3), "0x" + "bb".repeat(20))).toMatch(/as many unconfirmed transactions as it can follow/); // bytes are full
    expect(tracker.admit(rawOf(1), hashOf(1), SENDER)).toBeNull(); // the wallet sends one again that is followed already
  });

  it("stops following a transaction that reth keeps for too long without a block, so it cannot hold a slot for ever", async () => {
    const chain = fakeChain();
    const { tracker, clock } = await make(chain, { maxPendingMs: 60000, maxBytes: rawOf(1).length * 3 });
    const senders = [1, 2, 3].map((n) => "0x" + n.toString(16).repeat(40));
    senders.forEach((s, i) => { tracker.track(rawOf(i + 1), hashOf(i + 1), s, 0); chain.where.set(hashOf(i + 1), null); });
    expect(tracker.admit(rawOf(9), hashOf(9), "0x" + "9".repeat(40))).not.toBeNull(); // the byte budget is full
    clock.now += 30000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("pending");
    expect(tracker.admit(rawOf(9), hashOf(9), "0x" + "9".repeat(40))).not.toBeNull();
    clock.now += 30000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "dropped", reason: expect.stringMatching(/without going into a block.*no longer followed/) });
    expect(tracker.admit(rawOf(9), hashOf(9), "0x" + "9".repeat(40))).toBeNull(); // the slots are free again
  });

  it("keeps following a transaction that is in a block, however old it is", async () => {
    const chain = fakeChain();
    const { tracker, clock } = await make(chain, { maxPendingMs: 60000 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    chain.where.set(hashOf(1), 5);
    chain.finalized = 4;
    clock.now += 600000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "proving", block: 5 });
  });

  it("counts only open entries against the limits: a settled transaction frees room", async () => {
    const chain = fakeChain();
    const { tracker } = await make(chain, { maxPerSender: 1 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    expect(tracker.admit(rawOf(2), hashOf(2), SENDER)).not.toBeNull();
    chain.finalized = 1;
    chain.where.set(hashOf(1), 1);
    await tracker.poll();
    expect(tracker.admit(rawOf(2), hashOf(2), SENDER)).toBeNull();
  });

  it("keeps a transaction open while another from the same sender holds its nonce (a speed-up), and calls it replaced once that one is final", async () => {
    const chain = fakeChain();
    chain.send = () => { throw "replacement transaction underpriced"; };
    const { tracker, clock } = await make(chain, { maxRefusals: 2 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 5);
    for (let i = 0; i < 6; i++) { // far past maxRefusals, and past the time one block takes to prove
      clock.now += 6000;
      await tracker.poll();
    }
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", attempts: 1 });
    expect(tracker.state(hashOf(1))?.reason).toMatch(/holds nonce 5/);
    chain.send = () => { throw "nonce too low"; };
    clock.now += 6000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("pending");
    chain.nonce = 6; // the replacement is final
    clock.now += 6000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "replaced" });
  });

  it("sends it again when the transaction that held its nonce goes away", async () => {
    const chain = fakeChain();
    chain.send = () => { throw "nonce too low"; };
    const { tracker, clock } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    clock.now += 6000;
    await tracker.poll();
    chain.send = () => {};
    clock.now += 6000;
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", attempts: 2 });
  });

  it.skipIf(DATABASE_MODE)("writes the file once for a burst of sends, only when something changed, and on flush", async () => {
    vi.useFakeTimers();
    try {
      const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
      const file = join(dir, "t.json");
      const chain = fakeChain();
      const { tracker } = await make(chain, { file, saveMs: 1000 });
      for (const n of [1, 2, 3, 4]) tracker.track(rawOf(n), hashOf(n), SENDER, n);
      await Promise.resolve();
      expect(existsSync(file)).toBe(false); // not written inside track()
      await vi.advanceTimersByTimeAsync(1100);
      await tracker.flush();
      expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(4);
      writeFileSync(file, "marker");
      chain.where.set(hashOf(1), null);
      for (const n of [2, 3, 4]) chain.where.set(hashOf(n), null);
      await tracker.poll(); // nothing changed: every transaction is still pending
      await vi.advanceTimersByTimeAsync(2000);
      await tracker.flush();
      expect(readFileSync(file, "utf8")).toBe("marker");
      tracker.track(rawOf(5), hashOf(5), SENDER, 5);
      await tracker.flush(); // a shutdown does not wait for the timer
      expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fills in the Canton update of a final transaction when the index catches up later", async () => {
    const chain = fakeChain();
    chain.indexLag = true;
    const { tracker } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 0);
    chain.finalized = 3;
    chain.where.set(hashOf(1), 3);
    await tracker.poll();
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "final", block: 3, updateId: null });
    chain.indexLag = false;
    expect(tracker.state(hashOf(1))?.updateId).toBe("1220" + "03".repeat(32));
  });

  it("starts a settled transaction again when it is sent again, and leaves an open one alone", async () => {
    const chain = fakeChain();
    const { tracker } = await make(chain);
    tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    chain.nonce = 4;
    await tracker.poll();
    expect(tracker.state(hashOf(1))?.state).toBe("replaced");
    tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    expect(tracker.state(hashOf(1))).toMatchObject({ state: "pending", attempts: 1 });
    tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    expect(tracker.size()).toBe(1);
  });

  it.skipIf(DATABASE_MODE)("keeps the list across a restart in TRACKER_FILE, written atomically", async () => {
    const file = join(dir, "state", "tracker.json");
    const chain = fakeChain();
    const first = await make(chain, { file });
    first.tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    first.tracker.track(rawOf(2), hashOf(2), SENDER, 4);
    chain.finalized = 2;
    chain.where.set(hashOf(2), 2);
    await first.tracker.poll();
    await first.tracker.flush();
    expect(readdirSync(join(dir, "state"))).toEqual(["tracker.json"]); // no half-written file left behind

    const second = await make(chain, { file });
    expect(second.tracker.state(hashOf(1))).toMatchObject({ state: "pending", nonce: 3, attempts: 1 });
    expect(second.tracker.state(hashOf(2))).toMatchObject({ state: "final", block: 2 });
    // The restarted tracker still has the bytes of the open one, so it can send it again.
    chain.where.clear();
    second.clock.now += 6000;
    await second.tracker.poll();
    expect(chain.sent).toEqual([rawOf(1)]);
  });

  it.skipIf(DATABASE_MODE)("does not keep the bytes of a transaction once it is settled", async () => {
    const file = join(dir, "t.json");
    const chain = fakeChain();
    const { tracker } = await make(chain, { file });
    tracker.track(rawOf(1), hashOf(1), SENDER, 3);
    await tracker.flush();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf8")).toContain(rawOf(1));
    chain.nonce = 4;
    await tracker.poll();
    await tracker.flush();
    expect(readFileSync(file, "utf8")).not.toContain(rawOf(1));
  });

  it.skipIf(DATABASE_MODE)("starts empty, and says so, when its file is not one it wrote", async () => {
    const { writeFileSync } = await import("node:fs");
    const file = join(dir, "bad.json");
    writeFileSync(file, "not json");
    const { tracker } = await make(fakeChain(), { file });
    expect(tracker.size()).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("looks again on a timer once started, and stops", async () => {
    vi.useFakeTimers();
    try {
      const chain = fakeChain();
      const { tracker } = await make(chain);
      tracker.track(rawOf(1), hashOf(1), SENDER, 0);
      chain.where.set(hashOf(1), 0);
      tracker.start();
      await vi.advanceTimersByTimeAsync(2100);
      await tracker.poll(); // a database answers in real time, which the clock above does not move
      expect(tracker.state(hashOf(1))?.state).toBe("final");
      tracker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
