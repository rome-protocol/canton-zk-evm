import { afterEach, describe, expect, it } from "vitest";
import { startFakeReth, type FakeReth } from "../../test/fake-reth.ts";
import { RethError } from "../reth.ts";
import { createFinalReads, FINAL_READ_METHODS } from "./reads.ts";
import { readMetadata } from "./tokens.ts";

const H = (c: string) => "0x" + c.repeat(32);
const A = (c: string) => "0x" + c.repeat(20);
const rawBlock = (over: Record<string, unknown> = {}) => ({
  number: "0x5", hash: H("a1"), parentHash: H("b2"), timestamp: "0x65", gasLimit: "0x1c9c380", gasUsed: "0x5208", baseFeePerGas: "0x7", miner: A("be"), stateRoot: H("01"), transactionsRoot: H("02"),
  receiptsRoot: H("03"), extraData: "0x", size: "0x2f0",
  transactions: [{ hash: H("c3"), type: "0x2", from: A("f0"), to: A("f1"), nonce: "0x0", value: "0x1", gas: "0x5208", maxFeePerGas: "0x9", maxPriorityFeePerGas: "0x1", input: "0x", accessList: [] }],
  ...over,
});

/** The shape of reth's `trace` tracer (the parity format): a call that failed, a delegatecall, a create2 that made a contract, and that contract destroying itself. */
const RECORDED_TRACE = [
  { action: { from: A("f0"), callType: "call", gas: "0x5208", input: "0x", to: A("f1"), value: "0x1" }, result: null, error: "Reverted", subtraces: 2, traceAddress: [], type: "call" },
  { action: { from: A("f1"), callType: "delegatecall", gas: "0x100", input: "0x12345678", to: A("d0"), value: "0x0" }, result: { gasUsed: "0x10", output: "0x" }, subtraces: 0, traceAddress: [0], type: "call" },
  { action: { from: A("f1"), gas: "0x900", init: "0x6080", value: "0x5", creationMethod: "create2" }, result: { gasUsed: "0x40", address: A("c1"), code: "0x6001" }, subtraces: 1, traceAddress: [1], type: "create" },
  { action: { address: A("c1"), refundAddress: A("f0"), balance: "0x9" }, result: null, subtraces: 0, traceAddress: [1, 0], type: "suicide" },
];

let reth: FakeReth | null = null;
afterEach(async () => { await reth?.close(); reth = null; });

