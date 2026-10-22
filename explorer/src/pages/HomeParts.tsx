import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { BlockListItem, TxListItem } from "../api.ts";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { SearchBox } from "../components/SearchBox.tsx";
import { commitTime, count, duration, exact, seconds, short, units } from "../format.ts";
import type { Summary } from "../stats.ts";
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

const s1 = (ms: number) => (ms < 120_000 ? `${(ms / 1000).toFixed(1)}` : duration(ms));

/** The cards the API can fill today (see `summarize`): height, time to final, the transactions of the newest blocks, and what is not final yet. */
export function Stats({ summary: s }: { summary: Summary }) {
  const t = s.timeToFinal;
  return (
    <section className="stats" aria-label="Numbers">
      <Stat label="Block height" foot={s.height === null ? "No final block yet." : `final on Canton${s.proving !== null ? ` · block ${s.proving} is being proven` : ""}`}>{s.height ?? "—"}</Stat>
      <Stat label="Time to final" note={t ? `latest ${t.blocks} blocks` : undefined} foot="from a block's making to Canton's record of it">
        {t ? <>{s1(t.medianMs)} <small>{t.medianMs < 120_000 ? "s " : ""}p95 {s1(t.p95Ms)}{t.p95Ms < 120_000 ? " s" : ""}</small></> : "—"}
      </Stat>
      <Stat label="Transactions" note={`latest ${s.transactions.blocks} blocks`} foot={`in ${s.transactions.blocks} final block${s.transactions.blocks === 1 ? "" : "s"}, each one Canton transaction`}>{count(s.transactions.count)}</Stat>
      <Stat label="Not final yet" foot={`${s.notFinal.inBlocks} in blocks being made or proven · ${s.notFinal.waiting} waiting`}>{s.notFinal.inBlocks + s.notFinal.waiting}</Stat>
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
              <thead><tr><th>Block</th><th className="r">Txs</th><th className="r">Time to final</th><th>Canton update</th><th></th></tr></thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.number}>
                    <td><Link className="num" to={`/block/${b.number}`}>{b.number}</Link><span className="ago">{duration(now - b.timestamp * 1000)} ago</span></td>
                    <td className="r">{b.txCount}</td>
                    <td className="r" title={`made to recorded: ${commitTime(b.timestamp, b.recordTime)}`}>{seconds(b.timestamp, b.recordTime)}</td>
                    <td><HashLink value={b.updateId} kind="update" /></td>
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

/** The newest final transactions. The list route holds final transactions only: those still waiting or being proven are in the panel above. */
export function LatestTxs({ txs, coin, error }: { txs: TxListItem[] | undefined; coin: { symbol: string; decimals: number }; error?: string }) {
  const now = useNow();
  return (
    <section className="card" aria-labelledby="txs-h">
      <div className="sec-h"><h3 id="txs-h">Latest transactions</h3><span className="muted small">Final ones only</span></div>
      {error ? <p className="muted">{error}</p> : !txs ? <p className="muted">Reading the transactions…</p> : txs.length ? (
        <>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Transaction</th><th>From / to</th><th className="r">Value</th><th>Stage</th></tr></thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.hash}>
                    <td><Link className="mono" to={`/tx/${t.hash}`}>{short(t.hash, 8, 4)}</Link><span className="ago">{duration(now - t.timestamp * 1000)} ago</span></td>
                    <td className="mono small">
                      <Link className="who" to={`/address/${t.from}`}>{short(t.from, 8, 5)}</Link>
                      {t.to ? <span className="who muted">to <Link to={`/address/${t.to}`}>{short(t.to, 8, 5)}</Link></span> : t.created ? <span className="who muted">creates <Link to={`/address/${t.created}`}>{short(t.created, 8, 5)}</Link></span> : null}
                    </td>
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
