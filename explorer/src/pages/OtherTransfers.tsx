import { useState } from "react";
import { Link } from "react-router-dom";
import type { Hex } from "viem";
import type { Transfer } from "../bridge/other/record.ts";
import type { Live } from "../bridge/other/transfer.ts";
import { askingOf, sides } from "../bridge/other/transfer.ts";
import { viewOf, type Names, type View } from "../bridge/other/view.ts";
import { LEAVE_NOTE, otherTxUrl } from "../bridge/other/words.ts";
import { OutLink } from "../components/Help.tsx";
import { dateTime, short } from "../format.ts";
import { MoveMarks } from "./MoveMarks.tsx";
import { useMarks } from "./moveWatch.ts";

export interface RowActions {
  onSend(t: Transfer): void;
  onClaim(t: Transfer): void;
  onLook(t: Transfer, which: "send" | "claim"): void;
  onAdopt(t: Transfer, which: "send" | "claim", hash: string): void;
  onPutWallet(chainId: number): void;
  onRemove(t: Transfer): void;
}

/** A transaction of a transfer: Ostia's is a page of the explorer; Ethereum Sepolia's is its own explorer's page; any other chain's is shown by its hash. */
function TxLink({ hash, chainId, ostiaId, label }: { hash: Hex; chainId: number; ostiaId: number; label: string }) {
  if (chainId === ostiaId) return <Link to={`/tx/${hash}`}>{label}</Link>;
  const url = otherTxUrl(chainId, hash);
  const shown = <span className="mono" title={hash}>{short(hash, 8, 6)}</span>;
  return url ? <span><OutLink href={url}>{label}</OutLink> {shown}</span> : <span>{label} {shown}</span>;
}

function Row({ t, v, live, names, busy, message, a }: { t: Transfer; v: View; live: Live | undefined; names: Names; busy: boolean; message: string | null; a: RowActions }) {
  const [hash, setHash] = useState("");
  const [asking, setAsking] = useState(false);
  const s = sides({ ostia: names.ostia, other: names.other, topic0: "" }, t.dir);
  const marksTx = v.marksOf ? t[v.marksOf]?.tx ?? null : null;
  const marks = useMarks(marksTx);
  const which = v.phase === "unsure-claim" ? "claim" : "send";
  const unsure = v.phase === "unsure-send" || v.phase === "unsure-claim";
  const elsewhere = live?.wrongChain ?? null;
  const removable = v.phase === "unsent" || v.phase === "lost" || unsure;
  return (
    <li className="act-row transfer" aria-label={v.title}>
      <div className="act-top"><b>{v.title}</b><span className="muted small">{dateTime(t.at)} · {v.word}</span></div>
      <ol className="xsteps" aria-label="How far the transfer has got">
        {v.steps.map((x) => (
          <li key={x.key} className={x.state} aria-label={`${x.label}: ${x.state === "done" ? "done" : x.state === "now" ? "now" : "waiting"}`}>
            <i aria-hidden="true" /><span>{x.label}</span>{x.detail && <span className="muted small">{x.detail}</span>}
          </li>
        ))}
      </ol>
      {v.marksOf && <div className="act-marks"><MoveMarks marks={marks} /></div>}
      {v.progress && <p className="small muted">{v.progress}</p>}
      {v.note && <p className={`small ${v.note.bad ? "bad" : "muted"}`} role={v.note.bad ? "alert" : "status"}>{v.note.text}</p>}
      {message && <p className="small bad" role="alert">{message}</p>}
      {elsewhere !== null && (
        <p className="small muted" role="status">
          Put your wallet on {elsewhere === names.other.chainId ? names.other.name : names.ostia.name} to look for this. <button type="button" className="link-b" disabled={busy} onClick={() => a.onPutWallet(elsewhere)}>Put my wallet on {elsewhere === names.other.chainId ? names.other.name : names.ostia.name}</button>
        </p>
      )}
      {(t.send?.tx || t.claim?.tx) && (
        <p className="act-links small">
          {t.send?.tx && <TxLink hash={t.send.tx} chainId={t.send.chainId} ostiaId={names.ostia.chainId} label={`The send on ${s.sendName}`} />}
          {t.claim?.tx && <TxLink hash={t.claim.tx} chainId={t.claim.chainId} ostiaId={names.ostia.chainId} label={`The claim on ${s.claimName}`} />}
        </p>
      )}
      {v.action && (
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => (v.action!.kind === "send" ? a.onSend(t) : a.onClaim(t))}>{v.action.label}</button>
          {v.action.note && <p className="small muted">{v.action.note}</p>}
        </>
      )}
      {unsure && (
        <div className="unsure">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => a.onLook(t, which)}>Look for it</button>
          <p className="small muted">Found it in your wallet? Paste its transaction hash and the page carries on with it.</p>
          <div className="field">
            <input aria-label="Transaction hash" value={hash} spellCheck={false} autoComplete="off" onChange={(e) => setHash(e.target.value.trim())} />
          </div>
          <button type="button" className="btn ghost" disabled={busy || hash === ""} onClick={() => a.onAdopt(t, which, hash)}>Use this hash</button>
        </div>
      )}
      {v.open && v.phase !== "unsent" && v.phase !== "asking" && !unsure && <p className="small muted">{LEAVE_NOTE}</p>}
      {removable && !asking && <button type="button" className="link-b give-up" onClick={() => (unsure ? setAsking(true) : a.onRemove(t))}>{v.phase === "lost" ? "Remove this" : "Give this transfer up"}</button>}
      {removable && asking && (
        <div className="give-up" role="group" aria-label="Give this transfer up">
          <p className="small muted">Part of this may already be done. If you give it up, this page cannot track it.</p>
          <button type="button" className="link-b" onClick={() => a.onRemove(t)}>Give it up</button> <button type="button" className="link-b" onClick={() => setAsking(false)}>Keep it</button>
        </div>
      )}
    </li>
  );
}

/** The transfers started in this browser, newest first, each with its steps and the one thing that may be pressed next. */
export function Transfers({ items, live, names, busy, messages, now, empty, actions }: {
  items: Transfer[]; live: Record<string, Live>; names: Names; busy: string | null; messages: Record<string, string>; now: number; empty: string; actions: RowActions;
}) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="act-list">
      {items.map((t) => <Row key={t.id} t={t} v={viewOf(t, live[t.id]?.deposit ?? null, names, now, askingOf(t.id))} live={live[t.id]} names={names} busy={busy !== null} message={busy === t.id ? null : messages[t.id] ?? null} a={actions} />)}
    </ul>
  );
}
