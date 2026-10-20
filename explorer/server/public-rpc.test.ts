import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { clientKey, createPublicRpc, MAX_BATCH, PUBLIC_METHODS, type PublicRpc } from "./public-rpc.ts";
import { createHttpServer } from "./http.ts";
import { createTracker } from "./tracker.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const CHAIN = 770101, FINAL = 5, HEAD = 6;
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const hx = (n: number) => "0x" + n.toString(16);
const hashOf = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const block = (n: number) => ({ number: hx(n), hash: hashOf(n), transactions: [] });
const txIn = (h: string, n: number | null) => ({ hash: h, blockNumber: n === null ? null : hx(n), blockHash: n === null ? null : hashOf(n), nonce: "0x1" });
const receiptIn = (h: string, n: number) => ({ transactionHash: h, blockNumber: hx(n), blockHash: hashOf(n), status: "0x1" });
const TX_FINAL = "0x" + "f1".repeat(32), TX_PROVING = "0x" + "f2".repeat(32), TX_POOL = "0x" + "f3".repeat(32);

let reth: FakeReth | undefined, server: Server | undefined;
afterEach(async () => { await reth?.close(); await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())); reth = server = undefined; vi.restoreAllMocks(); });

/** What reth was asked, per method, so a test can see what the public RPC forwarded. */
type Seen = Record<string, unknown[][]>;

interface Setup { rpc: PublicRpc; seen: Seen; tracked: unknown[][]; clock: { now: number }; call: (method: string, ...params: unknown[]) => Promise<{ result?: unknown; error?: { code: number; message: string } }> }

async function boot(over: Record<string, unknown> = {}, opts: { rate?: number; ttl?: number; timeoutMs?: number; maxInFlight?: number; admit?: () => string | null; trackThrows?: boolean; order?: string[]; tracker?: { admit: (raw: string, hash: string, from: string) => string | null; track: (...a: never[]) => unknown } } = {}): Promise<Setup> {
  const seen: Seen = {};
  const rec = (m: string, f: unknown) => (p: unknown[]) => { (seen[m] ??= []).push(p); opts.order?.push(m); return typeof f === "function" ? (f as (p: unknown[]) => unknown)(p) : f; };
  const handlers: Record<string, unknown> = {
    eth_chainId: hx(CHAIN),
    net_version: String(CHAIN),
    eth_getBlockByNumber: (p: unknown[]) => (p[0] === "finalized" ? block(FINAL) : p[0] === "latest" ? block(HEAD) : Number(p[0]) <= HEAD ? block(Number(p[0])) : null),
    eth_getBlockByHash: (p: unknown[]) => { const n = [0, 1, 2, 3, 4, 5, 6].find((i) => hashOf(i) === p[0]); return n === undefined ? null : block(n); },
    eth_getTransactionByHash: (p: unknown[]) => (p[0] === TX_FINAL ? txIn(TX_FINAL, 4) : p[0] === TX_PROVING ? txIn(TX_PROVING, HEAD) : p[0] === TX_POOL ? txIn(TX_POOL, null) : null),
    eth_getTransactionReceipt: (p: unknown[]) => (p[0] === TX_FINAL ? receiptIn(TX_FINAL, 4) : p[0] === TX_PROVING ? receiptIn(TX_PROVING, HEAD) : null),
    eth_getBalance: "0x64",
    eth_getCode: "0x",
    eth_getStorageAt: "0x" + "0".repeat(64),
    eth_getTransactionCount: "0x3", // the default signed() transaction has nonce 3: the next one the chain expects
    eth_call: "0x",
    eth_estimateGas: "0x5208",
    eth_gasPrice: "0x1",
    eth_feeHistory: { oldestBlock: "0x1" },
    eth_getLogs: [{ logIndex: "0x0" }],
    eth_sendRawTransaction: (p: unknown[]) => keccak256(p[0] as Hex),
    eth_syncing: false,
    web3_clientVersion: "reth/test",
    ...over,
  };
  reth = await startFakeReth(Object.fromEntries(Object.entries(handlers).map(([m, f]) => [m, rec(m, f)])));
  const tracked: unknown[][] = [];
  const clock = { now: 1_000_000 };
  const rpc = createPublicRpc({ rethUrl: reth.url, timeoutMs: opts.timeoutMs ?? 1000, chainId: CHAIN, ratePerMinute: opts.rate ?? 100000, maxInFlight: opts.maxInFlight,
    tracker: opts.tracker ?? { admit: () => opts.admit?.() ?? null, track: (...a) => { if (opts.trackThrows) throw new Error("disk"); tracked.push(a); } }, now: () => clock.now, finalizedTtlMs: opts.ttl ?? 0 });
  let n = 0;
  const call = async (method: string, ...params: unknown[]) => {
    const answer = await rpc(JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }), "1.2.3.4");
    expect(answer.status).toBe(200);
    return answer.body as { result?: unknown; error?: { code: number; message: string } };
  };
  return { rpc, seen, tracked, clock, call };
}

