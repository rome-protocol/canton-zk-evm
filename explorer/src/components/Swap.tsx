import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getSwap, type BlockLeg, type SwapItem } from "../api.ts";
import { count, dateTime, short, units } from "../format.ts";
import { LegAmount, LegToken, useLegToken } from "../pages/LegParts.tsx";
import { BlockLegs } from "./BlockParts.tsx";
import { HashLink } from "./HashLink.tsx";
import { Icon } from "./Icon.tsx";
import { Info } from "./Info.tsx";
import "./swap.css";

/** Canton holds an amount with ten decimals, as the gateway's custody does. */
export const CANTON_DECIMALS = 10;
/** A block's or a transaction's answer carries this many legs; the block's own legs route has the rest. */
export const LEGS_SHOWN = 50;
/** A block with more swap legs than this shows each from its leg alone, with no read per card. */
const SWAP_LOOKUPS = 5;

/** What a swap card shows, from a swap or from the leg that paid it. The payer and the symbol are null where the leg alone does not say. */
export interface SwapView {
  payId: string; updateId: string | null; recordTime: string | null;
  canton: { amount: string | null; instrument: string | null };
  evm: { token: string; symbol: string | null; decimals: number | null; payer: string | null; payee: string; amount: string };
  claimant: string | null;
}

export const viewOfSwap = (s: SwapItem): SwapView => ({
  payId: s.payId, updateId: s.payment.updateId, recordTime: s.payment.recordTime,
  canton: { amount: s.canton.amount, instrument: s.canton.instrument?.id ?? null },
  evm: { ...s.evm }, claimant: s.canton.recipient,
});

/** The card of a payment leg that settled a venue's trade; null for any other leg. `payer` is the sender of the transaction when the page knows it. */
export function viewOfLeg(l: BlockLeg, payer: string | null = null): SwapView | null {
  if (l.canton?.role !== "venue-trade") return null;
  return {
    payId: l.legId, updateId: l.canton.settledUpdateId ?? l.updateId, recordTime: null,
    canton: { amount: l.canton.amount, instrument: l.canton.instrument?.id ?? null },
    evm: { token: l.token, symbol: null, decimals: null, payer, payee: l.account, amount: l.amount }, claimant: l.canton.recipient,
  };
}

/** The two amounts of a swap in words: the Canton side with the instrument's name, the EVM side with the token's symbol and decimals (the swap's own, else the token route's; the raw amount when neither is known). */
export function useSides(v: SwapView) {
  const known = v.evm.decimals !== null && v.evm.symbol !== null;
  const t = useLegToken(v.evm.token, !known);
  const decimals = v.evm.decimals ?? t?.decimals ?? null, symbol = v.evm.symbol ?? t?.symbol ?? short(v.evm.token, 6, 4);
  return {
    canton: v.canton.amount ? { amount: units(v.canton.amount, CANTON_DECIMALS), symbol: v.canton.instrument ?? "" } : null,
    evm: { amount: decimals !== null ? units(v.evm.amount, decimals) : count(v.evm.amount), symbol, raw: decimals === null },
  };
}

const Amt = ({ a }: { a: { amount: string; symbol: string } }) => <div className="sw-amt"><span className="num">{a.amount}</span> <em>{a.symbol}</em></div>;

/** The two sides of a swap and the one Canton transaction that settled both. */
export function SwapCard({ v }: { v: SwapView }) {
  const s = useSides(v);
  return (
    <div className="sw-card">
      <div className="sw-sides">
        <div className="sw-side canton">
          <span className="sw-role">Seller gives</span>
          {s.canton ? <Amt a={s.canton} /> : <div className="sw-amt muted">Not shown</div>}
          <span className="sw-where">On Canton</span>
          <div className="sw-who"><span><Icon name="lock" size={13} /> Canton party, private</span><span>Receives {s.evm.amount} {s.evm.symbol}</span></div>
        </div>
        <div className="sw-mid" aria-hidden="true"><span className="sw-knot"><Icon name="swap" size={16} /></span></div>
        <div className="sw-side evm">
          <span className="sw-role">Buyer gives</span>
          <Amt a={s.evm} />
          <span className="sw-where">On Ostia</span>
          <div className="sw-who">
            <span>{v.evm.payer ? <HashLink value={v.evm.payer} to={`/address/${v.evm.payer}`} /> : "An EVM wallet"} pays <HashLink value={v.evm.payee} to={`/address/${v.evm.payee}`} /></span>
            {s.canton && <span>Claims {s.canton.amount} {s.canton.symbol}{v.claimant && v.claimant !== v.evm.payer && <> at <HashLink value={v.claimant} to={`/address/${v.claimant}`} /></>}</span>}
          </div>
        </div>
      </div>
      {v.updateId && (
        <div className="sw-seal">
          <span><Icon name="check" size={14} /> Settled together in one Canton transaction <Info about="the settlement">Both sides settle in one Canton transaction, or neither does.</Info></span>
          <span className="sw-seal-r"><HashLink value={v.updateId} kind="update" to={`/canton/${v.updateId}`} />{v.recordTime && <span className="muted"> · {dateTime(v.recordTime)}</span>}</span>
        </div>
      )}
    </div>
  );
}

