import { Link } from "react-router-dom";
import { getLegPage, type LegListItem } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count } from "../format.ts";
import { listPoll } from "../stats.ts";
import { LegAmount, LegsPrivacy, LegToken, legKindWord } from "./LegParts.tsx";

const PER = 25;

function Row({ l }: { l: LegListItem }) {
  return (
    <tr>
      <td><HashLink value={l.legId} to={`/leg/${l.legId}`} /></td>
      <td><span className="tag">{l.kind}</span>{l.twin && <span className="tag">{legKindWord(l.kind, l.twin)}</span>}</td>
      <td><Link className="num" to={`/block/${l.block}`}>{l.block}</Link></td>
      <td>{l.txHash ? <HashLink value={l.txHash} to={`/tx/${l.txHash}`} /> : <span className="muted" title="The explorer has not stored this transaction">—</span>}</td>
      <td><LegToken token={l.token} /></td>
      <td><HashLink value={l.account} to={`/address/${l.account}`} /></td>
      <td className="r"><LegAmount l={l} /></td>
    </tr>
  );
}

/** The gateway's legs, newest first, as the EVM recorded them: the gateway's own events, with nothing from Canton's side. */
export function Legs() {
  const p = usePaged(["legs"], (before) => getLegPage(before, PER), listPoll(false));
  const items = p.data?.items;
  return (
    <>
      <div className="ptitle"><h1>Gateway legs</h1></div>
      <LegsPrivacy many />
      {p.error && !items ? <ErrorCard message={p.error.message} retrying /> : !items ? <LoadingCard>Reading the legs…</LoadingCard> : (
        <section className="card" aria-label="Gateway legs">
          <div className="list-h"><span className="muted">{items.length ? `Showing ${count(items.length)} on this page` : "No legs yet."}</span><Pager p={p} label="Pages of legs" /></div>
          {items.length > 0 && (
            <div className="scroll">
              <table className="tbl legs-tbl">
                <thead><tr><th>Leg</th><th>Kind</th><th>Block</th><th>Transaction</th><th>Token</th><th>Account</th><th className="r">Amount</th></tr></thead>
                <tbody>{items.map((l) => <Row key={l.legId + l.block + l.legIndex} l={l} />)}</tbody>
              </table>
            </div>
          )}
          <p className="muted small">Each leg is a public event the gateway wrote on the EVM, and is listed once its block is final. The explorer shows what the EVM recorded and nothing from Canton's side of the leg.</p>
        </section>
      )}
    </>
  );
}
