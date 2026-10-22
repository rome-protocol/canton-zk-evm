import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiTx, BlockListItem, InFlightTx, TxListItem } from "../api.ts";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { SearchBox } from "../components/SearchBox.tsx";
import { count, duration, exact, short, span, units } from "../format.ts";
import type { Read, Summary } from "../stats.ts";
import { useNow } from "../useStatus.ts";

/** What the home page says it is, with a search box of its own and a few things to try, which are the newest the explorer holds. */
export function Hero({ tries }: { tries: Array<{ label: string; q: string }> }) {
  return (
    <section className="card hero" aria-labelledby="hero-h">
      <h1 id="hero-h">Ostia block explorer</h1>
      <p>Ostia is an EVM chain on Canton. Every block is proven with ZisK and then committed to Canton as one transaction, so a transaction is final when its block is final on Canton.</p>
      <SearchBox hero />
      {tries.length > 0 && (
        <div className="try"><span>Try</span>{tries.map((t) => <Link key={t.q} className="mono" to={`/search?q=${encodeURIComponent(t.q)}`}>{t.label}</Link>)}</div>
      )}
    </section>
  );
}

function Stat({ label, note, children, foot }: { label: string; note?: string; children: ReactNode; foot: ReactNode }) {
  return (
    <div className="card stat">
      <span className="stat-k">{label}{note && <span className="faint"> · {note}</span>}</span>
      <span className="stat-v num">{children}</span>
      <span className="muted small">{foot}</span>
    </div>
  );
}

/** What is not final yet. Unknown is shown as unknown: a dash while the route is read or cannot be, and no waiting count with no sample of the pool. */
function NotFinal({ n, read }: { n: Summary["notFinal"]; read: Read }) {
  if (!n) return <Stat label="Not final yet" foot={read === "loading" ? "Reading…" : "what is in flight cannot be read right now"}>—</Stat>;
  return <Stat label="Not final yet" foot={`${n.inBlocks} in blocks being made or proven · ${n.waiting === null ? "pool count not known" : `${n.waiting} waiting`}`}>{n.waiting === null ? n.inBlocks : n.inBlocks + n.waiting}</Stat>;
}

const s1 = (ms: number) => (ms < 120_000 ? `${(ms / 1000).toFixed(1)}` : duration(ms));
const unit = (ms: number) => (ms < 120_000 ? "s" : "");
const NO_TIMES = "the producer's log has no times for these blocks";
/** The stat whose numbers need the stats rollups, which the API does not serve yet: a dash, and the reason. Nothing is made up. */
const SEAM = "not read yet: the stats rollups are not served";

/** A median and a 95th percentile in one card: "8.5 s p95 8.7 s". */
function Spread({ v }: { v: Summary["timeToFinal"] }) {
  return v ? <>{s1(v.medianMs)} <small>{unit(v.medianMs)} p95 {s1(v.p95Ms)} {unit(v.p95Ms)}</small></> : <>—</>;
}

/**
 * The cards of screen 01 in its order. Those the API can fill today are filled from the latest blocks, and say how many (the stats rollups will
 * make them an hour and a day): height, time to final and proof time (the producer's log), transactions, and what is not final yet. The others
 * need the rollups, so they show a dash and why: commit time, rate, lost transactions, success and the 72 h chart.
 */
export function Stats({ summary: s, flight = "ok" }: { summary: Summary; flight?: Read }) {
  const t = s.timeToFinal, p = s.proofTime;
  const window = (v: { blocks: number } | null) => (v ? `latest ${v.blocks} blocks` : undefined);
  return (
    <section className="stats" aria-label="Numbers">
      <Stat label="Block height" foot={s.height === null ? "No final block yet." : `final on Canton${s.proving !== null ? ` · block ${s.proving} is being proven` : ""}`}>{s.height ?? "—"}</Stat>
      <Stat label="Time to final" note={window(t)} foot={t ? "from the producer's cut to Canton's record time" : NO_TIMES}><Spread v={t} /></Stat>
      <Stat label="Proof time" note={window(p)} foot={p ? `ZisK, one proof per block, ${p.blocks} block${p.blocks === 1 ? "" : "s"} · producer log` : NO_TIMES}><Spread v={p} /></Stat>
      <Stat label="Canton commit time" foot={SEAM}>—</Stat>
      <Stat label="Transactions per second" foot={SEAM}>—</Stat>
      <Stat label="Transactions" note={`latest ${s.transactions.blocks} blocks`} foot={`in ${s.transactions.blocks} final block${s.transactions.blocks === 1 ? "" : "s"}, each one Canton transaction`}>{count(s.transactions.count)}</Stat>
      <NotFinal n={s.notFinal} read={flight} />
      <Stat label="Lost transactions" foot={SEAM}>—</Stat>
      <Stat label="Success rate" foot={SEAM}>—</Stat>
      <Stat label="Time to final" note="72 h" foot={SEAM}>—</Stat>
    </section>
  );
}

