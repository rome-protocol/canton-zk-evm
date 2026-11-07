import type { ApiStatus } from "../../api.ts";
import { addNetwork, walletWords, type Eip1193 } from "../../wallet.ts";

type Chain = Pick<ApiStatus, "chainId" | "chainName" | "coin">;

/**
 * Puts the wallet on Ostia: switches to it, or adds it from the explorer's own network details (the same call as the Add network button) when the wallet does not know it.
 * Says whether the wallet ended up on the chain, and why not when it did not.
 */
export async function ensureOstia(wallet: Eip1193, chain: Chain): Promise<{ ok: boolean; message: string | null }> {
  const on = async () => Number(BigInt(String(await wallet.request({ method: "eth_chainId" })))) === chain.chainId;
  try {
    if (await on()) return { ok: true, message: null };
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + chain.chainId.toString(16) }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      const said = await addNetwork(chain, chain.chainName, "below");
      if (!(await on())) return { ok: false, message: said };
    }
    return (await on()) ? { ok: true, message: null } : { ok: false, message: "Your wallet is not on " + chain.chainName + " yet." };
  } catch (e) {
    return { ok: false, message: walletWords(e) };
  }
}