describe("the indexer's reads from reth", () => {
  it("gives the trace read its own timeout, longer than the others", async () => {
    reth = await startFakeReth({
      eth_getBlockByNumber: async () => { await new Promise((ok) => setTimeout(ok, 300)); return null; },
      trace_replayBlockTransactions: async () => { await new Promise((ok) => setTimeout(ok, 300)); return []; },
    });
    const r = createFinalReads(reth.url, 100, 3000);
    await expect(r.block(5)).rejects.toThrow(/cannot reach reth/);
    expect(await r.traces(5)).toEqual([]);
  });

  it("reads a block with its transactions, receipts and traces, and a missing block as null", async () => {
    reth = await startFakeReth({
      eth_getBlockByNumber: ([n]: unknown[]) => (n === "0x5" ? rawBlock() : null),
      eth_getBlockReceipts: ([n]: unknown[]) => (n === "0x5" ? [{ transactionHash: H("c3"), status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x8", contractAddress: null, logs: [{ address: A("d0"), topics: [H("77")], data: "0x00" }] }] : null),
      trace_replayBlockTransactions: ([n, kinds]: unknown[]) => (n === "0x5" && JSON.stringify(kinds) === '["trace"]'
        ? [{ transactionHash: H("c3"), output: "0x08c379a0", trace: RECORDED_TRACE }] : null),
      eth_getStorageAt: () => H("5e"),
      eth_getCode: ([a, n]: unknown[]) => (a === A("9a") && n === "0x0" ? "0x6001" : "0x"),
    });
    const r = createFinalReads(reth.url, 2000);
    const b = await r.block(5);
    expect(b).toMatchObject({ number: 5, hash: H("a1"), gasLimit: 30_000_000, baseFeePerGas: 7n, size: 752 });
    expect(b!.transactions[0]).toMatchObject({ hash: H("c3"), type: 2, value: 1n, maxFeePerGas: 9n, to: A("f1") });
    expect((await r.receipts(5))![0]).toMatchObject({ status: 1, effectiveGasPrice: 8n, contractAddress: null, logs: [{ address: A("d0") }] });
    const [t] = (await r.traces(5))!;
    expect(t).toMatchObject({ transactionHash: H("c3"), output: "0x08c379a0", calls: 4, error: "Reverted" });
    expect(t!.frames.map((f) => [f.traceAddress.join("."), f.type, f.callType, f.value, f.error])).toEqual([
      ["", "call", "call", 1n, "Reverted"], ["0", "call", "delegatecall", 0n, null], ["1", "create", "create2", 5n, null], ["1.0", "suicide", "selfdestruct", 9n, null],
    ]);
    expect(t!.frames[2]).toMatchObject({ from: A("f1"), to: A("c1"), created: { address: A("c1"), code: "0x6001" }, input: "0x6080" });
    expect(t!.frames[3]).toMatchObject({ from: A("c1"), to: A("f0") });
    expect(await r.storageAt(A("9a"), H("00"), 5)).toBe(H("5e"));
    expect(await r.code(A("9a"), 0)).toBe("0x6001");
    expect(await r.code(A("9b"), 0)).toBe("0x");
    expect(await r.block(6)).toBeNull();
    expect(await r.receipts(6)).toBeNull();
    expect(await r.traces(6)).toBeNull();
  });

  it("reads the hash of a block without its transactions, and the finalized number", async () => {
    reth = await startFakeReth({
      eth_getBlockByNumber: ([n, full]: unknown[]) => (full === false && n === "0x5" ? rawBlock() : full === false && n === "finalized" ? rawBlock({ number: "0x4" }) : null),
    });
    const r = createFinalReads(reth.url, 2000);
    expect(await r.hashAt(5)).toBe(H("a1"));
    expect(await r.hashAt(6)).toBeNull();
    expect(await r.finalized()).toBe(4);
  });

  it("names the method when reth sends data that is not valid", async () => {
    reth = await startFakeReth({ eth_getBlockByNumber: rawBlock({ hash: "0xZZ" }), eth_getStorageAt: "0x12" });
    const r = createFinalReads(reth.url, 2000);
    await expect(r.block(5)).rejects.toThrow(/eth_getBlockByNumber: a hash is not valid/);
    await expect(r.storageAt(A("9a"), H("00"), 5)).rejects.toThrow(/eth_getStorageAt/);
  });

  it("reports an unreachable reth and an error answer as RethError, and calls no method outside its list", async () => {
    reth = await startFakeReth({}, { httpStatus: 503 });
    const r = createFinalReads(reth.url, 2000);
    await expect(r.block(1)).rejects.toThrow(RethError);
    await expect(r.rpc("eth_sendRawTransaction", ["0x00"])).rejects.toThrow(/not on the list/);
    expect(reth.calls).not.toContain("eth_sendRawTransaction");
    expect([...FINAL_READ_METHODS].some((m) => /send|debug|admin/.test(m))).toBe(false);
  });

  it("puts a gas limit on every eth_call (READ_CALL_GAS), and a token that burns all of it is read as failed, quickly", async () => {
    const seen: unknown[] = [];
    reth = await startFakeReth({
      eth_call: (params: unknown[]) => { seen.push(params[0]); throw "out of gas: gas required exceeds allowance"; },
    });
    const started = Date.now();
    const meta = await readMetadata(createFinalReads(reth.url, 2000, 2000, 777_000), A("d1"), "ERC-20", 5);
    expect(meta).toEqual({ name: null, symbol: null, decimals: null, totalSupply: null, status: "failed" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(seen).toHaveLength(4);
    for (const call of seen) expect(call).toMatchObject({ to: A("d1"), gas: "0x" + (777_000).toString(16) });
    // The default is 100,000.
    seen.length = 0;
    await readMetadata(createFinalReads(reth.url, 2000), A("d1"), "ERC-20", 5);
    expect(seen[0]).toMatchObject({ gas: "0x" + (100_000).toString(16) });
  });

  it("treats an answer longer than 4 KB of data as no answer, quickly and without decoding it", async () => {
    const fat = "0x" + "ab".repeat(340_000); // 680 KB
    const edge = "0x" + "00".repeat(4096);
    const over = "0x" + "00".repeat(4097);
    let answer = fat;
    reth = await startFakeReth({ eth_call: () => answer });
    const r = createFinalReads(reth.url, 2000);
    const started = Date.now();
    const meta = await readMetadata(r, A("d1"), "ERC-20", 5);
    expect(meta).toEqual({ name: null, symbol: null, decimals: null, totalSupply: null, status: "failed" });
    expect(Date.now() - started).toBeLessThan(1500);
    // It is the answered path of an out-of-gas call (not a failure to reach reth), and the bound is exactly 4 KB of data.
    const e = await r.call(A("d1"), "0x06fdde03", 5).catch((x) => x);
    expect(e).toBeInstanceOf(RethError);
    expect((e as RethError).answered).toBe(true);
    answer = over;
    await expect(r.call(A("d1"), "0x06fdde03", 5)).rejects.toThrow(/longer than 4096 bytes/);
    answer = edge;
    expect(await r.call(A("d1"), "0x06fdde03", 5)).toBe(edge);
  });
});
