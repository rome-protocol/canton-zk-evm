import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ConfigError } from "./config.ts";
import { createFaucet, FAUCET_GAS, loadFaucetKey, type Faucet, type FaucetOptions } from "./faucet.ts";
import { createReth, RethError, type Reth } from "./reth.ts";
import type { Tracked, TxState } from "./tracker.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const COIN = 10n ** 18n;
// Up to 1,000 signed transfers in one test, on a machine that may be busy with the other test files.
vi.setConfig({ testTimeout: 30000 });
const KEY = generatePrivateKey();
const FAUCET = privateKeyToAccount(KEY).address.toLowerCase();
const ALICE = "0x" + "9a".repeat(20), BOB = "0x" + "5b".repeat(20), CAROL = "0x" + "c4".repeat(20);
const DAY = 86400;
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");

/** A fake reth that holds the faucet's balance, its first nonce, and the raw transactions it was sent. Its pending nonce moves with each one it takes. */
interface Net {
  balance: bigint; base: number; raw: string[]; refuse?: string; refuseAt?: number;
  /** The block that holds the transfers, when reth has mined them. */
  mined?: number;
  /** The finalized block, and the faucet's count of sent transactions as of it. */
  finalized?: number; finalNonce?: number;
}
const net = (over: Partial<Net> = {}): Net => ({ balance: 1_000_000n * COIN, base: 5, raw: [], ...over });

/** A tracker that the test moves by hand. */
function fakeTracker() {
  const tracked = new Map<string, Tracked>();
  const sent: { hash: string; nonce: number; from: string }[] = [];
  const raws = new Map<string, string>();
  return {
    sent, tracked, raws,
    /** A reason to refuse, when a test wants the tracker to be full. */
    full: null as string | null,
    admit(_raw: string, _hash: string, _from: string): string | null { return this.full; },
    track(raw: string, hash: string, from: string, nonce: number) {
      sent.push({ hash, nonce, from });
      raws.set(hash, raw);
      tracked.set(hash, { state: "pending", reason: null, from, nonce, block: null, updateId: null, attempts: 1 });
    },
    state: (hash: string) => tracked.get(hash),
    move(hash: string, state: TxState, block: number | null = null, reason: string | null = null) { Object.assign(tracked.get(hash)!, { state, block, reason }); },
    /** Every transfer still waiting moves on to this state. */
    all(state: TxState, block = 100) { for (const [h, t] of tracked) if (t.state === "pending" || t.state === "proving") this.move(h, state, state === "final" ? block : null); },
  };
}

let fake: FakeReth | undefined, clock: { now: number }, state: Net, tracker: ReturnType<typeof fakeTracker>;
const logged: string[] = [];
beforeEach(() => {
  clock = { now: 1_000_000 };
  state = net();
  tracker = fakeTracker();
  logged.length = 0;
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(async () => { vi.restoreAllMocks(); await fake?.close(); fake = undefined; });

type Over = Partial<Omit<FaucetOptions, "reth" | "tracker">> & { down?: boolean; tracked?: boolean; wrap?: (r: Reth) => FaucetOptions["reth"] };

async function faucet(over: Over = {}): Promise<Faucet> {
  fake = await startFakeReth({
    eth_getTransactionCount: (p: unknown[]) => "0x" + (p[1] === "pending" ? state.base + state.raw.length : p[1] === "latest" ? state.base : state.finalNonce ?? state.base).toString(16),
    eth_getBlockByNumber: () => ({
      number: "0x" + (state.finalized ?? 0).toString(16), hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x1", gasUsed: "0x0", gasLimit: "0x1c9c380",
      baseFeePerGas: "0x7", miner: "0x" + "00".repeat(20), stateRoot: "0x" + "ef".repeat(32), transactions: [],
    }),
    eth_gasPrice: "0x3b9aca07",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_getBalance: () => "0x" + state.balance.toString(16),
    eth_getTransactionByHash: (p: unknown[]) => {
      const raw = state.raw.find((r) => keccak256(r as Hex) === p[0]);
      if (!raw) return null;
      return { hash: p[0], blockNumber: state.mined === undefined ? null : "0x" + state.mined.toString(16), blockHash: state.mined === undefined ? null : "0x" + "12".repeat(32), transactionIndex: state.mined === undefined ? null : "0x0", from: FAUCET, to: ALICE, value: "0x0", nonce: "0x0", type: "0x2", gas: "0x5208", input: "0x" };
    },
    eth_sendRawTransaction: (p: unknown[]) => {
      if (state.refuse && (state.refuseAt === undefined || state.refuseAt === state.raw.length)) { const r = state.refuse; if (state.refuseAt !== undefined) state.refuse = undefined; throw r; }
      state.raw.push(p[0] as string);
      return keccak256(p[0] as Hex);
    },
  });
  const { down, tracked, wrap, ...rest } = over;
  const reth = createReth(down ? "http://127.0.0.1:1" : fake.url, 5000);
  return createFaucet({
    key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: DAY, perIpSeconds: 600, maxPerHour: 100000, batch: 100, queueMax: 5000, stateFile: null, captcha: null,
    reth: wrap ? wrap(reth) : reth, tracker: tracked === false ? undefined : tracker, now: () => clock.now, ...rest,
  });
}

const ticketOf = (a: { body: unknown }) => (a.body as { ticket: string }).ticket;
const nonces = () => state.raw.map((r) => parseTransaction(r as Hex).nonce);
const tos = () => state.raw.map((r) => parseTransaction(r as Hex).to);
/** Runs the worker, and moves what it sent on to final, until the queue is empty. */
async function drain(f: Faucet) {
  for (let i = 0; i < 100 && f.queued(); i++) { await f.process(); tracker.all("final"); }
}

describe("a request", () => {
  it("is accepted at once with a ticket and its place in line, and nothing is sent until the worker runs", async () => {
    const f = await faucet();
    const first = await f.request(ALICE, { ip: "1.1.1.1" }), second = await f.request(BOB, { ip: "1.1.1.2" });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ ticket: expect.stringMatching(/^[0-9a-f]{24}$/), position: 1, to: ALICE, amount: COIN.toString() });
    expect((second.body as { position: number }).position).toBe(2);
    expect(state.raw).toEqual([]);
    expect(f.ticket(ticketOf(first))).toMatchObject({ status: "queued", position: 1, hash: null, block: null });
    expect(f.ticket(ticketOf(second))).toMatchObject({ status: "queued", position: 2 });
    expect(f.queued()).toBe(2);
  });

  it("is sent as an EIP-1559 transfer of 21,000 gas, signed by the faucet, at reth's pending count, and handed to the tracker", async () => {
    const f = await faucet({ amountWei: COIN / 2n });
    const t = ticketOf(await f.request(ALICE.toUpperCase().replace("0X", "0x")));
    await f.process();
    expect(state.raw).toHaveLength(1);
    const signed = state.raw[0] as Hex, tx = parseTransaction(signed);
    expect(tx).toMatchObject({ type: "eip1559", chainId: 770101, nonce: 5, to: ALICE, value: COIN / 2n, gas: 21000n });
    expect(tx.maxFeePerGas).toBeGreaterThanOrEqual(1000000007n);
    expect((await recoverTransactionAddress({ serializedTransaction: signed as never })).toLowerCase()).toBe(FAUCET);
    expect(tracker.sent).toEqual([{ hash: keccak256(signed), nonce: 5, from: FAUCET }]);
    expect(f.ticket(t)).toMatchObject({ status: "sent", position: null, hash: keccak256(signed), state: "pending", block: null });
    expect(f.queued()).toBe(0);
  });

  it("answers 400 to something that is not an address, and 503 with no key, asking nothing of reth", async () => {
    const f = await faucet();
    for (const bad of ["0x12", 5, undefined, null, "", "0x" + "zz".repeat(20)]) expect((await f.request(bad)).status).toBe(400);
    const off = await faucet({ key: null });
    expect(off.on).toBe(false);
    expect((await off.request(ALICE)).status).toBe(503);
    expect((await off.request("nonsense")).status).toBe(503);
    expect(await off.info()).toMatchObject({ on: false, address: null, balance: null, queue: 0 });
    expect(fake!.calls).toEqual([]);
  });
});

