import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createReth, ALLOWED_METHODS, MAX_ANSWER_BYTES, RethError, RethTooBig } from "./reth.ts";
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
    expect(await r.balanceAt(A("5"), 255)).toBe(500000000000000000n);
    expect(seen[1]).toEqual([A("5"), "0xff"]);
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

  it("reads a holder's token balance at the block asked for, and gives 0 for a revert or an address that is no token", async () => {
    let seen: unknown[] = [];
    const r = await reth({ eth_call: (p: unknown[]) => { seen = p; return "0x" + (1234).toString(16).padStart(64, "0"); } });
    expect(await r.tokenBalanceAt(A("7"), A("A"), 1203)).toBe(1234n);
    expect(seen).toEqual([{ to: A("7"), data: "0x70a08231" + "0".repeat(24) + "a".repeat(40), gas: "0x30d40" }, "0x4b3"]);
    await fake?.close();
    const reverted = await reth({ eth_call: () => { throw "execution reverted"; } });
    expect(await reverted.tokenBalanceAt(A("7"), A("a"), 1)).toBe(0n);
    await fake?.close();
    const empty = await reth({ eth_call: "0x" });
    expect(await empty.tokenBalanceAt(A("7"), A("a"), 1)).toBe(0n);
  });

  it("reads a token's total supply at the block asked for, and gives 0 for a revert or an address that is no token", async () => {
    let seen: unknown[] = [];
    const r = await reth({ eth_call: (p: unknown[]) => { seen = p; return "0x" + (5000).toString(16).padStart(64, "0"); } });
    expect(await r.tokenSupplyAt(A("7"), 1203)).toBe(5000n);
    expect(seen).toEqual([{ to: A("7"), data: "0x18160ddd", gas: "0x30d40" }, "0x4b3"]);
    await fake?.close();
    const reverted = await reth({ eth_call: () => { throw "execution reverted"; } });
    expect(await reverted.tokenSupplyAt(A("7"), 1)).toBe(0n);
    await fake?.close();
    const empty = await reth({ eth_call: "0x" });
    expect(await empty.tokenSupplyAt(A("7"), 1)).toBe(0n);
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

  it("only lists eth_, net_ and web3_ methods, and trace_transaction (never a replay)", () => {
    for (const m of ALLOWED_METHODS) expect(m).toMatch(/^(eth|net|web3)_|^trace_transaction$/);
  });
});

describe("an answer bigger than the cap", () => {
  const big = { jsonrpc: "2.0", id: 1, result: "0x" + "ab".repeat(5000) };
  it("is refused as RethTooBig, and a small answer still comes through", async () => {
    fake = await startFakeReth({ trace_transaction: "0x" + "ab".repeat(5000), eth_blockNumber: "0x1" });
    const r = createReth(fake.url, 2000, 1000);
    const e = await r.rpc("trace_transaction", [H("a")]).catch((x) => x);
    expect(e).toBeInstanceOf(RethTooBig);
    expect((e as Error).message).toMatch(/trace_transaction: reth's answer is bigger than 1000 bytes/);
    expect(await r.blockNumber()).toBe(1);
  });

  it("is refused when it comes chunked with no length", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.write(JSON.stringify(big).slice(0, 4000)); setTimeout(() => res.end(JSON.stringify(big).slice(4000)), 20); });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const r = createReth(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 2000, 1000);
      await expect(r.rpc("trace_transaction", [H("a")])).rejects.toBeInstanceOf(RethTooBig);
    } finally {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    }
  });

  it("is 32 MB by default", () => {
    expect(MAX_ANSWER_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("reads as of one block, for verifyproxycontract", () => {
  it("asks for a storage slot, the code and a call at the block it is given", async () => {
    const seen: unknown[][] = [];
    const r = await reth({
      eth_getStorageAt: (p: unknown[]) => { seen.push(p); return H("0"); },
      eth_getCode: (p: unknown[]) => { seen.push(p); return "0x6080"; },
      eth_call: (p: unknown[]) => { seen.push(p); return "0x" + "0".repeat(24) + "ab".repeat(20); },
    });
    expect(await r.storageAt(A("5"), H("1"), 255)).toBe(H("0"));
    expect(await r.codeAt(A("5"), 255)).toBe("0x6080");
    expect(await r.callAt(A("6"), "0x5c60da1b", 255)).toBe("0x" + "0".repeat(24) + "ab".repeat(20));
    expect(seen.map((p) => p[p.length - 1])).toEqual(["0xff", "0xff", "0xff"]);
  });
  it("refuses a storage word that is not 32 bytes, and an answer of a call longer than 4 KB", async () => {
    const r = await reth({ eth_getStorageAt: () => "0x01", eth_call: () => "0x" + "00".repeat(4097) });
    await expect(r.storageAt(A("5"), H("1"), 1)).rejects.toThrow(RethError);
    await expect(r.callAt(A("6"), "0x5c60da1b", 1)).rejects.toMatchObject({ answered: true });
  });
});
