import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ConfigError } from "./config.ts";
import { createFaucet, FAUCET_GAS, loadFaucetKey, type Faucet, type FaucetOptions } from "./faucet.ts";
import { createReth } from "./reth.ts";
import type { Tracked, TxState } from "./tracker.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const COIN = 10n ** 18n;
const KEY = generatePrivateKey();
const FAUCET = privateKeyToAccount(KEY).address.toLowerCase();
const ALICE = "0x" + "9a".repeat(20), BOB = "0x" + "5b".repeat(20), CAROL = "0x" + "c4".repeat(20);
const DAY = 86400;
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");

/** A fake reth that holds the faucet's balance, its first nonce, and the raw transactions it was sent. Its pending nonce moves with each one it takes. */
interface Net { balance: bigint; base: number; raw: string[]; refuse?: string; refuseAt?: number }
const net = (over: Partial<Net> = {}): Net => ({ balance: 1_000_000n * COIN, base: 5, raw: [], ...over });

/** A tracker that the test moves by hand. */
function fakeTracker() {
  const tracked = new Map<string, Tracked>();
  const sent: { hash: string; nonce: number; from: string }[] = [];
  return {
    sent, tracked,
    track(_raw: string, hash: string, from: string, nonce: number) {
      sent.push({ hash, nonce, from });
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

type Over = Partial<Omit<FaucetOptions, "reth" | "tracker">> & { down?: boolean; tracked?: boolean };

async function faucet(over: Over = {}): Promise<Faucet> {
  fake = await startFakeReth({
    eth_getTransactionCount: (p: unknown[]) => "0x" + (p[1] === "pending" ? state.base + state.raw.length : state.base).toString(16),
    eth_gasPrice: "0x3b9aca07",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_getBalance: () => "0x" + state.balance.toString(16),
    eth_sendRawTransaction: (p: unknown[]) => {
      if (state.refuse && (state.refuseAt === undefined || state.refuseAt === state.raw.length)) { const r = state.refuse; if (state.refuseAt !== undefined) state.refuse = undefined; throw r; }
      state.raw.push(p[0] as string);
      return keccak256(p[0] as Hex);
    },
  });
  const { down, tracked, ...rest } = over;
  return createFaucet({
    key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: DAY, perIpSeconds: 600, maxPerHour: 100000, batch: 100, queueMax: 5000, stateFile: null, captcha: null,
    reth: createReth(down ? "http://127.0.0.1:1" : fake.url, 300), tracker: tracked === false ? undefined : tracker, now: () => clock.now, ...rest,
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

  it("fails, with the tracker's reason, when the transfer was replaced or dropped, and the address may ask again", async () => {
    const f = await faucet();
    const t = ticketOf(await f.request(ALICE, { ip: "2.2.2.2" }));
    expect((await f.request(ALICE, { ip: "3.3.3.3" })).status).toBe(429);
    await f.process();
    tracker.move(tracker.sent[0]!.hash, "dropped", null, "It was sent to the chain 10 times and went missing each time.");
    expect(f.ticket(t)).toMatchObject({ status: "failed", reason: "It was sent to the chain 10 times and went missing each time." });
    expect((await f.request(ALICE, { ip: "2.2.2.2" })).status).toBe(202);
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
