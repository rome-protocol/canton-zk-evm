import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { createPublicRpc, type PublicRpc } from "./public-rpc.ts";
import { createHeavyLimiter, HEAVY_METHODS, isHeavy } from "./rpc-heavy.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const hx = (n: number) => "0x" + n.toString(16);
const block = { number: hx(5), hash: "0x" + "05".repeat(32), transactions: [] };

let RAW: Hex;
beforeAll(async () => {
  RAW = await privateKeyToAccount(generatePrivateKey()).signTransaction({ type: "eip1559", chainId: 1, nonce: 3, to: "0x" + "ab".repeat(20), value: 1n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n } as never);
});

let reth: FakeReth | undefined;
afterEach(async () => { await reth?.close(); reth = undefined; });

/** A gate that holds every heavy call at reth until the test lets them go, and counts how many are held at once. */
function hold() {
  const state = { running: 0, peak: 0, releases: [] as Array<() => void> };
  const heavy = () => new Promise<string>((ok) => {
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    state.releases.push(() => { state.running--; ok("0x"); });
  });
  const release = () => { for (const r of state.releases.splice(0)) r(); };
  return { state, heavy, release };
}

async function boot(o: { concurrency: number; queue: number; maxInFlight?: number; timeoutMs?: number; heavy?: (p: unknown[]) => unknown; httpStatus?: number; gate?: (m: string) => Promise<void> | void }) {
  const h = hold();
  reth = await startFakeReth({
    eth_getBlockByNumber: block, eth_chainId: hx(1), eth_blockNumber: hx(5), eth_getBalance: "0x64", eth_gasPrice: "0x1",
    eth_getTransactionCount: "0x3", eth_getCode: "0x", eth_sendRawTransaction: (p: unknown[]) => keccak256(p[0] as Hex),
    eth_call: o.heavy ?? h.heavy, eth_estimateGas: o.heavy ?? h.heavy, eth_getLogs: o.heavy ?? h.heavy,
    eth_getTransactionReceipt: null,
  }, { httpStatus: o.httpStatus, gate: o.gate });
  const rpc: PublicRpc = createPublicRpc({
    rethUrl: reth.url, timeoutMs: o.timeoutMs ?? 5000, chainId: 1, ratePerMinute: 100000, heavyConcurrency: o.concurrency, heavyQueue: o.queue,
    maxInFlight: o.maxInFlight, tracker: { admit: () => null, track: () => {} },
  });
  const send = (method: string, ip: string, params: unknown[] = []) => rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), ip);
  return { h, rpc, send };
}
/** Lets held heavy calls go, again and again, until every answer is in. */
const drain = async (h: ReturnType<typeof hold>, answers: Array<Promise<unknown>>) => {
  let done = false;
  const all = Promise.all(answers).then((r) => { done = true; return r; });
  while (!done) { h.release(); await new Promise((r) => setTimeout(r, 5)); }
  return all;
};
const until = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect(f()).toBe(true); };

describe("which methods are heavy", () => {
  it("is the calls that run the EVM or scan logs, and no lookup or send", () => {
    expect([...HEAVY_METHODS].sort()).toEqual(["eth_call", "eth_estimateGas", "eth_getLogs"]);
    for (const m of ["eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getTransactionCount", "eth_getCode", "eth_gasPrice", "eth_getTransactionReceipt", "eth_sendRawTransaction"]) {
      expect(isHeavy(m)).toBe(false);
    }
  });
});

describe("the heavy limiter", () => {
  it("runs `concurrency` at once, queues `queue`, refuses the rest, and passes a slot on in order", async () => {
    const l = createHeavyLimiter(2, 1);
    const a = await l.acquire(), b = await l.acquire();
    expect(a).toBeTypeOf("function");
    expect(b).toBeTypeOf("function");
    const queued = l.acquire(); // waits
    expect(l.stats()).toEqual({ running: 2, queued: 1 });
    expect(await l.acquire()).toBeNull(); // queue full: refused without waiting
    a!();
    const c = await queued;
    expect(c).toBeTypeOf("function");
    expect(l.stats()).toEqual({ running: 2, queued: 0 });
    b!(); c!();
    expect(l.stats()).toEqual({ running: 0, queued: 0 });
  });
});

describe("the heavy limiter queue", () => {
  it("passes slots to the waiters oldest first", async () => {
    const l = createHeavyLimiter(1, 3);
    const first = (await l.acquire())!;
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) => l.acquire().then((r) => { order.push(n); return r!; }));
    expect(l.stats()).toEqual({ running: 1, queued: 3 });
    first();
    const r1 = await waiters[0]!;
    expect(order).toEqual([1]);
    r1();
    const r2 = await waiters[1]!;
    expect(order).toEqual([1, 2]);
    r2();
    (await waiters[2]!)();
    expect(order).toEqual([1, 2, 3]);
    expect(l.stats()).toEqual({ running: 0, queued: 0 });
  });
});

