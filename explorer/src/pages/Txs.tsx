import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getFaucetAddress, getStatsSummary, getTx, getTxPage, getTxPageOldest, txsCsvPath, type ApiStatus, type ApiTx, type InFlight, type InFlightTx, type TxFilter, type TxListItem } from "../api.ts";
import { AddressCell } from "../components/AddressCell.tsx";
import { Amount } from "../components/Amount.tsx";
import { DownloadLink, ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { useBothEnds } from "../components/Ends.tsx";
import { NumberedPager } from "../components/Numbered.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration, exact, feeOf } from "../format.ts";
import { useLabels, type Labels } from "../labels.ts";
import { methodOf } from "../method.ts";
import { listPoll, notFinalCounts, readOf, useInFlight } from "../stats.ts";
import { useLive } from "../useLive.ts";
import { POLL_MS, useNow, useStatus } from "../useStatus.ts";
import { AllTime, DASH_WHY, Moved, ProvingMoved, Stat, Time } from "./HomeParts.tsx";
import "./home.css";

const PER = 25;
/** The rows of transactions that are not final that one page draws; the rest are counted. */
const NOT_FINAL_SHOWN = 25;
type View = "all" | "notfinal" | TxFilter;
const VIEWS: { id: View; label: string }[] = [{ id: "all", label: "All" }, { id: "notfinal", label: "Not final yet" }, { id: "failed", label: "Failed" }, { id: "calls", label: "Contract calls" }];
type Coin = ApiStatus["coin"];

/** gas used times the gas price, in the coin's smallest unit. */
const fee = (gasUsed: number, gasPrice: string) => (BigInt(gasUsed) * BigInt(gasPrice)).toString();
const Dash = () => <span className="muted">—</span>;

function Fee({ raw, coin }: { raw: string; coin: Coin }) {
  return <span className="num" title={`${exact(raw, coin.decimals)} ${coin.symbol}`}>{feeOf(raw, coin.decimals)}</span>;
}
/** The sender: the faucet by its name, anything else by its short address, or by its name when the index knows one. */
function From({ address, faucet, chain, labels }: { address: string; faucet: string | null | undefined; chain: string; labels: Labels }) {
  const named = !!faucet && faucet.toLowerCase() === address.toLowerCase();
  return named ? <Link className="hx" to={`/address/${address}`} title={address}>{chain} faucet</Link> : <AddressCell address={address} label={labels.get(address)} />;
}
/** The receiver by name or short address; a creation says "Create:" and names what it made. */
const To = ({ t, labels }: { t: { to: string | null; created: string | null }; labels: Labels }) =>
  t.to ? <AddressCell address={t.to} label={labels.get(t.to)} />
    : t.created ? <span className="create"><span className="muted">Create:</span> <AddressCell address={t.created} label={labels.get(t.created)} /></span>
    : <span className="muted">creates a contract</span>;

type Ctx = { now: number; coin: Coin; faucet: string | null | undefined; chain: string; labels: Labels };

function Row({ t, c }: { t: TxListItem; c: Ctx }) {
  return (
    <tr>
      <td className="c-hash"><HashLink value={t.hash} to={`/tx/${t.hash}`} plain />{!t.success && <span className="fact-bad" role="img" aria-label="Failed (reverted)" title="Failed (reverted)"><Icon name="cross" size={13} /></span>}</td>
      <td><span className="tag method">{methodOf(t)}</span></td>
      <td><Link className="num" to={`/block/${t.block}`}>{t.block}</Link></td>
      <td title={new Date(t.timestamp * 1000).toISOString()}>{duration(c.now - t.timestamp * 1000)} ago</td>
      <td><From address={t.from} faucet={c.faucet} chain={c.chain} labels={c.labels} /></td>
      <td className="arrow muted" aria-hidden="true">→</td>
      <td><To t={t} labels={c.labels} /></td>
      <td className="r"><Moved t={t} coin={c.coin} labels={c.labels} /></td>
      <td className="r"><Fee raw={fee(t.gasUsed, t.gasPrice)} coin={c.coin} /></td>
      <td><Chip status="final" /></td>
    </tr>
  );
}

/** What each transaction that is not final yet is read as from its own page: all of them together, so that their names are asked for once. */
const useDetails = (fs: InFlightTx[]): (ApiTx | undefined)[] =>
  useQueries({ queries: fs.map((f) => ({ queryKey: ["tx", f.hash], queryFn: () => getTx(f.hash), refetchInterval: POLL_MS, retry: false })) }).map((q) => q.data);

/** A transaction that is not final: the in-flight route names it and its stage; the rest of its row is read from its own page, and stays a dash until that answers. */
function NotFinalRow({ f, t, c }: { f: InFlightTx; t: ApiTx | undefined; c: Ctx }) {
  const seen = t && t.value !== null ? t : undefined;
  return (
    <tr className="row-proving">
      <td className="c-hash"><HashLink value={f.hash} to={`/tx/${f.hash}`} plain />{t?.success === false && <span className="fact-bad" role="img" aria-label="Failed (reverted)" title="Failed (reverted)"><Icon name="cross" size={13} /></span>}</td>
      <td>{seen ? <span className="tag method">{methodOf({ methodId: seen.input.length >= 10 ? seen.input.slice(0, 10) : null, to: seen.to, created: seen.created, value: seen.value })}</span> : <Dash />}</td>
      <td>{t?.block ? <Link className="num" to={`/block/${t.block.number}`}>{t.block.number}</Link> : <span className="muted">pool</span>}</td>
      <td title={f.at}>{duration(c.now - Date.parse(f.at))} ago</td>
      <td>{t ? <From address={t.from} faucet={c.faucet} chain={c.chain} labels={c.labels} /> : <Dash />}</td>
      <td className="arrow muted" aria-hidden="true">→</td>
      <td>{t ? <To t={t} labels={c.labels} /> : <Dash />}</td>
      <td className="r">{seen ? <ProvingMoved d={{ ...seen, value: seen.value! }} coin={c.coin} labels={c.labels} /> : <Dash />}</td>
      <td className="r">{t?.fee ? <Fee raw={t.fee} coin={c.coin} /> : <Dash />}</td>
      <td><Chip status={f.stage} /></td>
    </tr>
  );
}

const head = (coin: Coin) => <thead><tr><th>Transaction hash</th><th>Method</th><th>Block</th><th>Age</th><th>From</th><th aria-hidden="true" /><th>To</th><th className="r">Value</th><th className="r">{`Fee (${coin.symbol})`}</th><th>Stage</th></tr></thead>;

/**
 * How many are not final yet in all, from the attempts and the pool; the in-flight list is capped by the server and is not the count. `atLeast` when the pool is
 * not counted. `inBlocks` is the part in blocks being proven that the final total does not hold already. The pool is a count with no hashes, so a transaction
 * waiting when it was read may be final by the time of the final total: `about` says so when the pool was read before that total.
 */
type Total = { total: number; atLeast: boolean; inBlocks: number; about: boolean };
const totalOf = (f: InFlight | undefined, asOfBlock?: number | null, asOf?: string | null): Total | null => {
  if (!f) return null;
  const c = notFinalCounts(f);
  // The final total counts every block up to asOfBlock, so an attempt at or below it (its block was indexed after the in-flight read) is already in that total.
  const inBlocks = typeof asOfBlock === "number" ? f.attempts.reduce((n, a) => n + (a.number > asOfBlock ? (a.txCount ?? 0) : 0), 0) : c.inBlocks;
  // The two reads are from different moments, and that matters only when something can have changed between them: a transaction waiting in the pool (it may be final
  // in the total by now) or an attempt whose block the total already holds. With neither, the figure is exact and says no "about".
  // Known and left as it is: when the in-flight read is the NEWER one, a block that became final between the two reads is in neither the total (as of asOfBlock) nor the
  // attempts (it is final now), so "in all" is short by that block's transactions until the next poll (a few seconds); the two reads share no snapshot to tell it by.
  const overlap = typeof asOfBlock === "number" && f.attempts.some((a) => a.number <= asOfBlock && (a.txCount ?? 0) > 0);
  const poolOlder = !!asOf && !!f.poolWaiting && c.waiting !== null && c.waiting > 0 && Date.parse(f.poolWaiting.at) < Date.parse(asOf);
  const about = poolOlder || overlap;
  return { total: inBlocks + (c.waiting ?? 0), atLeast: c.waiting === null, inBlocks, about };
};
const more = (t: Total) => `${t.atLeast ? "at least " : t.about ? "about " : ""}${count(t.total)}`;

/** The title's counts: the final transactions the server counted, those in blocks being proven and those waiting. The total is final only, so "in all" adds the two that are not final yet, and the parts add up; null from the server is said as not counted, never as 0. */
function headline(finalTotal: number | null | undefined, inAll: Total | null, flight: InFlight | undefined): string | null {
  const nf = flight ? notFinalCounts(flight) : null;
  const parts: string[] = [];
  if (finalTotal !== undefined) {
    if (finalTotal === null) parts.push("total not counted yet");
    else {
      if (inAll) parts.push(`${more({ ...inAll, total: finalTotal + inAll.total })} in all`);
      parts.push(`${count(finalTotal)} final`);
    }
  }
  if (nf) parts.push(`${count(inAll && finalTotal !== null && finalTotal !== undefined ? inAll.inBlocks : nf.inBlocks)} being proven`, nf.waiting === null ? "the pool is not counted" : `${count(nf.waiting)} waiting`);
  return parts.length ? parts.join(" · ") : null;
}

/** The four cards of screen 04, from the stats routes: the day's transactions, the last hour's time to final, what is not final yet with how many are stuck, and the lost ones. A number the stats cannot give is a dash and says why. */
function Cards({ live, inBlocks }: { live: boolean; inBlocks?: number }) {
  const hour = useQuery({ queryKey: ["stats-summary", "1h"], queryFn: () => getStatsSummary("1h"), refetchInterval: 30_000 });
  const day = useQuery({ queryKey: ["stats-summary", "24h"], queryFn: () => getStatsSummary("24h"), refetchInterval: 30_000 });
  const flight = useInFlight(live);
  const h = hour.data, d = day.data;
  // The same count of the blocks being proven as the title's: with the final total known, the attempts it already holds are left out.
  const n = flight.data ? (({ waiting, inBlocks: raw }) => ({ waiting, inBlocks: inBlocks ?? raw }))(notFinalCounts(flight.data)) : null;
  const stuckOf = (h ?? d)?.acceptedNotFinal;
  const noDay = DASH_WHY(readOf(day));
  return (
    <section className="stats stats-4" aria-label="Numbers">
      {d ? (
        <Stat icon="doc" label="Transactions" note="24 h" sub={<AllTime t={d.txs.allTime} />} foot={`in ${count(d.blocks.count)} ${d.blocks.count === 1 ? "block" : "blocks"}, each one Canton transaction`}>{count(d.txs.count)}</Stat>
      ) : <Stat icon="doc" label="Transactions" note="24 h" foot={noDay}>—</Stat>}
      <Time icon="clock" label="Time to final" note="last hour" s={h ? h.timeToFinal : undefined} read={readOf(hour)} foot="accepted to final on Canton" none="no transaction in the last hour" />
      {n ? (
        <Stat icon="clock" label="Not final yet" foot={`${count(n.inBlocks)} being proven · ${n.waiting === null ? "pool count not known" : `${count(n.waiting)} waiting`}${stuckOf ? ` · ${count(stuckOf.stuck)} stuck (over ${count(stuckOf.stuckAfterSeconds)} s)` : ""}`}>{count(n.inBlocks + (n.waiting ?? 0))}</Stat>
      ) : <Stat icon="clock" label="Not final yet" foot={flight.isError ? "what is in flight cannot be read right now" : "Reading…"}>—</Stat>}
      {d ? (
        <Stat icon="shield" label="Lost" note="all time" tone={d.lost.total ? undefined : "ok"} foot={d.lost.total ? <>Accepted by Ostia and never made final. <Link to="/stats">Stats</Link> lists each with its reason.</> : "accepted by Ostia and never made final"}>
          <span className={d.lost.total ? "bad" : "ok"}>{count(d.lost.total)}</span>
        </Stat>
      ) : <Stat icon="shield" label="Lost" note="all time" foot={noDay}>—</Stat>}
    </section>
  );
}

type Rows = { items: TxListItem[] | undefined; error: Error | null; page: number };
type RowsProps = { view: TxFilter; st: ApiStatus | undefined; now: number; live: boolean; faucet: string | null | undefined; notFinal: InFlightTx[]; all: Total | null; inAll: Total | null; finalTotal: number | null | undefined };

/** The list of All with a counted total: Page x of y, First and Last, the last page read from the other end (`order=asc`). */
function NumberedRows(props: RowsProps) {
  const p = useBothEnds(["txs", "page", "all"], PER, (before, n) => getTxPage(before, n, "all"), (after, n) => getTxPageOldest(after, n, "all"), listPoll(props.live));
  return <FinalList {...props} rows={{ items: p.items, error: p.error, page: p.page }} pager={<NumberedPager p={p} label="Pages of transactions" />} />;
}
/** The filtered lists, and All while the server cannot count: the server totals only All, so these have no page count and no Last, only newer and older. */
function PagedRows(props: RowsProps) {
  const p = usePaged(["txs", "page", props.view], (before) => getTxPage(before, PER, props.view), listPoll(props.live));
  return <FinalList {...props} rows={{ items: p.data?.items, error: p.error, page: p.page }} pager={<Pager p={p} label="Pages of transactions" />} />;
}
const FinalRows = (props: RowsProps) => (props.view === "all" && typeof props.finalTotal === "number" ? <NumberedRows {...props} /> : <PagedRows {...props} />);

function FinalList({ view, st, now, faucet, notFinal, all, inAll, finalTotal, rows, pager }: RowsProps & { rows: Rows; pager: React.ReactNode }) {
  const p = rows;
  const items = p.items;
  const showNotFinal = view === "all" && p.page === 1;
  const shown = showNotFinal ? notFinal.slice(0, NOT_FINAL_SHOWN) : [];
  const details = useDetails(shown);
  const labels = useLabels([
    ...(items ?? []).flatMap((t) => [t.from, t.to, t.created, t.tokenMoves?.first?.token]),
    ...details.flatMap((t) => (t ? [t.from, t.to, t.created] : [])),
  ]);
  if (p.error && !items) return <ErrorCard message={p.error.message} retrying />;
  if (!items || !st) return <LoadingCard>Reading the transactions…</LoadingCard>;
  const c: Ctx = { now, coin: st.coin, faucet, chain: st.chainName, labels };
  const n = shown.length + items.length;
  // Only the list of all is totalled; the rows of page 1 include the ones not final yet, so they are told against the total with those added.
  const of = view !== "all" || finalTotal === undefined ? "" : finalTotal === null ? " · total not counted yet"
    : p.page === 1 ? "" : ` · ${count(finalTotal)} final in all`;
  // When not-final rows are cut off, the rows shown are not the newest of the total, and the label does not say so.
  const cut = !!inAll && inAll.total > shown.length;
  const label = !n ? "No transactions yet."
    : view === "all" && finalTotal !== undefined && finalTotal !== null && p.page === 1 && inAll ? `Showing ${cut ? "" : "the newest "}${count(n)} of ${more({ ...inAll, total: finalTotal + inAll.total })}`
    : view === "all" && finalTotal !== undefined && finalTotal !== null && p.page === 1 ? `Showing the newest ${count(n)} of ${count(finalTotal)}`
    : p.page === 1 ? `Showing the newest ${count(n)} on this page${of}` : `Showing ${count(n)} on page ${p.page}${of}`;
  return (
    <section className="card" aria-label="Transactions">
      <div className="list-h"><span className="muted">{label}</span>{pager}</div>
      <div className="scroll">
        <table className="tbl txs">
          {head(st.coin)}
          <tbody>
            {shown.map((f, i) => <NotFinalRow key={f.hash} f={f} t={details[i]} c={c} />)}
            {items.map((t) => <Row key={t.hash} t={t} c={c} />)}
          </tbody>
        </table>
      </div>
      {showNotFinal && all && all.total > shown.length && <p className="muted small">{all.atLeast ? "At least " : ""}{count(all.total - shown.length)} more not final yet, older than the rows shown, are not listed.</p>}
      <p className="muted small"><b>Waiting</b>: accepted, in the pool. <b>Being proven</b>: in a block that is not final yet; if Canton refused that block, the transaction would go back to the pool. <b>Final</b>: its block is final on Canton.</p>
    </section>
  );
}

function NotFinalOnly({ st, now, faucet, notFinal, all }: { st: ApiStatus | undefined; now: number; faucet: string | null | undefined; notFinal: InFlightTx[]; all: Total | null }) {
  const shown = notFinal.slice(0, NOT_FINAL_SHOWN);
  const details = useDetails(shown);
  const labels = useLabels(details.flatMap((t) => (t ? [t.from, t.to, t.created] : [])));
  if (!all || !st) return <LoadingCard>Reading what is not final yet…</LoadingCard>;
  const c: Ctx = { now, coin: st.coin, faucet, chain: st.chainName, labels };
  const unlisted = all.total - shown.length;
  const label = all.total === 0 && shown.length === 0 ? "Nothing is waiting or being proven."
    : shown.length === 0 ? `${more(all)} not final yet, none listed.`
    : unlisted > 0 ? `The newest ${count(shown.length)} of ${more(all)} not final yet` : `${count(shown.length)} not final yet`;
  return (
    <section className="card" aria-label="Transactions not final yet">
      <div className="list-h"><span className="muted">{label}</span></div>
      {shown.length > 0 && <div className="scroll"><table className="tbl txs">{head(st.coin)}<tbody>{shown.map((f, i) => <NotFinalRow key={f.hash} f={f} t={details[i]} c={c} />)}</tbody></table></div>}
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
  // The total comes with the first page of all; the list below shares this read when it shows that page.
  const first = useQuery({ queryKey: ["txs", "page", "all", null], queryFn: () => getTxPage(null, PER, "all"), refetchInterval: listPoll(live) }).data;
  const finalTotal = first ? (first.total ?? null) : undefined;
  const inAll = totalOf(flight.data, first?.totalAsOfBlock, first?.totalAsOf);
  const counts = headline(finalTotal, inAll, flight.data);
  const csv: TxFilter = view === "failed" || view === "calls" ? view : "all";
  return (
    <>
      <div className="ptitle">
        <h1>Transactions</h1>
        {counts && <span className="muted">{counts}</span>}
        <span className="grow" />
        <div className="seg" role="group" aria-label="Show transactions">
          {VIEWS.map((v) => <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)}>{v.label}</button>)}
        </div>
        {view !== "notfinal" && <DownloadLink href={txsCsvPath(csv)} file="transactions.csv">CSV</DownloadLink>}
      </div>
      <Cards live={live} inBlocks={inAll && finalTotal != null ? inAll.inBlocks : undefined} />
      {view === "notfinal"
        ? <NotFinalOnly st={st} now={now} faucet={faucet} notFinal={notFinal} all={all} />
        : <FinalRows key={view} view={view === "all" ? "all" : view} st={st} now={now} live={live} faucet={faucet} notFinal={notFinal} all={all} inAll={inAll} finalTotal={finalTotal} />}
    </>
  );
}
