import { useState } from "react";
import { Link } from "react-router-dom";
import type { ContractListItem, ContractListPage, ContractSort } from "../api.ts";
import { ago } from "../block-times.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { NumberedPager } from "../components/Numbered.tsx";
import { count, exact, plural, units } from "../format.ts";
import { listPoll } from "../stats.ts";
import { systemContract } from "../system-contracts.ts";
import { useNow, useStatus } from "../useStatus.ts";
import { compilerLine, MatchChip, PARTIAL_MATCH_NOTE, useContractList } from "./ContractParts.tsx";
import "./contract.css";

const PER = 25;
const SORTS: { id: ContractSort; label: string }[] = [{ id: "interactions", label: "Most interactions" }, { id: "newest", label: "Newest" }, { id: "oldest", label: "Oldest" }];
const FILTERS: { id: "all" | "yes" | "no"; label: string; value: boolean | null }[] = [{ id: "all", label: "All", value: null }, { id: "yes", label: "Verified", value: true }, { id: "no", label: "Not verified", value: false }];
const Dash = () => <span className="muted">—</span>;

function Row({ c, coin, now }: { c: ContractListItem; coin: { symbol: string; decimals: number } | undefined; now: number }) {
  const to = `/contract/${c.address}`;
  const sys = systemContract(c.address);
  const name = c.name ?? sys?.name ?? null;
  return (
    <tr>
      <td>
        <div className="ct-cell">
          <span className="ct-ic" aria-hidden="true"><Icon name="doc" size={16} /></span>
          <div>
            {name ? <Link to={to}>{name}</Link> : null}
            <div>{name ? <HashLink value={c.address} plain lead={10} tail={6} /> : <HashLink value={c.address} to={to} plain lead={10} tail={6} />}</div>
          </div>
        </div>
      </td>
      <td>
        <MatchChip matchType={c.matchType} />
        {c.compilerVersion && <div className="muted small">{compilerLine(c.compilerVersion)}</div>}
        {sys && !c.matchType && <div className="muted small">system contract, {sys.eip}</div>}
      </td>
      <td><span className="chip chip-kind">{sys ? "System" : (c.standard ?? "Contract")}</span></td>
      <td className="r">
        {sys ? <><span className="muted" title="The explorer does not see the chain's own system calls, so it has no count">—</span><div className="muted small">system calls, one per block at its {sys.at}</div></>
          : <>
            <span className="num">{count(c.interactionCount)}</span>
            {c.interactionCount === 0 && c.txCount === 0 && c.internalCount === 0 ? <div className="muted small">no calls yet</div>
              : c.txCount + c.internalCount > 0 && <div className="muted small">{plural(c.txCount, "transaction")} · {plural(c.internalCount, "internal call")}</div>}
          </>}
      </td>
      <td>
        {c.origin === "genesis"
          ? <><span>genesis</span><div className="muted small">{sys ? "in the chain's genesis" : "set by the chain, no creation"}</div></>
          : c.creationBlock === null ? <Dash /> : <><Link className="num" to={`/block/${c.creationBlock}`}>Block {c.creationBlock}</Link>{c.createdAt && <div className="muted small">{ago(c.createdAt, now)}</div>}</>}
        {c.destroyedBlock !== null && <div className="small fact-bad">destroyed in block {c.destroyedBlock}</div>}
      </td>
      <td>{c.creator ? <HashLink value={c.creator} to={`/address/${c.creator}`} plain lead={8} tail={4} /> : <Dash />}</td>
      <td className="r"><span className="num">{count(c.codeSize)} B</span></td>
      <td className="r">{c.balance === null ? <span className="muted" title="The explorer has not read this balance yet">—</span> : coin ? <span className="num" title={`${exact(c.balance, coin.decimals)} ${coin.symbol}`}>{units(c.balance, coin.decimals)}</span> : <span className="muted">…</span>}</td>
    </tr>
  );
}

function listLabel(shown: number, from: number, d: ContractListPage | undefined): string {
  if (shown === 0) return d?.derived === false ? "The explorer has not read this far yet." : "No contracts yet.";
  if (d && typeof d.total !== "number") return `Showing ${count(from + 1)}–${count(from + shown)} contracts`;
  if (!d || d.total <= shown) return `Showing all ${plural(shown, "contract")}`;
  return `Showing ${count(from + 1)}–${count(from + shown)} of ${count(d.total)} contracts`;
}

/** Every contract the explorer holds code for, by interactions or by when it was made, all or only the verified (or not), a page at a time. */
export function Contracts() {
  const [sort, setSort] = useState<ContractSort>("interactions");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(FILTERS[0]!);
  const p = useContractList({ sort, verified: filter.value }, PER, listPoll(false));
  const coin = useStatus().data?.coin;
  const now = useNow();
  const items = p.items;
  const counts = p.data?.counts;
  return (
    <>
      <div className="ptitle">
        <h1>Contracts</h1>
        {counts && <span className="muted">{plural(counts.all, "contract")} · {count(counts.verified)} with verified source</span>}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Which contracts">
          {FILTERS.map((f) => {
            const n = counts ? (f.id === "all" ? counts.all : f.id === "yes" ? counts.verified : counts.notVerified) : null;
            return <button key={f.id} type="button" aria-pressed={f.id === filter.id} onClick={() => setFilter(f)}>{f.label}{n !== null && <> <span className="num">{count(n)}</span></>}</button>;
          })}
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
          <div className="list-h"><span className="muted">{listLabel(items.length, p.from, p.data)}</span><NumberedPager p={p} label="Pages of contracts" always /></div>
          {items.length > 0 && (
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Contract</th><th>Verified</th><th>Kind</th><th className="r">Interactions</th><th>Created</th><th>Creator</th><th className="r">Code size</th><th className="r">Balance ({coin?.symbol ?? "coin"})</th></tr></thead>
                <tbody>{items.map((c) => <Row key={c.address} c={c} coin={coin} now={now} />)}</tbody>
              </table>
            </div>
          )}
          <p className="muted small">Balances and counts here are the explorer's copy, as of the block each was last read at. A contract's own page reads reth at the final block.</p>
          {items.some((c) => systemContract(c.address)) && <p className="muted small">The system contracts are the standard ones of the Prague rules. The chain calls each of them itself in every block, and the explorer does not see these calls, so it shows no count for them.</p>}
          {items.some((c) => c.origin === "genesis") && <p className="muted small">A contract in the genesis allocation has no creator and no creation transaction: the chain set it.</p>}
          {items.some((c) => c.matchType === "partial") && <p className="muted small">{PARTIAL_MATCH_NOTE}</p>}
          {p.data?.derived === false && <p className="muted small">The explorer is still reading blocks, so this list may be missing the newest contracts and their counts.</p>}
        </section>
      )}
    </>
  );
}
