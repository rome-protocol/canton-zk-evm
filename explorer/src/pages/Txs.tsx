import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getBlocks, getFaucetAddress, getTx, getTxPage, txsCsvPath, type ApiStatus, type ApiTx, type InFlight, type InFlightTx, type TxFilter, type TxListItem } from "../api.ts";
import { Sender } from "../components/BlockParts.tsx";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration, exact, span, units } from "../format.ts";
import { methodOf } from "../method.ts";
import { listPoll, notFinalCounts, summarize, useInFlight } from "../stats.ts";
import { useLive } from "../useLive.ts";
import { POLL_MS, useNow, useStatus } from "../useStatus.ts";

const PER = 25;
/** The rows of transactions that are not final that one page draws; the rest are counted. */
const NOT_FINAL_SHOWN = 25;
type View = "all" | "notfinal" | TxFilter;
const VIEWS: { id: View; label: string }[] = [{ id: "all", label: "All" }, { id: "notfinal", label: "Not final yet" }, { id: "failed", label: "Failed" }, { id: "calls", label: "Contract calls" }];
type Coin = ApiStatus["coin"];

const fee = (gasUsed: number, gasPrice: string) => (BigInt(gasUsed) * BigInt(gasPrice)).toString();
const Dash = () => <span className="muted">—</span>;

function Value({ raw, coin }: { raw: string; coin: Coin }) {
  return <span title={`${exact(raw, coin.decimals)} ${coin.symbol}`}>{units(raw, coin.decimals)} {coin.symbol}</span>;
}
function Fee({ raw, coin }: { raw: string; coin: Coin }) {
  return <span className="mono" title={`${exact(raw, coin.decimals)} ${coin.symbol}`}>{exact(raw, coin.decimals)}</span>;
}
const To = ({ t }: { t: { to: string | null; created: string | null } }) =>
  t.to ? <HashLink value={t.to} to={`/address/${t.to}`} /> : t.created ? <span className="muted">Create: <Link className="mono" to={`/address/${t.created}`}>contract</Link></span> : <span className="muted">creates a contract</span>;

