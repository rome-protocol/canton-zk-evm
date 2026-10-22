import { Link } from "react-router-dom";
import type { InFlightAttempt, InFlightTx } from "../api.ts";
import { Chip, type Status } from "./Chip.tsx";
import type { Read } from "../stats.ts";
import type { StreamState } from "../useLive.ts";
import { duration, short, utcMs } from "../format.ts";
import { useNow } from "../useStatus.ts";

/** How many of the five steps are done at each stage; the next one is under way. */
const DONE = { cut: 1, built: 2, proving: 2, proved: 3, submitted: 3, committed: 5 } as const;

interface Step { name: string; at: string | null; after: string | null; note?: string; usual?: string }
type Usual = { lowMs: number; highMs: number } | null;

/** The word for a block at each stage: nothing is proven before the proof starts, and a block Canton has committed waits for the explorer to read it. */
const CHIP: Record<InFlightAttempt["stage"], Status> = { cut: "building", built: "building", proving: "proving", proved: "proving", submitted: "proving", committed: "unindexed" };

/** The five steps of a block's way to final, with the time of each that has happened. A step with no time is one that has not happened, and says nothing. */
function steps(a: InFlightAttempt, now: number, usual: Usual): { rows: Step[]; reached: number } {
  const gap = (from: string | null, to: string | null) => (from && to ? `+${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(2)} s` : null);
  const proving = a.proofStartedAt && !a.proofEndedAt ? `${duration(now - Date.parse(a.proofStartedAt))} so far` : a.proofEndedAt ? `done in ${duration(Date.parse(a.proofEndedAt) - Date.parse(a.proofStartedAt ?? a.proofEndedAt))}` : undefined;
  return {
    reached: DONE[a.stage],
    rows: [
      { name: "Cut", at: a.cutAt, after: null },
      { name: "Built by reth", at: a.builtAt, after: gap(a.cutAt, a.builtAt) },
      { name: "Being proven", at: a.proofStartedAt, after: null, note: proving, usual: usual && a.proofStartedAt && !a.proofEndedAt ? `usually ${(usual.lowMs / 1000).toFixed(1)}–${(usual.highMs / 1000).toFixed(1)} s` : undefined },
      { name: "Sent to Canton", at: a.submittedAt, after: gap(a.proofEndedAt, a.submittedAt) },
      { name: "Final on Canton", at: null, after: null, note: a.stage === "committed" ? "committed; the explorer has not read it yet" : undefined },
    ],
  };
}

/** The transactions that came to the pool after this block was cut: they wait for the next one, which is cut when this one is final. */
function Later({ a, later }: { a: InFlightAttempt; later: InFlightTx[] }) {
  if (!later.length) return null;
  const one = later.length === 1 ? later[0]! : null;
  return (
    <p className="fl-later small muted">
      {later.length} more transaction{one ? "" : "s"}{one && <>, <Link className="mono" to={`/tx/${one.hash}`}>{short(one.hash, 8, 4)}</Link>,</>} arrived after this block was cut. {one ? "It waits" : "They wait"} for block {a.number + 1}, which is cut when block {a.number} is final.
    </p>
  );
}

function Attempt({ a, now, usual, later }: { a: InFlightAttempt; now: number; usual: Usual; later: InFlightTx[] }) {
  const { rows, reached } = steps(a, now, usual);
  return (
    <li className="fl-row">
      <div className="fl-block">
        <span className="fl-k">Block</span>
        <Link className="fl-n num" to={`/block/${a.number}`}>{a.number}</Link>
        <span className="muted small">{a.txCount === null ? "transactions not known yet" : `${a.txCount} transaction${a.txCount === 1 ? "" : "s"}`}</span>
        <Chip status={CHIP[a.stage]} />
      </div>
      <ol className="fl-steps" aria-label={`Steps of block ${a.number}`}>
        {rows.map((s, i) => (
          <li key={s.name} className={`fl-step${i < reached ? " done" : i === reached ? " now" : ""}`}>
            <i aria-hidden="true" />
            <span className="fl-name">{s.name}</span>
            <span className="fl-at mono small">{s.at ? utcMs(s.at).replace(" UTC", "") : "—"}{s.after ? ` · ${s.after}` : ""}</span>
            {s.note && <span className="fl-note small muted">{s.note}</span>}
            {s.usual && <span className="fl-note small muted">{s.usual} <span className="tag">producer log</span></span>}
          </li>
        ))}
      </ol>
      <Later a={a} later={later} />
    </li>
  );
}

const PILL: Record<StreamState, string> = { connecting: "connecting…", live: "updates live", down: "reconnecting…", off: "updates every 5 s" };

/**
 * The blocks that are not final yet, and the transactions waiting for one. Everything here can still change, and the panel says so. It says
 * that every block is final only when the route answered with no attempts: while it is being read, or cannot be, it says that instead.
 */
export function InFlightPanel({ attempts, waiting, stream, read = "ok", usual = null, later = [] }: { attempts: InFlightAttempt[]; waiting: number | null; stream: StreamState; read?: Read; usual?: Usual; later?: InFlightTx[] }) {
  const now = useNow();
  const newest = Math.max(...attempts.map((a) => a.number));
  const cut = new Set(attempts.map((a) => a.number));
  const idle = waiting !== null && waiting > 0 && !attempts.length;
  return (
    <section className="card flight" aria-labelledby="flight-h">
      <div className="sec-h">
        <h3 id="flight-h">In flight</h3>
        <span className="muted small">Not final yet. These can still change: a block that Canton refuses is gone, and its transactions go back to the pool.</span>
        <span className={`live-pill small${stream === "live" ? " on" : ""}`}>{PILL[stream]}</span>
      </div>
      {read === "loading" ? <p className="muted">Reading…</p> : read === "error" ? <p className="muted">The explorer cannot read what is in flight right now.</p> : (
        <>
          {attempts.length ? <ul className="fl-list">{attempts.map((a) => <Attempt key={`${a.number}`} a={a} now={now} usual={usual} later={a.number === newest ? later.filter((t) => t.stage === "waiting" && Date.parse(t.at) > Date.parse(a.cutAt)) : []} />)}</ul> : <p className="muted">{idle ? "No block is being made right now." : "Nothing is in flight: every block made so far is final."}</p>}
          {waiting === null ? <p className="fl-wait small muted">The pool count is not known right now.</p> : waiting > 0 && (
            <p className="fl-wait small muted">{waiting} transaction{waiting === 1 ? "" : "s"} {waiting === 1 ? "is" : "are"} waiting in the pool, in no block yet{cut.size ? "; the next block takes them" : ""}.</p>
          )}
        </>
      )}
    </section>
  );
}
