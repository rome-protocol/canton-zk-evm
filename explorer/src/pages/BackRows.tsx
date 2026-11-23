import type { Hex } from "viem";
import { dateTime } from "../format.ts";
import { ExplorerLink } from "../components/ExplorerLink.tsx";
import { LEAVE_MOVE } from "../bridge/route/words.ts";
import { MoveMarks } from "./MoveMarks.tsx";
import { useMarks } from "./moveWatch.ts";
import type { Back, BackRow } from "./useBack.ts";

export interface Faucet { label: string; busy: boolean; coming: boolean; onGet(): void }

function Row({ item, back, faucet }: { item: BackRow; back: Back; faucet: Faucet | null }) {
  const { row, view: v } = item;
  const marks = useMarks((v.marksOf as Hex | null) ?? null);
  const message = back.busy === row.id ? null : back.messages[row.id] || null;
  const onOstia = v.actions.some((a) => a.kind === "claim" || a.kind === "forward" || a.kind === "refund");
  return (
    <li className="act-row transfer" aria-label={v.title}>
      <div className="act-top"><b>{v.title}</b><span className="muted small">{dateTime(new Date(row.at).toISOString())} · {v.word}</span></div>
      <ol className="xsteps" aria-label="How far the move has got">
        {v.steps.map((x) => (
          <li key={x.key} className={x.state} aria-label={`${x.label}: ${x.state === "done" ? "done" : x.state === "now" ? "now" : "waiting"}`}>
            <i aria-hidden="true" /><span>{x.label}</span>{x.detail && <span className="muted small">{x.detail}</span>}
          </li>
        ))}
      </ol>
      {v.sends.length > 0 && <ul className="small muted" aria-label="The sends held together">{v.sends.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      {v.marksOf && <div className="act-marks"><MoveMarks marks={marks} block={false} /></div>}
      {v.notes.map((n) => <p key={n.text} className={`small ${n.bad ? "bad" : "muted"}`} role="status">{n.text}</p>)}
      {message && <p className="small bad" role="alert">{message}</p>}
      {v.actions.map((a) => (
        <div key={a.kind}>
          <button type="button" className="btn ghost" disabled={back.busy !== null} onClick={() => back.act(item, a.kind)}>{a.label}</button>
          {a.notes.map((n) => <p key={n} className="small muted">{n}</p>)}
        </div>
      ))}
      {onOstia && faucet && <p className="small"><button type="button" className="link-b" disabled={faucet.busy || faucet.coming} onClick={faucet.onGet}>{faucet.busy ? "Asking the faucet…" : faucet.coming ? "Your test coin is on its way…" : faucet.label}</button></p>}
      {v.phase === "unsent" && <button type="button" className="link-b" onClick={() => back.giveUp(item)}>Give this up</button>}
      {row.episode && <p className="act-links small"><ExplorerLink to={`/tx/${row.episode.txHash}`}>The move on Ostia</ExplorerLink></p>}
      {v.open && v.actions.length === 0 && v.phase !== "lost" && <p className="small muted">{LEAVE_MOVE}</p>}
    </li>
  );
}

/** The rows of the way back to Canton: each send or held coin with its steps, and the person's own steps when they are offered. */
export function BackRows({ items, back, faucet }: { items: BackRow[]; back: Back; faucet: Faucet | null }) {
  if (items.length === 0) return null;
  return <ul className="act-list">{items.map((i) => <Row key={i.row.id} item={i} back={back} faucet={faucet} />)}</ul>;
}
