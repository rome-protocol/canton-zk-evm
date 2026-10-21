import { afterEach, describe, expect, it } from "vitest";
import { startFakeReth, type FakeReth } from "../../test/fake-reth.ts";
import { RethError } from "../reth.ts";
import { createFinalReads, FINAL_READ_METHODS } from "./reads.ts";

const H = (c: string) => "0x" + c.repeat(32);
const A = (c: string) => "0x" + c.repeat(20);
const rawBlock = (over: Record<string, unknown> = {}) => ({
  number: "0x5", hash: H("a1"), parentHash: H("b2"), timestamp: "0x65", gasLimit: "0x1c9c380", gasUsed: "0x5208", baseFeePerGas: "0x7", miner: A("be"), stateRoot: H("01"), transactionsRoot: H("02"),
  receiptsRoot: H("03"), extraData: "0x", size: "0x2f0",
  transactions: [{ hash: H("c3"), type: "0x2", from: A("f0"), to: A("f1"), nonce: "0x0", value: "0x1", gas: "0x5208", maxFeePerGas: "0x9", maxPriorityFeePerGas: "0x1", input: "0x", accessList: [] }],
  ...over,
});

let reth: FakeReth | null = null;
afterEach(async () => { await reth?.close(); reth = null; });

describe("the indexer's reads from reth", () => {
  it("reads a block with its transactions, receipts and traces, and a missing block as null", async () => {
    reth = await startFakeReth({
      eth_getBlockByNumber: ([n]: unknown[]) => (n === "0x5" ? rawBlock() : null),
      eth_getBlockReceipts: ([n]: unknown[]) => (n === "0x5" ? [{ transactionHash: H("c3"), status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x8", contractAddress: null, logs: [{ address: A("d0"), topics: [H("77")], data: "0x00" }] }] : null),
      trace_replayBlockTransactions: ([n, kinds]: unknown[]) => (n === "0x5" && JSON.stringify(kinds) === '["trace"]'
        ? [{ transactionHash: H("c3"), output: "0x08c379a0", trace: [{ error: "Reverted" }, {}] }] : null),
      eth_getStorageAt: () => H("5e"),
    });
    const r = createFinalReads(reth.url, 2000);
    const b = await r.block(5);
    expect(b).toMatchObject({ number: 5, hash: H("a1"), gasLimit: 30_000_000, baseFeePerGas: 7n, size: 752 });
    expect(b!.transactions[0]).toMatchObject({ hash: H("c3"), type: 2, value: 1n, maxFeePerGas: 9n, to: A("f1") });
    expect((await r.receipts(5))![0]).toMatchObject({ status: 1, effectiveGasPrice: 8n, contractAddress: null, logs: [{ address: A("d0") }] });
    expect(await r.traces(5)).toEqual([{ transactionHash: H("c3"), output: "0x08c379a0", calls: 2, error: "Reverted" }]);
    expect(await r.storageAt(A("9a"), H("00"), 5)).toBe(H("5e"));
    expect(await r.block(6)).toBeNull();
    expect(await r.receipts(6)).toBeNull();
    expect(await r.traces(6)).toBeNull();
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
});