const Foot = ({ to, children }: { to: string; children: string }) => <div className="tbl-foot"><Link to={to}>{children} →</Link></div>;

/** The newest final blocks, each with the time Canton took to commit it. */
export function LatestBlocks({ blocks, error }: { blocks: BlockListItem[] | undefined; error?: string }) {
  const now = useNow();
  return (
    <section className="card" aria-labelledby="latest-h">
      <div className="sec-h"><h3 id="latest-h">Latest final blocks</h3><span className="muted small">One Canton transaction each</span></div>
      {error ? <p className="muted">{error}</p> : !blocks ? <p className="muted">Reading the blocks…</p> : blocks.length ? (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Block</th><th className="r">Txs</th><th className="r">Time to final</th><th>Canton update</th><th>Stage</th></tr></thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.number}>
                    <td><Link className="num" to={`/block/${b.number}`}>{b.number}</Link><span className="ago">{duration(now - b.timestamp * 1000)} ago</span></td>
                    <td className="r">{b.txCount}</td>
                    <td className="r" title="from the producer's cut to Canton's record time">{b.finalSeconds === null ? <span className="muted">—</span> : span(b.finalSeconds)}</td>
                    <td>{b.updateId ? <HashLink value={b.updateId} kind="update" to={`/canton/${b.updateId}`} /> : <span className="muted">no record</span>}</td>
                    <td><Chip status="final" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Foot to="/blocks">View all blocks</Foot>
        </>
      ) : <p className="muted">No final blocks yet.</p>}
    </section>
  );
}

/** What is known of a transaction that is not final yet: its details from the transaction route, or that they are being read or cannot be. */
export type Details = ApiTx | "reading" | "error";

function Who({ from, to, created, label }: { from: string; to: string | null; created: string | null; label?: string }) {
  return (
    <>
      <Link className="who" to={`/address/${from}`}>{short(from, 8, 5)}</Link>
      {to ? <span className="who muted">to <Link to={`/address/${to}`}>{short(to, 8, 5)}</Link></span> : created ? <span className="who muted">creates <Link to={`/address/${created}`}>{short(created, 8, 5)}</Link></span> : label ? <span className="who muted">{label}</span> : null}
    </>
  );
}

/**
 * The newest transactions: those that are not final yet come first, each with the stage the journal gives it, then the final ones. A transaction
 * that is not final can still change, so what is shown of it is what reth holds; where that cannot be read, the row says so and keeps its stage.
 */
export function LatestTxs({ txs, coin, error, pending = [], pendingRead = "ok", details = {} }: {
  txs: TxListItem[] | undefined; coin: { symbol: string; decimals: number }; error?: string; pending?: InFlightTx[]; pendingRead?: Read; details?: Record<string, Details>;
}) {
  const now = useNow();
  return (
    <section className="card" aria-labelledby="txs-h">
      <div className="sec-h"><h3 id="txs-h">Latest transactions</h3><span className="muted small">Including those not final yet</span></div>
      {pendingRead === "error" && <p className="muted small">Transactions not final yet cannot be read right now.</p>}
      {error ? <p className="muted">{error}</p> : !txs ? <p className="muted">Reading the transactions…</p> : txs.length ? (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Transaction</th><th>From / to</th><th className="r">Value</th><th>Stage</th></tr></thead>
              <tbody>
                {pending.filter((p) => !txs.some((t) => t.hash === p.hash)).map((p) => {
                  const d = details[p.hash] ?? "reading";
                  return (
                    <tr key={p.hash}>
                      <td><Link className="mono" to={`/tx/${p.hash}`}>{short(p.hash, 8, 4)}</Link><span className="ago">{duration(now - Date.parse(p.at))} ago</span></td>
                      <td className="mono small">{d === "reading" ? <span className="muted">reading…</span> : d === "error" ? <span className="muted">cannot be read right now</span> : <Who from={d.from} to={d.to} created={d.created} />}</td>
                      <td className="r">{typeof d === "object" && d.value !== null ? <span title={`${exact(d.value, coin.decimals)} ${coin.symbol}`}>{units(d.value, coin.decimals)} {coin.symbol}</span> : <span className="muted">—</span>}</td>
                      <td><Chip status={p.stage} /></td>
                    </tr>
                  );
                })}
                {txs.map((t) => (
                  <tr key={t.hash}>
                    <td><Link className="mono" to={`/tx/${t.hash}`}>{short(t.hash, 8, 4)}</Link><span className="ago">{duration(now - t.timestamp * 1000)} ago</span></td>
                    <td className="mono small"><Who from={t.from} to={t.to} created={t.created} /></td>
                    <td className="r" title={`${exact(t.value, coin.decimals)} ${coin.symbol}`}>{units(t.value, coin.decimals)} {coin.symbol}</td>
                    <td><Chip status="final" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Foot to="/txs">View all transactions</Foot>
        </>
      ) : <p className="muted">No final transactions yet.</p>}
    </section>
  );
}