async function signed(over: Record<string, unknown> = {}): Promise<Hex> {
  return ACCOUNT.signTransaction({ type: "eip1559", chainId: CHAIN, nonce: 3, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, ...over } as never);
}

describe("the methods", () => {
  it("answers the twenty methods on the list and says -32601 to anything else", async () => {
    expect(PUBLIC_METHODS.size).toBe(20);
    const { call, seen } = await boot();
    for (const m of ["eth_getBlockReceipts", "debug_traceTransaction", "txpool_content", "eth_accounts", "eth_sign", "admin_peers", "eth_subscribe"]) {
      expect((await call(m)).error?.code).toBe(-32601);
    }
    expect(Object.keys(seen)).toEqual([]);
    expect((await call("eth_chainId")).result).toBe(hx(CHAIN));
    expect((await call("net_version")).result).toBe(String(CHAIN));
  });

  it("answers a body that is not JSON, and one that is not a call, with the standard errors", async () => {
    const { rpc } = await boot();
    expect(((await rpc("{nope", "ip")).body as { error: { code: number } }).error.code).toBe(-32700);
    expect(((await rpc("5", "ip")).body as { error: { code: number } }).error.code).toBe(-32600);
    expect(((await rpc('{"method":"eth_chainId","params":5}', "ip")).body as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("says it cannot reach the chain when reth is down, and does not hang", async () => {
    const { call } = await boot();
    await reth!.close();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("eth_chainId")).error).toMatchObject({ code: -32603 });
  });
});

describe("the final-only view", () => {
  it("answers the finalized number for eth_blockNumber, not reth's head", async () => {
    const { call } = await boot();
    expect((await call("eth_blockNumber")).result).toBe(hx(FINAL));
  });

  it("rewrites latest, safe, pending and finalized to the finalized number in a state read", async () => {
    const { call, seen } = await boot();
    for (const tag of ["latest", "safe", "pending", "finalized"]) await call("eth_getBalance", "0x" + "11".repeat(20), tag);
    await call("eth_getBalance", "0x" + "11".repeat(20));
    expect(seen.eth_getBalance!.map((p) => p[1])).toEqual([hx(FINAL), hx(FINAL), hx(FINAL), hx(FINAL), hx(FINAL)]);
    await call("eth_getCode", "0x" + "11".repeat(20), "latest");
    await call("eth_getStorageAt", "0x" + "11".repeat(20), "0x0", "latest");
    await call("eth_call", { to: "0x" + "11".repeat(20) }, "latest");
    await call("eth_estimateGas", { to: "0x" + "11".repeat(20) });
    expect(seen.eth_getCode![0]![1]).toBe(hx(FINAL));
    expect(seen.eth_getStorageAt![0]![2]).toBe(hx(FINAL));
    expect(seen.eth_call![0]![1]).toBe(hx(FINAL));
    expect(seen.eth_estimateGas![0]![1]).toBe(hx(FINAL));
  });

  it("keeps a number at or below the finalized one, and the earliest block", async () => {
    const { call, seen } = await boot();
    await call("eth_getBalance", "0x" + "11".repeat(20), "0x3");
    await call("eth_getBalance", "0x" + "11".repeat(20), "earliest");
    await call("eth_getBalance", "0x" + "11".repeat(20), hx(FINAL));
    expect(seen.eth_getBalance!.map((p) => p[1])).toEqual(["0x3", "earliest", hx(FINAL)]);
  });

  it("gives an error for a state read above the finalized block, and does not ask reth", async () => {
    const { call, seen } = await boot();
    for (const m of ["eth_getBalance", "eth_getCode", "eth_getTransactionCount"]) {
      expect((await call(m, "0x" + "11".repeat(20), hx(HEAD))).error?.message).toMatch(/not final/);
    }
    expect((await call("eth_call", { to: "0x" + "11".repeat(20) }, hx(HEAD))).error?.code).toBe(-32000);
    expect(seen.eth_getBalance).toBeUndefined();
  });

  it("refuses a block argument that is nonsense", async () => {
    const { call } = await boot();
    expect((await call("eth_getBalance", "0x" + "11".repeat(20), "yesterday")).error?.code).toBe(-32602);
    expect((await call("eth_getBlockByNumber", 7, false)).error?.code).toBe(-32602);
  });

  it("reads a state call by block hash only when that block is final", async () => {
    const { call, seen } = await boot();
    expect((await call("eth_getBalance", "0x" + "11".repeat(20), { blockHash: hashOf(HEAD) })).error?.message).toMatch(/not final/);
    expect((await call("eth_getBalance", "0x" + "11".repeat(20), { blockHash: hashOf(2) })).result).toBe("0x64");
    expect(seen.eth_getBalance).toHaveLength(1);
  });

  it("keeps the pool's count for a wallet that asks for pending, and the finalized count for latest", async () => {
    const { call, seen } = await boot();
    await call("eth_getTransactionCount", "0x" + "11".repeat(20), "pending");
    await call("eth_getTransactionCount", "0x" + "11".repeat(20), "latest");
    expect(seen.eth_getTransactionCount!.map((p) => p[1])).toEqual(["pending", hx(FINAL)]);
  });

  it("answers a block read above the finalized block with null, and a block read at latest with the finalized block", async () => {
    const { call, seen } = await boot();
    expect((await call("eth_getBlockByNumber", hx(HEAD), false)).result).toBeNull();
    expect((await call("eth_getBlockByNumber", "latest", false)).result).toMatchObject({ number: hx(FINAL) });
    expect((await call("eth_getBlockByNumber", "pending", true)).result).toMatchObject({ number: hx(FINAL) });
    expect((await call("eth_getBlockByNumber", hx(2), false)).result).toMatchObject({ number: hx(2) });
    expect(seen.eth_getBlockByNumber!.filter((p) => p[0] !== "finalized").map((p) => p[0])).toEqual([hx(FINAL), hx(FINAL), hx(2)]);
  });

  it("answers a block by hash with null when the block is above the finalized one", async () => {
    const { call } = await boot();
    expect((await call("eth_getBlockByHash", hashOf(HEAD), false)).result).toBeNull();
    expect((await call("eth_getBlockByHash", hashOf(FINAL), false)).result).toMatchObject({ number: hx(FINAL) });
    expect((await call("eth_getBlockByHash", "0x" + "ee".repeat(32), false)).result).toBeNull();
  });

  it("answers a receipt in a block that is not final with null, and one in a final block as it is", async () => {
    const { call } = await boot();
    expect((await call("eth_getTransactionReceipt", TX_PROVING)).result).toBeNull();
    expect((await call("eth_getTransactionReceipt", TX_FINAL)).result).toMatchObject({ blockNumber: hx(4) });
    expect((await call("eth_getTransactionReceipt", TX_POOL)).result).toBeNull();
  });

  it("answers a transaction in a non-final block as a pending one (no block yet), one in the pool as pending, and a final one as it is", async () => {
    const { call } = await boot();
    expect((await call("eth_getTransactionByHash", TX_PROVING)).result).toMatchObject({ hash: TX_PROVING, blockHash: null, blockNumber: null, transactionIndex: null });
    expect((await call("eth_getTransactionByHash", TX_POOL)).result).toMatchObject({ hash: TX_POOL, blockNumber: null });
    expect((await call("eth_getTransactionByHash", TX_FINAL)).result).toMatchObject({ blockNumber: hx(4) });
  });

  it("clamps the logs' last block to the finalized one, and gives none when the first block is above it", async () => {
    const { call, seen } = await boot();
    await call("eth_getLogs", { fromBlock: "0x1", toBlock: "latest" });
    await call("eth_getLogs", { fromBlock: "0x1", toBlock: hx(HEAD) });
    await call("eth_getLogs", {});
    expect(seen.eth_getLogs!.map((p) => (p[0] as { fromBlock: string; toBlock: string }).toBlock)).toEqual([hx(FINAL), hx(FINAL), hx(FINAL)]);
    expect((seen.eth_getLogs![2]![0] as { fromBlock: string }).fromBlock).toBe(hx(FINAL));
    expect((await call("eth_getLogs", { fromBlock: hx(HEAD) })).result).toEqual([]);
    expect(seen.eth_getLogs).toHaveLength(3);
  });

  it("gives no logs for a block hash that is not final, and the logs of one that is", async () => {
    const { call } = await boot();
    expect((await call("eth_getLogs", { blockHash: hashOf(HEAD) })).result).toEqual([]);
    expect((await call("eth_getLogs", { blockHash: hashOf(3) })).result).toEqual([{ logIndex: "0x0" }]);
  });

  it("clamps the fee history's newest block", async () => {
    const { call, seen } = await boot();
    await call("eth_feeHistory", "0x4", "latest", [50]);
    await call("eth_feeHistory", "0x4", hx(HEAD), [50]);
    expect(seen.eth_feeHistory!.map((p) => p[1])).toEqual([hx(FINAL), hx(FINAL)]);
  });

  it("asks reth for the finalized number once for a whole batch", async () => {
    const { rpc, seen } = await boot();
    const answer = await rpc(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }, { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0x" + "11".repeat(20), "latest"] },
    ]), "ip");
    expect(answer.body).toEqual([{ jsonrpc: "2.0", id: 1, result: hx(FINAL) }, { jsonrpc: "2.0", id: 2, result: "0x64" }]);
    expect(seen.eth_getBlockByNumber).toHaveLength(1);
  });

  it("reuses the finalized number for the length of its lifetime and then asks again", async () => {
    const { call, seen, clock } = await boot({}, { ttl: 500 });
    await call("eth_blockNumber");
    await call("eth_blockNumber");
    expect(seen.eth_getBlockByNumber).toHaveLength(1);
    clock.now += 600;
    await call("eth_blockNumber");
    expect(seen.eth_getBlockByNumber).toHaveLength(2);
  });
});

