import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Address } from "viem";
import type { Eip1193 } from "../../wallet.ts";
import { padGas, viemAdapter } from "./adapter.ts";

const ME = ("0x" + "11".repeat(20)) as Address, GATEWAY = ("0x" + "22".repeat(20)) as Address, TOKEN = ("0x" + "aa".repeat(20)) as Address;
const chain = { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } };

function setup(estimate: () => string = () => "0x186a0") {
  const sent: Record<string, string>[] = [];
  const reads: string[] = [];
  const wallet: Eip1193 = {
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return "0x" + chain.chainId.toString(16);
      if (method === "eth_sendTransaction") { sent.push((params as Record<string, string>[])[0]!); return "0x" + "ab".repeat(32); }
      throw new Error(`the wallet was asked ${method}`);
    },
  };
  const read = async (method: string, params: unknown[] = []) => {
    reads.push(method);
    if (method === "eth_estimateGas") return estimate();
    if (method === "eth_getBalance") return "0x64";
    if (method === "eth_getTransactionCount") return "0x9";
    if (method === "eth_call") return "0x" + ((params[0] as { data: string }).data.startsWith(toFunctionSelector("used(bytes32)")) ? 1 : 7).toString(16).padStart(64, "0");
    throw new Error(`the RPC was asked ${method}`);
  };
  return { adapter: viemAdapter({ wallet, account: ME, chain, read }), sent, reads };
}

describe("the viem adapter", () => {
  it("pads the estimate by a fifth", () => expect(padGas(100_000n)).toBe(120_000n));

  it("estimates through the explorer's RPC, then has the wallet send pay() to the gateway with the padded gas", async () => {
    const { adapter, sent, reads } = setup();
    const tx = await adapter.pay(GATEWAY, ("0x" + "01".repeat(32)) as `0x${string}`, TOKEN, ("0x" + "33".repeat(20)) as Address, 5n);
    expect(tx).toBe("0x" + "ab".repeat(32));
    expect(reads).toContain("eth_estimateGas");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to!.toLowerCase()).toBe(GATEWAY);
    expect(sent[0]!.data!.slice(0, 10)).toBe(toFunctionSelector("pay(bytes32,address,address,uint256)"));
    expect(BigInt(sent[0]!.gas!)).toBe(120_000n);
  });
  it("sends the wrap as a deposit() that carries the value", async () => {
    const { adapter, sent } = setup();
    await adapter.wrap(TOKEN, 1000n);
    expect(sent[0]!.data).toBe(toFunctionSelector("deposit()"));
    expect(BigInt(sent[0]!.value!)).toBe(1000n);
  });
  it("asks the wallet for nothing when the estimate fails", async () => {
    const { adapter, sent } = setup(() => { throw new Error("execution reverted: id used"); });
    await expect(adapter.claim(GATEWAY, ("0x" + "01".repeat(32)) as `0x${string}`, TOKEN, 1n)).rejects.toThrow();
    expect(sent).toEqual([]);
  });
  it("reads balances through the RPC", async () => {
    const { adapter } = setup();
    expect(await adapter.native()).toBe(100n);
    expect(await adapter.balanceOf(TOKEN)).toBe(7n);
    expect(await adapter.allowance(TOKEN, GATEWAY)).toBe(7n);
    expect(await adapter.balanceOf(TOKEN, GATEWAY)).toBe(7n);
  });
  it("gives the account's pending nonce and the gateway's used(id)", async () => {
    const { adapter, reads } = setup();
    expect(await adapter.nonce()).toBe(9);
    expect(await adapter.used(GATEWAY, ("0x" + "01".repeat(32)) as `0x${string}`)).toBe(true);
    expect(reads).toContain("eth_getTransactionCount");
  });
});
