import { howItBecameFinal, secs, type Became, type Lifecycle } from "../block-times.ts";
import { count } from "../format.ts";
import "./block.css";

/** What the producer's times can say, or why they say nothing: still being read, could not be read, or read (from the journal for a final block, from the in-flight attempt for one still being proven). */
export type Times =
  | { state: "reading" }
  | { state: "unreadable"; became: Became }
  | { state: "read"; became: Became; lifecycle: Lifecycle | null; final: boolean };

export interface TimesSource { proofBytes?: number | null; lifecycle: Lifecycle | null | undefined; recordTime: string | null; reading: boolean; failed: boolean; final: boolean }

export function timesOf({ lifecycle, recordTime, reading, failed, final, proofBytes = null }: TimesSource): Times {
  const became = howItBecameFinal(lifecycle ?? null, recordTime, proofBytes);
  if (reading) return { state: "reading" };
  if (failed) return { state: "unreadable", became: howItBecameFinal(null, recordTime, proofBytes) };
  return { state: "read", became, lifecycle: lifecycle ?? null, final };
}

const NONE = "—";
const tile = (k: string, v: string, s: string) => (
  <div className="tile"><span className="tile-k">{k}</span><b className="tile-v">{v}</b><span className="tile-s">{s}</span></div>
);

/** The four numbers at the top of the block page. A time the producer's journal does not hold is shown as a dash, with the reason under it. */
export function Tiles({ txCount, gasUsed, times }: { txCount: number; gasUsed: number; times: Times }) {
  const t = times.state === "reading" ? null : times.became;
  const why = times.state === "reading" ? "reading the producer's log" : times.state === "unreadable" ? "cannot be read right now"
    : !times.final ? "not final yet" : times.lifecycle === null ? "no row in the producer's log" : "not in the producer's log";
  return (
    <div className="tiles" role="group" aria-label="This block in numbers">
      {tile("Transactions", count(txCount), `${count(gasUsed)} gas`)}
      {tile("Proof time", t?.proofMs != null ? secs(t.proofMs) : NONE, t?.proofMs != null ? "ZisK, from the producer's log" : why)}
      {tile("Canton commit", t?.commitMs != null ? secs(t.commitMs) : NONE, t?.commitMs != null ? "sent to record time" : why)}
      {tile("Cut to final", t?.totalMs != null ? secs(t.totalMs) : NONE, t?.totalMs != null ? "the block's whole way to final" : why)}
    </div>
  );
}

const PART_LABEL = { prepare: "", proof: "Proof", send: "", canton: "" } as const;

/** "How this block became final": the whole way as a bar, and the six steps under it with their times and where each time comes from. */
export function HowFinal({ times, final }: { times: Times; final: boolean }) {
  const t = times.state === "reading" ? null : times.became;
  const caption = !final ? "This block is not final yet, so its way is not finished."
    : times.state === "reading" ? "Reading the producer's times…"
    : times.state === "unreadable" ? "The producer's times cannot be read right now, so only Canton's record time is shown."
    : t?.totalMs != null ? `Cut to final in ${secs(t.totalMs, 3)}. Times are from the producer's log, and the last one is Canton's record time.`
    : times.lifecycle === null ? "The producer's log has no row for this block, so only Canton's record time is known."
    : "The producer's log misses some of this block's times, so the steps and the numbers that need them are left out.";
  const total = t?.totalMs ?? 0;
  return (
    <section className="card how" aria-labelledby="how-h">
      <div className="sec-h"><h3 id="how-h">How this block became final</h3><span className="muted small">{caption}</span></div>
      {final && t?.bar && total > 0 && (
        <div className="how-bar-w">
          <div className="how-bar" role="img" aria-label={`The way to final, ${secs(total, 2)} in all`}>
            {t.bar.map((p) => <span key={p.name} className={`part part-${p.name}`} style={{ flexGrow: Math.max(p.ms, 1) }}>{p.name === "proof" ? `${PART_LABEL.proof} ${secs(p.ms)}` : p.name === "canton" ? (p.ms / 1000).toFixed(2) : ""}</span>)}
          </div>
          <div className="how-axis" aria-hidden="true">{[0, 1, 2, 3].map((i) => <span key={i}>{secs((total * i) / 4, i === 0 ? 0 : 1)}</span>)}<span>{secs(total)}</span></div>
        </div>
      )}
      <ol className="how-steps">
        {(t?.steps ?? howItBecameFinal(null, null).steps).map((s, i, all) => {
          const last = i === all.length - 1;
          return (
            <li key={s.name} className={s.clock !== null ? (last ? "got last" : "got") : "none"}>
              <i className="how-dot" aria-hidden="true" />
              <b className="how-n">{s.name}</b>
              <span className="how-t mono">{s.clock ?? NONE}</span>
              <span className="how-d muted small">{s.delta ?? ""}{s.delta && s.note ? " · " : ""}{s.note && s.clock !== null ? s.note : ""}</span>
              {s.source && <span className="tag how-src">{s.source}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
