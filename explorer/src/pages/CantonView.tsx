import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { getBlockLegs, getCantonStats, type CantonStats, type CantonWindow, type UpdateAttempt, type UpdateDetail, type UpdateLegs, type UpdateRow, type UpdateView } from "../api.ts";
import { HashLink } from "../components/HashLink.tsx";
import { Info } from "../components/Info.tsx";
import { Pager, usePaged } from "../components/Pager.tsx";
import { Seg } from "../components/Seg.tsx";
import { count, nb, pct, plural, sec, sinceWord, span, utcDate, utcMs } from "../format.ts";
import { Bad, Good } from "./BlockSides.tsx";
import { legKindWord } from "./LegParts.tsx";

const DASH = <span className="muted">—</span>;

/** The Daml choice the producer exercises to commit a block, said once for the list and for the page of one update. */
export const ADVANCE_HELP = "Each block is committed by exercising the choice Advance on the chain's ZkChain contract on Canton. The confirmers' external call checks the block's proof inside it.";

/** Where a settlement time starts, in words: the column help says it once, and each row names its own start. */
export const SETTLE_HELP = "From the start of the proof of the attempt that committed the block, as the producer's log has it, to Canton's record time (time spent on earlier attempts is not in it). A block the log does not hold is timed from the block's own timestamp (whole seconds, on the producer's clock). A time that would be negative, because the two clocks disagree, is left out.";
const FROM: Record<NonNullable<UpdateRow["settleFrom"]>, string> = { proofStart: "from proof start", blockTime: "from block time" };

export const STATUS_HELP = "How many times the block was submitted to Canton before it committed, from the producer's log. A block the log does not hold has no status. A refused attempt makes no Canton update, so it is no row of its own: it is counted in the header, shown on the row of the update that commits the block, and listed on that update's page.";

/** The kinds of leg a block carries, in the order the header and the rows name them. A lock and a release are the payments a registered twin vault received or paid. */
const KINDS = [["deposit", "deposit"], ["payment", "payment"], ["withdrawal", "withdrawal"], ["lock", "lock"], ["release", "release"]] as const;

/** What a block's legs are, by kind, as words: "2 deposits, 1 payment". */
export function legsWords(l: UpdateLegs): string {
  return KINDS.filter(([k]) => l[k] > 0).map(([k, one]) => plural(l[k], one)).join(", ");
}

/** Who the commit took: the first attempt, or the attempt that got through after refusals. Null where the producer's log does not hold the block. */
export function StatusChip({ u }: { u: Pick<UpdateRow, "status" | "attempts" | "refused"> }) {
  if (u.status === null || u.attempts === null) return <span className="muted">not in the producer's log</span>;
  return u.status === "first"
    ? <span className="chip chip-final"><i className="dot" />First attempt</span>
    : <span className="chip chip-building"><i className="dot" />{`After ${u.attempts} attempts`}{u.refused ? ` (${u.refused} refused)` : ""}</span>;
}

/** The choice a block was committed with, as the log recorded it: "ZkChain → Advance". */
export function ChoiceName({ u }: { u: Pick<UpdateRow, "submittedTemplate" | "submittedChoice"> }) {
  if (u.submittedTemplate === null || u.submittedChoice === null) return <span className="muted">not in the producer's log</span>;
  return <span className="mono nowrap">{`${u.submittedTemplate.split(":").pop()} → ${u.submittedChoice}`}</span>;
}

/** The legs of a row, by kind, linking to the update's page where each leg is listed. */
export function LegsCell({ u }: { u: Pick<UpdateRow, "legs" | "updateId"> }) {
  if (u.legs === null) return <span className="muted" title="The explorer has not indexed this block's legs yet">not indexed yet</span>;
  if (u.legs.total === 0) return <span className="muted">none</span>;
  return <Link to={`/canton/${u.updateId}#legs`}>{legsWords(u.legs)}</Link>;
}

