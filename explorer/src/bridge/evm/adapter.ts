import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, type Address, type Hex } from "viem";
import { rpc } from "../../rpc.ts";
import { timeoutSignal } from "../../timeout.ts";
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
  /** The account's transaction count at "pending", as Ostia's own node answers it: above the final count means a transaction of the account waits in its pool, whatever the wallet says. Optional: a missing answer says nothing. */
  pendingNonce?(): Promise<number>;
  /** The nonce of the transaction the wallet returned this hash for, from the wallet itself; null when it does not say. */
  sentNonce(hash: Hex): Promise<number | null>;
  waitReceipt(hash: Hex): Promise<{ success: boolean }>;
}

/** The explorer's /rpc for the adapter's reads (`ViemOptions.read`), with the Bridge page's timeout. */
export const explorerRead = (method: string, params: unknown[]): Promise<unknown> => rpc(method, params, timeoutSignal());

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

export const payCall = (gateway: Address, id: Hex, erc20: Address, vault: Address, amount: bigint): Call => ({ to: gateway, data: encodeFunctionData({ abi: gatewayAbi, functionName: "pay", args: [id, erc20, vault, amount] }) });
export const releaseCall = (vault: Address, ref: string, erc20: Address, to: Address, amount: bigint): Call => ({ to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "release", args: [ref, erc20, to, amount] }) });
export const claimCall = (gateway: Address, id: Hex, erc20: Address, amount: bigint): Call => ({ to: gateway, data: encodeFunctionData({ abi: gatewayAbi, functionName: "claim", args: [id, erc20, amount] }) });

/** A send that stopped before the wallet was asked (the estimate failed): nothing was broadcast. It keeps the words of the error it wraps. */
export class NotSent extends Error {
  shortMessage?: string; code?: number;
  constructor(cause: unknown) {
    const c = cause as { message?: string; shortMessage?: string; code?: number } | null;
    super(c?.message ?? "The transaction could not be estimated.", { cause });
    this.shortMessage = c?.shortMessage; this.code = c?.code;
  }
}
/** EIP-1193 codes of a wallet that refused the request outright: the person said no (4001), the site may not ask (4100), the wallet cannot do it (4200). */
const REFUSED = [4001, 4100, 4200];
/**
 * Whether a failed send certainly sent nothing. Any other error (a timeout, a dropped connection, a request that expired) leaves it unknown: the wallet may have broadcast the transaction before it failed,
 * so the move keeps its record and looks at Ostia before it sends anything again.
 */
export function definitelyNotSent(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 6; x = (x as { cause?: unknown }).cause, depth++) {
    if (x instanceof NotSent) return true;
    const code = (x as { code?: unknown }).code;
    if (typeof code === "number" && REFUSED.includes(code)) return true;
  }
  return false;
}

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
    let gas: bigint;
    try { gas = padGas(await pub.estimateGas({ account, to, data, value })); } catch (e) { throw new NotSent(e); }
    return wal.sendTransaction({ account, chain, to, data, value, gas });
  }
  const read = <T>(erc20: Address, abi: typeof erc20Abi, functionName: "balanceOf" | "allowance", args: readonly Address[]) =>
    pub.readContract({ address: erc20, abi, functionName, args } as never) as Promise<T>;

  return {
    account,
    native: () => pub.getBalance({ address: account }),
    balanceOf: (erc20, holder) => read<bigint>(erc20, erc20Abi, "balanceOf", [holder ?? account]),
    nonce: () => pub.getTransactionCount({ address: account, blockTag: "latest" }),
    pendingNonce: () => pub.getTransactionCount({ address: account, blockTag: "pending" }),
    used: (gateway, id) => pub.readContract({ address: gateway, abi: gatewayAbi, functionName: "used", args: [id] }),
    allowance: (erc20, spender) => read<bigint>(erc20, erc20Abi, "allowance", [account, spender]),
    wrap: (wrapper, amount) => { const c = wrapCall(wrapper, amount); return send(c.to, c.data, amount); },
    approve: (erc20, spender, amount) => { const c = approveCall(erc20, spender, amount); return send(c.to, c.data); },
    pay: (gateway, id, erc20, vault, amount) => { const c = payCall(gateway, id, erc20, vault, amount); return send(c.to, c.data); },
    release: (vault, ref, erc20, to, amount) => { const c = releaseCall(vault, ref, erc20, to, amount); return send(c.to, c.data); },
    claim: (gateway, id, erc20, amount) => { const c = claimCall(gateway, id, erc20, amount); return send(c.to, c.data); },
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
