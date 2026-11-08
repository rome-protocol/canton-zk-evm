import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { short } from "../format.ts";
import { showBalance } from "../bridge/amounts.ts";
import type { Pair } from "../bridge/tokens.ts";

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
export function AccountPanel({ wallet, party, pairs, held, chainName }: { wallet: string; party: string | null; pairs: Pair[]; held: Record<string, bigint | null>; chainName: string }) {
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
          <p className="small muted">This is your address on Canton. Anyone on Canton can send tokens to it; only your MetaMask can move them.</p>
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
        </>
      )}
    </section>
  );
}
