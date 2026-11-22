// What the wallet holds, for the card: the token it sends (on Ostia through the explorer, on the other chain through the wallet while it is on that chain) and Ostia's coin for fees. A balance that cannot be read is null.
import { decodeFunctionResult, encodeFunctionData, erc20Abi, type Hex } from "viem";
import type { Eip1193 } from "../../wallet.ts";
import type { Asset } from "./setup.ts";
import type { Dir } from "./record.ts";

type Read = (method: string, params: unknown[]) => Promise<unknown>;
const big = (v: unknown): bigint | null => { try { return BigInt(String(v)); } catch { return null; } };

export interface Balances {
  /** What the wallet can send: the other chain's ether or token (`in`), or the token on Ostia (`out`). */
  from: bigint | null;
  /** What the wallet holds of Ostia's own coin (fees there). */
  coin: bigint | null;
}

export async function readBalances(o: { dir: Dir; asset: Asset; account: string; read: Read; wallet: Eip1193 | null; walletChainId: number | null; otherChainId: number }): Promise<Balances> {
  const coin = await o.read("eth_getBalance", [o.account, "latest"]).then(big, () => null);
  if (o.dir === "in") {
    // A wallet answers only for the chain it is on.
    if (!o.wallet || o.walletChainId !== o.otherChainId) return { from: null, coin };
    try {
      if (o.asset.sepolia === "native") return { from: big(await o.wallet.request({ method: "eth_getBalance", params: [o.account, "latest"] })), coin };
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [o.account as Hex] });
      const out = await o.wallet.request({ method: "eth_call", params: [{ to: o.asset.sepolia, data }, "latest"] });
      return { from: decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: out as Hex }), coin };
    } catch { return { from: null, coin }; }
  }
  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [o.account as Hex] });
    const out = await o.read("eth_call", [{ to: o.asset.ostia, data }, "latest"]);
    return { from: decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: out as Hex }), coin };
  } catch { return { from: null, coin }; }
}
