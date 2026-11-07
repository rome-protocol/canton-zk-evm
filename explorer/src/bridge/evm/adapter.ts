import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, type Address, type Hex } from "viem";
import type { Eip1193 } from "../../wallet.ts";
import { erc20Abi, gatewayAbi, vaultAbi, wrapperAbi } from "./abi.ts";

/**
 * What the moves need of Ostia, one call per step. Each send returns the transaction hash once the wallet has signed it; `waitReceipt` returns when the block is final
 * (the explorer's RPC answers a receipt only then). The viem version below is the real one; the tests give the moves a fake.
 */
export interface EvmAdapter {
  account: Address;
  native(): Promise<bigint>;
  /** The balance of `holder` (the account itself when none is named). */
  balanceOf(erc20: Address, holder?: Address): Promise<bigint>;
  /** The account's transaction count at the final block ("latest"): a lower bound of the nonce its next send takes. The explorer's RPC passes "pending" through to the node's pool for transaction counts, but a move saves only this count, which does not depend on it. */
  nonce(): Promise<number>;
  /** The gateway's `used(id)`: the id has been paid, claimed or released. */
  used(gateway: Address, id: Hex): Promise<boolean>;
  allowance(erc20: Address, spender: Address): Promise<bigint>;
  wrap(wrapper: Address, amount: bigint): Promise<Hex>;
  approve(erc20: Address, spender: Address, amount: bigint): Promise<Hex>;
  pay(gateway: Address, id: Hex, erc20: Address, vault: Address, amount: bigint): Promise<Hex>;
  release(vault: Address, ref: string, erc20: Address, to: Address, amount: bigint): Promise<Hex>;
  claim(gateway: Address, id: Hex, erc20: Address, amount: bigint): Promise<Hex>;
  withdraw(gateway: Address, erc20: Address, amount: bigint, party: string): Promise<Hex>;
  /** The account's transaction count as the wallet provider itself answers it (not the explorer's RPC, which shows only final blocks), pending and latest: pending above latest means a transaction of the account is still waiting. Null when the wallet does not answer. */
  walletNonces(): Promise<{ pending: number; latest: number } | null>;
  /** The nonce of the transaction the wallet returned this hash for, from the wallet itself; null when it does not say. */
  sentNonce(hash: Hex): Promise<number | null>;
  waitReceipt(hash: Hex): Promise<{ success: boolean }>;
}

export interface ViemOptions {
  wallet: Eip1193;
  account: Address;
  chain: { chainId: number; chainName: string; coin: { symbol: string; decimals: number } };
  /** A read-only JSON-RPC call to Ostia (the explorer's /rpc). */
  read(method: string, params: unknown[]): Promise<unknown>;
  /** How long a receipt is waited for, and how often it is asked. */
  receiptTimeoutMs?: number; pollMs?: number;
}

/** Gas the estimate gives, with a fifth more on top: the chain's blocks are fixed, so a short limit is the one failure that costs a fee. */
export const padGas = (g: bigint): bigint => (g * 12n) / 10n;

/** The exact call a step makes: where it goes, its input data and, for the wrap, the value in wei (a decimal string). A move keeps it, so a transaction found later can be matched to it exactly. */
export interface Call { to: Address; data: Hex; value?: string }
export const wrapCall = (wrapper: Address, amount: bigint): Call => ({ to: wrapper, data: encodeFunctionData({ abi: wrapperAbi, functionName: "deposit" }), value: amount.toString() });
export const approveCall = (erc20: Address, spender: Address, amount: bigint): Call => ({ to: erc20, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });
export const withdrawCall = (gateway: Address, erc20: Address, amount: bigint, party: string): Call => ({ to: gateway, data: encodeFunctionData({ abi: gatewayAbi, functionName: "withdraw", args: [erc20, amount, party] }) });

export function viemAdapter(o: ViemOptions): EvmAdapter {
  const chain = defineChain({
    id: o.chain.chainId, name: o.chain.chainName,
    nativeCurrency: { name: o.chain.coin.symbol, symbol: o.chain.coin.symbol, decimals: o.chain.coin.decimals },
    rpcUrls: { default: { http: ["/rpc"] } },
  });
  const pub = createPublicClient({ chain, transport: custom({ request: (a: { method: string; params?: unknown }) => o.read(a.method, (a.params as unknown[] | undefined) ?? []) as Promise<never> }) });
  const wal = createWalletClient({ account: o.account, chain, transport: custom(o.wallet as unknown as Parameters<typeof custom>[0]) });
  const account = o.account;

  /** Estimates first (a call that would revert stops here, before the wallet is asked), then asks the wallet to send with the padded limit. */
  async function send(to: Address, data: Hex, value?: bigint): Promise<Hex> {
    const gas = padGas(await pub.estimateGas({ account, to, data, value }));
    return wal.sendTransaction({ account, chain, to, data, value, gas });
  }
  const read = <T>(erc20: Address, abi: typeof erc20Abi, functionName: "balanceOf" | "allowance", args: readonly Address[]) =>
    pub.readContract({ address: erc20, abi, functionName, args } as never) as Promise<T>;

  return {
    account,
    native: () => pub.getBalance({ address: account }),
    balanceOf: (erc20, holder) => read<bigint>(erc20, erc20Abi, "balanceOf", [holder ?? account]),
    nonce: () => pub.getTransactionCount({ address: account, blockTag: "latest" }),
    used: (gateway, id) => pub.readContract({ address: gateway, abi: gatewayAbi, functionName: "used", args: [id] }),
    allowance: (erc20, spender) => read<bigint>(erc20, erc20Abi, "allowance", [account, spender]),
    wrap: (wrapper, amount) => { const c = wrapCall(wrapper, amount); return send(c.to, c.data, amount); },
    approve: (erc20, spender, amount) => { const c = approveCall(erc20, spender, amount); return send(c.to, c.data); },
    pay: (gateway, id, erc20, vault, amount) => send(gateway, encodeFunctionData({ abi: gatewayAbi, functionName: "pay", args: [id, erc20, vault, amount] })),
    release: (vault, ref, erc20, to, amount) => send(vault, encodeFunctionData({ abi: vaultAbi, functionName: "release", args: [ref, erc20, to, amount] })),
    claim: (gateway, id, erc20, amount) => send(gateway, encodeFunctionData({ abi: gatewayAbi, functionName: "claim", args: [id, erc20, amount] })),
    withdraw: (gateway, erc20, amount, party) => { const c = withdrawCall(gateway, erc20, amount, party); return send(c.to, c.data); },
    walletNonces: async () => {
      try {
        const count = async (tag: string) => Number(BigInt(String(await o.wallet.request({ method: "eth_getTransactionCount", params: [account, tag] }))));
        return { pending: await count("pending"), latest: await count("latest") };
      } catch { return null; }
    },
    sentNonce: async (hash) => {
      try {
        const t = (await o.wallet.request({ method: "eth_getTransactionByHash", params: [hash] })) as { nonce?: string } | null;
        return typeof t?.nonce === "string" ? Number(BigInt(t.nonce)) : null;
      } catch { return null; }
    },
    waitReceipt: async (hash) => {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: o.receiptTimeoutMs ?? 600_000, pollingInterval: o.pollMs ?? 2_000 });
      return { success: r.status === "success" };
    },
  };
}