describe("the batches", () => {
  it("sends up to FAUCET_BATCH transfers with consecutive nonces, then waits until they have left the pool", async () => {
    const f = await faucet({ batch: 100 });
    for (let i = 0; i < 250; i++) await f.request(addr(i + 1), { ip: `10.0.${i}.1` });
    await f.process();
    expect(nonces()).toEqual(Array.from({ length: 100 }, (_, i) => 5 + i));
    expect(tos().slice(0, 3)).toEqual([addr(1), addr(2), addr(3)]); // in the order they asked
    await f.process();
    await f.process();
    expect(state.raw).toHaveLength(100); // still pending: the next batch does not flood the pool
    expect(f.queued()).toBe(150);
    for (const s of tracker.sent.slice(0, 99)) tracker.move(s.hash, "proving");
    await f.process();
    expect(state.raw).toHaveLength(100); // one is still pending
    tracker.move(tracker.sent[99]!.hash, "proving");
    await f.process();
    expect(nonces().slice(100)).toEqual(Array.from({ length: 100 }, (_, i) => 105 + i));
    tracker.all("final");
    await f.process();
    expect(nonces().slice(200)).toEqual(Array.from({ length: 50 }, (_, i) => 205 + i));
    expect(new Set(nonces()).size).toBe(250);
  });

  it("keeps the nonces without a gap when reth refuses one in the middle of a batch", async () => {
    const f = await faucet();
    for (let i = 0; i < 5; i++) await f.request(addr(i + 1), { ip: `10.0.${i}.1` });
    state.refuse = "nonce too low"; state.refuseAt = 2;
    await f.process();
    expect(nonces()).toEqual([5, 6]);
    expect(f.queued()).toBe(3);
    tracker.all("proving");
    await f.process();
    expect(nonces()).toEqual([5, 6, 7, 8, 9]);
  });

  it("treats a transfer that reth already has as sent", async () => {
    const f = await faucet();
    const t = ticketOf(await f.request(ALICE));
    state.refuse = "already known";
    await f.process();
    expect(f.ticket(t)).toMatchObject({ status: "sent", hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(tracker.sent).toHaveLength(1);
  });

  it("gives up on a transfer that reth refuses five times, and gives the address its turn back", async () => {
    const f = await faucet();
    const t = ticketOf(await f.request(ALICE, { ip: "1.1.1.1" }));
    state.refuse = "insufficient funds";
    for (let i = 0; i < 4; i++) { await f.process(); expect(f.ticket(t)?.status).toBe("queued"); }
    await f.process();
    expect(f.ticket(t)).toMatchObject({ status: "failed", reason: "The chain did not accept the faucet's transfer." });
    state.refuse = undefined;
    expect((await f.request(ALICE, { ip: "1.1.1.1" })).status).toBe(202);
  });

  it("keeps a request waiting, losing none, while reth cannot be reached", async () => {
    const f = await faucet({ down: true });
    const t = ticketOf(await f.request(ALICE));
    await f.process();
    expect(f.ticket(t)).toMatchObject({ status: "queued", position: 1 });
  });

  it("starts on its own when started, at each request and on the timer", async () => {
    const f = await faucet({ tickMs: 20 });
    f.start();
    try {
      const t = ticketOf(await f.request(ALICE));
      await vi.waitFor(() => expect(f.ticket(t)?.status).toBe("sent"));
      const u = ticketOf(await f.request(BOB));
      tracker.all("proving");
      await vi.waitFor(() => expect(f.ticket(u)?.status).toBe("sent"));
    } finally {
      f.stop();
    }
  });
});

describe("a ticket", () => {
  it("is final only when the tracker says the transfer is final, never before", async () => {
    const f = await faucet();
    const t = ticketOf(await f.request(ALICE));
    expect(f.ticket(t)?.status).toBe("queued");
    await f.process();
    const hash = tracker.sent[0]!.hash;
    expect(f.ticket(t)).toMatchObject({ status: "sent", state: "pending", block: null });
    tracker.move(hash, "proving", 7);
    expect(f.ticket(t)).toMatchObject({ status: "sent", state: "proving" });
    tracker.move(hash, "final", 7);
    expect(f.ticket(t)).toMatchObject({ status: "final", block: 7, hash, reason: null });
  });

  it("fails, with the tracker's reason, when the transfer was replaced, or dropped and reth does not have it, and the address may ask again", async () => {
    const f = await faucet();
    const t = ticketOf(await f.request(ALICE, { ip: "2.2.2.2" }));
    expect((await f.request(ALICE, { ip: "3.3.3.3" })).status).toBe(429);
    await f.process();
    state.raw.length = 0; // reth lost it
    tracker.move(tracker.sent[0]!.hash, "dropped", null, "It was sent to the chain 10 times and went missing each time.");
    expect(f.ticket(t)).toMatchObject({ status: "sent" }); // not failed on the tracker's word alone
    await f.process();
    expect(f.ticket(t)).toMatchObject({ status: "failed", reason: "It was sent to the chain 10 times and went missing each time." });
    expect((await f.request(ALICE, { ip: "2.2.2.2" })).status).toBe(202);
    const u = ticketOf(await f.request(BOB, { ip: "4.4.4.4" }));
    await f.process();
    tracker.move(tracker.sent[2]!.hash, "replaced", null, "Another transfer took its place.");
    expect(f.ticket(u)).toMatchObject({ status: "failed", reason: "Another transfer took its place." });
  });

  it("is not failed when the tracker only stopped following it and reth still has it: the address keeps its turn", async () => {
    const f = await faucet();
    const t = ticketOf(await f.request(ALICE, { ip: "2.2.2.2" }));
    await f.process();
    tracker.move(tracker.sent[0]!.hash, "dropped", null, "The explorer was holding too many unconfirmed transactions, so it stopped following this one. It may still be sent on by the chain.");
    await f.process();
    expect(f.ticket(t)).toMatchObject({ status: "sent", state: "dropped", reason: null });
    expect((await f.request(ALICE, { ip: "3.3.3.3" })).body).toMatchObject({ reason: "address" });
  });

  it("is left as it is when reth cannot say whether it has a transfer the tracker dropped", async () => {
    const f = await faucet({ wrap: (r) => ({ ...r, transaction: async () => { throw new RethError("down"); } }) });
    const t = ticketOf(await f.request(ALICE, { ip: "2.2.2.2" }));
    await f.process();
    tracker.move(tracker.sent[0]!.hash, "dropped", null, "gone");
    await f.process();
    expect(f.ticket(t)).toMatchObject({ status: "sent" });
  });

  describe("a transfer the tracker stopped following", () => {
    const WATCH = 48 * 3600_000;
    const sendOne = async (f: Faucet) => {
      const t = ticketOf(await f.request(ALICE, { ip: "2.2.2.2" }));
      await f.process();
      return { t, hash: tracker.sent[0]!.hash };
    };

    it("goes final with its block when reth mines it after the tracker dropped it (a prover outage: the transfer sat in the pool too long)", async () => {
      const f = await faucet();
      const { t, hash } = await sendOne(f);
      tracker.move(hash, "dropped", null, "It stayed in the chain's waiting list for 60 minutes without going into a block, so it is no longer followed. The chain may still mine it.");
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "sent" });
      state.mined = 50; state.finalized = 49; // mined, not yet final
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "sent" });
      state.finalized = 60;
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "final", block: 50, hash, reason: null });
    });

    it("goes final when the tracker has no entry for it any more (its list was full)", async () => {
      const f = await faucet();
      const { t, hash } = await sendOne(f);
      tracker.tracked.delete(hash);
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "sent" });
      state.mined = 7; state.finalized = 8;
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "final", block: 7 });
    });

    it("fails, and the address may ask again, when another transaction used its nonce", async () => {
      const f = await faucet();
      const { t } = await sendOne(f);
      const hash = tracker.sent[0]!.hash;
      tracker.move(hash, "dropped", null, "gone");
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "sent" });
      state.raw.length = 0; state.finalNonce = state.base + 1; state.finalized = 30; // the nonce is used, by another transaction
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "failed", reason: expect.stringContaining("Another transaction took") });
      expect((await f.request(ALICE, { ip: "2.2.2.2" })).status).toBe(202);
    });

    it("is not failed while its nonce is unused, even when reth does not have it", async () => {
      const f = await faucet();
      const { t, hash } = await sendOne(f);
      tracker.tracked.delete(hash);
      state.raw.length = 0;
      for (let i = 0; i < 3; i++) await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "sent" });
    });

    it("is followed after a restart", async () => {
      const dir = mkdtempSync(join(tmpdir(), "faucet-late-"));
      try {
        const stateFile = join(dir, "faucet.json");
        const first = await faucet({ stateFile });
        const { t, hash } = await sendOne(first);
        tracker.tracked.delete(hash);
        await first.process();
        await first.flush();
        await fake!.close();
        const second = await faucet({ stateFile });
        state.mined = 3; state.finalized = 4;
        await second.process();
        expect(second.ticket(t)).toMatchObject({ status: "final", block: 3 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("is left alone while reth cannot say, and asked again", async () => {
      let down = true;
      const f = await faucet({ wrap: (r) => ({ ...r, block: (async (id: number | string) => { if (down) throw new RethError("down"); return r.block(id); }) as never }) });
      const { t, hash } = await sendOne(f);
      tracker.tracked.delete(hash);
      state.mined = 3; state.finalized = 4;
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "sent" });
      down = false;
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "final" });
    });

    it("is followed for two days at most, then says it is no longer followed, and costs reth nothing after that", async () => {
      const f = await faucet();
      const { t, hash } = await sendOne(f);
      tracker.tracked.delete(hash);
      await f.process();
      clock.now += WATCH + 1;
      await f.process();
      expect(f.ticket(t)).toMatchObject({ status: "sent", reason: expect.stringContaining("stopped following") });
      const before = fake!.calls.length;
      state.mined = 3; state.finalized = 4;
      await f.process();
      expect(fake!.calls.length).toBe(before);
    });

    it("looks at no more than twenty late transfers in one pass, and every one in turn", async () => {
      const f = await faucet();
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push(ticketOf(await f.request(addr(i + 1), { ip: `9.9.9.${i}` })));
      await f.process();
      for (const h of [...tracker.tracked.keys()]) tracker.tracked.delete(h);
      state.mined = 3; state.finalized = 4;
      await f.process();
      const done = () => ids.filter((id) => f.ticket(id)!.status === "final").length;
      expect(done()).toBe(20);
      await f.process();
      expect(done()).toBe(30);
    });
  });

  it("is unknown when there is no such ticket", async () => {
    expect((await faucet()).ticket("00".repeat(12))).toBeNull();
  });

  it("stays sent, not final, when no tracker is there to say", async () => {
    const f = await faucet({ tracked: false });
    const t = ticketOf(await f.request(ALICE));
    await f.process();
    tracker.all("final");
    expect(f.ticket(t)?.status).toBe("sent");
  });
});

