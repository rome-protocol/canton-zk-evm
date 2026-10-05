import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import { createReth, ALLOWED_METHODS, RethError } from "./reth.ts";
import { startFakeReth, type FakeReth } from "../test/fake-reth.ts";

const H = (c: string) => "0x" + c.repeat(64);
const A = (c: string) => "0x" + c.repeat(40);

const RAW_BLOCK = {
  number: "0x4b3", hash: H("a"), parentHash: H("b"), timestamp: "0x68e0f1a4", gasUsed: "0xc9f2", gasLimit: "0x1c9c380",
  baseFeePerGas: "0x7", miner: A("1"), stateRoot: H("c"),
  transactions: [H("d")],
};
const RAW_TX = {
  hash: H("d"), blockNumber: "0x4b3", blockHash: H("a"), transactionIndex: "0x0", from: A("2"), to: A("3"),
  value: "0x0", nonce: "0x1", type: "0x2", gas: "0x186a0", input: "0xa9059cbb", gasPrice: "0x3b9aca00",
};

let fake: FakeReth | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });
const reth = async (handlers: Record<string, unknown>) => {
  fake = await startFakeReth(handlers);
  return createReth(fake.url, 2000);
};

describe("blocks", () => {
  it("reads a block by number and turns its quantities into numbers", async () => {
    const r = await reth({ eth_getBlockByNumber: (p: unknown[]) => (p[0] === "0x4b3" ? RAW_BLOCK : null) });
    const b = await r.block(1203);
    expect(b).toMatchObject({ number: 1203, hash: H("a"), parentHash: H("b"), timestamp: 0x68e0f1a4, gasUsed: 51698, gasLimit: 30000000, baseFeePerGas: 7n, miner: A("1"), stateRoot: H("c") });
    expect(b?.transactions).toEqual([H("d")]);
  });

  it("reads a block by hash, and by the latest and finalized tags", async () => {
    const seen: unknown[][] = [];
    const r = await reth({ eth_getBlockByHash: (p: unknown[]) => (seen.push(p), RAW_BLOCK), eth_getBlockByNumber: (p: unknown[]) => (seen.push(p), p[1] ? { ...RAW_BLOCK, transactions: [RAW_TX] } : RAW_BLOCK) });
    await r.block(H("a"));
    await r.block("finalized");
    await r.block("latest", true);
    expect(seen).toEqual([[H("a"), false], ["finalized", false], ["latest", true]]);
  });

  it("answers null for a block reth does not have", async () => {
    const r = await reth({ eth_getBlockByNumber: null });
    expect(await r.block(99)).toBeNull();
  });

  it("returns full transactions when asked, and the base fee as null before London", async () => {
    const r = await reth({ eth_getBlockByNumber: { ...RAW_BLOCK, baseFeePerGas: undefined, transactions: [RAW_TX] } });
    const b = await r.block(1203, true);
    expect(b?.baseFeePerGas).toBeNull();
    expect(b?.transactions[0]).toMatchObject({ hash: H("d"), blockNumber: 1203, from: A("2"), to: A("3"), nonce: 1, type: 2, gas: 100000, value: 0n });
  });

  it("reads the newest block number", async () => {
    const r = await reth({ eth_blockNumber: "0x4b4" });
    expect(await r.blockNumber()).toBe(1204);
  });

  it("reads a block's receipts", async () => {
    const r = await reth({ eth_getBlockReceipts: [{ transactionHash: H("d"), status: "0x1", gasUsed: "0xc9f2", effectiveGasPrice: "0x3b9aca00", contractAddress: null, logs: [{ address: A("3"), topics: [H("e")], data: "0x" }] }] });
    const rs = await r.blockReceipts(1203);
    expect(rs?.[0]).toMatchObject({ transactionHash: H("d"), success: true, gasUsed: 51698, effectiveGasPrice: 1000000000n, contractAddress: null });
    expect(rs?.[0]?.logs).toHaveLength(1);
  });
});

describe("transactions", () => {
  it("reads a mined transaction and its receipt", async () => {
    const r = await reth({
      eth_getTransactionByHash: RAW_TX,
      eth_getTransactionReceipt: { transactionHash: H("d"), status: "0x0", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: A("9"), logs: [] },
    });
    expect((await r.transaction(H("d")))?.blockNumber).toBe(1203);
    const rc = await r.receipt(H("d"));
    expect(rc).toMatchObject({ success: false, gasUsed: 21000, contractAddress: A("9") });
  });

  it("shows a transaction that is only in reth's pool with no block number", async () => {
    const r = await reth({ eth_getTransactionByHash: { ...RAW_TX, blockNumber: null, blockHash: null, transactionIndex: null } });
    expect(await r.transaction(H("d"))).toMatchObject({ blockNumber: null, blockHash: null, index: null });
  });

  it("answers null for an unknown transaction and a receipt that is not there yet", async () => {
    const r = await reth({ eth_getTransactionByHash: null, eth_getTransactionReceipt: null });
    expect(await r.transaction(H("0"))).toBeNull();
    expect(await r.receipt(H("0"))).toBeNull();
  });
});