describe("eth_sendRawTransaction", () => {
  it("hands reth the transaction, returns reth's hash, and gives the tracker the bytes, hash, sender and nonce", async () => {
    const { call, tracked, seen } = await boot();
    const raw = await signed();
    const answer = await call("eth_sendRawTransaction", raw);
    expect(answer.result).toBe(keccak256(raw));
    expect(seen.eth_sendRawTransaction).toEqual([[raw]]);
    expect(tracked).toEqual([[raw, keccak256(raw), ACCOUNT.address.toLowerCase(), 3]]);
  });

  it("refuses a transaction for another chain, and does not call reth or the tracker", async () => {
    const { call, tracked, seen } = await boot();
    const answer = await call("eth_sendRawTransaction", await signed({ chainId: 1 }));
    expect(answer.error).toMatchObject({ code: -32000 });
    expect(answer.error!.message).toMatch(/chain 1\b.*770101/);
    expect(seen.eth_sendRawTransaction).toBeUndefined();
    expect(tracked).toEqual([]);
  });

  it("refuses a transaction that is not tied to any chain", async () => {
    const { call, seen } = await boot();
    const legacy = await ACCOUNT.signTransaction({ type: "legacy", nonce: 0, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, gasPrice: 10n ** 9n } as never);
    expect((await call("eth_sendRawTransaction", legacy)).error?.message).toMatch(/not tied to a chain/);
    expect(seen.eth_sendRawTransaction).toBeUndefined();
  });

  it("refuses bytes that are not a transaction", async () => {
    const { call, seen } = await boot();
    expect((await call("eth_sendRawTransaction", "0x1234")).error?.code).toBe(-32602);
    expect((await call("eth_sendRawTransaction", "nonsense")).error?.code).toBe(-32602);
    expect((await call("eth_sendRawTransaction")).error?.code).toBe(-32602);
    expect(seen.eth_sendRawTransaction).toBeUndefined();
  });

  it("returns reth's refusal as an error, with no hash, and tracks nothing", async () => {
    const { call, tracked } = await boot({ eth_sendRawTransaction: () => { throw "nonce too low"; } });
    const answer = await call("eth_sendRawTransaction", await signed());
    expect(answer.result).toBeUndefined();
    expect(answer.error).toMatchObject({ code: -32000, message: expect.stringContaining("nonce too low") });
    expect(tracked).toEqual([]);
  });
});