describe("the limits", () => {
  it("gives one request per address per 24 hours, and says how long to wait", async () => {
    const f = await faucet();
    expect((await f.request(ALICE, { ip: "1.1.1.1" })).status).toBe(202);
    clock.now += 3600_000;
    const again = await f.request(ALICE.toUpperCase().replace("0X", "0x"), { ip: "9.9.9.9" });
    expect(again).toMatchObject({ status: 429, headers: { "Retry-After": String(23 * 3600) }, body: { reason: "address" } });
    clock.now += 23 * 3600_000 - 1;
    expect((await f.request(ALICE, { ip: "9.9.9.9" })).status).toBe(429);
    clock.now += 1;
    expect((await f.request(ALICE, { ip: "9.9.9.9" })).status).toBe(202);
  });

  it("gives one request per client address in the window, and says how long to wait", async () => {
    const f = await faucet({ perIpSeconds: 600 });
    await f.request(ALICE, { ip: "1.1.1.1" });
    clock.now += 100_000;
    const other = await f.request(BOB, { ip: "1.1.1.1" });
    expect(other).toMatchObject({ status: 429, headers: { "Retry-After": "500" }, body: { reason: "ip" } });
    expect((await f.request(BOB, { ip: "1.1.1.2" })).status).toBe(202);
    clock.now += 500_000;
    expect((await f.request(CAROL, { ip: "1.1.1.1" })).status).toBe(202);
  });

  it("caps the requests accepted in an hour, and lets the next hour in", async () => {
    const f = await faucet({ maxPerHour: 3 });
    for (let i = 1; i <= 3; i++) { expect((await f.request(addr(i), { ip: `1.1.1.${i}` })).status).toBe(202); clock.now += 60_000; }
    const over = await f.request(addr(4), { ip: "1.1.1.4" });
    expect(over).toMatchObject({ status: 429, body: { reason: "hour" }, headers: { "Retry-After": String(3600 - 180) } });
    clock.now += 3600_000 - 180_000;
    expect((await f.request(addr(4), { ip: "1.1.1.4" })).status).toBe(202);
  });

  it("does not count a request that was turned away, or one that failed, against anyone", async () => {
    const f = await faucet({ maxPerHour: 2 });
    await f.request("junk");
    await f.request(ALICE, { ip: "1.1.1.1" });
    await f.request(ALICE, { ip: "1.1.1.2" }); // turned away: the address has had its turn
    expect((await f.request(BOB, { ip: "1.1.1.3" })).status).toBe(202);
  });

  it("turns requests away with honest words and a wait when the line is full, and still sends every request it took", async () => {
    const f = await faucet({ queueMax: 3, batch: 100 });
    for (let i = 1; i <= 3; i++) expect((await f.request(addr(i), { ip: `1.1.1.${i}` })).status).toBe(202);
    const full = await f.request(addr(4), { ip: "1.1.1.4" });
    expect(full).toMatchObject({ status: 503, body: { reason: "queue" }, headers: { "Retry-After": "10" } });
    expect(JSON.stringify(full.body)).toMatch(/turned away, not lost/);
    expect(f.queued()).toBe(3);
    await f.process();
    expect(state.raw).toHaveLength(3);
    expect((await f.request(addr(4), { ip: "1.1.1.4" })).status).toBe(202); // the line has room again, and the turned-away request kept its turn
  });

  it("forgets what is past its window, so the memory does not grow for ever", async () => {
    const f = await faucet();
    for (let i = 1; i <= 20; i++) await f.request(addr(i), { ip: `1.1.1.${i}` });
    expect(f.served()).toBe(20);
    clock.now += DAY * 1000 + 1;
    await f.request(addr(99), { ip: "9.9.9.9" });
    expect(f.served()).toBe(1);
  });
});

