import { Link } from "react-router-dom";
import { getSwapPage, type SwapItem } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Info } from "../components/Info.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { useSides, viewOfSwap } from "../components/Swap.tsx";
import { SwapStatus } from "./SwapPage.tsx";
import { dateTime } from "../format.ts";
import { listPoll } from "../stats.ts";

const PER = 25;

function Row({ s }: { s: SwapItem }) {
  const sides = useSides(viewOfSwap(s));
  return (
    <tr>
      <td><SwapStatus s={s} /></td>
      <td className="num">{sides.canton ? `${sides.canton.amount} ${sides.canton.symbol}` : "Not shown"}</td>
      <td className="num">{sides.evm.amount} {sides.evm.symbol}</td>
      <td><Link className="num" to={`/block/${s.payment.block}`}>{s.payment.block}</Link></td>
      <td>{s.payment.txHash ? <HashLink value={s.payment.txHash} to={`/tx/${s.payment.txHash}`} /> : <span className="muted" title="The explorer has not stored this transaction">—</span>}</td>
      <td>{dateTime(s.payment.recordTime)}</td>
      <td className="r"><Link to={`/swap/${s.payId}`} aria-label={`Open the swap paid in block ${s.payment.block}`}>Open</Link></td>
    </tr>
  );
}

/** The swaps a Canton venue made with the EVM, newest first. */
export function Swaps() {
  const p = usePaged(["swaps"], (before) => getSwapPage(before, PER), listPoll(false));
  const items = p.data?.items;
  return (
    <>
      <div className="ptitle"><h1>Swaps</h1><span className="muted">a Canton seller and an EVM buyer, settled together</span><Info about="swaps">A swap is one trade between a seller on Canton and a buyer on Ostia. The buyer's payment is in a block, and the seller's side settles in the same Canton transaction as that block.</Info></div>
      {p.error && !items ? <ErrorCard message={p.error.message} retrying /> : !items ? <LoadingCard>Reading the swaps…</LoadingCard> : (
        <section className="card" aria-label="Swaps">
          <div className="list-h"><span className="muted">{items.length ? "Newest first, by the payment's block" : "No swaps yet."}</span><Pager p={p} label="Pages of swaps" /></div>
          {items.length > 0 && (
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Status</th><th>Seller gives (Canton)</th><th>Buyer gives (Ostia)</th><th>Payment block</th><th>Transaction</th><th>Time</th><th aria-hidden="true" /></tr></thead>
                <tbody>{items.map((s) => <Row key={s.payId} s={s} />)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
