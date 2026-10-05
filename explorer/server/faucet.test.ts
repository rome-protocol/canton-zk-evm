import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ConfigError } from "./config.ts";
import { createFaucet, FAUCET_GAS, loadFaucetKey, type Faucet } from "./faucet.ts";
import { createReth } from "./reth.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const COIN = 10n ** 18n;
const KEY = generatePrivateKey();
const FAUCET = privateKeyToAccount(KEY).address.toLowerCase();
const ALICE = "0x" + "9a".repeat(20), BOB = "0x" + "5b".repeat(20), CAROL = "0x" + "c4".repeat(20);
const DAY = 86400;

/** A fake reth that holds the faucet's balance, its pending count, and the raw transactions it was sent. */
interface Net { balance: bigint; pending: number; raw: string[]; hold?: Promise<void>; refuse?: string }
const net = (over: Partial<Net> = {}): Net => ({ balance: 1_000_000n * COIN, pending: 5, raw: [], ...over });

let fake: FakeReth | undefined, clock: { now: number }, state: Net;
const logged: string[] = [];
beforeEach(() => {
  clock = { now: 1_000_000 };
  state = net();
  logged.length = 0;
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(async () => { vi.restoreAllMocks(); await fake?.close(); fake = undefined; });

async function faucet(over: { key?: Hex | null; amountWei?: bigint; minIntervalMs?: number; perAddressSeconds?: number; down?: boolean } = {}): Promise<Faucet> {
  fake = await startFakeReth({
    eth_getTransactionCount: (p: unknown[]) => "0x" + (p[1] === "pending" ? state.pending : 0).toString(16),
    eth_gasPrice: "0x3b9aca07",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_getBalance: () => "0x" + state.balance.toString(16),
    eth_sendRawTransaction: async (p: unknown[]) => {
      await state.hold;
      if (state.refuse) throw state.refuse;
      state.raw.push(p[0] as string);
      return keccak256(p[0] as Hex);
    },
  });
  return createFaucet({
    key: over.key === undefined ? KEY : over.key, chainId: 770101, amountWei: over.amountWei ?? COIN, perAddressSeconds: over.perAddressSeconds ?? DAY,
    minIntervalMs: over.minIntervalMs ?? 2000, reth: createReth(over.down ? "http://127.0.0.1:1" : fake.url, 300), now: () => clock.now,
  });
}

describe("a request", () => {
  it("sends 1 tROME as an EIP-1559 transfer of 21,000 gas, signed by the faucet, at reth's pending count", async () => {
    const f = await faucet();
    const answer = await f.request(ALICE);
    expect(answer.status).toBe(200);
    expect(state.raw).toHaveLength(1);
    const signed = state.raw[0] as Hex, tx = parseTransaction(signed);
    expect(tx).toMatchObject({ type: "eip1559", chainId: 770101, nonce: 5, to: ALICE, value: COIN, gas: 21000n });
    expect(tx.maxFeePerGas).toBeGreaterThanOrEqual(1000000007n);
    expect((await recoverTransactionAddress({ serializedTransaction: signed as never })).toLowerCase()).toBe(FAUCET);
    expect(answer.body).toEqual({ hash: keccak256(signed), to: ALICE, amount: COIN.toString() });
  });

  it("uses the amount that is set", async () => {
    const f = await faucet({ amountWei: COIN / 2n });
    await f.request(ALICE);
    expect(parseTransaction(state.raw[0] as Hex).value).toBe(COIN / 2n);
  });

  it("takes the nonce from reth each time, so a payout that vanished is replaced by the next", async () => {
    const f = await faucet();
    await f.request(ALICE);
    clock.now += 2000;
    await f.request(BOB); // the first payout was dropped by Canton: reth's pending count is still 5
    clock.now += 2000;
    state.pending = 6;
    await f.request(CAROL);
    expect(state.raw.map((r) => parseTransaction(r as Hex).nonce)).toEqual([5, 5, 6]);
  });

  it("takes an address in any letter case, and sends to its lower-case form", async () => {
    const f = await faucet();
    const mixed = "0x" + "9A".repeat(20);
    expect((await f.request(mixed)).status).toBe(200);
    expect(parseTransaction(state.raw[0] as Hex).to).toBe(ALICE);
  });
});

describe("the two limits", () => {
  it("gives one request per address per 24 hours, and says how long to wait", async () => {
    const f = await faucet();
    await f.request(ALICE);
    clock.now += 60_000;
    const again = await f.request(ALICE.toUpperCase().replace("0X", "0x"));
    expect(again.status).toBe(429);
    expect(again.headers).toEqual({ "Retry-After": String(DAY - 60) });
    expect(again.body).toMatchObject({ reason: "address" });
    expect(JSON.stringify(again.body)).toMatch(/24 hours|once a day|day/i);
    expect(state.raw).toHaveLength(1);
    clock.now += (DAY - 60) * 1000 - 1;
    expect((await f.request(ALICE)).status).toBe(429);
    clock.now += 1;
    expect((await f.request(ALICE)).status).toBe(200);
  });

  it("rounds the wait up to a whole second", async () => {
    const f = await faucet();
    await f.request(ALICE);
    clock.now += 500;
    expect((await f.request(ALICE)).headers).toEqual({ "Retry-After": String(DAY) });
  });

  it("sends one at a time: a request while a send is under way is told to wait", async () => {
    let release!: () => void;
    state.hold = new Promise<void>((ok) => { release = ok; });
    const f = await faucet();
    const first = f.request(ALICE);
    await new Promise((ok) => setTimeout(ok, 50));
    const second = await f.request(BOB);
    expect(second.status).toBe(429);
    expect(Number(second.headers?.["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(second.body).toMatchObject({ reason: "busy" });
    release();
    expect((await first).status).toBe(200);
    expect(state.raw).toHaveLength(1);
  });

  it("keeps sends at least 2 seconds apart, from the end of the last one", async () => {
    const f = await faucet();
    await f.request(ALICE);
    clock.now += 1500;
    const early = await f.request(BOB);
    expect(early.status).toBe(429);
    expect(early.headers).toEqual({ "Retry-After": "1" });
    expect(early.body).toMatchObject({ reason: "busy" });
    clock.now += 500;
    expect((await f.request(BOB)).status).toBe(200);
  });

  it("does not count a request that was turned away against the address", async () => {
    const f = await faucet();
    await f.request(ALICE);
    clock.now += 100;
    expect((await f.request(BOB)).status).toBe(429);
    clock.now += 2000;
    expect((await f.request(BOB)).status).toBe(200);
  });

  it("forgets an address once its day is over, so the memory does not grow for ever", async () => {
    const f = await faucet({ minIntervalMs: 0 });
    for (let i = 0; i < 20; i++) { await f.request("0x" + i.toString(16).padStart(40, "0")); clock.now += 1; }
    expect(f.served()).toBe(20);
    clock.now += DAY * 1000;
    await f.request(BOB);
    expect(f.served()).toBe(1);
  });
});

describe("what it refuses", () => {
  it("answers 400 to something that is not an address, and sends nothing", async () => {
    const f = await faucet();
    for (const bad of ["", "0x123", "9a".repeat(20), "0x" + "zz".repeat(20), "0x" + "9a".repeat(21), 5, null, undefined, { a: 1 }]) {
      expect((await f.request(bad)).status).toBe(400);
    }
    expect(state.raw).toHaveLength(0);
    expect(fake!.calls).toEqual([]);
  });

  it("answers 503 when the faucet is empty, and keeps the address's turn", async () => {
    state.balance = COIN; // the coin itself, with nothing left for the fee
    const f = await faucet();
    const empty = await f.request(ALICE);
    expect(empty.status).toBe(503);
    expect(JSON.stringify(empty.body)).toMatch(/empty/i);
    expect(state.raw).toHaveLength(0);
    state.balance = 100n * COIN;
    clock.now += 2000;
    expect((await f.request(ALICE)).status).toBe(200);
  });

  it("answers 503 when reth cannot be reached", async () => {
    const f = await faucet({ down: true });
    expect((await f.request(ALICE)).status).toBe(503);
    expect(state.raw).toHaveLength(0);
  });

  it("answers 503 when reth refuses the transfer, keeps the address's turn, and still spaces the next send", async () => {
    const f = await faucet();
    state.refuse = "nonce too low";
    const refused = await f.request(ALICE);
    expect(refused.status).toBe(503);
    state.refuse = undefined;
    expect((await f.request(BOB)).status).toBe(429);
    clock.now += 2000;
    expect((await f.request(ALICE)).status).toBe(200);
  });

  it("is off with no key: 503 for every request, nothing asked of reth, and an info that says so", async () => {
    const f = await faucet({ key: null });
    expect(f.on).toBe(false);
    expect(f.address).toBeNull();
    const off = await f.request(ALICE);
    expect(off.status).toBe(503);
    expect(JSON.stringify(off.body)).toMatch(/off/i);
    expect((await f.request("nonsense")).status).toBe(503);
    expect(await f.info()).toEqual({ on: false, address: null, balance: null, amount: COIN.toString(), perAddressSeconds: DAY });
    expect(fake!.calls).toEqual([]);
  });
});

describe("what it shows about itself", () => {
  it("gives its address and balance, and what it gives per request", async () => {
    const f = await faucet();
    expect(f.address).toBe(FAUCET);
    expect(await f.info()).toEqual({ on: true, address: FAUCET, balance: (1_000_000n * COIN).toString(), amount: COIN.toString(), perAddressSeconds: DAY });
  });

  it("shows no balance, rather than failing, when reth cannot be read", async () => {
    const f = await faucet({ down: true });
    expect(await f.info()).toMatchObject({ on: true, address: FAUCET, balance: null });
  });
});

describe("the key", () => {
  it("never appears in an answer or a log line, on any path", async () => {
    const f = await faucet();
    const answers = [await f.request(ALICE), await f.request(ALICE), await f.request("junk")];
    clock.now += 2000;
    state.refuse = "boom";
    answers.push(await f.request(BOB));
    state.balance = 0n;
    state.refuse = undefined;
    clock.now += 2000;
    answers.push(await f.request(CAROL));
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
