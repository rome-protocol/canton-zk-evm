// The real `Env` of a transfer: Ostia is read through the explorer's own /rpc, the other chain only through the person's wallet (the explorer's server reads it for the bridge's own facts, never
// for the wallet's). Every send is the wallet's.
import type { Hex } from "viem";
import type { ApiStatus } from "../../api.ts";
import { walletWords, type Eip1193 } from "../../wallet.ts";
import { ensureOstia } from "../evm/network.ts";
import { NotSent, padGas } from "../evm/adapter.ts";
import { asTransaction, type Call } from "./calls.ts";
import { readClaim, readDeposit } from "./reads.ts";
import { Stop, WrongChain, type Env, type Plan, type Receipt, type Seen } from "./transfer.ts";
import type { LocksLike } from "../moves/moves.ts";
import type { StoreLike } from "../moves/state.ts";
import { plainText } from "../words.ts";

type Read = (method: string, params: unknown[]) => Promise<unknown>;
export interface WireOptions {
  wallet: Eip1193;
  account: string;
  plan: Plan;
  /** Ostia as the explorer's status names it (its chain id, name and coin): the wallet is put on it with the explorer's own network details. */
  ostia: Pick<ApiStatus, "chainId" | "chainName" | "coin">;
  /** A read of Ostia through the explorer's /rpc. */
  read: Read;
  store: StoreLike | null;
  locks: LocksLike | null;
  now?: () => number;
  newId?: () => string;
}

const hexNumber = (v: unknown): number => Number(BigInt(String(v)));
const hashText = (v: unknown): Hex => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("The wallet did not give a transaction hash.");
  return v as Hex;
};

/** Puts the wallet on a chain it already knows. A wallet that does not know the chain is told to add it by hand: the page does not add chains it has no network details of. */
export async function ensureOther(wallet: Eip1193, chainId: number, name: string): Promise<string | null> {
  const on = async () => hexNumber(await wallet.request({ method: "eth_chainId" })) === chainId;
  try {
    if (await on()) return null;
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + chainId.toString(16) }] });
    } catch (e) {
      if ((e as { code?: number }).code === 4902) return `Your wallet does not know ${name} yet. Add it in your wallet's network list, then try again.`;
      throw e;
    }
    return (await on()) ? null : `Your wallet is not on ${name} yet.`;
  } catch (e) {
    return walletWords(e);
  }
}

export function createEnv(o: WireOptions): Env {
  const { wallet, plan } = o;
  const account = o.account.toLowerCase();
  const onChain = async (chainId: number) => { try { return hexNumber(await wallet.request({ method: "eth_chainId" })) === chainId; } catch { return false; } };
  /** Ostia through the explorer; any other chain through the wallet, and only while the wallet is on it. */
  async function ask(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    if (chainId === plan.ostia.chainId) return o.read(method, params);
    if (!(await onChain(chainId))) throw new WrongChain(chainId);
    return wallet.request({ method, params });
  }
  return {
    plan, account, store: o.store, locks: o.locks, now: o.now ?? Date.now, newId: o.newId ?? (() => crypto.randomUUID()),
    async ensure(chainId) {
      if (chainId === plan.ostia.chainId) { const r = await ensureOstia(wallet, o.ostia); return r.ok ? null : plainText(r.message) ?? `Your wallet is not on ${o.ostia.chainName} yet.`; }
      return ensureOther(wallet, chainId, plan.other.name);
    },
    onChain,
    async nonces() {
      try {
        const count = async (tag: string) => hexNumber(await wallet.request({ method: "eth_getTransactionCount", params: [account, tag] }));
        return { pending: await count("pending"), latest: await count("latest") };
      } catch { return null; }
    },
    async send(chainId: number, call: Call): Promise<Hex> {
      let gas: bigint;
      try { gas = padGas(BigInt(String(await ask(chainId, "eth_estimateGas", [asTransaction(account, call)])))); } catch (e) { throw new NotSent(e); }
      // The wallet may have changed network since the check before the estimate: look again right before it is asked, and name the chain in the request, as the Canton page's client does.
      if (!(await onChain(chainId))) throw new NotSent(new Stop(`Your wallet is not on ${chainId === plan.ostia.chainId ? plan.ostia.name : plan.other.name}. Nothing was sent.`));
      return hashText(await wallet.request({ method: "eth_sendTransaction", params: [asTransaction(account, call, gas, chainId)] }));
    },
    async receipt(chainId, hash): Promise<Receipt | null> {
      const r = (await ask(chainId, "eth_getTransactionReceipt", [hash])) as { status?: string; logs?: { address: string; topics: string[]; data: string }[] } | null;
      return r ? { ok: r.status === "0x1", logs: Array.isArray(r.logs) ? r.logs : [] } : null;
    },
    async lookup(chainId, hash): Promise<Seen | null> {
      const t = (await ask(chainId, "eth_getTransactionByHash", [hash])) as { from?: string; to?: string | null; input?: string; value?: string } | null;
      return t && typeof t.from === "string" && typeof t.input === "string" ? { from: t.from, to: t.to ?? null, input: t.input, value: BigInt(t.value ?? "0x0").toString() } : null;
    },
    deposit: (network, count) => readDeposit(network, count),
    claim: (network, count) => readClaim(network, count),
  };
}