describe("addresses", () => {
  it("reads the balance, the sent count and whether there is code, from the newest block", async () => {
    const seen: unknown[][] = [];
    const r = await reth({
      eth_getBalance: (p: unknown[]) => (seen.push(p), "0x6f05b59d3b20000"),
      eth_getTransactionCount: "0x3",
      eth_getCode: "0x6080",
    });
    expect(await r.balance(A("5"))).toBe(500000000000000000n);
    expect(seen[0]).toEqual([A("5"), "latest"]);
    expect(await r.nonce(A("5"))).toBe(3);
    expect(await r.code(A("5"))).toBe("0x6080");
  });

  it("names a token that answers name, symbol and decimals", async () => {
    const text = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);
    const r = await reth({
      eth_call: (p: unknown[]) => {
        const sel = ((p[0] as { data: string }).data).slice(0, 10);
        if (sel === "0x06fdde03") return text("Token A");
        if (sel === "0x95d89b41") return text("TKA");
        if (sel === "0x313ce567") return "0x" + "12".padStart(64, "0");
        throw "no such function";
      },
    });
    expect(await r.token(A("7"))).toEqual({ name: "Token A", symbol: "TKA", decimals: 18 });
  });

  it("returns null for a contract that does not answer the ERC-20 calls, or answers nonsense", async () => {
    const a = await reth({ eth_call: () => { throw "execution reverted"; } });
    expect(await a.token(A("7"))).toBeNull();
    await fake?.close();
    const b = await reth({ eth_call: "0x" });
    expect(await b.token(A("7"))).toBeNull();
  });
});

describe("what the faucet needs", () => {
  it("counts sent transactions including the pool when asked for the pending count, and from the newest block otherwise", async () => {
    const seen: unknown[][] = [];
    const r = await reth({ eth_getTransactionCount: (p: unknown[]) => (seen.push(p), p[1] === "pending" ? "0x5" : "0x3") });
    expect(await r.nonce(A("5"), "pending")).toBe(5);
    expect(await r.nonce(A("5"))).toBe(3);
    expect(seen).toEqual([[A("5"), "pending"], [A("5"), "latest"]]);
  });

  it("reads the fee data as numbers", async () => {
    const r = await reth({ eth_gasPrice: "0x3b9aca07", eth_maxPriorityFeePerGas: "0x3b9aca00" });
    expect(await r.gasPrice()).toBe(1000000007n);
    expect(await r.priorityFee()).toBe(1000000000n);
  });

  it("sends a signed transaction and returns the hash reth gives back", async () => {
    const seen: unknown[][] = [];
    const r = await reth({ eth_sendRawTransaction: (p: unknown[]) => (seen.push(p), H("e")) });
    expect(await r.sendRaw("0x02f8")).toBe(H("e"));
    expect(seen).toEqual([["0x02f8"]]);
  });

  it("rejects a hash that is not a hash", async () => {
    const r = await reth({ eth_sendRawTransaction: "0x12" });
    await expect(r.sendRaw("0x02f8")).rejects.toThrow(/eth_sendRawTransaction/);
  });

  it("marks a refusal from reth as an answer, so the caller can tell it from an unreachable reth", async () => {
    const r = await reth({ eth_sendRawTransaction: () => { throw "nonce too low"; } });
    await expect(r.sendRaw("0x02f8")).rejects.toMatchObject({ answered: true });
  });
});

describe("failures", () => {
  it("raises a RethError that names the method when reth answers an error", async () => {
    const r = await reth({ eth_blockNumber: () => { throw "boom"; } });
    await expect(r.blockNumber()).rejects.toThrow(/eth_blockNumber.*boom/);
  });

  it("raises a RethError when the HTTP port is down or answers with a bad status", async () => {
    fake = await startFakeReth({}, { httpStatus: 502 });
    await expect(createReth(fake.url, 2000).blockNumber()).rejects.toBeInstanceOf(RethError);
    await fake.close();
    fake = undefined;
    await expect(createReth("http://127.0.0.1:1", 500).blockNumber()).rejects.toBeInstanceOf(RethError);
  });

  it("rejects a quantity that is not a hex quantity", async () => {
    const r = await reth({ eth_blockNumber: "1204" });
    await expect(r.blockNumber()).rejects.toThrow(/eth_blockNumber/);
  });

  it("refuses a method that is not on the list, without calling reth", async () => {
    const r = await reth({ txpool_content: {} });
    await expect(r.rpc("txpool_content", [])).rejects.toThrow(/not on the list/);
    await expect(r.rpc("engine_forkchoiceUpdatedV3", [])).rejects.toThrow(/not on the list/);
    expect(fake?.calls).toEqual([]);
  });

  it("only lists eth_, net_ and web3_ methods", () => {
    for (const m of ALLOWED_METHODS) expect(m).toMatch(/^(eth|net|web3)_/);
  });
});