describe("when the coins run low", () => {
  it("answers 503 when the faucet is empty, keeping the address's turn", async () => {
    state.balance = COIN / 2n;
    const f = await faucet();
    expect(await f.request(ALICE)).toMatchObject({ status: 503, body: { error: "The faucet is empty.", reason: "empty" } });
    state.balance = 10n * COIN;
    clock.now += 10_000;
    expect((await f.request(ALICE)).status).toBe(202);
  });

  it("counts what is already promised: a queue that the balance cannot cover closes the door", async () => {
    state.balance = 2n * COIN + COIN / 2n;
    const f = await faucet();
    expect((await f.request(addr(1))).status).toBe(202);
    expect((await f.request(addr(2))).status).toBe(202);
    expect((await f.request(addr(3))).status).toBe(503);
  });

  it("fails the requests that the balance cannot pay when their batch comes, and gives them their turn back", async () => {
    const f = await faucet();
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push(ticketOf(await f.request(addr(i), { ip: `1.1.1.${i}` })));
    state.balance = 2n * COIN + COIN / 2n;
    await f.process();
    expect(state.raw).toHaveLength(2);
    expect(ids.map((t) => f.ticket(t)?.status)).toEqual(["sent", "sent", "failed", "failed", "failed"]);
    expect(f.ticket(ids[4]!)?.reason).toMatch(/ran out of coins/);
    expect(f.queued()).toBe(0);
    expect((await f.request(addr(5), { ip: "1.1.1.5" })).status).toBe(503); // empty now, but the address is not held
  });
});

