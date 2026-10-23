import { useState } from "react";
import { Link } from "react-router-dom";
import { getContractList, type ContractListItem, type ContractSort } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, exact, plural, units } from "../format.ts";
import { listPoll } from "../stats.ts";
import { useStatus } from "../useStatus.ts";
import { MatchChip, PARTIAL_MATCH_NOTE } from "./ContractParts.tsx";

const PER = 25;
const SORTS: { id: ContractSort; label: string }[] = [{ id: "interactions", label: "Most interactions" }, { id: "newest", label: "Newest" }, { id: "oldest", label: "Oldest" }];
const FILTERS: { id: "all" | "yes" | "no"; label: string; value: boolean | null }[] = [{ id: "all", label: "All", value: null }, { id: "yes", label: "Verified", value: true }, { id: "no", label: "Not verified", value: false }];
const Dash = () => <span className="muted">—</span>;

function Row({ c, coin }: { c: ContractListItem; coin: { symbol: string; decimals: number } | undefined }) {
  const to = `/contract/${c.address}`;
  return (
    <tr>
      <td>
        {c.name ? <Link to={to}>{c.name}</Link> : null}
        <div>{c.name ? <HashLink value={c.address} /> : <HashLink value={c.address} to={to} />}</div>
      </td>
      <td><MatchChip matchType={c.matchType} /></td>
      <td><span className="chip chip-kind">{c.standard ?? "Contract"}</span></td>
      <td className="r">
        <span className="mono">{count(c.interactionCount)}</span>
        {c.interactionCount === 0 && c.txCount === 0 && c.internalCount === 0 ? <div className="muted small">no calls yet</div>
          : c.txCount + c.internalCount > 0 && <div className="muted small">{plural(c.txCount, "transaction")} · {plural(c.internalCount, "internal call")}</div>}
      </td>
      <td>
        {c.origin === "genesis"
          ? <><span>genesis</span><div className="muted small">set by the chain, no creation</div></>
          : c.creationBlock === null ? <Dash /> : <Link className="num" to={`/block/${c.creationBlock}`}>Block {c.creationBlock}</Link>}
        {c.destroyedBlock !== null && <div className="small fact-bad">destroyed in block {c.destroyedBlock}</div>}
      </td>
      <td>{c.creator ? <HashLink value={c.creator} to={`/address/${c.creator}`} /> : <Dash />}</td>
      <td className="r"><span className="mono">{count(c.codeSize)} B</span></td>
      <td className="r">{c.balance === null ? <span className="muted" title="The explorer has not read this balance yet">—</span> : coin ? <span className="mono" title={`${exact(c.balance, coin.decimals)} ${coin.symbol}`}>{units(c.balance, coin.decimals)}</span> : <span className="muted">…</span>}</td>
    </tr>
  );
}

/** Every contract the explorer holds code for, by interactions or by when it was made, all or only the verified (or not), a page at a time. */
export function Contracts() {
  const [sort, setSort] = useState<ContractSort>("interactions");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(FILTERS[0]!);
  const p = usePaged(["contracts", sort, filter.id], (before) => getContractList(sort, filter.value, before, PER), listPoll(false));
  const coin = useStatus().data?.coin;
  const items = p.data?.items;
  return (
    <>
      <div className="ptitle">
        <h1>Contracts</h1>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Which contracts">
          {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={f.id === filter.id} onClick={() => setFilter(f)}>{f.label}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Sort contracts by">
          {SORTS.map((s) => <button key={s.id} type="button" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>)}
        </div>
      </div>
      <aside className="card note" role="note" aria-label="How to verify a contract">
        <p className="small">
          Verify a contract with the tools you already use: <code className="mono">forge verify-contract --verifier etherscan --verifier-url {window.location.origin}/api</code>, Hardhat's <code className="mono">customChains</code>,
          or the Code tab of the contract. The source is compiled in a sandbox and matched against the code on chain. More in the <Link to="/docs/api">API</Link> page.
        </p>
      </aside>
      {p.error && !items ? <ErrorCard message={p.error.message} retrying /> : !items ? <LoadingCard>Reading the contracts…</LoadingCard> : (
        <section className="card" aria-label="Contracts">
          <div className="list-h"><span className="muted">{items.length ? `Showing ${count(items.length)} on this page` : (p.data?.derived === false ? "The explorer has not read this far yet." : "No contracts yet.")}</span><Pager p={p} label="Pages of contracts" /></div>
          {items.length > 0 && (
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Contract</th><th>Verified</th><th>Kind</th><th className="r">Interactions</th><th>Created</th><th>Creator</th><th className="r">Code size</th><th className="r">Balance ({coin?.symbol ?? "coin"})</th></tr></thead>
                <tbody>{items.map((c) => <Row key={c.address} c={c} coin={coin} />)}</tbody>
              </table>
            </div>
          )}
          <p className="muted small">Balances and counts here are the explorer's copy, as of the block each was last read at. A contract's own page reads reth at the final block.</p>
          {items.some((c) => c.origin === "genesis") && <p className="muted small">A contract in the genesis allocation has no creator and no creation transaction: the chain set it.</p>}
          {items.some((c) => c.matchType === "partial") && <p className="muted small">{PARTIAL_MATCH_NOTE}</p>}
          {p.data?.derived === false && <p className="muted small">The explorer is still reading blocks, so this list may be missing the newest contracts and their counts.</p>}
        </section>
      )}
    </>
  );
}
