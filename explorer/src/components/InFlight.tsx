import { Link } from "react-router-dom";
import type { InFlightAttempt } from "../api.ts";
import { Chip } from "./Chip.tsx";
import { duration, utcMs } from "../format.ts";
import { useNow } from "../useStatus.ts";

/** How many of the five steps are done at each stage; the next one is under way. */
const DONE = { cut: 1, built: 2, proving: 2, proved: 3, submitted: 3, committed: 4 } as const;

interface Step { name: string; at: string | null; after: string | null; note?: string }

/** The five steps of a block's way to final, with the time of each that has happened. A step with no time is one that has not happened, and says nothing. */
function steps(a: InFlightAttempt, now: number): { rows: Step[]; reached: number } {
  const gap = (from: string | null, to: string | null) => (from && to ? `+${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(2)} s` : null);
  const proving = a.proofStartedAt && !a.proofEndedAt ? `${duration(now - Date.parse(a.proofStartedAt))} so far` : a.proofEndedAt ? `done in ${duration(Date.parse(a.proofEndedAt) - Date.parse(a.proofStartedAt ?? a.proofEndedAt))}` : undefined;
  return {
    reached: DONE[a.stage],
    rows: [
      { name: "Cut", at: a.cutAt, after: null },
      { name: "Built by reth", at: a.builtAt, after: gap(a.cutAt, a.builtAt) },
      { name: "Being proven", at: a.proofStartedAt, after: null, note: proving },
      { name: "Sent to Canton", at: a.submittedAt, after: gap(a.proofEndedAt, a.submittedAt) },
      { name: "Final on Canton", at: null, after: null },
    ],
  };
}

function Attempt({ a, now }: { a: InFlightAttempt; now: number }) {
  const { rows, reached } = steps(a, now);
  return (
    <li className="fl-row">
      <div className="fl-block">
        <span className="fl-k">Block</span>
        <Link className="fl-n num" to={`/block/${a.number}`}>{a.number}</Link>
        <span className="muted small">{a.txCount === null ? "transactions not known yet" : `${a.txCount} transaction${a.txCount === 1 ? "" : "s"}`}</span>
        <Chip status="proving" />
      </div>
      <ol className="fl-steps" aria-label={`Steps of block ${a.number}`}>
        {rows.map((s, i) => (
          <li key={s.name} className={`fl-step${i < reached ? " done" : i === reached ? " now" : ""}`}>
            <i aria-hidden="true" />
            <span className="fl-name">{s.name}</span>
            <span className="fl-at mono small">{s.at ? utcMs(s.at).replace(" UTC", "") : "—"}{s.after ? ` · ${s.after}` : ""}</span>
            {s.note && <span className="fl-note small muted">{s.note}</span>}
          </li>
        ))}
      </ol>
    </li>
  );
}

/** The blocks that are not final yet, and the transactions waiting for one. Everything here can still change, and the panel says so. */
export function InFlightPanel({ attempts, waiting, live }: { attempts: InFlightAttempt[]; waiting: number | null; live: boolean }) {
  const now = useNow();
  const cut = new Set(attempts.map((a) => a.number));
  const idle = waiting !== null && waiting > 0 && !attempts.length;
  return (
    <section className="card flight" aria-labelledby="flight-h">
      <div className="sec-h">
        <h3 id="flight-h">In flight</h3>
        <span className="muted small">Not final yet. These can still change: a block that Canton refuses is gone, and its transactions go back to the pool.</span>
        <span className={`live-pill small${live ? " on" : ""}`}>{live ? "updates live" : "reconnecting…"}</span>
      </div>
      {attempts.length ? <ul className="fl-list">{attempts.map((a) => <Attempt key={`${a.number}`} a={a} now={now} />)}</ul> : <p className="muted">{idle ? "No block is being made right now." : "Nothing is in flight: every block made so far is final."}</p>}
      {waiting !== null && waiting > 0 && (
        <p className="fl-wait small muted">{waiting} transaction{waiting === 1 ? "" : "s"} {waiting === 1 ? "is" : "are"} waiting in the pool, in no block yet{cut.size ? "; the next block takes them" : ""}.</p>
      )}
    </section>
  );
}
