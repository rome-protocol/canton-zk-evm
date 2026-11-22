import { Link } from "react-router-dom";
import type { Hex } from "viem";
import type { Deposit } from "../bridge/other/reads.ts";
import type { Move, RouteAsset, RouteOn } from "../bridge/route/setup.ts";
import { viewOfMove } from "../bridge/route/view.ts";
import { LEAVE_MOVE } from "../bridge/route/words.ts";
import { dateTime } from "../format.ts";
import { MoveMarks } from "./MoveMarks.tsx";
import { useMarks } from "./moveWatch.ts";

export interface MoveActions {
  onClaim(m: Move): void;
  /** Starts the move again, once the page can start a move on Canton; without it a lapsed move offers no button. */
  onTryAgain?: () => void;
}

function Row({ m, deposit, setup, asset, claiming, now, busy, message, a }: { m: Move; deposit: Deposit | null; setup: RouteOn; asset: RouteAsset | null; claiming: boolean; now: number; busy: boolean; message: string | null; a: MoveActions }) {
  const v = viewOfMove(m, deposit, setup, asset, claiming, now);
  const marks = useMarks((v.marksOf as Hex | null) ?? null);
  return (
    <li className="act-row transfer" aria-label={v.title}>
      <div className="act-top"><b>{v.title}</b><span className="muted small">{m.at ? `${dateTime(m.at)} · ` : ""}{v.word}</span></div>
      <ol className="xsteps" aria-label="How far the move has got">
        {v.steps.map((x) => (
          <li key={x.key} className={x.state} aria-label={`${x.label}: ${x.state === "done" ? "done" : x.state === "now" ? "now" : "waiting"}`}>
            <i aria-hidden="true" /><span>{x.label}</span>{x.detail && <span className="muted small">{x.detail}</span>}
          </li>
        ))}
      </ol>
      {v.marksOf && <div className="act-marks"><MoveMarks marks={marks} block={false} /></div>}
      {v.progress && <p className="small muted">{v.progress}</p>}
      {v.note && <p className="small muted" role="status">{v.note}</p>}
      {message && <p className="small bad" role="alert">{message}</p>}
      {v.action && (
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => a.onClaim(m)}>{v.action.label}</button>
          <p className="small muted">{v.action.note}</p>
        </>
      )}
      {v.phase === "lapsed" && a.onTryAgain && <button type="button" className="btn ghost" onClick={a.onTryAgain}>Try again</button>}
      {m.txHash && <p className="act-links small"><Link to={`/tx/${m.txHash}`}>The move on Ostia</Link></p>}
      {v.open && v.phase !== "ready" && v.phase !== "claiming" && <p className="small muted">{LEAVE_MOVE}</p>}
    </li>
  );
}

/** The moves of the wallet, newest first, each with its four steps and, once it is ready past the set time, the person's own claim. */
export function RouteMoves({ items, deposits, setup, asset, claiming, now, busy, messages, empty, actions }: {
  items: Move[]; deposits: Record<string, Deposit>; setup: RouteOn; asset: RouteAsset | null; claiming: (m: Move) => boolean; now: number; busy: string | null; messages: Record<string, string>; empty: string; actions: MoveActions;
}) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="act-list">
      {items.map((m) => <Row key={m.id} m={m} deposit={deposits[m.id] ?? null} setup={setup} asset={asset} claiming={claiming(m)} now={now} busy={busy !== null} message={busy === m.id ? null : messages[m.id] ?? null} a={actions} />)}
    </ul>
  );
}
