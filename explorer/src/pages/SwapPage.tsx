import { Link, useParams } from "react-router-dom";
import { getSwap, type SwapItem, type SwapStep } from "../api.ts";
import { unready } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Info } from "../components/Info.tsx";
import { SwapCard, useSides, viewOfSwap } from "../components/Swap.tsx";
import { dateTime } from "../format.ts";
import { useFollowing } from "../useStatus.ts";

/** Settled: the payment is in its block. Claimed: the buyer has also redeemed the Canton side. */
export function SwapStatus({ s }: { s: Pick<SwapItem, "status"> }) {
  return <span className="chip chip-final"><i className="dot" />{s.status === "claimed" ? "Claimed" : "Settled"}</span>;
}

function Step({ name, where, children, waiting = false }: { name: string; where: string; children?: React.ReactNode; waiting?: boolean }) {
  return (
    <li className={`sw-step${waiting ? " wait" : ""}`}>
      <span className="sw-dot" aria-hidden="true">{waiting ? null : <Icon name="check" size={13} />}</span>
      <div><b>{name}</b><small>{where}</small>{children}</div>
    </li>
  );
}

function Landed({ step }: { step: SwapStep }) {
  return (
    <>
      <span><Link to={`/block/${step.block}`}>Block {step.block}</Link>{" "}{step.txHash ? <HashLink value={step.txHash} to={`/tx/${step.txHash}`} /> : <span className="muted" title="The explorer has not stored this transaction">—</span>}</span>
      <span>Canton update <HashLink value={step.updateId} kind="update" to={`/canton/${step.updateId}`} /></span>
      <span className="muted">{dateTime(step.recordTime)}</span>
    </>
  );
}

function Body({ s }: { s: SwapItem }) {
  const sides = useSides(viewOfSwap(s));
  return (
    <>
      <nav className="crumbs" aria-label="Where this is"><Link to="/swaps">Swaps</Link> / <span className="mono">{s.payId.slice(0, 8)}…</span></nav>
      <div className="ptitle">
        <h1>{sides.canton ? `${sides.canton.amount} ${sides.canton.symbol}` : "A swap"} <em>for</em> {sides.evm.amount} {sides.evm.symbol}</h1>
        <SwapStatus s={s} />
        <Info about="the status">Settled: the buyer has paid, and the swap is done on Canton. Claimed: the buyer has also taken the Canton side into their wallet.</Info>
      </div>
      <SwapCard v={viewOfSwap(s)} />
      <section className="card" aria-label="Journey">
        <div className="sec-h"><h3>Journey</h3><Info about="the journey">The offer is made on Canton. The buyer's payment lands in a block of Ostia. The claim moves the Canton side to the buyer's wallet.</Info></div>
        <ol className="sw-road">
          <Step name="Offer" where="On Canton"><span>Canton update <HashLink value={s.offer.updateId} kind="update" to={`/canton/${s.offer.updateId}`} /></span></Step>
          <Step name="Payment" where="On Ostia"><Landed step={s.payment} /></Step>
          {s.claim ? <Step name="Claim" where="On Ostia"><Landed step={s.claim} /></Step> : <Step name="Claim" where="On Ostia" waiting><span className="muted">Waiting for the buyer to claim</span></Step>}
        </ol>
      </section>
    </>
  );
}

/** One swap, by the id of its payment: the two sides, and the journey from the offer to the claim. */
export function SwapPage() {
  const { id = "" } = useParams();
  const q = useFollowing(["swap", id], () => getSwap(id), (x) => x.status === "claimed");
  const wait = unready(q, "Reading the swap…");
  return wait ?? (q.data ? <Body s={q.data} /> : null);
}
