import { useCallback, useEffect, useState } from "react";
import type { ApiStatus } from "./api.ts";

/** What a browser wallet gives a page (EIP-1193). */
export interface Eip1193 {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...a: never[]) => void): void;
  removeListener?(event: string, fn: (...a: never[]) => void): void;
}
export const injected = (): Eip1193 | null => (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;

/** A wallet's refusal or failure in plain words. 4001 is the person saying no. */
export const walletWords = (e: unknown): string => {
  const x = e as { code?: number; message?: string } | null;
  return x?.code === 4001 ? "You declined it in your wallet." : x?.message ? x.message : "The wallet did not do it.";
};

type Chain = Pick<ApiStatus, "chainId" | "chainName" | "coin">;

/** The visitor's injected wallet: connected or not, which account, and which chain it is on. The explorer holds no key; every signature is the wallet's. */
export function useWallet(chain: Chain | undefined) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallet = injected();
  const read = useCallback(async (w: Eip1193) => {
    setChainId(Number(BigInt(String(await w.request({ method: "eth_chainId" })))));
  }, []);
  const connect = useCallback(async () => {
    const w = injected();
    if (!w) return setError("No wallet was found in this browser. Open this page in a browser with an EIP-1193 wallet.");
    try {
      const accounts = (await w.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(accounts[0]?.toLowerCase() ?? null);
      await read(w);
      setError(null);
    } catch (e) { setError(walletWords(e)); }
  }, [read]);
  const switchChain = useCallback(async () => {
    const w = injected();
    if (!w || !chain) return;
    const hex = "0x" + chain.chainId.toString(16);
    try {
      try { await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
      catch (e) {
        if ((e as { code?: number }).code !== 4902) throw e;
        await w.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: chain.chainName, nativeCurrency: { name: chain.coin.symbol, symbol: chain.coin.symbol, decimals: chain.coin.decimals }, rpcUrls: [`${location.origin}/rpc`], blockExplorerUrls: [location.origin] }] });
      }
      await read(w);
      setError(null);
    } catch (e) { setError(walletWords(e)); }
  }, [chain, read]);
  useEffect(() => {
    const w = injected();
    if (!w?.on) return;
    const onAccounts = (a: string[]) => setAccount(a[0]?.toLowerCase() ?? null);
    const onChain = (c: string) => setChainId(Number(BigInt(c)));
    w.on("accountsChanged", onAccounts as never);
    w.on("chainChanged", onChain as never);
    return () => { w.removeListener?.("accountsChanged", onAccounts as never); w.removeListener?.("chainChanged", onChain as never); };
  }, [account !== null]);
  return { available: wallet !== null, account, chainId, canSend: account !== null && chain !== undefined && chainId === chain.chainId, wrongChain: account !== null && chain !== undefined && chainId !== null && chainId !== chain.chainId, error, connect, switchChain };
}

/** The address wallets and scripts use, on this explorer's own host. */
export const rpcUrl = () => `${location.origin}/rpc`;

/** Asks the visitor's wallet to add this chain and says how it went. `name` is the chain's name as drawn (a caller may cut it); `where` is where the details are to be read when there is no wallet. */
export async function addNetwork(status: Pick<ApiStatus, "chainId" | "chainName" | "coin">, name: string, where: "above" | "below"): Promise<string> {
  const wallet = injected();
  if (!wallet) return `No wallet was found in this browser. Add the network by hand with ${where === "above" ? "the details above" : "the address below"}.`;
  try {
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x" + status.chainId.toString(16), chainName: status.chainName,
        nativeCurrency: { name: status.coin.symbol, symbol: status.coin.symbol, decimals: status.coin.decimals },
        rpcUrls: [rpcUrl()], blockExplorerUrls: [location.origin],
      }],
    });
    return `${name} is in your wallet.`;
  } catch (e) {
    const m = (e as { message?: string }).message;
    return `Your wallet did not add the network${m ? `: ${m.length > 160 ? `${m.slice(0, 159)}…` : m}` : "."}`;
  }
}
