import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { createPublicRpc } from "../public-rpc.ts";
import { startFakeReth, type FakeReth } from "../../test/fake-reth.ts";
import { MODULES, TEXTS, etherscan } from "./etherscan.ts";

const CHAIN = 770101, FINAL = 5, HEAD = 6;
const hx = (n: number) => "0x" + n.toString(16);
const hashOf = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const ADDR = "0x" + "ab".repeat(20);
const TX_FINAL = "0x" + "f1".repeat(32), TX_PROVING = "0x" + "f2".repeat(32);
const tx = (h: string, n: number, i: number) => ({ hash: h, blockNumber: hx(n), blockHash: hashOf(n), transactionIndex: hx(i), nonce: "0x1" });
const TXS = [tx(TX_FINAL, 4, 0), tx("0x" + "f3".repeat(32), 4, 1)];
const block = (n: number, full: boolean) => ({ number: hx(n), hash: hashOf(n), transactions: n === 4 ? (full ? TXS : TXS.map((t) => t.hash)) : [] });
const ACCOUNT = privateKeyToAccount(generatePrivateKey());

let reth: FakeReth | undefined;
afterEach(async () => { await reth?.close(); reth = undefined; });

interface Boot { get: (q: Record<string, string>) => Promise<any>; post: (q: Record<string, string>, form: string) => Promise<any>; asked: Record<string, unknown[][]>; tracked: unknown[][] } // eslint-disable-line @typescript-eslint/no-explicit-any

async function boot(withRpc = true): Promise<Boot> {
  const asked: Record<string, unknown[][]> = {};
  const rec = (m: string, f: unknown) => (p: unknown[]) => { (asked[m] ??= []).push(p); return typeof f === "function" ? (f as (p: unknown[]) => unknown)(p) : f; };
  const handlers: Record<string, unknown> = {
    eth_getBlockByNumber: (p: unknown[]) => (p[0] === "finalized" ? block(FINAL, false) : p[0] === "latest" ? block(HEAD, false) : Number(p[0]) <= HEAD ? block(Number(p[0]), p[1] === true) : null),
    eth_getBlockByHash: (p: unknown[]) => [0, 1, 2, 3, 4, 5, 6].map((i) => (hashOf(i) === p[0] ? block(i, false) : null)).find((b) => b) ?? null,
    eth_getTransactionByHash: (p: unknown[]) => (p[0] === TX_FINAL ? TXS[0] : p[0] === TX_PROVING ? tx(TX_PROVING, HEAD, 0) : null),
    eth_getTransactionReceipt: (p: unknown[]) => (p[0] === TX_FINAL ? { transactionHash: TX_FINAL, blockNumber: hx(4), blockHash: hashOf(4), status: "0x1" } : null),
    eth_getTransactionCount: "0x3", eth_getCode: "0x6080", eth_getStorageAt: "0x" + "0".repeat(63) + "7", eth_call: "0x0000000000000000000000000000000000000000000000000000000000000001",
    eth_estimateGas: "0x5208", eth_gasPrice: "0x3b9aca00", eth_sendRawTransaction: (p: unknown[]) => keccak256(p[0] as Hex),
  };
  reth = await startFakeReth(Object.fromEntries(Object.entries(handlers).map(([m, f]) => [m, rec(m, f)])));
  const tracked: unknown[][] = [];
  const rpc = createPublicRpc({ rethUrl: reth.url, timeoutMs: 1000, chainId: CHAIN, ratePerMinute: 100000, finalizedTtlMs: 0, tracker: { admit: () => null, track: (...a) => { tracked.push(a); } } });
  const door = etherscan({ rest: {} as never, reth: {} as never, chainId: CHAIN, ...(withRpc ? { rpc } : {}) });
  const q = (o: Record<string, string>) => new URLSearchParams({ module: "proxy", ...o });
  return { asked, tracked, get: async (o) => (await door(q(o), undefined, "1.2.3.4")).body, post: async (o, form) => (await door(q(o), form, "1.2.3.4")).body };
}
const rpcOk = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });

describe("the proxy module, as Etherscan's: a JSON-RPC answer, in hex, as the public RPC gives it", () => {
  it("is in the module table with its fourteen actions", () => {
    expect(Object.keys(MODULES.proxy as object)).toHaveLength(14);
    expect(Object.keys(MODULES)).toContain("proxy");
  });

  it("eth_blockNumber is the final head, in hex", async () => {
    expect(await (await boot()).get({ action: "eth_blockNumber" })).toEqual(rpcOk("0x5"));
  });

  it("eth_getBlockByNumber answers with a final block, true or false for the transactions, and null above final", async () => {
    const b = await boot();
    expect(await b.get({ action: "eth_getBlockByNumber", tag: "0x4", boolean: "false" })).toEqual(rpcOk(block(4, false)));
    expect(await b.get({ action: "eth_getBlockByNumber", tag: "0x4", boolean: "true" })).toEqual(rpcOk(block(4, true)));
    expect(await b.get({ action: "eth_getBlockByNumber", tag: "latest", boolean: "false" })).toEqual(rpcOk(block(FINAL, false)));
    expect(await b.get({ action: "eth_getBlockByNumber", tag: "0x6", boolean: "false" })).toEqual(rpcOk(null));
    expect((await b.get({ action: "eth_getBlockByNumber", tag: "0x4", boolean: "maybe" })).error.code).toBe(-32602);
  });

  it("eth_getBlockTransactionCountByNumber counts a final block's transactions in hex", async () => {
    const b = await boot();
    expect(await b.get({ action: "eth_getBlockTransactionCountByNumber", tag: "0x4" })).toEqual(rpcOk("0x2"));
    expect(await b.get({ action: "eth_getBlockTransactionCountByNumber", tag: "0x3" })).toEqual(rpcOk("0x0"));
    expect(await b.get({ action: "eth_getBlockTransactionCountByNumber", tag: "0x6" })).toEqual(rpcOk(null));
  });

  it("eth_getTransactionByBlockNumberAndIndex picks one from a final block, or null", async () => {
    const b = await boot();
    expect(await b.get({ action: "eth_getTransactionByBlockNumberAndIndex", tag: "0x4", index: "0x1" })).toEqual(rpcOk(TXS[1]));
    expect(await b.get({ action: "eth_getTransactionByBlockNumberAndIndex", tag: "0x4", index: "0x2" })).toEqual(rpcOk(null));
    expect(await b.get({ action: "eth_getTransactionByBlockNumberAndIndex", tag: "0x6", index: "0x0" })).toEqual(rpcOk(null));
    expect(await b.get({ action: "eth_getTransactionByBlockNumberAndIndex", tag: "0x4", index: "0xffffffffffffffffff" })).toEqual(rpcOk(null));
    expect((await b.get({ action: "eth_getTransactionByBlockNumberAndIndex", tag: "0x4", index: "1" })).error.code).toBe(-32602);
  });

  it("eth_getTransactionByHash shows a transaction of a block still being proven with no block yet, and null for one unknown", async () => {
    const b = await boot();
    expect(await b.get({ action: "eth_getTransactionByHash", txhash: TX_FINAL })).toEqual(rpcOk(TXS[0]));
    expect(await b.get({ action: "eth_getTransactionByHash", txhash: TX_PROVING })).toEqual(rpcOk({ ...tx(TX_PROVING, HEAD, 0), blockHash: null, blockNumber: null, transactionIndex: null }));
    expect(await b.get({ action: "eth_getTransactionByHash", txhash: hashOf(9) })).toEqual(rpcOk(null));
  });

  it("eth_getTransactionReceipt is a final transaction's, or null", async () => {
    const b = await boot();
    expect((await b.get({ action: "eth_getTransactionReceipt", txhash: TX_FINAL })).result.status).toBe("0x1");
    expect(await b.get({ action: "eth_getTransactionReceipt", txhash: TX_PROVING })).toEqual(rpcOk(null));
  });

  it("the state reads (count, code, storage, call) answer in hex at the final block", async () => {
    const b = await boot();
    expect(await b.get({ action: "eth_getTransactionCount", address: ADDR, tag: "latest" })).toEqual(rpcOk("0x3"));
    expect(await b.get({ action: "eth_getCode", address: ADDR, tag: "latest" })).toEqual(rpcOk("0x6080"));
    expect(await b.get({ action: "eth_getStorageAt", address: ADDR, position: "0x0", tag: "latest" })).toEqual(rpcOk("0x" + "0".repeat(63) + "7"));
    expect(await b.get({ action: "eth_call", to: ADDR, data: "0x70a08231", tag: "latest" })).toEqual(rpcOk("0x" + "0".repeat(63) + "1"));
    expect(b.asked.eth_getCode?.[0]).toEqual([ADDR, "0x5"]);
    expect(b.asked.eth_call?.[0]).toEqual([{ to: ADDR, data: "0x70a08231" }, "0x5"]);
    // A block above final is refused as /rpc refuses it.
    expect((await b.get({ action: "eth_getCode", address: ADDR, tag: "0x6" })).error.message).toMatch(/not final/);
  });

  it("eth_gasPrice and eth_estimateGas answer in hex", async () => {
    const b = await boot();
    expect(await b.get({ action: "eth_gasPrice" })).toEqual(rpcOk("0x3b9aca00"));
    expect(await b.get({ action: "eth_estimateGas", to: ADDR, data: "0x", value: "0x1", gasPrice: "0x1", gas: "0x5208" })).toEqual(rpcOk("0x5208"));
    expect(b.asked.eth_estimateGas?.[0]).toEqual([{ to: ADDR, data: "0x", value: "0x1", gasPrice: "0x1", gas: "0x5208" }, "0x5"]); // the public RPC reads it at the final block
  });

  it("eth_sendRawTransaction goes through the public RPC's send path: reth takes it and the tracker follows it", async () => {
    const b = await boot();
    const raw = await ACCOUNT.signTransaction({ type: "eip1559", chainId: CHAIN, nonce: 3, to: ADDR, value: 1n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n } as never);
    expect(await b.post({ action: "eth_sendRawTransaction" }, `hex=${raw}`)).toEqual(rpcOk(keccak256(raw)));
    expect(b.tracked).toHaveLength(1);
    expect(b.tracked[0]?.[1]).toBe(keccak256(raw));
    expect((await b.get({ action: "eth_sendRawTransaction", hex: "0x1234" })).error.code).toBe(-32602);
  });

  it("eth_getUncleByBlockNumberAndIndex is null: there are no uncles", async () => {
    expect(await (await boot()).get({ action: "eth_getUncleByBlockNumberAndIndex", tag: "0x4", index: "0x0" })).toEqual(rpcOk(null));
  });

  it("a missing argument is the node's own error, an unknown action is Etherscan's, and without the public RPC the module is not supported", async () => {
    const b = await boot();
    expect(await b.get({ action: "eth_getCode", address: ADDR })).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "missing value for required argument 1" } });
    expect(await b.get({ action: "eth_getLogs" })).toEqual({ status: "0", message: "NOTOK", result: TEXTS.action });
    await reth?.close();
    expect(await (await boot(false)).get({ action: "eth_blockNumber" })).toEqual({ status: "0", message: "NOTOK", result: TEXTS.unsupported });
  });
});
