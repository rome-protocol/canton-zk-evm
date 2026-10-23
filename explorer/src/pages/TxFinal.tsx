import { useQuery } from "@tanstack/react-query";
import { getStatsSummary, type BlockSummary, type ApiTx } from "../api.ts";
import { at, clock, secs } from "../block-times.ts";
import { Icon } from "../components/Icon.tsx";
import { sec } from "../format.ts";
import "./block.css";

/** What reading the transaction's block came to: still being read, could not be read, or read. A transaction in no block has none to read. */
export type BlockRead = "none" | "reading" | "failed" | "read";

interface Step { name: string; reached: boolean; time: string | null; digits: 3 | 6; note: string | null; source: "producer log" | "Canton record time" | null }

const NONE = "—";

/** "by Ostia's RPC" for the usual way in; any other way is named as the journal wrote it. */
const via = (v: string | null) => (v === null ? null : v === "rpc" ? "by Ostia's RPC" : `via ${v}`);

/** The four steps of a transaction's way to final. A step is reached when the transaction has got there, and has a time only when the producer's journal or Canton gave one. */
export function stepsOf(t: ApiTx, block: BlockSummary | undefined, read: BlockRead, index: number | null): Step[] {
  const l = t.lifecycle;
  const final = t.status === "final";
  const canton = block?.canton ?? null;
  const inBlock = t.block !== null;
  const where = !inBlock ? null : index !== null && block ? `position ${index} of ${block.txCount}` : read === "reading" ? "reading the block…" : read === "failed" ? "the block cannot be read right now" : null;
  const proofDone = l?.proofEndedAt != null;
  const proofNote = canton ? `ZisK, ${canton.proofBytes.toLocaleString("en-US")} bytes` : proofDone || final ? "ZisK" : null;
  return [
    { name: "Accepted", reached: l?.acceptedAt != null || inBlock || t.status === "waiting", time: l?.acceptedAt ?? null, digits: 3, note: via(l?.acceptedVia ?? null), source: l?.acceptedAt ? "producer log" : null },
    { name: inBlock ? `In block ${t.block!.number}` : "In a block", reached: inBlock, time: l?.includedAt ?? null, digits: 3, note: where, source: l?.includedAt ? "producer log" : null },
    { name: "Proof done", reached: proofDone || final || t.status === "unindexed" || canton !== null, time: l?.proofEndedAt ?? null, digits: 3, note: proofNote, source: l?.proofEndedAt ? "producer log" : null },
    { name: "Final on Canton", reached: final || t.status === "unindexed", time: canton?.recordTime ?? null, digits: 6, note: null, source: canton ? "Canton record time" : null },
  ];
}

/** "The way to final": a transaction's four steps with the time of each that is known and the seconds between known neighbours. Nothing is guessed; a missing time is a dash. */
export function TxFinal({ t, block, read, index }: { t: ApiTx; block: BlockSummary | undefined; read: BlockRead; index: number | null }) {
  const steps = stepsOf(t, block, read, index);
  const l = t.lifecycle;
  const final = t.status === "final";
  // The hour's median is the same read the home page makes; where it cannot be read, or the hour has no final transaction, the page says nothing of it.
  const hour = useQuery({ queryKey: ["stats-summary", "1h"], queryFn: () => getStatsSummary("1h"), enabled: final, retry: false, staleTime: 30_000 });
  const median = hour.data?.timeToFinal?.median ?? null;
  // The footer is drawn only when one of its lines has something to say.
  const took = final && l?.timeToFinalMs != null;
  const typical = final && median !== null;
  const clean = final && l !== null && l.attempts === 1 && !l.leftOutReason;
  const caption = l === null ? "No row in the producer's journal, so only the times Canton and the block give are shown."
    : "One line per step, each with its own time. Only measured times are shown.";
  return (
    <section className="card way" aria-labelledby="way-h">
      <div className="sec-h"><h3 id="way-h">The way to final</h3><span className="muted small">{caption}</span></div>
      <ol className="how-steps way-steps">
        {steps.map((s, i) => {
          const prev = steps[i - 1];
          const delta = i > 0 && s.time && prev?.time ? `+${secs(at(s.time) - at(prev.time))}` : null;
          const last = i === steps.length - 1;
          return (
            <li key={s.name} className={s.reached ? (last ? "got last" : "got") : "none"}>
              <i className="how-dot" aria-hidden="true" />
              {delta && <span className="way-delta mono small muted">{delta}</span>}
              <b className="how-n">{s.name}</b>
              <span className="how-t mono">{s.time ? clock(s.time, s.digits) : NONE}</span>
              <span className="how-d muted small">{s.note ?? (s.reached || s.time ? "" : "not reached yet")}</span>
              {s.source && <span className="tag how-src">{s.source}</span>}
            </li>
          );
        })}
      </ol>
      {l === null && <p className="way-foot muted small">The producer's journal has no row for this transaction, so Accepted, In block and Proof done have no times.</p>}
      {l !== null && (took || typical || l.attempts > 1 || l.leftOutReason || clean) && (
        <div className="way-foot small">
          {(took || typical) && <span className="way-foot-l"><Icon name="clock" size={13} />
            {took && <span>Final <b className="num">{secs(l.timeToFinalMs!)}</b> after Ostia accepted it.</span>}
            {typical && <span className="muted"> The median for the last hour is {sec(median!)}.</span>}
          </span>}
          <span className="way-foot-r muted">
            {l.attempts > 1 && <span>It took {l.attempts} attempts.</span>}
            {l.leftOutReason && <span> Left out of an earlier block: {l.leftOutReason}.</span>}
            {clean && <span>Not refused or left out of any earlier block.</span>}
          </span>
        </div>
      )}
    </section>
  );
}