describe("the human check", () => {
  const captcha = { secret: "s3cret", verifyUrl: "https://check.example/verify", scriptUrl: "https://check.example/api.js", siteKey: "site-key", widgetClass: "human-check" };
  const verifier = (say: unknown | Error) => {
    const calls: { url: string; body: URLSearchParams; type: string | null }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as URLSearchParams, type: new Headers(init.headers).get("content-type") });
      if (say instanceof Error) throw say;
      return new Response(JSON.stringify(say));
    }) as unknown as typeof fetch;
    return { calls, fn };
  };

  it("is off when not set: no token needed, nothing asked of anyone", async () => {
    const f = await faucet();
    expect((await f.request(ALICE)).status).toBe(202);
    expect((await f.info()).captcha).toBeNull();
  });

  it("asks for a token, and verifies it by posting the secret, the token and the client's address as a form", async () => {
    const v = verifier({ success: true });
    const f = await faucet({ captcha, fetch: v.fn });
    expect(await f.request(ALICE, { ip: "1.1.1.1" })).toMatchObject({ status: 403, body: { reason: "captcha" } });
    expect(v.calls).toHaveLength(0);
    expect((await f.request(ALICE, { ip: "1.1.1.1", captcha: "tok" })).status).toBe(202);
    expect(v.calls).toHaveLength(1);
    expect(v.calls[0]!.url).toBe(captcha.verifyUrl);
    expect(v.calls[0]!.type).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(v.calls[0]!.body)).toEqual({ secret: "s3cret", response: "tok", remoteip: "1.1.1.1" });
  });

  it("turns a token that does not pass away with 403, and does not use up the address's turn", async () => {
    const f = await faucet({ captcha, fetch: verifier({ success: false }).fn });
    expect(await f.request(ALICE, { captcha: "bad" })).toMatchObject({ status: 403, body: { reason: "captcha" } });
    expect(f.served()).toBe(0);
    for (const odd of [{ success: "true" }, {}, null]) expect((await (await faucet({ captcha, fetch: verifier(odd).fn })).request(ALICE, { captcha: "x" })).status).toBe(403);
  });

  it("asks nothing of the check for an address that the limits already turn away", async () => {
    const v = verifier({ success: true });
    const f = await faucet({ captcha, fetch: v.fn });
    await f.request(ALICE, { ip: "1.1.1.1", captcha: "a" });
    await f.request(ALICE, { ip: "2.2.2.2", captcha: "b" });
    await f.request(BOB, { ip: "1.1.1.1", captcha: "c" });
    expect(v.calls).toHaveLength(1);
  });

  it("says so, with 503, when the check cannot be reached, rather than letting anyone in", async () => {
    const f = await faucet({ captcha, fetch: verifier(new TypeError("fetch failed")).fn });
    expect(await f.request(ALICE, { captcha: "a" })).toMatchObject({ status: 503, headers: { "Retry-After": "5" } });
    expect(f.queued()).toBe(0);
  });

  it("shows the page what it needs, and never the secret", async () => {
    const f = await faucet({ captcha });
    const info = await f.info();
    expect(info.captcha).toEqual({ siteKey: "site-key", scriptUrl: captcha.scriptUrl, widgetClass: "human-check" });
    expect(JSON.stringify(info)).not.toContain("s3cret");
  });
});

describe("a restart", () => {
  const withFile = async (run: (file: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "faucet-state-"));
    try { await run(join(dir, "nested", "faucet.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("keeps the limits and the waiting requests", async () => {
    await withFile(async (stateFile) => {
      const first = await faucet({ stateFile, maxPerHour: 2 });
      const a = ticketOf(await first.request(ALICE, { ip: "1.1.1.1" })), b = ticketOf(await first.request(BOB, { ip: "1.1.1.2" }));
      await first.process();
      await first.flush();
      await fake!.close();
      const second = await faucet({ stateFile, maxPerHour: 2 });
      expect((await second.request(ALICE, { ip: "5.5.5.5" })).body).toMatchObject({ reason: "address" });
      expect((await second.request(CAROL, { ip: "1.1.1.1" })).body).toMatchObject({ reason: "ip" });
      expect((await second.request(CAROL, { ip: "5.5.5.5" })).body).toMatchObject({ reason: "hour" });
      expect(second.ticket(a)).toMatchObject({ status: "sent", to: ALICE });
      expect(second.ticket(b)).toMatchObject({ status: "sent", to: BOB });
    });
  });

  it("sends a request that was still waiting", async () => {
    await withFile(async (stateFile) => {
      const first = await faucet({ stateFile });
      const t = ticketOf(await first.request(ALICE));
      await first.flush();
      await fake!.close();
      const second = await faucet({ stateFile });
      expect(second.ticket(t)).toMatchObject({ status: "queued", position: 1 });
      await second.process();
      expect(second.ticket(t)?.status).toBe("sent");
      expect(tos()).toEqual([ALICE]);
    });
  });

  it("is written through a temporary file, with the key nowhere in it", async () => {
    await withFile(async (stateFile) => {
      const f = await faucet({ stateFile });
      await f.request(ALICE, { ip: "1.1.1.1" });
      await f.flush();
      const text = (await import("node:fs")).readFileSync(stateFile, "utf8");
      expect(text).toContain(ALICE);
      expect(text).not.toContain(KEY.slice(2));
      expect((await import("node:fs")).existsSync(`${stateFile}.tmp`)).toBe(false);
    });
  });

  it("starts with no limits, and says so, when the file is not one it wrote", async () => {
    await withFile(async (stateFile) => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(stateFile, ".."), { recursive: true });
      writeFileSync(stateFile, "{{{");
      const f = await faucet({ stateFile });
      expect((await f.request(ALICE)).status).toBe(202);
      expect(logged.join("\n")).toMatch(/is not a file the faucet wrote/);
    });
  });
});