describe("a send that pays less than the base fee", () => {
  const withBase = (base: string | undefined) => ({ eth_getBlockByNumber: (p: unknown[]) => (p[0] === "finalized" ? block(FINAL) : p[0] === "latest" ? { ...block(HEAD), ...(base === undefined ? {} : { baseFeePerGas: base }) } : Number(p[0]) <= HEAD ? block(Number(p[0])) : null) });

  it("is refused before the tracker or reth see it, with the reason", async () => {
    const { call, seen, tracked } = await boot(withBase("0x3b9aca00")); // base fee 1 gwei
    const answer = await call("eth_sendRawTransaction", await signed({ maxFeePerGas: 10n ** 9n - 1n }));
    expect(answer.error).toMatchObject({ code: -32000, message: expect.stringContaining("max fee per gas is below the current base fee") });
    expect(seen.eth_sendRawTransaction).toBeUndefined();
    expect(tracked).toEqual([]);
  });

  it("is refused for a legacy transaction by its gas price", async () => {
    const { call, seen } = await boot(withBase("0x3b9aca00"));
    const legacy = await ACCOUNT.signTransaction({ type: "legacy", chainId: CHAIN, nonce: 3, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, gasPrice: 5n } as never);
    expect((await call("eth_sendRawTransaction", legacy)).error?.message).toMatch(/below the current base fee/);
    expect(seen.eth_sendRawTransaction).toBeUndefined();
  });

  it("goes through when it pays exactly the base fee or more", async () => {
    const { call, tracked } = await boot(withBase("0x3b9aca00"));
    const raw = await signed({ maxFeePerGas: 10n ** 9n });
    expect((await call("eth_sendRawTransaction", raw)).result).toBe(keccak256(raw));
    expect(tracked).toHaveLength(1);
  });

  it("goes through when reth gives no base fee, and when it cannot be read: reth's own answer decides", async () => {
    const none = await boot(withBase(undefined));
    expect((await none.call("eth_sendRawTransaction", await signed({ maxFeePerGas: 1n }))).result).toBeDefined();
    await reth!.close();
    const broken = await boot({ eth_getBlockByNumber: (p: unknown[]) => { if (p[0] === "latest") throw "busy"; return p[0] === "finalized" ? block(FINAL) : null; } });
    expect((await broken.call("eth_sendRawTransaction", await signed({ maxFeePerGas: 1n }))).result).toBeDefined();
  });

  it("does not let dust-funded senders with a low fee fill the tracker, and an honest send still goes through", async () => {
    const tracker = createTracker({ reth: {} as never, index: {} as never, max: 5, maxPerSender: 2 });
    const { call, seen } = await boot({ ...withBase("0x3b9aca00"), eth_getTransactionCount: "0x0" }, { tracker });
    for (let i = 0; i < 50; i++) {
      const dust = privateKeyToAccount(generatePrivateKey());
      const raw = await dust.signTransaction({ type: "eip1559", chainId: CHAIN, nonce: 0, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 1n } as never);
      expect((await call("eth_sendRawTransaction", raw)).error?.message).toMatch(/below the current base fee/);
    }
    expect(tracker.size()).toBe(0);
    expect(seen.eth_sendRawTransaction).toBeUndefined();
    const honest = await signed({ nonce: 0 });
    expect((await call("eth_sendRawTransaction", honest)).result).toBe(keccak256(honest));
    expect(tracker.size()).toBe(1);
  });

  it("reads the base fee once for a burst, for as long as the finalized number is reused", async () => {
    const { call, seen, clock } = await boot(withBase("0x1"), { ttl: 500 });
    await call("eth_sendRawTransaction", await signed());
    await call("eth_sendRawTransaction", await signed());
    expect(seen.eth_getBlockByNumber!.filter((p) => p[0] === "latest")).toHaveLength(1);
    clock.now += 600;
    await call("eth_sendRawTransaction", await signed());
    expect(seen.eth_getBlockByNumber!.filter((p) => p[0] === "latest")).toHaveLength(2);
  });
});