describe("the public RPC under a heavy flood", () => {
  it("never runs more heavy calls at reth than the cap, from many clients", async () => {
    const { h, send } = await boot({ concurrency: 3, queue: 100 });
    const answers = Array.from({ length: 40 }, (_, i) => send(["eth_call", "eth_estimateGas", "eth_getLogs"][i % 3]!, `10.0.${i}.1`, i % 3 === 2 ? [{ fromBlock: "0x1", toBlock: "0x2" }] : [{}]));
    await until(() => h.state.running === 3);
    const done = await drain(h, answers) as Array<{ status: number }>;
    expect(done.every((a) => a.status === 200)).toBe(true);
    expect(h.state.peak).toBe(3);
  });

  it("queues a short line and refuses the overflow at once with Retry-After", async () => {
    const { h, send } = await boot({ concurrency: 2, queue: 3 });
    const held = Array.from({ length: 5 }, (_, i) => send("eth_call", `10.1.${i}.1`, [{}]));
    await until(() => h.state.running === 2);
    const t0 = Date.now();
    const refused = await send("eth_call", "10.1.99.1", [{}]); // the sixth: 2 running, 3 queued
    expect(Date.now() - t0).toBeLessThan(500);
    expect(refused.status).toBe(429);
    expect(refused.headers?.["retry-after"]).toBe("1");
    expect((refused.body as { error: { code: number } }).error.code).toBe(-32005);
    expect(h.state.running).toBe(2); // the refused call never reached reth
    const done = await drain(h, held) as Array<{ status: number }>;
    expect(done.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it("answers light calls while heavy ones are running and queued", async () => {
    const { h, send } = await boot({ concurrency: 1, queue: 2, maxInFlight: 64 });
    const heavy = [send("eth_call", "10.2.1.1", [{}]), send("eth_estimateGas", "10.2.2.1", [{}]), send("eth_getLogs", "10.2.3.1", [{ fromBlock: "0x1", toBlock: "0x2" }])];
    await until(() => h.state.running === 1);
    expect((await send("eth_call", "10.2.4.1", [{}])).status).toBe(429); // the line is full
    const light = await Promise.all([
      send("eth_chainId", "10.2.5.1"), send("eth_blockNumber", "10.2.5.2"), send("eth_getBalance", "10.2.5.3", ["0x" + "11".repeat(20), "latest"]),
      send("eth_getTransactionCount", "10.2.5.4", ["0x" + "11".repeat(20), "pending"]), send("eth_getCode", "10.2.5.5", ["0x" + "11".repeat(20), "latest"]),
      send("eth_gasPrice", "10.2.5.6"), send("eth_getTransactionReceipt", "10.2.5.7", ["0x" + "cd".repeat(32)]),
      send("eth_sendRawTransaction", "10.2.5.8", [RAW]),
    ]);
    expect(light.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
    expect(light.every((a) => "result" in (a.body as object))).toBe(true);
    await drain(h, heavy);
  });

  it("splits a batch: the heavy calls over the cap are refused one by one, the light ones answer, and the status stays 200", async () => {
    const { h, send, rpc } = await boot({ concurrency: 1, queue: 0 });
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{}] },
      { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{}] },
      { jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] },
    ];
    const p = rpc(JSON.stringify(batch), "10.3.0.1");
    await until(() => h.state.running === 1);
    h.release();
    const a = await p;
    expect(a.status).toBe(200);
    const byId = Object.fromEntries((a.body as Array<{ id: number }>).map((r) => [r.id, r]));
    expect("result" in byId[1]! !== "result" in byId[2]!).toBe(true); // one ran, one was refused
    expect("result" in byId[3]!).toBe(true);
    void send;
  });

  it("frees the slot when a heavy call fails at reth", async () => {
    // reth answers the first call with a JSON-RPC error and the second with a value; one slot, no queue.
    let n = 0;
    const { send } = await boot({ concurrency: 1, queue: 0, heavy: () => { if (n++ === 0) throw new Error("execution reverted"); return "0x"; } });
    const first = await send("eth_call", "10.4.0.1", [{}]);
    expect((first.body as { error?: unknown }).error).toBeDefined();
    const second = await send("eth_call", "10.4.0.2", [{}]);
    expect(second.status).toBe(200);
    expect((second.body as { result?: string }).result).toBe("0x");
  });

  it("frees the slot when reth cannot be reached", async () => {
    const { send, rpc } = await boot({ concurrency: 1, queue: 0, httpStatus: 500 });
    for (let i = 0; i < 3; i++) {
      const a = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{}] }), `10.4.1.${i}`);
      expect((a.body as { error: { code: number } }).error.code).toBe(-32603); // unreachable, never the busy error
      expect(a.status).toBe(200);
    }
    void send;
  });

  it("keeps the place of a call that timed out for one more timeout, because reth may still be running it", async () => {
    // reth never answers an eth_call; the explorer gives up after 600 ms (long enough that a loaded machine still reaches the next call inside the extra hold).
    const { send } = await boot({ concurrency: 1, queue: 0, timeoutMs: 600, gate: (m) => (m === "eth_call" ? new Promise<void>(() => {}) : undefined) });
    const t0 = Date.now();
    const first = await send("eth_call", "10.5.0.1", [{}]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(580);
    expect((first.body as { error: { code: number } }).error.code).toBe(-32603);
    // The first call is gone from the explorer's side but still counts: the next one is refused at once.
    const busy = await send("eth_call", "10.5.0.2", [{}]);
    expect(busy.status).toBe(429);
    expect((busy.body as { error: { code: number } }).error.code).toBe(-32005);
    // After another timeout the place is free again: the next call is let in (and times out in its turn).
    await new Promise((r) => setTimeout(r, 700));
    const later = await send("eth_call", "10.5.0.3", [{}]);
    expect((later.body as { error: { code: number } }).error.code).toBe(-32603);
  });
});
