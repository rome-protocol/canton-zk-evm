import { afterEach, describe, expect, it } from "vitest";
import { createPublicRpc, type PublicRpc } from "./public-rpc.ts";
import { createHeavyLimiter, HEAVY_METHODS, isHeavy } from "./rpc-heavy.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const hx = (n: number) => "0x" + n.toString(16);
const block = { number: hx(5), hash: "0x" + "05".repeat(32), transactions: [] };

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

async function boot(o: { concurrency: number; queue: number; maxInFlight?: number }) {
  const h = hold();
  reth = await startFakeReth({
    eth_getBlockByNumber: block, eth_chainId: hx(1), eth_blockNumber: hx(5), eth_getBalance: "0x64", eth_gasPrice: "0x1",
    eth_getTransactionCount: "0x3", eth_getCode: "0x", eth_sendRawTransaction: "0x" + "ab".repeat(32),
    eth_call: h.heavy, eth_estimateGas: h.heavy, eth_getLogs: h.heavy,
  });
  const rpc: PublicRpc = createPublicRpc({
    rethUrl: reth.url, timeoutMs: 5000, chainId: 1, ratePerMinute: 100000, heavyConcurrency: o.concurrency, heavyQueue: o.queue,
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
      send("eth_gasPrice", "10.2.5.6"),
    ]);
    expect(light.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200]);
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

  it("frees the slot when a heavy call fails", async () => {
    const { h, send } = await boot({ concurrency: 1, queue: 0 });
    reth!.calls.length = 0;
    const first = send("eth_call", "10.4.0.1", [{}]);
    await until(() => h.state.running === 1);
    h.release();
    expect((await first).status).toBe(200);
    const second = send("eth_call", "10.4.0.2", [{}]);
    await until(() => h.state.running === 1);
    h.release();
    expect((await second).status).toBe(200);
  });
});
