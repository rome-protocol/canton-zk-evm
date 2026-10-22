import { Link } from "react-router-dom";
import { getBlockPage, type BlockListItem } from "../api.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Chip } from "../components/Chip.tsx";
import { HashLink } from "../components/HashLink.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { count, duration, seconds } from "../format.ts";
import { listPoll } from "../stats.ts";
import { useLive } from "../useLive.ts";
import { useNow, useStatus } from "../useStatus.ts";

const share = (b: BlockListItem) => (b.gasLimit > 0 ? (b.gasUsed / b.gasLimit) * 100 : 0);

function Row({ b, now }: { b: BlockListItem; now: number }) {
  const pct = share(b);
  return (
    <tr>
      <td><Link className="num" to={`/block/${b.number}`}>{b.number}</Link></td>
      <td title={new Date(b.timestamp * 1000).toISOString()}>{b.timestamp === 0 ? "genesis" : `${duration(now - b.timestamp * 1000)} ago`}</td>
      <td className="r">{b.txCount}</td>
      <td className="r mono">{count(b.gasUsed)} <span className="muted small">{pct.toFixed(1)}%</span><span className="gasbar" aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }} /></span></td>
      <td className="r">{b.legsCount}</td>
      <td className="r">{b.updateId ? seconds(b.timestamp, b.recordTime) : "—"}</td>
      <td>{b.updateId ? <HashLink value={b.updateId} kind="update" to={`/canton/${b.updateId}`} /> : <span className="muted">no record</span>}</td>
      <td>{b.number === 0 ? <Chip status="genesis" /> : <Chip status="final" />}</td>
    </tr>
  );
}

/** The block being proven, which the list does not hold yet: it comes from the status and is shown on the first page only. */
function ProvingRow({ number, timestamp, now }: { number: number; timestamp: number; now: number }) {
  return (
    <tr className="row-proving">
      <td><Link className="num" to={`/block/${number}`}>{number}</Link></td>
      <td>cut {duration(now - timestamp * 1000)} ago</td>
      <td className="r">—</td><td className="r">—</td><td className="r">—</td><td className="r">—</td>
      <td className="muted">not on Canton yet</td>
      <td><Chip status="proving" /></td>
    </tr>
  );
}

/** Every final block, newest first, a page at a time. */
export function Blocks() {
  const live = useLive(["blocks"]);
  const now = useNow();
  const st = useStatus().data;
  const p = usePaged(["blocks", "page"], getBlockPage, listPoll(live));
  const items = p.data?.items;
  return (
    <>
      <div className="ptitle">
        <h1>Blocks</h1>
        <span className="muted">{st?.final ? `final block ${st.final.number}` : ""}{st?.proving ? ` · block ${st.proving.number} is being proven` : ""}</span>
      </div>
      <div className="note">Blocks are cut on demand: when transactions wait and the last block is final. Each final block is one Canton transaction, and its update id opens the Canton record.</div>
      {p.error && !items ? <ErrorCard message={p.error.message} retrying /> : !items ? <LoadingCard>Reading the blocks…</LoadingCard> : (
        <section className="card" aria-label="Blocks">
          <div className="list-h"><span className="muted">{items.length ? `Showing blocks ${items[0]!.number} to ${items[items.length - 1]!.number}` : "No blocks yet."}</span><Pager p={p} label="Pages of blocks" /></div>
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>Block</th><th>Age</th><th className="r">Transactions</th><th className="r">Gas used</th><th className="r">Legs</th><th className="r">Time to final</th><th>Canton update</th><th>Stage</th></tr></thead>
              <tbody>
                {!p.hasPrev && st?.proving && <ProvingRow number={st.proving.number} timestamp={st.proving.timestamp} now={now} />}
                {items.map((b) => <Row key={b.number} b={b} now={now} />)}
              </tbody>
            </table>
          </div>
          <p className="muted small">Ages are counted to {new Date(now).toISOString().slice(11, 19)} UTC. Time to final runs from the block's making to Canton's record time.</p>
        </section>
      )}
    </>
  );
}