describe("a flood", () => {
  /** 1,000 requests, 20 in flight at a time, from 50 client addresses asking for 300 addresses. */
  async function flood(f: Faucet, each: (round: number) => void = () => {}) {
    const results: { ip: string; to: string; status: number; reason?: string; ticket?: string }[] = [];
    for (let start = 0; start < 1000; start += 50) {
      each(start / 50);
      await Promise.all(Array.from({ length: 50 }, async (_, k) => {
        const i = start + k, ip = `10.0.0.${(i * 7) % 50}`, to = addr(1 + (i % 300));
        const a = await f.request(to, { ip });
        const body = a.body as { reason?: string; ticket?: string };
        results.push({ ip, to, status: a.status, reason: body.reason, ticket: body.ticket });
      }));
    }
    return results;
  }
  const accepted = (r: Awaited<ReturnType<typeof flood>>) => r.filter((x) => x.status === 202);
  const reasons = (r: Awaited<ReturnType<typeof flood>>) => r.reduce<Record<string, number>>((m, x) => ((m[x.reason ?? String(x.status)] = (m[x.reason ?? String(x.status)] ?? 0) + 1), m), {});

  it("holds the per-address and per-client limits: each address once, each client once in its window", async () => {
    const f = await faucet({ perIpSeconds: 600 });
    const r = await flood(f);
    expect(r).toHaveLength(1000);
    expect(accepted(r)).toHaveLength(50); // one for each of the 50 clients, however many they asked for
    expect(new Set(accepted(r).map((x) => x.ip)).size).toBe(50);
    expect(new Set(accepted(r).map((x) => x.to)).size).toBe(50);
    expect(reasons(r)).toEqual({ "202": 50, ip: expect.any(Number), address: expect.any(Number) });
    expect(reasons(r).ip! + reasons(r).address!).toBe(950);
    await drain(f);
    expect(state.raw).toHaveLength(50);
  });

  it("holds the per-address limit when clients may come back: 300 addresses, 300 transfers, no address twice", async () => {
    const f = await faucet({ perIpSeconds: 1 });
    const r = await flood(f, () => { clock.now += 2000; });
    expect(accepted(r)).toHaveLength(300);
    expect(new Set(accepted(r).map((x) => x.to)).size).toBe(300);
    expect(reasons(r)).toEqual({ "202": 300, address: 700 });
    await drain(f);
    expect(state.raw).toHaveLength(300);
    expect(new Set(tos()).size).toBe(300);
    expect(nonces()).toEqual(Array.from({ length: 300 }, (_, i) => 5 + i));
  });

  it("holds the hourly cap", async () => {
    const f = await faucet({ perIpSeconds: 1, maxPerHour: 120 });
    const r = await flood(f, () => { clock.now += 2000; });
    expect(accepted(r)).toHaveLength(120);
    expect(reasons(r).hour).toBeGreaterThan(0);
    await drain(f);
    expect(state.raw).toHaveLength(120);
  });

  it("answers honestly when the line is full: exactly the room there is is taken, the rest are told 503 with a wait, and every ticket taken is sent", async () => {
    const f = await faucet({ perIpSeconds: 1, queueMax: 100, batch: 40 });
    const r = await flood(f, () => { clock.now += 2000; });
    expect(accepted(r)).toHaveLength(100);
    expect(reasons(r)).toMatchObject({ "202": 100, queue: expect.any(Number) });
    expect(r.filter((x) => x.status === 503 && x.reason === "queue").length + r.filter((x) => x.status === 202).length + r.filter((x) => x.status === 429).length).toBe(1000);
    await drain(f);
    expect(state.raw).toHaveLength(100);
    for (const a of accepted(r)) expect(f.ticket(a.ticket!)?.status).toBe("final");
  });

  it("never reports a ticket final before its transfer is final, at any step of a drain", async () => {
    const f = await faucet({ perIpSeconds: 1, batch: 30 });
    const r = accepted(await flood(f, () => { clock.now += 2000; })).slice(0, 100);
    for (let i = 0; i < 20 && f.queued(); i++) {
      await f.process();
      for (const a of r) {
        const t = f.ticket(a.ticket!)!;
        if (t.status === "final") expect(tracker.tracked.get(t.hash!)?.state).toBe("final");
      }
      tracker.all("proving");
      for (const a of r) {
        const t = f.ticket(a.ticket!)!;
        if (t.hash && tracker.tracked.get(t.hash)?.state !== "final") expect(t.status).not.toBe("final");
      }
      tracker.all("final");
    }
  });
});

