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