export function SettleCell({ u }: { u: Pick<UpdateRow, "settleSeconds" | "settleFrom"> }) {
  if (u.settleSeconds === null || u.settleFrom === null) return DASH;
  return <><span className="num">{sec(u.settleSeconds)}</span> <span className="muted small k-label-s">{FROM[u.settleFrom]}</span></>;
}

function Tile({ k, v, small, sub, info, wide }: { k: string; v: ReactNode; small?: ReactNode; sub: ReactNode; info?: ReactNode; wide?: boolean }) {
  return <div className={`card stat${wide ? " stat-wide" : ""}`}><span className="stat-k">{nb(k)}{info && <Info about={k}>{info}</Info>}</span><span className="stat-v"><span className="hl">{v}</span>{small && <> <small>{small}</small></>}</span><span className="small muted">{sub}</span></div>;
}

/** The figures over the whole view, from the hourly rollup (never a scan of the updates): how many blocks, how often a commit got through, how long it took, what was refused or retried and the legs settled. */
export function CantonHeader() {
  const [window, setWindow] = useState<CantonWindow>("24h");
  const q = useQuery({ queryKey: ["canton", "stats", window], queryFn: () => getCantonStats(window), refetchInterval: 30_000 });
  const s: CantonStats | undefined = q.data;
  return (
    <section aria-label="Figures of the Canton commits">
      <div className="list-h">
        <span className="muted small">{s ? (s.asOf ? `Figures as of ${utcDate(Date.parse(s.asOf))} ${utcMs(s.asOf).slice(0, 8)} UTC` : "The rollup has not run yet.") : ""}</span>
        <Seg label="Window of the settlement time" value={window} onPick={setWindow} options={[{ id: "24h", text: "24 hours" }, { id: "7d", text: "7 days" }]} />
      </div>
      {q.isError && !s ? <p className="muted">The explorer cannot read the figures right now.</p> : !s ? <p className="muted">Reading the figures…</p> : <Tiles s={s} />}
    </section>
  );
}

function Tiles({ s }: { s: CantonStats }) {
  const a = s.attempts, st = s.settlement;
  return (
    <div className="stats canton-stats">
      <Tile k="Blocks committed" v={count(s.blocks)} sub={s.dataSince ? `since ${utcDate(Date.parse(s.dataSince))}` : "none yet"} info="Canton updates that carry a block: one per block, each holding the block's proof, its transactions and its legs." />
      <Tile k="Success rate" v={s.successRate === null ? DASH : pct(s.successRate)} sub={a.submitted > 0 ? `${count(a.committed)} of ${count(a.submitted - a.pending)} answered commit attempts${a.pending > 0 ? ` · ${count(a.pending)} waiting for an answer` : ""}` : "no commit attempt in the producer's log"}
        info={`Commit attempts that committed over commit attempts submitted to Canton${a.since ? `, counted from ${utcDate(Date.parse(a.since))}` : ""}. An attempt that was refused, failed, was not taken, was cancelled or never got an answer counts against it. An attempt still waiting for its answer is left out until it has one. Attempts of test runs are left out.`} />
      <Tile k="Settlement time" v={st.averageSeconds === null ? DASH : sec(st.averageSeconds)} small={st.p95Seconds === null ? undefined : `p95 ${st.p95Capped ? "> " : ""}${sec(st.p95Seconds)}`}
        sub={st.blocks > 0 ? `average over ${plural(st.blocks, "block")}, ${sinceWord(st.from)}` : `no timed block ${sinceWord(st.from)}`}
        info="From the start of the proof of the attempt that committed the block to Canton's record time, for blocks the producer's log holds, over the window picked above. The p95 is read from buckets 5% wide, so it is at most 5% above the true value." />
      <Tile k="Refused or retried" v={count(a.refused)} small="refused" sub={`${plural(s.retriedBlocks, "block")} committed after a retry${a.other > 0 ? ` · ${count(a.other)} failed or not answered` : ""}`}
        info="Refused: Canton refused the command (the reason is on the page of the update the block was committed in). Retried: the block was committed, but not on its first attempt. Failed or not answered: failed, not taken, cancelled, or never answered." />
      <Tile wide k="Legs settled" v={count(s.legs.total)} sub={<span className="legs-kinds">{KINDS.map(([k, one]) => <span key={k}>{plural(s.legs[k], one)}</span>)}</span>} info="Legs the gateway recorded in committed blocks, by kind. A lock and a release are the payments a registered twin vault received or paid; a payment here is any other." />
    </div>
  );
}

