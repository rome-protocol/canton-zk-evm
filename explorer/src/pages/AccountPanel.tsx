import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { OutLink } from "../components/Help.tsx";
import { ACCOUNT_KEY_WORDS, TRUST_MODEL_URL } from "../copy.ts";
import { short } from "../format.ts";
import { showBalance } from "../bridge/amounts.ts";
import type { Sender } from "../bridge/send.ts";
import type { Pair } from "../bridge/tokens.ts";
import { inWallet } from "../bridge/wallet/wallets.ts";
import { IncomingTransfers, SendOnCanton } from "./CantonSend.tsx";

/** One address with its Copy button: the short form on the screen, the whole address on copy. */
function Address({ label, value, copyLabel, lead, tail }: { label: string; value: string; copyLabel: string; lead: number; tail: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [value]);
  return (
    <div className="addr">
      <span className="lbl">{label}</span>
      <span className="mono">{short(value, lead, tail)}</span>
      <button type="button" className="copy" aria-label={copyLabel} onClick={() => { navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {}); }}><Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/**
 * The Bridge page's account panel: the wallet's address on Ostia and the Canton account's, side by side, and what the Canton account holds of each token this build lists.
 * Before the Canton account is open it is the short version: the wallet's address, and a word that the account is not open yet.
 * It reads nothing itself: the balances are the move card's read of the account's holdings (`held`, by token key), so a page with the panel asks the account service for no more than before.
 */
export function AccountPanel({ wallet, party, pairs, held, chainName, sender = null, refresh = 0, onChanged = () => {}, kept = null, cantonWallet = null }: {
  wallet: string; party: string | null;
  /** The name of the connected Canton wallet, when the Canton account is a wallet's: it signs and sends in the wallet itself. */
  cantonWallet?: string | null; pairs: Pair[]; held: Record<string, bigint | null>; chainName: string;
  /** What signs a send and an accept for the open account (null until it is ready); `onChanged` is said after one, so the balances are read again, and `refresh` counts up when they were. */
  sender?: Sender | null; refresh?: number; onChanged?: () => void;
  /** Set when this browser keeps the open account's key: the button that removes it, and what to say when the browser could not. */
  kept?: { onClose: () => void; note: string | null } | null;
}) {
  return (
    <section className="card addrs" aria-label="Your addresses">
      <div className="addr-pair">
        <Address label={`Your wallet on ${chainName}`} value={wallet} copyLabel={`Copy your wallet address on ${chainName}`} lead={6} tail={4} />
        {party ? (
          <Address label="Your account on Canton" value={party} copyLabel="Copy your account address on Canton" lead={16} tail={6} />
        ) : (
          <div className="addr"><span className="lbl">Your account on Canton</span><span className="muted">Not opened yet</span></div>
        )}
      </div>
      {party && (
        <>
          {cantonWallet ? (
            <p className="small muted">This is your address on Canton. Sending and accepting are done in {inWallet(cantonWallet)} itself.</p>
          ) : (
            <p className="small muted">{ACCOUNT_KEY_WORDS} <OutLink href={TRUST_MODEL_URL}>Limits</OutLink></p>
          )}
          {kept && (
            <>
              <p className="small muted">This browser keeps your account's key: a reload does not ask your wallet again. The key is stored here and cannot be read out, but a script running on this page could still sign with it while it is kept. Removing it here does not close the account on Canton.</p>
              <button type="button" className="btn ghost" onClick={kept.onClose}>Remove my Canton key from this browser</button>
              {kept.note && <p className="small bad" role="alert">{kept.note}</p>}
            </>
          )}
          {pairs.length > 0 && (
            <>
              <p className="small muted" id="canton-holds">On Canton</p>
              <ul className="coins" aria-labelledby="canton-holds">
                {pairs.map((p) => {
                  const b = held[p.key];
                  return <li key={p.key}><span>{p.canton.symbol}</span><span className="num">{b === undefined || b === null ? "–" : showBalance(b, p.canton.decimals)}</span></li>;
                })}
              </ul>
            </>
          )}
          {sender && <SendOnCanton sender={sender} pairs={pairs} held={held} party={party} onChanged={onChanged} />}
          {sender && <IncomingTransfers sender={sender} pairs={pairs} refresh={refresh} onChanged={onChanged} />}
        </>
      )}
    </section>
  );
}
