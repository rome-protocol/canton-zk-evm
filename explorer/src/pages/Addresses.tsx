import { useState } from "react";
import { Link } from "react-router-dom";
import { getAddressList, type AddressListItem, type AddressSort } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count } from "../format.ts";
import { listPoll } from "../stats.ts";
import { useStatus } from "../useStatus.ts";

const PER = 25;
const SORTS: { id: AddressSort; label: string }[] = [{ id: "balance", label: "Balance" }, { id: "txs", label: "Transactions" }];
const KIND = { account: "Account", contract: "Contract", token: "Token" } as const;

function Row({ a, coin }: { a: AddressListItem; coin: { symbol: string; decimals: number } | undefined }) {
  return (
    <tr>
      <td><HashLink value={a.address} to={`/${a.kind === "token" ? "token" : a.kind === "contract" ? "contract" : "address"}/${a.address}`} /></td>
      <td><span className="chip chip-kind">{KIND[a.kind]}</span></td>
      <td className="r">{a.balance === null ? <span className="muted" title="The explorer has not read this balance yet">—</span> : coin ? <Amount raw={a.balance} decimals={coin.decimals} symbol={coin.symbol} /> : <span className="muted">…</span>}</td>
      <td>{a.balanceBlock === null ? <span className="muted">—</span> : <Link className="num" to={`/block/${a.balanceBlock}`}>block {a.balanceBlock}</Link>}</td>
      <td className="r"><span className="mono">{count(a.txCount)}</span></td>
    </tr>
  );
}

/** Every address the explorer has seen, by balance or by how many transactions it is in, a page at a time. */
export function Addresses() {
  const [sort, setSort] = useState<AddressSort>("balance");
  const coin = useStatus().data?.coin;
  const p = usePaged(["addresses", sort], (before) => getAddressList(sort, before, PER), listPoll(false));
  const items = p.data?.items;
  return (
    <>
      <div className="ptitle">
        <h1>Addresses</h1>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Sort addresses by">
          {SORTS.map((s) => <button key={s.id} type="button" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>)}
        </div>
      </div>
      {p.error && !items ? <ErrorCard message={p.error.message} retrying /> : !items ? <LoadingCard>Reading the addresses…</LoadingCard> : (
        <section className="card" aria-label="Addresses">
          <div className="list-h"><span className="muted">{items.length ? `Showing ${count(items.length)} on this page, ${sort === "balance" ? "largest balance" : "most transactions"} first` : "No addresses yet."}</span><Pager p={p} label="Pages of addresses" /></div>
          {items.length > 0 && (
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Address</th><th>Kind</th><th className="r">Balance</th><th>As of</th><th className="r">Transactions</th></tr></thead>
                <tbody>{items.map((a) => <Row key={a.address} a={a} coin={coin} />)}</tbody>
              </table>
            </div>
          )}
          <p className="muted small">Balances here are the explorer's copy, as of the block on each row. An address's own page reads reth at the final block.</p>
          {p.data?.derived === false && <p className="muted small">The explorer is still reading blocks, so this list may be missing the newest addresses and their counts.</p>}
        </section>
      )}
    </>
  );
}