/** A step of the timeline, as the explorer holds it. */
const STEP_WORD: Record<UpdateView["timeline"][number]["step"], string> = { built: "Block built", proofStarted: "Proof started", proofDone: "Proof done", submitted: "Submitted to Canton", committed: "Committed on Canton" };
const SOURCE_WORD: Record<UpdateView["timeline"][number]["source"], string> = { producer: "producer log", block: "block timestamp", canton: "Canton record time" };

/** The steps of one block's way to Canton, each with the time since the one before. A step the explorer has no time for is not drawn. */
export function Timeline({ u }: { u: UpdateDetail }) {
  const steps = u.view.timeline;
  const full = steps.some((t) => t.step === "proofStarted");
  return (
    <section className="card" aria-labelledby="tl-h">
      <div className="sec-h">
        <h3 id="tl-h">Timeline</h3>
        {u.settleSeconds !== null && u.settleFrom !== null && <span className="muted small">{`${sec(u.settleSeconds)} ${FROM[u.settleFrom]} to the record time`}</span>}
        <Info about="the settlement time">{SETTLE_HELP}</Info>
      </div>
      <ol className="tl">
        {steps.map((t, i) => {
          const prev = i > 0 ? Date.parse(steps[i - 1]!.at) : null, d = prev === null ? null : (Date.parse(t.at) - prev) / 1000;
          return (
            <li key={t.step}>
              <span className="tl-dot" aria-hidden="true" />
              <span className="tl-k">{STEP_WORD[t.step]}</span>
              <span className="mono tl-t" title={t.at}>{utcMs(t.at)}</span>
              {d !== null && d >= 0 && <span className="muted small">+{span(d)}</span>}
              <span className="tag">{SOURCE_WORD[t.source]}</span>
            </li>
          );
        })}
      </ol>
      {!full && <p className="muted small">The producer's log does not hold this block, so the steps between the block's timestamp and Canton's record time are not known.</p>}
    </section>
  );
}

const OUTCOME_WORD: Record<string, string> = { committed: "Committed", refused: "Refused", not_taken: "Not taken", unknown: "No answer", failed: "Failed", skipped: "Skipped", cancelled: "Cancelled" };
const outcomeWord = (o: string) => OUTCOME_WORD[o] ?? o;

function Attempt({ a }: { a: UpdateAttempt }) {
  const proof = a.proofStartedAt && a.proofEndedAt ? (Date.parse(a.proofEndedAt) - Date.parse(a.proofStartedAt)) / 1000 : null;
  const asked = a.submittedAt && a.answeredAt ? (Date.parse(a.answeredAt) - Date.parse(a.submittedAt)) / 1000 : null;
  return (
    <li>
      <div className="att-h"><b>{`Attempt ${a.number}`}</b><span className={`chip ${a.committed ? "chip-final" : "chip-dropped"}`}><i className="dot" />{outcomeWord(a.outcome)}</span></div>
      {a.reason && <p className="att-r">{a.reason}</p>}
      <p className="muted small att-t">
        {a.proofOutcome && a.proofOutcome !== "ok" ? `Proof ${a.proofOutcome.replace(/_/g, " ")}` : proof !== null && proof >= 0 ? `Proof took ${span(proof)}` : "Proof time not recorded"}
        {a.submittedAt ? ` · submitted ${utcMs(a.submittedAt)}` : ""}
        {a.answeredAt ? ` · answered ${utcMs(a.answeredAt)}${asked !== null && asked >= 0 ? ` (${span(asked)} later)` : ""}` : ""}
      </p>
    </li>
  );
}

/** Every submission of this block's number up to the one that committed, with what Canton or the producer said of each. */
export function Attempts({ u }: { u: UpdateDetail }) {
  const list = u.view.attempts;
  return (
    <section className="card" aria-labelledby="att-h">
      <div className="sec-h"><h3 id="att-h">Commit attempts</h3><Info about="the attempts">{STATUS_HELP}</Info></div>
      {list.length === 0 ? <p className="muted">The producer's log does not hold this block, so its attempts are not known.</p> : (
        <>
          <p className="small">{list.length === 1 ? "Committed on the first attempt." : `Committed on attempt ${list.length}, after ${plural(list.length - 1, "attempt")} that did not commit.`}</p>
          <ol className="att">{list.map((a) => <Attempt key={a.number} a={a} />)}</ol>
        </>
      )}
    </section>
  );
}