/** The swap behind a payment id, read once and kept for every card and page that shows it. */
export const useSwap = (payId: string, enabled = true) => useQuery({ queryKey: ["swap", payId], queryFn: () => getSwap(payId), retry: false, staleTime: 60_000, enabled });

/** The card of a leg that paid a swap: from the swap itself when it can be read (it names the payer), else from the leg. */
function LegCard({ v, lookup }: { v: SwapView; lookup: boolean }) {
  const q = useSwap(v.payId, lookup);
  return <SwapCard v={q.data ? viewOfSwap(q.data) : v} />;
}

const KIND: Record<string, string> = { deposit: "Deposit", withdrawal: "Withdrawal", payment: "Payment" };

/** One leg that is no swap, in a line: what it was, its amount, the account, and its page. */
export function LegLine({ l }: { l: BlockLeg }) {
  const claim = l.canton?.role === "funded-claim";
  const word = claim ? "Claim" : (KIND[l.kind] ?? l.kind);
  const to = l.kind === "withdrawal" ? "from" : "to";
  return (
    <li className="sw-line">
      <span className="tag">{word}</span>
      {claim && l.canton?.amount ? <span><span className="num">{units(l.canton.amount, CANTON_DECIMALS)}</span> {l.canton.instrument?.id}</span> : <><LegAmount l={l} /><LegToken token={l.token} /></>}
      <span className="muted">{to}</span>
      <HashLink value={l.account} to={`/address/${l.account}`} />
      <Link className="small" to={`/leg/${l.legId}`}>Leg {l.legIndex}</Link>
    </li>
  );
}

/** The legs of a block or a transaction: a swap as its card, every other leg as one line. A block with more than 50 legs says how many, and pages through them from its own route. */
export function LegsPanel({ title, info, legs, total, block, payer = null, txBlock }: { title: string; info: string; legs: BlockLeg[]; total: number; block?: string; payer?: string | null; txBlock?: number }) {
  const [all, setAll] = useState(false);
  if (!legs.length) return null;
  const more = block !== undefined && total > legs.length;
  if (more && all) {
    return (
      <>
        <BlockLegs id={block} />
        <p className="muted small"><button type="button" className="linkish" onClick={() => setAll(false)}>Show the first {LEGS_SHOWN} again</button> with their swaps.</p>
      </>
    );
  }
  const views = legs.map((l) => [l, viewOfLeg(l, payer)] as const);
  // A block full of swaps does not read each swap on its own: the leg already shows both amounts. A transaction names its payer, so its cards keep the read.
  const lookup = payer !== null || views.filter(([, v]) => v).length <= SWAP_LOOKUPS;
  const lines = views.filter(([, v]) => !v).map(([l]) => l);
  return (
    <section className="card" aria-label={title}>
      <div className="sec-h"><h3>{title}</h3><Info about={title.toLowerCase()}>{info}</Info></div>
      {views.map(([l, v]) => v && (
        <div className="sw-one" key={l.legId + l.legIndex}>
          <div className="sw-one-h"><Link className="small" to={`/swap/${v.payId}`}>Open swap</Link><Link className="small" to="/swaps">All swaps</Link></div>
          <LegCard v={v} lookup={lookup} />
        </div>
      ))}
      {lines.length > 0 && <ul className="sw-lines">{lines.map((l) => <LegLine key={l.legId + l.legIndex} l={l} />)}</ul>}
      {more && (
        <p className="muted small">{count(total)} legs in this block; the first {LEGS_SHOWN} are shown. <button type="button" className="linkish" onClick={() => setAll(true)}>Page through all {count(total)} legs</button></p>
      )}
      {block === undefined && txBlock !== undefined && legs.length >= LEGS_SHOWN && (
        <p className="muted small">Only the first {LEGS_SHOWN} legs are shown. <Link to={`/block/${txBlock}`}>Open the block</Link> to page through all of its legs.</p>
      )}
    </section>
  );
}