describe("a send ahead of the sender's next nonce", () => {
  it("refuses a nonce gap before the tracker or reth see it, and says what to do", async () => {
    const { call, seen, tracked } = await boot({ eth_getTransactionCount: "0x1" });
    const answer = await call("eth_sendRawTransaction", await signed()); // nonce 3, the chain expects 1
    expect(answer.error).toMatchObject({ code: -32000, message: expect.stringMatching(/nonce gap: send the missing transactions first.*nonce 3.*expects 1/) });
    expect(seen.eth_sendRawTransaction).toBeUndefined();
    expect(tracked).toEqual([]);
    expect(seen.eth_getTransactionCount).toEqual([[ACCOUNT.address.toLowerCase(), "pending"]]); // the pool's count, not the finalized one
  });

  it("takes the next nonce, and passes a nonce that is already used to reth, which says what is wrong", async () => {
    const next = await boot({ eth_getTransactionCount: "0x3" });
    expect((await next.call("eth_sendRawTransaction", await signed())).result).toBeDefined();
    await reth!.close();
    const used = await boot({ eth_getTransactionCount: "0x9", eth_sendRawTransaction: () => { throw "nonce too low"; } });
    expect((await used.call("eth_sendRawTransaction", await signed())).error?.message).toContain("nonce too low");
  });

  it("returns reth's error when it cannot tell the sender's count", async () => {
    const { call, seen } = await boot({ eth_getTransactionCount: () => { throw "pool busy"; } });
    expect((await call("eth_sendRawTransaction", await signed())).error?.message).toContain("pool busy");
    expect(seen.eth_sendRawTransaction).toBeUndefined();
  });

  it("does not let one sender with gapped transactions from many addresses fill the list and block everyone else", async () => {
    const tracker = createTracker({ reth: {} as never, index: {} as never, max: 3, maxPerSender: 2 });
    const { call } = await boot({ eth_getTransactionCount: "0x3" }, { tracker });
    for (let i = 0; i < 6; i++) {
      const griefer = privateKeyToAccount(generatePrivateKey());
      for (const nonce of [4, 5, 9]) {
        const raw = await griefer.signTransaction({ type: "eip1559", chainId: CHAIN, nonce, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n } as never);
        expect((await call("eth_sendRawTransaction", raw)).error?.message).toMatch(/nonce gap/);
      }
    }
    expect(tracker.size()).toBe(0);
    const raw = await signed();
    expect((await call("eth_sendRawTransaction", raw)).result).toBe(keccak256(raw)); // an honest send still goes through
    expect(tracker.size()).toBe(1);
  });

  it("says plainly that the list is full when it really is, with the limit", async () => {
    const tracker = createTracker({ reth: {} as never, index: {} as never, max: 1, maxPerSender: 2 });
    const { call } = await boot({ eth_getTransactionCount: "0x3" }, { tracker });
    expect((await call("eth_sendRawTransaction", await signed())).result).toBeDefined();
    const other = privateKeyToAccount(generatePrivateKey());
    const raw = await other.signTransaction({ type: "eip1559", chainId: CHAIN, nonce: 3, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n } as never);
    expect((await call("eth_sendRawTransaction", raw)).error).toMatchObject({ code: -32005, message: expect.stringMatching(/following as many unconfirmed transactions as it can follow.*limit is 1 transactions/) });
  });
});