/** The confirmers' check of the proof: the one fact the reader can see of it is that the update exists. The explorer's own comparison stands beside it. */
export function ProofCheck({ u }: { u: UpdateDetail }) {
  const c = u.view.proofCheck;
  return (
    <section className="card" aria-labelledby="pc-h">
      <div className="sec-h"><h3 id="pc-h">Proof check</h3></div>
      <p className="small">{ADVANCE_HELP} The committed update is the evidence of that check: Canton records it only if {c.confirmers > 0 ? plural(c.confirmers, "confirmer") : "the confirmers"} accepted it. Their own check time and result are not visible to the reader party; only the commit is.</p>
      <p className="small">
        <span className="muted">The explorer's own comparison of the proof:</span>{" "}
        {c.matchesPins === null && c.matchesBlock === null ? <span className="muted">not made for this block</span> : (
          <>
            {c.matchesPins === null ? null : c.matchesPins ? <Good>program and ZisK release are the pinned ones</Good> : <Bad>program or ZisK release is not the pinned one</Bad>}{" "}
            {c.matchesBlock === null ? null : c.matchesBlock ? <Good>names this block's hash</Good> : <Bad>does not name this block's hash</Bad>}
          </>
        )}
      </p>
    </section>
  );
}

/** The legs of a block, one by one, each linked to its page. Read only when the block has legs. */
function LegList({ id, block }: { id: string; block: number }) {
  const p = usePaged(["canton", "update", id, "legs"], (after) => getBlockLegs(String(block), after), false);
  const items = p.data?.items;
  return (
    <>
      {p.error && !items ? <p className="muted">The explorer cannot read the legs right now.</p> : !items ? <p className="muted">Reading the legs…</p> : (
        <ul className="leg-list">
          {items.map((l) => (
            <li key={`${l.gateway ?? ""}${l.legId}${l.legIndex}`}>
              <span className="tag">{legKindWord(l.kind, l.canton?.role ?? null)}</span>
              <HashLink value={l.legId} to={`/leg/${l.legId}`} />
            </li>
          ))}
        </ul>
      )}
      <Pager p={p} label="Pages of the block's legs" />
    </>
  );
}

/** The legs this block settled, by kind, then one by one with links to each leg. As the EVM recorded them: nothing from the parties' side. */
export function UpdateLegsSection({ u }: { u: UpdateDetail }) {
  return (
    <section className="card" id="legs" aria-labelledby="legs-h">
      <div className="sec-h"><h3 id="legs-h">Legs settled in this block</h3></div>
      {u.block === null ? <p className="muted">This update carries no block.</p> : u.legs === null ? <p className="muted">The explorer has not indexed this block's legs yet.</p> : u.legs.total === 0 ? <p className="muted">This block settled no legs.</p> : (
        <>
          <p className="small">{legsWords(u.legs)} <span className="muted">· as the EVM recorded them</span></p>
          <LegList id={u.updateId} block={u.block} />
        </>
      )}
    </section>
  );
}
