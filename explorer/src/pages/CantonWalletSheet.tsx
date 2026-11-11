import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { short } from "../format.ts";
import { inWallet } from "../bridge/wallet/wallets.ts";
import type { WalletState } from "./useCantonWallet.ts";

/**
 * The Canton side of the sheet when the build offers Canton wallets: "Connect your Canton wallet" (the wallet asks to approve), the way to the Bridge account from MetaMask, and once a wallet is
 * connected its address and name, the opt-in the first time, and Disconnect. Moves are approved in the wallet, which shows each Canton step before it signs.
 */
export function CantonWalletSheet({ state, onConnect, onPick, onOptIn, onDisconnect, onBridgeAccount }: { state: WalletState; onConnect(): void; onPick(id: string): void; onOptIn(): void; onDisconnect(): void; onBridgeAccount(): void }) {
  const [copied, setCopied] = useState(false);
  const party = state.s === "ready" ? state.link.party : "";
  useEffect(() => setCopied(false), [party]);
  // The wallet's code is fetched ahead of the click, so a wallet that opens a window can do it at once (a browser lets a page open a window only just after a click).
  useEffect(() => { if (state.s === "idle" || state.s === "failed") void import("../bridge/wallet/connect.ts"); }, [state.s]);

  if (state.s === "ready") {
    const where = inWallet(state.link.name);
    return (
      <>
        <p className="ready">
          <span className="sd ok"><i /><b>Connected</b></span> <span className="mono" title={party}>{short(party, 16, 6)}</span> <span className="wname">{state.link.name}</span>
          <button type="button" className="copy" aria-label="Copy account id" onClick={() => { navigator.clipboard?.writeText(party).then(() => setCopied(true), () => {}); }}><Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}</button>
        </p>
        {state.opted ? (
          <p className="small muted">Each Canton step of a move opens in {where} for you to approve.</p>
        ) : (
          <>
            <p className="lead">Opt in once: Ostia tokens and withdrawals. You approve two steps in {where}.</p>
            <button type="button" className="btn" disabled={state.opting} onClick={onOptIn}>{state.opting ? `Waiting for ${where}…` : "Opt in"}</button>
            {state.note && <p className="small bad" role="alert">{state.note}</p>}
          </>
        )}
        <p className="small muted">The Canton Coin faucet on this page is for Bridge accounts only. Get test Canton Coin in {where}.</p>
        <div className="actions"><button type="button" className="btn ghost" onClick={onDisconnect}>Disconnect</button></div>
      </>
    );
  }
  if (state.s === "choosing") {
    return (
      <>
        <p className="lead">Which wallet?</p>
        <div className="actions">{state.choices.map((c) => <button key={c.id} type="button" className="btn" onClick={() => onPick(c.id)}>{c.name}</button>)}</div>
        <p className="small muted">No Canton wallet? <button type="button" className="link-b" onClick={onBridgeAccount}>Use a Bridge account from your wallet</button></p>
      </>
    );
  }
  return (
    <>
      <p className="lead">Use the Canton wallet you already have. It shows each Canton step of a move and you approve it there.</p>
      <button type="button" className="btn" disabled={state.s === "working"} onClick={onConnect}>{state.s === "working" ? state.note : "Connect your Canton wallet"}</button>
      <p className="small muted">No Canton wallet? <button type="button" className="link-b" onClick={onBridgeAccount}>Use a Bridge account from your wallet</button></p>
      {state.s === "failed" && <p className="small bad" role="alert">{state.message}</p>}
    </>
  );
}