describe("sends from one sender that arrive together", () => {
  /** A reth whose pending count follows its pool, as the real one's does. */
  async function pooled(start = 3) {
    let pool = start;
    const setup = await boot({
      eth_getTransactionCount: () => hx(pool),
      eth_sendRawTransaction: (p: unknown[]) => { pool++; return keccak256(p[0] as Hex); },
    });
    return { ...setup, pool: () => pool };
  }
  const raws = (...nonces: number[]) => Promise.all(nonces.map((nonce) => signed({ nonce })));

  it("takes the next nonces of a JSON-RPC batch, in order", async () => {
    const { rpc, tracked, pool } = await pooled();
    const [a, b, c] = (await raws(3, 4, 5)) as [Hex, Hex, Hex];
    const body = JSON.stringify([a, b, c].map((raw, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_sendRawTransaction", params: [raw] })));
    const answer = (await rpc(body, "1.2.3.4")).body as { result?: string; error?: unknown }[];
    expect(answer.map((r) => r.result)).toEqual([a, b, c].map((raw) => keccak256(raw)));
    expect(pool()).toBe(6);
    expect(tracked.length).toBe(3);
  });

  it("takes the next nonces of two overlapping requests", async () => {
    const { call, pool } = await pooled(5);
    const [a, b] = (await raws(5, 6)) as [Hex, Hex];
    const answers = await Promise.all([call("eth_sendRawTransaction", a), call("eth_sendRawTransaction", b)]);
    expect(answers.map((r) => r.result)).toEqual([keccak256(a), keccak256(b)]);
    expect(pool()).toBe(7);
  });

  it("still refuses a real gap inside a batch, and goes on with the sends after it", async () => {
    const { rpc, pool } = await pooled();
    const [a, gap, ok] = (await raws(3, 6, 4)) as [Hex, Hex, Hex];
    const body = JSON.stringify([a, gap, ok].map((raw, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_sendRawTransaction", params: [raw] })));
    const answer = (await rpc(body, "1.2.3.4")).body as { result?: string; error?: { message: string } }[];
    expect(answer[0]!.result).toBe(keccak256(a));
    expect(answer[1]!.error?.message).toMatch(/nonce gap.*nonce 6.*expects 4/);
    expect(answer[2]!.result).toBe(keccak256(ok));
    expect(pool()).toBe(5);
  });

  it("does not make one sender wait for another's slow send", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const slow = other.address.toLowerCase();
    let release: () => void = () => {};
    const gate = new Promise<void>((ok) => { release = ok; });
    const { call } = await boot({
      eth_getTransactionCount: (p: unknown[]) => (String(p[0]).toLowerCase() === slow ? "0x0" : "0x3"),
      eth_sendRawTransaction: async (p: unknown[]) => { const t = await import("viem").then((v) => v.parseTransaction(p[0] as Hex)); if (t.nonce === 0) await gate; return keccak256(p[0] as Hex); },
    });
    const slowRaw = await other.signTransaction({ type: "eip1559", chainId: CHAIN, nonce: 0, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n } as never);
    const first = call("eth_sendRawTransaction", slowRaw);
    const raw = await signed();
    expect((await call("eth_sendRawTransaction", raw)).result).toBe(keccak256(raw));
    release();
    expect((await first).result).toBe(keccak256(slowRaw));
  });

  it("goes on with the next send after one that failed", async () => {
    let n = 0;
    const { rpc } = await boot({ eth_sendRawTransaction: (p: unknown[]) => { if (n++ === 0) throw "insufficient funds"; return keccak256(p[0] as Hex); } });
    const [a, b] = (await raws(3, 3)) as [Hex, Hex];
    const body = JSON.stringify([a, b].map((raw, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_sendRawTransaction", params: [raw] })));
    const answer = (await rpc(body, "1.2.3.4")).body as { result?: string; error?: { message: string } }[];
    expect(answer[0]!.error?.message).toContain("insufficient funds");
    expect(answer[1]!.result).toBeDefined();
  });
});

describe("a send that goes wrong around reth", () => {
  it("refuses a send before reth sees it when the tracker cannot follow it, and tracks nothing", async () => {
    const { call, seen, tracked } = await boot({}, { admit: () => "This sender has 64 transactions waiting to be confirmed." });
    const answer = await call("eth_sendRawTransaction", await signed());
    expect(answer.error).toMatchObject({ code: -32005, message: expect.stringContaining("waiting to be confirmed") });
    expect(seen.eth_sendRawTransaction).toBeUndefined();
    expect(tracked).toEqual([]);
  });

  it("returns reth's hash even when the tracker throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = await boot({}, { trackThrows: true });
    const raw = await signed();
    expect((await call("eth_sendRawTransaction", raw)).result).toBe(keccak256(raw));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cannot follow"));
  });

  it("tracks a transaction that reth took although its answer did not come in time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call, tracked } = await boot({ eth_sendRawTransaction: () => new Promise((ok) => setTimeout(ok, 400)) }, { timeoutMs: 100 });
    const raw = await signed();
    expect((await call("eth_sendRawTransaction", raw)).error?.code).toBe(-32603);
    expect(tracked).toEqual([[raw, keccak256(raw), ACCOUNT.address.toLowerCase(), 3]]);
  });

  it("tracks a transaction that reth says it knows already, and still returns reth's error", async () => {
    const { call, tracked } = await boot({ eth_sendRawTransaction: () => { throw "already known"; } });
    const raw = await signed();
    expect((await call("eth_sendRawTransaction", raw)).error).toMatchObject({ message: expect.stringContaining("already known") });
    expect(tracked).toHaveLength(1);
  });

  it("answers a JSON-RPC error, not a thrown one, when something unexpected breaks inside a call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = await boot({}, { admit: () => { throw new Error("boom"); } });
    expect((await call("eth_sendRawTransaction", await signed())).error).toMatchObject({ code: -32603 });
  });
});

describe("reading the finalized number before the block", () => {
  it("asks for the finalized number before it reads a block, a transaction or a receipt", async () => {
    const order: string[] = [];
    const { call } = await boot({}, { order });
    for (const [m, a] of [["eth_getBlockByHash", hashOf(4)], ["eth_getTransactionByHash", TX_FINAL], ["eth_getTransactionReceipt", TX_FINAL]] as const) {
      order.length = 0;
      await call(m, a);
      expect(order[0]).toBe("eth_getBlockByNumber"); // the finalized number
      expect(order.indexOf(m)).toBeGreaterThan(0);
    }
  });

  it("does not show a block, transaction or receipt whose block is not the one at that height", async () => {
    // reth serves a block at height 4 whose hash is not the block it has at height 4 now.
    const stale = "0x" + "ee".repeat(32);
    const { call } = await boot({
      eth_getBlockByHash: (p: unknown[]) => (p[0] === stale ? { number: hx(4), hash: stale, transactions: [] } : null),
      eth_getTransactionByHash: () => ({ hash: TX_FINAL, blockNumber: hx(4), blockHash: stale }),
      eth_getTransactionReceipt: () => ({ transactionHash: TX_FINAL, blockNumber: hx(4), blockHash: stale }),
    });
    expect((await call("eth_getBlockByHash", stale)).result).toBeNull();
    expect((await call("eth_getTransactionByHash", TX_FINAL)).result).toBeNull();
    expect((await call("eth_getTransactionReceipt", TX_FINAL)).result).toBeNull();
    expect((await call("eth_getBalance", "0x" + "11".repeat(20), { blockHash: stale })).error?.message).toMatch(/not final/);
    expect((await call("eth_getLogs", { blockHash: stale })).result).toEqual([]);
  });

  it("reads a block hash given as a plain string in a state call, as reth allows", async () => {
    const { call, seen } = await boot();
    expect((await call("eth_getBalance", "0x" + "11".repeat(20), hashOf(4))).result).toBe("0x64");
    expect(seen.eth_getBalance![0]![1]).toBe(hashOf(4));
    expect((await call("eth_getBalance", "0x" + "11".repeat(20), hashOf(6))).error?.message).toMatch(/not final/); // above the finalized block
    expect((await call("eth_getBlockByNumber", hashOf(4), false)).error?.code).toBe(-32602); // a number is asked for here
  });
});

describe("the limits", () => {
  it("gives every address in one IPv6 /64 the same bucket, and a different /64 its own", () => {
    expect(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(clientKey("2001:0db8:0001:0002::1"));
    expect(clientKey("2001:db8:1:2::1")).not.toBe(clientKey("2001:db8:1:3::1"));
    expect(clientKey("::ffff:10.0.0.7")).toBe("10.0.0.7");
    expect(clientKey("10.0.0.7")).toBe("10.0.0.7");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
  });

  it("does not give a fresh bucket to each address of one /64", async () => {
    const { rpc } = await boot({}, { rate: 2 });
    const one = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    expect((await rpc(one, "2001:db8:1:2::1")).status).toBe(200);
    expect((await rpc(one, "2001:db8:1:2::2")).status).toBe(200);
    expect((await rpc(one, "2001:db8:1:2::3")).status).toBe(429);
  });

  it("holds all clients together to a number of requests at one time, and tells the rest to come back", async () => {
    let release!: () => void;
    const held = new Promise<void>((ok) => { release = ok; });
    const { rpc } = await boot({ eth_chainId: () => held.then(() => hx(CHAIN)) }, { maxInFlight: 2 });
    const one = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    const first = [rpc(one, "a"), rpc(one, "b")];
    await new Promise((ok) => setTimeout(ok, 50));
    const busy = await rpc(one, "c");
    expect(busy.status).toBe(503);
    expect(busy.headers?.["retry-after"]).toBe("1");
    release();
    expect((await Promise.all(first)).map((a) => a.status)).toEqual([200, 200]);
    expect((await rpc(one, "c")).status).toBe(200); // room again
  });

  it("refuses a batch of more than 20 calls, and takes one of exactly 20", async () => {
    const { rpc } = await boot();
    const calls = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId" })));
    expect(((await rpc(calls(MAX_BATCH + 1), "ip")).body as { error: { code: number } }).error.code).toBe(-32600);
    expect((await rpc(calls(MAX_BATCH), "ip")).body).toHaveLength(MAX_BATCH);
    expect(((await rpc("[]", "ip")).body as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("limits each client address with a token bucket: a burst, then a steady rate, counting each call of a batch", async () => {
    const { rpc, clock } = await boot({}, { rate: 60 });
    const one = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    for (let i = 0; i < 60; i++) expect((await rpc(one, "a")).status).toBe(200);
    const refused = await rpc(one, "a");
    expect(refused.status).toBe(429);
    expect(refused.headers?.["retry-after"]).toBe("1");
    expect((refused.body as { error: { code: number } }).error.code).toBe(-32005);
    expect((await rpc(one, "b")).status).toBe(200); // another client has its own bucket
    clock.now += 2000; // 60 a minute is one a second
    expect((await rpc(one, "a")).status).toBe(200);
    expect((await rpc(one, "a")).status).toBe(200);
    expect((await rpc(one, "a")).status).toBe(429);
    clock.now += 60000;
    const batch = JSON.stringify(Array.from({ length: 20 }, () => ({ jsonrpc: "2.0", id: 1, method: "eth_chainId" })));
    for (let i = 0; i < 3; i++) expect((await rpc(batch, "a")).status).toBe(200);
    expect((await rpc(batch, "a")).status).toBe(429);
  });

  it("keeps the bucket of the client in hand when the table is swept, so a new client is not let through for free", async () => {
    const { rpc } = await boot({}, { rate: 2 });
    for (let i = 0; i < 10000; i++) await rpc("x", `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`); // fills the table
    expect((await rpc("x", "9.9.9.9")).status).toBe(200);
    expect((await rpc("x", "9.9.9.9")).status).toBe(200);
    expect((await rpc("x", "9.9.9.9")).status).toBe(429);
  });

  it("charges a body that is not JSON too", async () => {
    const { rpc } = await boot({}, { rate: 2 });
    expect((await rpc("x", "a")).status).toBe(200);
    expect((await rpc("x", "a")).status).toBe(200);
    expect((await rpc("x", "a")).status).toBe(429);
  });
});

describe("the HTTP door", () => {
  async function listen(handler: PublicRpc | null, ipHeader: string | null = null) {
    const api = async () => ({ status: 404, body: {} });
    server = createHttpServer(api, "/nonexistent", handler ? { handler, ipHeader } : undefined);
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  }
  const post = (url: string, body: string, headers: Record<string, string> = {}) => fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  it("is not there when the public RPC is off", async () => {
    const url = await listen(null);
    expect((await post(url, "{}")).status).toBe(404);
  });

  it("answers POST with JSON, lets a browser page call it, and refuses other methods", async () => {
    const seen: string[] = [];
    const url = await listen(async (body, ip) => { seen.push(ip); return { status: 200, body: { echo: body } }; });
    const res = await post(url, '{"a":1}');
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ echo: '{"a":1}' });
    expect(seen).toEqual(["127.0.0.1"]);
    const preflight = await fetch(url, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
    const get = await fetch(url);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toContain("POST");
  });

  it("takes a body of 256 KiB and refuses one a byte bigger with 413, without calling the handler", async () => {
    let calls = 0;
    const url = await listen(async () => { calls++; return { status: 200, body: {} }; });
    expect((await post(url, "x".repeat(256 * 1024))).status).toBe(200);
    const big = await post(url, "x".repeat(256 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(calls).toBe(1);
  });

  it("uses the socket's address, or the last address in the trusted header when one is set", async () => {
    const seen: string[] = [];
    const handler: PublicRpc = async (_b, ip) => { seen.push(ip); return { status: 200, body: {} }; };
    let url = await listen(handler);
    await post(url, "{}", { "x-real-ip": "9.9.9.9" });
    await new Promise<void>((ok) => server!.close(() => ok()));
    url = await listen(handler, "x-forwarded-for");
    await post(url, "{}", { "x-forwarded-for": "6.6.6.6, 9.9.9.9" });
    await post(url, "{}");
    expect(seen).toEqual(["127.0.0.1", "9.9.9.9", "127.0.0.1"]);
  });

  it("passes the handler's status and headers on, for a refused client", async () => {
    const url = await listen(async () => ({ status: 429, headers: { "retry-after": "7" }, body: { error: "slow down" } }));
    const res = await post(url, "{}");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("answers a handler that throws with a JSON-RPC error and the CORS headers, so a browser page can read it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const url = await listen(async () => { throw new Error("boom"); });
    const res = await post(url, "{}", { origin: "https://dapp.example" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
    expect(body).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 } });
    expect(body.error.message).not.toContain("boom");
  });
});
