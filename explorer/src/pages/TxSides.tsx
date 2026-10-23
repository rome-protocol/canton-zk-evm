import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getUpdate, type BlockSummary, type ApiStatus, type ApiTx } from "../api.ts";
import { ago } from "../block-times.ts";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { ProofCard } from "./BlockProof.tsx";
import { TxVerify } from "./TxVerify.tsx";
import type { BlockRead } from "./TxFinal.tsx";
import "./block.css";

/** Final on Canton, and the explorer's indexer has not written the block yet: there is a record, only not one the explorer can show. */
const NOT_INDEXED = "Final on Canton, not indexed yet.";
const NOT_INDEXED_WHY = "Canton holds this transaction's block; the record is shown once the explorer reads it. This page looks again.";

const readingOr = (read: BlockRead, off: string) => <span className="muted">{read === "reading" ? "reading…" : read === "failed" ? "cannot be read right now" : off}</span>;

/** The Canton record that holds this transaction's block: its update, its time, and what the update's own route adds (the synchronizer, the reader's offset, what the producer submitted). */
export function CantonRecord({ t, block, read }: { t: ApiTx; block: BlockSummary | undefined; read: BlockRead }) {
  const c = block?.canton ?? null;
  const id = c?.updateId ?? t.block?.updateId ?? null;
  const update = useQuery({ queryKey: ["update", id], queryFn: () => getUpdate(id!), enabled: !!id, retry: false, staleTime: 60_000 });
  const n = t.block?.number;
  const u = update.data, sent = u?.producerRecord;
  const unread = update.isPending && !!id ? <span className="muted">reading…</span> : update.isError ? <span className="muted">cannot be read right now</span> : <span className="muted">—</span>;
  return (
    <section className="card side canton" aria-labelledby="rec-h">
      <div className="side-h"><span className="side-l" id="rec-h">Canton record</span><span className="muted small">{n !== undefined ? `of block ${n}, which holds this transaction` : "the record that will hold this transaction"}</span></div>
      {!id && t.status === "unindexed" ? (
        <div className="empty-side"><b>{NOT_INDEXED}</b><p>{NOT_INDEXED_WHY}</p></div>
      ) : !id ? (
        <div className="empty-side"><b>Not on Canton yet.</b><p>{t.block ? "Its block is being proven. It has a record on Canton once it is final." : "No block holds it yet, so no record does."}</p></div>
      ) : (
        <>
          <Kv wide>
            <Item label="Update id"><HashLink value={id} kind="update" to={`/canton/${id}`} /></Item>
            <Item label="Record time">{c ? <><span className="mono">{c.recordTime}</span> <span className="muted">· {ago(c.recordTime)}</span></> : readingOr(read, "—")}</Item>
            <Item label="Synchronizer">{u ? <HashLink value={u.synchronizer} kind="party" /> : unread}</Item>
            <Item label="Offset">{u ? <><span className="mono">{u.offset}</span> <span className="tag">reader's participant</span></> : unread}</Item>
            <Item label="Template">{u ? (sent?.template ? <><span className="mono">{sent.template}</span>{sent.choice && <> <span className="muted">·</span> <span className="mono">{sent.choice}</span></>} <span className="tag">producer log</span></> : <span className="muted">not in the producer's log</span>) : unread}</Item>
            <Item label="Command id">{u ? (sent?.commandId ? <><span className="mono">{sent.commandId}</span> <span className="tag">producer log</span></> : <span className="muted">not in the producer's log</span>) : unread}</Item>
            <Item label="Block">{n !== undefined ? <><Link className="num" to={`/block/${n}`}>Block {n}</Link>{block && <span className="muted"> · {block.txCount} transaction{block.txCount === 1 ? "" : "s"}, one Canton transaction</span>}</> : "—"}</Item>
          </Kv>
          <div className="side-foot">
            <Link className="side-link" to={`/canton/${id}`}>Open the Canton record →</Link>
            <span className="grow" />
            {n !== undefined && <Link className="side-link" to={`/block/${n}`}>Open block {n} →</Link>}
          </div>
        </>
      )}
    </section>
  );
}

/** The proof of the block, with Verify. Before the block is final there is no proof to show: the card says so, and Verify is greyed. */
export function ProofSide({ t, block, st, read }: { t: ApiTx; block: BlockSummary | undefined; st: ApiStatus | undefined; read: BlockRead }) {
  const n = t.block?.number;
  const c = block?.canton ?? null;
  if (n === undefined) return null;
  if (!c || !block) {
    const unindexed = t.status === "unindexed";
    return (
      <section className="card side canton proof" aria-labelledby="proof-h">
        <div className="side-h"><span className="side-l" id="proof-h">The proof</span><span className="muted small">of block {n}</span></div>
        <div className="empty-side">{unindexed ? <><b>{NOT_INDEXED}</b><p>{NOT_INDEXED_WHY}</p></> : read === "reading" ? <p>Reading the block…</p> : read === "failed" ? <p>The block cannot be read right now.</p> : <p>The proof is made while the block is being proven. Its facts are shown once the block is final.</p>}</div>
        {st && read !== "reading" && <div className="proof-verify"><TxVerify number={n} blockHash={t.block?.hash ?? ""} pins={st.pins} final={t.status === "final" && !!t.block?.hash} unindexed={unindexed} proofBytes={null} /></div>}
      </section>
    );
  }
  return (
    <ProofCard c={c} pins={st?.pins} compactFor={n}>
      {st && <TxVerify number={n} blockHash={block.hash} pins={st.pins} final proofBytes={c.proofBytes} />}
    </ProofCard>
  );
}
