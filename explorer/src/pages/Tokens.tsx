import { useState } from "react";
import { Link } from "react-router-dom";
import { getTokenList, type TokenListItem, type TokenSort } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count } from "../format.ts";
import { listPoll } from "../stats.ts";
import { noName, Supply } from "./TokenParts.tsx";

const PER = 25;
const SORTS: { id: TokenSort; label: string }[] = [{ id: "holders", label: "Holders" }, { id: "transfers", label: "Transfers" }, { id: "newest", label: "Newest" }];

function Row({ t, n }: { t: TokenListItem; n: number }) {
  const to = `/token/${t.address}`;
  return (
    <tr>
      <td className="muted">{n}</td>
      <td>
        {t.name ? <Link to={to}>{t.name}</Link> : <span className="muted">{noName(t)}</span>}
        {t.symbol && <span className="tag">{t.symbol}</span>}
        {t.gatewayWrapped && <span className="chip chip-kind" title="The gateway made this wrapped token for a Canton token">From Canton</span>}
        <div>{t.name ? <HashLink value={t.address} /> : <HashLink value={t.address} to={to} />}</div>
      </td>
      <td><span className="chip chip-kind">{t.standard}</span></td>
      <td className="r"><Supply t={t} /></td>
      <td className="r"><span className="mono">{count(t.holderCount)}</span></td>
      <td className="r"><span className="mono">{count(t.transferCount)}</span></td>
      <td><Link className="num" to={`/block/${t.firstTransferBlock}`}>Block {t.firstTransferBlock}</Link></td>
    </tr>
  );
}

/** Every token the explorer has seen move, by holders, by transfers or by when it first moved, a page at a time. */
export function Tokens() {
  const [sort, setSort] = useState<TokenSort>("holders");
  const p = usePaged(["tokens", sort], (before) => getTokenList(sort, before, PER), listPoll(false));
  const items = p.data?.items;
  return (
    <>
      <div className="ptitle">
        <h1>Tokens</h1>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Sort tokens by">
          {SORTS.map((s) => <button key={s.id} type="button" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>)}
        </div>
      </div>
      {p.error && !items ? <ErrorCard message={p.error.message} retrying /> : !items ? <LoadingCard>Reading the tokens…</LoadingCard> : (
        <section className="card" aria-label="Tokens">
          <div className="list-h"><span className="muted">{items.length ? `Showing ${count(items.length)} on this page` : (p.data?.derived === false ? "The explorer has not read this far yet." : "No tokens yet.")}</span><Pager p={p} label="Pages of tokens" /></div>
          {items.length > 0 && (
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>#</th><th>Token</th><th>Standard</th><th className="r">Total supply</th><th className="r">Holders</th><th className="r">Transfers</th><th>First transfer</th></tr></thead>
                <tbody>{items.map((t, i) => <Row key={t.address} t={t} n={(p.page - 1) * PER + i + 1} />)}</tbody>
              </table>
            </div>
          )}
          <p className="muted small">Holders, transfers and supply are the explorer's copy, read from the Transfer logs of final blocks and the contract. A token with no name here did not answer, and is still listed.</p>
          {p.data?.derived === false && <p className="muted small">The explorer is still reading blocks, so this list may be missing the newest tokens and their counts.</p>}
        </section>
      )}
    </>
  );
}