function Row({ t, now, coin, faucet, chain }: { t: TxListItem; now: number; coin: Coin; faucet: string | null | undefined; chain: string }) {
  return (
    <tr>
      <td className="c-hash"><HashLink value={t.hash} to={`/tx/${t.hash}`} />{!t.success && <span className="fact-bad" role="img" aria-label="Failed (reverted)" title="Failed (reverted)"><Icon name="cross" size={13} /></span>}</td>
      <td><span className="tag method">{methodOf(t)}</span></td>
      <td><Link className="num" to={`/block/${t.block}`}>{t.block}</Link></td>
      <td title={new Date(t.timestamp * 1000).toISOString()}>{duration(now - t.timestamp * 1000)} ago</td>
      <td><Sender address={t.from} faucet={faucet} chain={chain} /></td>
      <td className="arrow muted" aria-hidden="true">→</td>
      <td><To t={t} /></td>
      <td className="r"><Value raw={t.value} coin={coin} /></td>
      <td className="r"><Fee raw={fee(t.gasUsed, t.gasPrice)} coin={coin} /></td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

/** A transaction that is not final: the in-flight route names it and its stage; the rest of its row is read from its own page, and stays a dash until that answers. */
function NotFinalRow({ f, now, coin, faucet, chain }: { f: InFlightTx; now: number; coin: Coin; faucet: string | null | undefined; chain: string }) {
  const t: ApiTx | undefined = useQuery({ queryKey: ["tx", f.hash], queryFn: () => getTx(f.hash), refetchInterval: POLL_MS, retry: false }).data;
  const seen = t && t.value !== null ? t : undefined;
  return (
    <tr className="row-proving">
      <td className="c-hash"><HashLink value={f.hash} to={`/tx/${f.hash}`} /></td>
      <td>{seen ? <span className="tag method">{methodOf({ methodId: seen.input.length >= 10 ? seen.input.slice(0, 10) : null, to: seen.to, created: seen.created, value: seen.value })}</span> : <Dash />}</td>
      <td>{t?.block ? <Link className="num" to={`/block/${t.block.number}`}>{t.block.number}</Link> : <span className="muted">pool</span>}</td>
      <td title={f.at}>{duration(now - Date.parse(f.at))} ago</td>
      <td>{t ? <Sender address={t.from} faucet={faucet} chain={chain} /> : <Dash />}</td>
      <td className="arrow muted" aria-hidden="true">→</td>
      <td>{t ? <To t={t} /> : <Dash />}</td>
      <td className="r">{seen ? <Value raw={seen.value} coin={coin} /> : <Dash />}</td>
      <td className="r">{t?.fee ? <Fee raw={t.fee} coin={coin} /> : <Dash />}</td>
      <td><Chip status={f.stage} /></td>
    </tr>
  );
}

const head = (coin: Coin) => <thead><tr><th>Transaction hash</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Value</th><th className="r">{`Fee (${coin.symbol})`}</th><th>Stage</th></tr></thead>;

/** How many are not final yet in all, from the attempts and the pool; the in-flight list is capped by the server and is not the count. `atLeast` when the pool is not counted. */
type Total = { total: number; atLeast: boolean };
const totalOf = (f: InFlight | undefined): Total | null => {
  if (!f) return null;
  const c = notFinalCounts(f);
  return { total: c.inBlocks + (c.waiting ?? 0), atLeast: c.waiting === null };
};
const more = (t: Total) => `${t.atLeast ? "at least " : ""}${count(t.total)}`;

function Cards({ st, live }: { st: ApiStatus | undefined; live: boolean }) {
  const blocks = useQuery({ queryKey: ["blocks", 10], queryFn: () => getBlocks(10), refetchInterval: listPoll(live) }).data;
  const flight = useInFlight(live).data ?? null;
  const sum = st && blocks ? summarize(st, blocks.items, flight) : null;
  const ttf = sum?.timeToFinal;
  const nf = sum?.notFinal;
  const total = nf ? nf.inBlocks + (nf.waiting ?? 0) : null;
  return (
    <div className="stats">
      <section className="card stat" aria-label="Time to final">
        <div className="stat-k">Time to final · newest {ttf?.blocks ?? 10} blocks</div>
        <div className="stat-v">{ttf ? <>{span(ttf.medianMs / 1000)} <span className="muted small">p95 {span(ttf.p95Ms / 1000)}</span></> : "—"}</div>
        <div className="muted small">{ttf ? "from the producer's cut to Canton's record time" : "the producer's log has no times for these blocks"}</div>
      </section>
      <section className="card stat" aria-label="Not final yet">
        <div className="stat-k">Not final yet</div>
        <div className="stat-v">{total === null ? "—" : count(total)}</div>
        <div className="muted small">{nf ? `${count(nf.inBlocks)} in blocks being proven · ${nf.waiting === null ? "the pool is not counted" : `${count(nf.waiting)} waiting`}` : "reading"}</div>
      </section>
    </div>
  );
}

function FinalRows({ view, st, now, live, faucet, notFinal, all }: { view: TxFilter; st: ApiStatus | undefined; now: number; live: boolean; faucet: string | null | undefined; notFinal: InFlightTx[]; all: Total | null }) {
  const p = usePaged(["txs", "page", view], (before) => getTxPage(before, PER, view), listPoll(live));
  const items = p.data?.items;
  if (p.error && !items) return <ErrorCard message={p.error.message} retrying />;
  if (!items || !st) return <LoadingCard>Reading the transactions…</LoadingCard>;
  const showNotFinal = view === "all" && p.page === 1;
  const shown = showNotFinal ? notFinal.slice(0, NOT_FINAL_SHOWN) : [];
  return (
    <section className="card" aria-label="Transactions">
      <div className="list-h"><span className="muted">{items.length || shown.length ? `Showing the newest ${count(shown.length + items.length)} on this page` : "No transactions yet."}</span><Pager p={p} label="Pages of transactions" /></div>
      <div className="scroll">
        <table className="tbl txs">
          {head(st.coin)}
          <tbody>
            {shown.map((f) => <NotFinalRow key={f.hash} f={f} now={now} coin={st.coin} faucet={faucet} chain={st.chainName} />)}
            {items.map((t) => <Row key={t.hash} t={t} now={now} coin={st.coin} faucet={faucet} chain={st.chainName} />)}
          </tbody>
        </table>
      </div>
      {showNotFinal && all && all.total > shown.length && <p className="muted small">{all.atLeast ? "At least " : ""}{count(all.total - shown.length)} more not final yet, older than the rows shown, are not listed.</p>}
      <p className="muted small"><b>Waiting</b>: accepted, in the pool. <b>Being proven</b>: in a block that is not final yet; if Canton refused that block, the transaction would go back to the pool. <b>Final</b>: its block is final on Canton.</p>
    </section>
  );
}

function NotFinalOnly({ st, now, faucet, notFinal, all }: { st: ApiStatus | undefined; now: number; faucet: string | null | undefined; notFinal: InFlightTx[]; all: Total | null }) {
  if (!all || !st) return <LoadingCard>Reading what is not final yet…</LoadingCard>;
  const shown = notFinal.slice(0, NOT_FINAL_SHOWN);
  const unlisted = all.total - shown.length;
  const label = all.total === 0 && shown.length === 0 ? "Nothing is waiting or being proven."
    : shown.length === 0 ? `${more(all)} not final yet, none listed.`
    : unlisted > 0 ? `The newest ${count(shown.length)} of ${more(all)} not final yet` : `${count(shown.length)} not final yet`;
  return (
    <section className="card" aria-label="Transactions not final yet">
      <div className="list-h"><span className="muted">{label}</span></div>
      {shown.length > 0 && <div className="scroll"><table className="tbl txs">{head(st.coin)}<tbody>{shown.map((f) => <NotFinalRow key={f.hash} f={f} now={now} coin={st.coin} faucet={faucet} chain={st.chainName} />)}</tbody></table></div>}
      {shown.length > 0 && unlisted > 0 && <p className="muted small">{all.atLeast ? "At least " : ""}{count(unlisted)} more, older than these, are not listed.</p>}
    </section>
  );
}

/** Every final transaction, newest first, a page at a time, with the ones that are not final yet above the first page of All. */
export function Txs() {
  const live = useLive(["txs", "inflight", "blocks"]);
  const now = useNow();
  const st = useStatus().data;
  const [view, setView] = useState<View>("all");
  const flight = useInFlight(live);
  const faucet = useQuery({ queryKey: ["faucet-address"], queryFn: getFaucetAddress, staleTime: 60_000, retry: false }).data;
  const notFinal = flight.data?.transactions ?? [];
  const all = totalOf(flight.data);
  const csv: TxFilter = view === "failed" || view === "calls" ? view : "all";
  return (
    <>
      <div className="ptitle">
        <h1>Transactions</h1>
        {all && <span className="muted">{more(all)} not final yet</span>}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Show transactions">
          {VIEWS.map((v) => <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)}>{v.label}</button>)}
        </div>
        {view !== "notfinal" && <a className="csv" href={txsCsvPath(csv)} download="transactions.csv">CSV</a>}
      </div>
      <Cards st={st} live={live} />
      {view === "notfinal"
        ? <NotFinalOnly st={st} now={now} faucet={faucet} notFinal={notFinal} all={all} />
        : <FinalRows key={view} view={view === "all" ? "all" : view} st={st} now={now} live={live} faucet={faucet} notFinal={notFinal} all={all} />}
    </>
  );
}