describe("the key", () => {
  it("never appears in an answer, a ticket or a log line, on any path", async () => {
    const f = await faucet();
    const answers: unknown[] = [await f.request(ALICE), await f.request(ALICE), await f.request("junk")];
    state.refuse = "boom";
    await f.process();
    state.balance = 0n;
    state.refuse = undefined;
    answers.push(await f.request(CAROL), f.ticket((answers[0] as { body: { ticket: string } }).body.ticket));
    const everything = JSON.stringify(answers, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + logged.join("\n") + JSON.stringify(await f.info());
    expect(everything).not.toContain(KEY.slice(2));
    expect(everything).not.toContain(KEY.slice(2, 34));
  });

  it("is loaded from the file with or without 0x and with a trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "faucet-key-"));
    try {
      const bare = join(dir, "bare"), prefixed = join(dir, "prefixed");
      writeFileSync(bare, KEY.slice(2) + "\n");
      writeFileSync(prefixed, KEY + "\n");
      expect(loadFaucetKey(bare)).toBe(KEY);
      expect(loadFaucetKey(prefixed)).toBe(KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is absent when no file is named", () => {
    expect(loadFaucetKey(null)).toBeNull();
  });

  it("stops the server with a message that names the setting, and never prints the file's content", () => {
    const dir = mkdtempSync(join(tmpdir(), "faucet-key-"));
    try {
      const wrong = join(dir, "wrong");
      writeFileSync(wrong, "super-secret-but-not-a-key");
      let message = "";
      try { loadFaucetKey(wrong); } catch (e) { expect(e).toBeInstanceOf(ConfigError); message = (e as Error).message; }
      expect(message).toMatch(/FAUCET_KEY_FILE/);
      expect(message).not.toContain("super-secret");
      expect(() => loadFaucetKey(join(dir, "missing"))).toThrow(/FAUCET_KEY_FILE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a transfer of exactly 21,000 gas", () => {
    expect(FAUCET_GAS).toBe(21000n);
  });
});

describe("a send whose answer is lost", () => {
  /** Reth takes the transfer, and the answer never comes back: a timeout, a dropped connection, or a proxy's 502. */
  const loseAnswer = (times: number) => (r: Reth): FaucetOptions["reth"] => {
    let left = times;
    return { ...r, sendRaw: async (raw: string) => { const h = await r.sendRaw(raw); if (left-- > 0) throw new RethError("reth did not answer in time"); return h; } };
  };

  it("pays the address exactly once: the transfer is handed to the tracker, and is never signed again", async () => {
    const f = await faucet({ wrap: loseAnswer(1) });
    const t = ticketOf(await f.request(ALICE, { ip: "1.1.1.1" }));
    await f.process();
    expect(nonces()).toEqual([5]);
    expect(f.ticket(t)).toMatchObject({ status: "sent", hash: keccak256(state.raw[0] as Hex) });
    expect(tracker.sent).toEqual([{ hash: keccak256(state.raw[0] as Hex), nonce: 5, from: FAUCET }]);
    for (let i = 0; i < 3; i++) await f.process();
    expect(nonces()).toEqual([5]);
    tracker.all("final");
    await f.process();
    expect(nonces()).toEqual([5]);
    expect(f.ticket(t)).toMatchObject({ status: "final", block: 100 });
  });

  it("stops the batch there, keeps the rest queued, and sends them at the next nonces once the tracker has let go", async () => {
    const f = await faucet({ wrap: loseAnswer(1) });
    for (let i = 1; i <= 4; i++) await f.request(addr(i), { ip: `9.9.9.${i}` });
    await f.process();
    expect(nonces()).toEqual([5]);
    expect(f.queued()).toBe(3);
    await f.process();
    expect(nonces()).toEqual([5]); // the lost one is still pending
    tracker.all("final");
    await f.process();
    expect(nonces()).toEqual([5, 6, 7, 8]);
    expect(new Set(tos()).size).toBe(4);
  });

  it("hands over a transfer that reth never got too: the tracker sends it again", async () => {
    const f = await faucet({ wrap: (r) => ({ ...r, sendRaw: async () => { throw new RethError("connection reset"); } }) });
    const t = ticketOf(await f.request(ALICE));
    await f.process();
    expect(state.raw).toEqual([]);
    expect(f.ticket(t)).toMatchObject({ status: "sent" });
    expect(tracker.raws.get(f.ticket(t)!.hash!)).toMatch(/^0x/);
  });
});

describe("a stop or a crash in the middle of a batch", () => {
  const withFile = async (run: (file: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "faucet-state-"));
    try { await run(join(dir, "faucet.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  /** Holds the send number `at` until released. */
  function gated(at: number) {
    let n = 0, release!: () => void, reached!: () => void;
    const open = new Promise<void>((ok) => (release = ok)), arrived = new Promise<void>((ok) => (reached = ok));
    const wrap = (r: Reth): FaucetOptions["reth"] => ({ ...r, sendRaw: async (raw: string) => { if (n++ === at) { reached(); await open; } return r.sendRaw(raw); } });
    return { wrap, release, arrived };
  }
  const requestAll = async (f: Faucet, n: number) => { for (let i = 1; i <= n; i++) await f.request(addr(i), { ip: `8.8.${i}.1` }); };

  it("a stop waits for the send in hand, sends no more, and keeps every ticket's state, so a restart pays nobody twice", async () => {
    await withFile(async (stateFile) => {
      const g = gated(6);
      const first = await faucet({ stateFile, wrap: g.wrap });
      await requestAll(first, 20);
      first.start();
      await g.arrived;
      first.stop();
      const flushed = first.flush();
      g.release();
      await flushed;
      const sentBefore = state.raw.length;
      expect(sentBefore).toBe(7);
      await fake!.close();
      tracker = fakeTracker();
      const second = await faucet({ stateFile });
      for (let i = 0; i < 10 && second.queued(); i++) { await second.process(); tracker.all("final"); }
      expect(state.raw.length).toBe(20);
      expect(new Set(tos()).size).toBe(20);
      expect(nonces()).toEqual(Array.from({ length: 20 }, (_, i) => 5 + i));
    });
  });

  it("a crash after the batch was written and before it was all sent: the restart hands the unsent ones to the tracker and signs nothing twice", async () => {
    await withFile(async (stateFile) => {
      const g = gated(6);
      const first = await faucet({ stateFile, wrap: g.wrap });
      await requestAll(first, 20);
      const dying = first.process();
      await g.arrived; // six are in reth, the seventh is held: the process "dies" here
      const reth6 = state.raw.length;
      expect(reth6).toBe(6);
      const old = tracker;
      const afterCrash = fakeTracker(); // the tracker lost what the faucet had not handed it
      tracker = afterCrash;
      const second = await faucet({ stateFile });
      expect(second.queued()).toBe(0); // nobody is waiting for a new signature
      await second.process();
      expect(state.raw.length).toBe(reth6); // and nothing new is signed while those are pending
      // The tracker sends what reth never got.
      for (const [h, raw] of afterCrash.raws) if (!state.raw.includes(raw)) { state.raw.push(raw); void h; }
      expect(afterCrash.raws.size).toBe(20); // all 20 were signed and written; the tracker finds the 6 in reth and sends the other 14
      expect(state.raw.length).toBe(20);
      expect(new Set(tos()).size).toBe(20);
      expect(nonces()).toEqual(Array.from({ length: 20 }, (_, i) => 5 + i));
      void old;
      g.release();
      await dying; // the old process is let go, so it cannot send into the next test
    });
  });
});

describe("the tracker's room", () => {
  it("sends nothing while the tracker says it is full, keeps every request, and sends when there is room", async () => {
    const f = await faucet();
    const t = ticketOf(await f.request(ALICE));
    tracker.full = "This chain is holding as many unconfirmed transactions as it can follow right now. Try again in a moment.";
    await f.process();
    expect(state.raw).toEqual([]);
    expect(f.ticket(t)).toMatchObject({ status: "queued", position: 1 });
    tracker.full = null;
    await f.process();
    expect(f.ticket(t)?.status).toBe("sent");
  });

  it("stops a batch at the point where the tracker runs out of room, and keeps the rest queued", async () => {
    const f = await faucet();
    for (let i = 1; i <= 5; i++) await f.request(addr(i), { ip: `7.7.7.${i}` });
    let asked = 0;
    tracker.admit = () => (++asked > 2 ? "full" : null);
    await f.process();
    expect(nonces()).toEqual([5, 6]);
    expect(f.queued()).toBe(3);
  });
});

describe("the human check under a flood of junk", () => {
  const captcha = { secret: "s3cret", verifyUrl: "https://check.example/verify", scriptUrl: "https://check.example/api.js", siteKey: "site-key", widgetClass: "human-check" };
  /** Says yes to "good" and no to anything else, after a wait, and counts the calls and the most in flight at once. */
  function checker(waitMs = 30) {
    const seen = { calls: 0, inFlight: 0, peak: 0 };
    const fn = (async (_url: string, init: RequestInit) => {
      seen.calls++; seen.peak = Math.max(seen.peak, ++seen.inFlight);
      await new Promise((ok) => setTimeout(ok, waitMs));
      seen.inFlight--;
      return new Response(JSON.stringify({ success: (init.body as URLSearchParams).get("response") === "good" }));
    }) as unknown as typeof fetch;
    return { seen, fn };
  }

  it("lets one client's junk fill neither the checks nor the other users' way: 200 junk requests from one client, then an honest one from another", async () => {
    const c = checker(800);
    const f = await faucet({ captcha, fetch: c.fn });
    const junk = await Promise.all(Array.from({ length: 200 }, (_, i) => f.request(addr(1000 + i), { ip: "6.6.6.6", captcha: `junk-${i}` })));
    expect(c.seen.peak).toBe(1); // one check at a time for one client
    expect(c.seen.calls).toBeLessThanOrEqual(5);
    expect(junk.filter((a) => a.status === 503)).toHaveLength(0);
    expect(junk.every((a) => a.status === 403 || a.status === 429)).toBe(true);
    const honest = await f.request(ALICE, { ip: "7.7.7.7", captcha: "good" });
    expect(honest.status).toBe(202);
  });

  it("turns a client away for a while after a few failed checks, without calling the check, and says how long", async () => {
    const c = checker(1);
    const f = await faucet({ captcha, fetch: c.fn });
    for (let i = 0; i < 5; i++) expect((await f.request(addr(i + 1), { ip: "6.6.6.6", captcha: "junk" })).status).toBe(403);
    const calls = c.seen.calls;
    const turned = await f.request(ALICE, { ip: "6.6.6.6", captcha: "good" });
    expect(turned).toMatchObject({ status: 429, body: { reason: "checks" }, headers: { "Retry-After": expect.stringMatching(/^\d+$/) } });
    expect(c.seen.calls).toBe(calls);
    clock.now += 61_000;
    expect((await f.request(ALICE, { ip: "6.6.6.6", captcha: "good" })).status).toBe(202);
  });

  it("counts a missing token as a failed check too", async () => {
    const f = await faucet({ captcha, fetch: checker(1).fn });
    for (let i = 0; i < 5; i++) expect((await f.request(addr(i + 1), { ip: "6.6.6.6" })).status).toBe(403);
    expect((await f.request(ALICE, { ip: "6.6.6.6", captcha: "good" })).status).toBe(429);
  });

  it("does not count a check that passed, or the failures of another client", async () => {
    const f = await faucet({ captcha, fetch: checker(1).fn, perIpSeconds: 1 });
    for (let i = 0; i < 4; i++) await f.request(addr(i + 1), { ip: "6.6.6.6", captcha: "junk" });
    expect((await f.request(ALICE, { ip: "7.7.7.7", captcha: "good" })).status).toBe(202);
    expect((await f.request(BOB, { ip: "6.6.6.6", captcha: "good" })).status).toBe(202);
  });
});

describe("a client's address", () => {
  it("is one client for a whole IPv6 /64, and an IPv4 address written as IPv6 is the IPv4 address", async () => {
    const f = await faucet({ perIpSeconds: 600 });
    expect((await f.request(addr(1), { ip: "2001:db8:1:2::1" })).status).toBe(202);
    expect((await f.request(addr(2), { ip: "2001:db8:1:2:ffff:ffff:ffff:ffff" })).body).toMatchObject({ reason: "ip" });
    expect((await f.request(addr(3), { ip: "2001:DB8:1:2:0:0:0:7" })).body).toMatchObject({ reason: "ip" });
    expect((await f.request(addr(4), { ip: "2001:db8:1:3::1" })).status).toBe(202);
    expect((await f.request(addr(5), { ip: "1.2.3.4" })).status).toBe(202);
    expect((await f.request(addr(6), { ip: "::ffff:1.2.3.4" })).body).toMatchObject({ reason: "ip" });
    expect((await f.request(addr(7), { ip: "::ffff:102:304" })).body).toMatchObject({ reason: "ip" });
  });
});

describe("a flood across a restart", () => {
  it("keeps every limit when the faucet is stopped and started in the middle of the flood, with requests still arriving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faucet-state-"));
    const stateFile = join(dir, "faucet.json");
    try {
      let f = await faucet({ stateFile, perIpSeconds: 600, tickMs: 5 });
      f.start();
      const results: { ip: string; to: string; status: number }[] = [];
      for (let round = 0; round < 20; round++) {
        if (round === 10) {
          f.stop();
          await f.flush();
          await fake!.close();
          f = await faucet({ stateFile, perIpSeconds: 600, tickMs: 5 });
          f.start();
        }
        await Promise.all(Array.from({ length: 50 }, async (_, k) => {
          const i = round * 50 + k, ip = `10.0.0.${(i * 7) % 50}`, to = addr(1 + (i % 300));
          results.push({ ip, to, status: (await f.request(to, { ip })).status });
        }));
        tracker.all("final");
      }
      const ok = results.filter((r) => r.status === 202);
      expect(results).toHaveLength(1000);
      expect(new Set(ok.map((r) => r.ip)).size).toBe(ok.length); // each client once
      expect(new Set(ok.map((r) => r.to)).size).toBe(ok.length); // each address once
      expect(ok).toHaveLength(50);
      f.stop();
      for (let i = 0; i < 100 && f.queued(); i++) { await f.process(); tracker.all("final"); }
      await f.flush();
      expect(new Set(tos()).size).toBe(state.raw.length);
      expect(state.raw).toHaveLength(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
