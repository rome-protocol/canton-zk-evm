import { encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { redeemRequest, type Chain as CantonChain } from "../src/bridge/canton/commands.ts";
import { keyFromSignature } from "../src/bridge/canton/key.ts";
import { signPrepared, UnexpectedTransaction } from "../src/bridge/canton/sign.ts";
import { erc20Abi, gatewayAbi, vaultAbi } from "../src/bridge/evm/abi.ts";
import { BUILD_PINS, loadBridgeConfig } from "../src/bridge/evm/config.ts";
import { viemAdapter } from "../src/bridge/evm/adapter.ts";
import { releaseIdOf } from "../src/bridge/moves/state.ts";
import { freshChain, GATEWAY, twinsOverview, ME_BALANCE, preparedRedeem, rpcResult, sendTransaction, TKA, txAnswer, VAULT, VAULT_CODE } from "./bridge-fakes.ts";

// The fakes of the browser tests of moves, checked here without a browser: what the page would reject in them is rejected here first.
const PARTY = "alice::1220" + "ab".repeat(32);
const chain: CantonChain = { operator: "operator::1220" + "01".repeat(32), confirmer: "confirmer::1220" + "02".repeat(32), gateway: "gateway::1220" + "03".repeat(32), builder: "builder::1220" + "04".repeat(32), chainId: 770101 };
const ME = "0x" + "11".repeat(20);

describe("the fake account service's prepared transaction", () => {
  it("is a redeem request the page's own checks sign, and not one for another amount", async () => {
    const key = await keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1b");
    const built = redeemRequest(PARTY, chain, TKA, ["00" + "ee".repeat(40)], "5.0000000000", ME, "ref-9");
    const prepared = await preparedRedeem(PARTY, (built.command as { CreateCommand: { createArguments: Record<string, unknown> } }).CreateCommand.createArguments);
    expect((await signPrepared(key, built.intent, prepared)).length).toBe(64);
    await expect(signPrepared(key, redeemRequest(PARTY, chain, TKA, ["00" + "ee".repeat(40)], "6.0000000000", ME, "ref-9").intent, prepared)).rejects.toThrow(UnexpectedTransaction);
  });
});

describe("the fake chain", () => {
  it("answers the reads the page makes of the gateway, the vault and the ERC-20", () => {
    const c = freshChain();
    const call = (to: string, abi: any, functionName: string, args: unknown[] = []) => rpcResult(c, ME, "eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, "latest"]);
    expect(call(VAULT, vaultAbi, "GATEWAY")).toBe("0x" + "00".repeat(12) + GATEWAY.slice(2).toLowerCase());
    expect(BigInt(call(TKA, erc20Abi, "balanceOf", [ME]) as string)).toBe(ME_BALANCE);
    expect(BigInt(call(TKA, erc20Abi, "decimals") as string)).toBe(18n);
    expect(call(GATEWAY, gatewayAbi, "used", ["0x" + "00".repeat(32)])).toBe("0x" + "00".repeat(32));
    expect(rpcResult(c, ME, "eth_getCode", [VAULT, "latest"])).toBe(VAULT_CODE);
  });
  it("records an approval and the leg of a payment and of a release, and shows them final", () => {
    const c = freshChain();
    sendTransaction(c, { from: ME, to: TKA, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GATEWAY as Hex, 5n] }) });
    expect(c.allowance).toBe(5n);
    const id = ("0x" + "ab".repeat(32)) as Hex;
    const pay = sendTransaction(c, { from: ME, to: GATEWAY, data: encodeFunctionData({ abi: gatewayAbi, functionName: "pay", args: [id, TKA as Hex, VAULT as Hex, 5n] }) });
    expect(txAnswer(c, pay)).toMatchObject({ status: "final", success: true, block: { number: 36512 }, legs: [{ kind: "payment", legId: id }] });
    const release = sendTransaction(c, { from: ME, to: VAULT, data: encodeFunctionData({ abi: vaultAbi, functionName: "release", args: ["ref-9", TKA as Hex, ME as Hex, 5n] }) });
    expect(txAnswer(c, release)!.legs[0]).toMatchObject({ legId: releaseIdOf(VAULT as Hex, "ref-9") });
    expect(rpcResult(c, ME, "eth_getTransactionReceipt", [pay])).toMatchObject({ status: "0x1" });
    expect(txAnswer(c, "0xnope")).toBeNull();
  });
});

describe("the fake chain, with the page's own Ostia adapter", () => {
  it("lets the adapter read balances, send an approval and a payment through a wallet, and see them final", async () => {
    const c = freshChain();
    const wallet = { request: async ({ method, params }: { method: string; params?: any[] }) => {
      if (method === "eth_sendTransaction") return sendTransaction(c, params![0]);
      if (method === "eth_chainId") return "0x" + (770101).toString(16);
      return rpcResult(c, ME, method, params ?? []);
    } };
    const evm = viemAdapter({ wallet, account: ME as Hex, chain: { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } }, read: async (m, p) => rpcResult(c, ME, m, p), pollMs: 5 });
    expect(await evm.balanceOf(TKA as Hex)).toBe(ME_BALANCE);
    expect(await evm.balanceOf(TKA as Hex, VAULT as Hex)).toBe(10n ** 21n);
    expect(await evm.native()).toBe(10n ** 18n);
    const approved = await evm.approve(TKA as Hex, GATEWAY as Hex, 7n);
    expect((await evm.waitReceipt(approved)).success).toBe(true);
    expect(await evm.allowance(TKA as Hex, GATEWAY as Hex)).toBe(7n);
    const id = ("0x" + "cd".repeat(32)) as Hex;
    const paid = await evm.pay(GATEWAY as Hex, id, TKA as Hex, VAULT as Hex, 7n);
    expect(txAnswer(c, paid)!.legs).toHaveLength(1);
    expect(await evm.sentNonce(paid)).toBe(8);
    expect(await evm.walletNonces()).toEqual({ pending: 9, latest: 9 });
    expect(await evm.used(GATEWAY as Hex, id)).toBe(false);
  });
});

describe("the fake chain, with the page's own reading of the bridge's configuration", () => {
  it("is a chain the page accepts: the pinned gateway, the pinned vault code, and one twin of 18 decimals", async () => {
    const c = freshChain();
    const config = await loadBridgeConfig({
      status: async () => ({ chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } }) as never,
      twins: async () => twinsOverview("http://127.0.0.1:4173/twin-registry") as never,
      call: async (to, data) => rpcResult(c, ME, "eth_call", [{ to, data }, "latest"]) as string,
      code: async (address) => rpcResult(c, ME, "eth_getCode", [address, "latest"]) as string,
    }, BUILD_PINS);
    expect(config).toMatchObject({ gateway: GATEWAY.toLowerCase(), vault: VAULT, registryUrl: "http://127.0.0.1:4173/twin-registry", twins: [{ address: TKA, symbol: "TKA", decimals: 18 }], wrapped: [], wrapper: null });
  });
});
