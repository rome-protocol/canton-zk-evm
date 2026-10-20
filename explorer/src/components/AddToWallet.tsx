import { useState } from "react";
import type { ApiStatus } from "../api.ts";
import { copyText } from "./HashLink.tsx";
import { Icon } from "./Icon.tsx";

interface Provider { request(call: { method: string; params: unknown[] }): Promise<unknown> }

/** The address wallets and scripts use, on this explorer's own host. */
export const rpcUrl = () => `${location.origin}/rpc`;

/**
 * A button that asks the visitor's wallet to add this chain, and the RPC address with a copy button. It shows nothing when the
 * explorer does not serve the public RPC, because there would be no address to give.
 */
export function AddToWallet({ status }: { status: Pick<ApiStatus, "chainId" | "chainName" | "coin" | "publicRpc"> }) {
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!status.publicRpc) return null;
  const url = rpcUrl();
  const add = async () => {
    const wallet = (window as unknown as { ethereum?: Provider }).ethereum;
    if (!wallet) return setNote("No wallet was found in this browser. Add the network by hand with the address below.");
    try {
      await wallet.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x" + status.chainId.toString(16), chainName: status.chainName,
          nativeCurrency: { name: status.coin.symbol, symbol: status.coin.symbol, decimals: status.coin.decimals },
          rpcUrls: [url], blockExplorerUrls: [location.origin],
        }],
      });
      setNote(`${status.chainName} is in your wallet.`);
    } catch (e) {
      setNote(`Your wallet did not add the network${(e as { message?: string }).message ? `: ${(e as { message: string }).message}` : "."}`);
    }
  };
  return (
    <section className="card rpc-card" aria-labelledby="rpc-h">
      <h3 id="rpc-h">Add {status.chainName} to your wallet</h3>
      <p className="muted small">A receipt from this address means the block is proven and final on Canton.</p>
      <div className="rpc-row">
        <button type="button" className="rpc-btn" onClick={add}>Add {status.chainName} to your wallet</button>
        <span className="rpc-url" aria-label="RPC address">{url}</span>
        <button type="button" className="copy" aria-label={copied ? "Copied" : "Copy the RPC address"} onClick={async () => {
          if (!(await copyText(url))) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}><Icon name={copied ? "check" : "copy"} size={13} /></button>
      </div>
      <div className="rpc-msg" role="status">{note}</div>
    </section>
  );
}
