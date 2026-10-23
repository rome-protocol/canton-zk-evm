import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { getFaucetInfo, getStatsSeries, getStatsSummary, STATS_WINDOWS, type StatsMetric, type StatsSeries, type StatsSpread, type StatsSummary, type StatsWindow } from "../api.ts";
import { DownloadLink, ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { Chart, pointTime } from "../components/Chart.tsx";
import { Icon } from "../components/Icon.tsx";
import { count, pct, plural, sec, short, span, trim, units, utcDate } from "../format.ts";
import { useStatus } from "../useStatus.ts";

const DEFAULT_WINDOW: StatsWindow = "24h";
const BUTTONS: [StatsWindow, string][] = [["1h", "Last hour"], ["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"]];
/** The step each window is drawn in when none is asked for: the first the series route allows. */
const STEP: Record<StatsWindow, { word: string; every: string }> = { "1h": { word: "minute", every: "minute" }, "6h": { word: "10 minutes", every: "10 minutes" }, "24h": { word: "hour", every: "hour" }, "7d": { word: "hour", every: "hour" }, "30d": { word: "day", every: "day" } };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DASH = <span className="muted">—</span>;

/** "14 – 20 Oct 2026" for days, or the hours of a window of hours. The end of a window is the start of the next step, which is not in it. */
function heading(s: StatsSummary): string {
  const a = new Date(Date.parse(s.from)), b = new Date(Date.parse(s.to) - 1);
  const day = (d: Date, m = true, y = true) => `${d.getUTCDate()}${m ? ` ${MONTHS[d.getUTCMonth()]}` : ""}${y ? ` ${d.getUTCFullYear()}` : ""}`;
  const step = STEP[s.window].word;
  if (s.window === "1h" || s.window === "6h") return `${day(a)} ${s.from.slice(11, 16)} – ${s.to.slice(11, 16)}, by the ${step}, UTC`;
  const same = day(a) === day(b);
  const range = same ? day(a) : a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear() ? `${day(a, false, false)} – ${day(b)}` : `${day(a, true, false)} – ${day(b)}`;
  return `${range}, by the ${step}, UTC`;
}

function Tile({ k, v, small, sub }: { k: string; v: React.ReactNode; small?: React.ReactNode; sub: React.ReactNode }) {
  return <div className="card stat"><span className="stat-k">{k}</span><span className="stat-v">{v}{small && <small> {small}</small>}</span><span className="small muted">{sub}</span></div>;
}
const timeTile = (k: string, s: StatsSpread | null, sub: string) => <Tile k={k} v={s ? sec(s.median) : DASH} small={s && `p95 ${sec(s.p95)}`} sub={s ? sub : "no block in this window"} />;

function Cell({ k, v, sub, tone }: { k: string; v: React.ReactNode; sub: React.ReactNode; tone?: string }) {
  return <div className="cell"><span className="stat-k">{k}</span><span className={`stat-v ${tone ?? ""}`}>{v}</span><span className="small muted">{sub}</span></div>;
}

function Reliability({ s }: { s: StatsSummary }) {
  const a = s.acceptedNotFinal, lost = s.lost.total;
  return (
    <section className="card panel">
      <div className="list-h"><div><h3>Reliability</h3> <span className="muted small">every transaction Ostia accepted, by what became of it · {STEP_NAME[s.window]}</span></div>
        <span className={`chip ${lost ? "chip-bad" : "chip-final"}`}>{lost ? `${count(lost)} lost` : "none lost"}</span></div>
      <div className="cells">
        <Cell k="Accepted" v={count(s.txs.accepted)} sub="by Ostia's RPC or the faucet" />
        <Cell k="Final" v={count(s.txs.count)} sub="their block is final on Canton" />
        <Cell k="Not final yet" v={count(s.waiting.open)} sub={`${count(a.beingProven)} being proven · ${count(a.waiting)} waiting · ${count(a.stuck)} stuck`} />
        <Cell k="Replaced or dropped" v={count(s.replaced.window + s.dropped.window)} sub={`replaced by the sender: ${count(s.replaced.window)} · dropped: ${count(s.dropped.window)}`} />
        <Cell k="Lost" v={count(lost)} tone={lost ? "bad" : "ok"} sub="accepted and never made final, all time" />
      </div>
      {s.lost.listed.length > 0 && (
        <ul className="lostlist">{s.lost.listed.slice(0, 10).map((i) => <li key={i.txHash}><Link className="mono" to={`/tx/${i.txHash}`}>{short(i.txHash)}</Link> <span className="muted small">{pointTime(i.at, false)} UTC · {i.reason ?? "no reason recorded"}</span></li>)}</ul>
      )}
      <p className="card-note small muted">Blocks refused by Canton: {count(s.attempts.refused)} of {plural(s.attempts.total, "attempt")}. Attempts that failed: {count(s.attempts.failed)}. Cut and not taken: {count(s.attempts.notTaken)}. Empty blocks: {count(s.blocks.empty)}. A transaction left out by a refused block is listed here with the reason.</p>
    </section>
  );
}
const STEP_NAME: Record<StatsWindow, string> = { "1h": "last hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

type Part = { metric: StatsMetric; name: string; tone: "a" | "b"; draw?: "bars" | "lines" };
/** One chart: the series it draws are read one by one, and one that cannot be read leaves the other cards alone. */
function ChartCard({ title, sub, parts, window, kind, fmt, point, note, legend = true }: { title: string; sub: string; parts: Part[]; window: StatsWindow; kind: "lines" | "bars"; fmt: (v: number) => string; point?: (v: number) => string; note?: string; legend?: boolean }) {
  const reads = parts.map((p) => useQuery({ queryKey: ["stats-series", p.metric, window], queryFn: () => getStatsSeries(p.metric, window), refetchInterval: 60_000 })); // eslint-disable-line react-hooks/rules-of-hooks
  const data = reads.map((r) => r.data) as (StatsSeries | undefined)[];
  const failed = reads.some((r) => r.isError && !r.data);
  const ready = data.every(Boolean);
  const first = data[0];
  return (
    <section className="card panel">
      <div className="list-h"><div><h3>{title}</h3> <span className="muted small">{sub}</span></div>
        {legend && parts.length > 1 && <span className="legend small muted">{parts.map((p) => <span key={p.name}><i className={`sw ch-${p.tone}`} />{p.name}</span>)}</span>}</div>
      {failed ? <p className="muted small chart-msg">This chart cannot be read right now. The page tries again in a minute.</p>
        : !ready || !first ? <p className="muted small chart-msg" aria-busy="true">Reading…</p>
        : <Chart kind={kind} fmt={fmt} fmtPoint={point} from={first.from} to={first.to} step={first.step} label={`${title}, ${sub}`}
            lines={parts.map((p, i) => ({ name: p.name, tone: p.tone, draw: p.draw, points: data[i]!.points }))} />}
      {note && <p className="card-note small muted">{note}</p>}
    </section>
  );
}

const sizeLabel = (size: string) => (size === "over 1000" ? "over 1,000" : size.replace(/(\d+)/g, (d) => count(d)).replace("-", "–"));

function PerBlock({ s }: { s: StatsSummary }) {
  const t = s.txsPerBlock, sizes = s.blocks.bySize, top = Math.max(1, ...sizes.map((x) => x.count)), proof = s.proofTime?.bySize ?? [];
  return (
    <section className="card panel">
      <div className="list-h"><div><h3>Transactions per block</h3> <span className="muted small">{count(s.blocks.count)} final blocks{t.mean !== null && ` · mean ${trim(t.mean, 1)}`}{t.median !== null && ` · median ${trim(t.median, 1)}`}{t.max !== null && ` · largest ${count(t.max)}`}</span></div></div>
      <ul className="sizes">{sizes.map((x) => <li key={x.size}><span>{sizeLabel(x.size)} txs</span><span className="track"><i style={{ width: `${(x.count / top) * 100}%` }} /></span><b>{plural(x.count, "block")}</b></li>)}</ul>
      <div className="scroll"><table className="tbl">
        <thead><tr><th>Block size</th><th className="r">Blocks</th><th className="r">Proof, median</th><th className="r">Proof, p95</th></tr></thead>
        <tbody>{sizes.map((x, k) => { const p = proof[k]; return <tr key={x.size}><td>{sizeLabel(x.size)}</td><td className="r">{count(x.count)}</td><td className="r">{p?.median != null ? span(p.median) : DASH}</td><td className="r">{p?.p95 != null ? span(p.p95) : DASH}</td></tr>; })}</tbody>
      </table></div>
    </section>
  );
}

/** The most a step's p95 time to final may be before the rule cuts differently: above this for more than an hour. */
const SLOW_FINAL_SECONDS = 20;

function Rule({ s }: { s: StatsSummary }) {
  const p = s.prover, word = STEP[s.window].word;
  // The same series as the Time to final chart (so one read serves both): the p95 of each step, to find the worst and count those above the line.
  const ttf = useQuery({ queryKey: ["stats-series", "time_to_final_p95", s.window], queryFn: () => getStatsSeries("time_to_final_p95", s.window), refetchInterval: 60_000 }).data;
  const vals = (ttf?.points ?? []).map((x) => x.value).filter((v): v is number => v !== null);
  const worst = vals.length ? Math.max(...vals) : null, over = vals.filter((v) => v > SLOW_FINAL_SECONDS).length;
  return (
    <div className="rule">
      <h4>The two numbers the block-cutting rule watches</h4>
      <dl className="kv wide">
        <dt className="kv-k">p95 time to final</dt>
        <dd className="kv-v">{worst !== null ? <><b>{sec(worst)}</b> <span className="muted small">by the {word} (the worst) · {plural(over, "step")} above {SLOW_FINAL_SECONDS} s{s.timeToFinal ? ` · ${sec(s.timeToFinal.p95)} over the whole window` : ""}</span></> : s.timeToFinal ? <><b>{sec(s.timeToFinal.p95)}</b> <span className="muted small">over this window</span></> : DASH}</dd>
        <dt className="kv-k">Busiest ten minutes</dt>
        <dd className="kv-v">{p.maxBusyRatio10m !== null ? <><b>{pct(p.maxBusyRatio10m)}</b> <span className="muted small">of what one prover can carry · {count(p.windowsOver)} of {count(p.windowsCounted)} ten-minute windows above {pct(p.loadedAbove)}</span></> : DASH}</dd>
        <dt className="kv-k">Cutting now</dt>
        <dd className="kv-v">{s.cutting ? <><code>{s.cutting.strategy}</code>{s.cutting.strategy === "on_demand" && <span className="muted small"> · a block when transactions wait</span>}</> : DASH}</dd>
      </dl>
    </div>
  );
}

/** The line under the turned-away count: why, or since when it was not recorded. Only reasons that had a refusal are named. */
function turnedAwaySub(f: StatsSummary["faucet"]): string {
  if (f.turnedAway === null) return f.turnedAwaySince ? `not recorded before ${utcDate(Date.parse(f.turnedAwaySince))}` : "not recorded";
  const r = f.turnedAway.byReason;
  const parts = [[r.address, "same address"], [r.ip, "same network"], [r.hour, "hourly cap"], [r.captcha, "failed check"]].filter(([n]) => (n as number) > 0).map(([n, w]) => `${count(n as number)} ${w}`);
  return parts.length ? parts.join(" · ") : "requests the limits refused";
}

function FaucetCard({ s, faucetOn, coin }: { s: StatsSummary; faucetOn: boolean; coin: { symbol: string; decimals: number } | undefined }) {
  const f = s.faucet;
  const info = useQuery({ queryKey: ["faucet-info"], queryFn: getFaucetInfo, enabled: faucetOn, refetchInterval: 30_000 }).data;
  return (
    <section className="card panel">
      <div className="list-h"><div><h3>Faucet</h3> <span className="muted small">{STEP_NAME[s.window]}</span></div><Link className="csv" to="/faucet">Open the faucet <Icon name="next" /></Link></div>
      <div className="cells">
        <Cell k="Requests" v={count(f.requests)} sub="in this window" />
        <Cell k="Sent" v={count(f.sent)} sub={`${f.final === f.sent ? "all final" : `${count(f.final)} final`}${f.failed ? ` · ${count(f.failed)} failed` : ""}`} />
        <Cell k="Turned away by the limits" v={f.turnedAway === null ? "Not recorded" : count(f.turnedAway.total)} sub={turnedAwaySub(f)} />
        <Cell k="Time to final, faucet sends" v={f.timeToFinal ? sec(f.timeToFinal.median) : DASH} sub={f.timeToFinal ? `median · p95 ${sec(f.timeToFinal.p95)}` : "no faucet send was final in this window"} />
        <Cell k="Faucet balance" v={info?.balance != null && coin ? units(info.balance, coin.decimals) : DASH} sub={info && coin ? `${coin.symbol} · queue now ${info.queue ?? 0}` : faucetOn ? "reading…" : "the faucet is off"} />
      </div>
    </section>
  );
}

const secs = (v: number) => `${trim(v, v < 10 ? 1 : 0)} s`;

export function Stats() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("window");
  const window = (STATS_WINDOWS as readonly string[]).includes(asked ?? "") ? (asked as StatsWindow) : DEFAULT_WINDOW;
  const q = useQuery({ queryKey: ["stats-summary", window], queryFn: () => getStatsSummary(window), refetchInterval: 30_000 });
  const st = useStatus().data;
  const s = q.data;
  const step = STEP[window].word;
  return (
    <>
      <div className="list-h">
        <div><h1>Stats</h1> <span className="muted stats-sub">{s ? heading(s) : ""}</span></div>
        <div className="row">
          <span className="seg" role="group" aria-label="Window">{BUTTONS.map(([w, label]) => <button key={w} type="button" aria-pressed={w === window} onClick={() => setParams({ window: w }, { replace: true })}>{label}</button>)}</span>
          {" "}<DownloadLink href={`/api/stats/summary?window=${window}`}>Data</DownloadLink>
        </div>
      </div>
      <p className="note">Every number is computed from stored facts: Canton's record time for "final", the producer's log for its own steps. Medians and p95 over more than an hour are read from histograms: a figure is at most 5% above the truth. Blocks are cut only when transactions wait, so a step with no transactions has no block and shows as a gap.</p>
      {q.isError && !s ? <ErrorCard message={(q.error as Error).message} retrying /> : !s ? <LoadingCard>Reading the stats…</LoadingCard> : (
        <>
          {s.asOf === null && <p className="note">The rollups have not run yet, so there are no figures to show for this window.</p>}
          <div className="stats six">
            {timeTile("Time to final", s.timeToFinal, "accepted to final on Canton")}
            {timeTile("Proof time", s.proofTime, `per block, ${plural(s.proofTime?.samples ?? 0, "proof")}`)}
            {timeTile("Canton commit", s.commitTime, "sent to record time")}
            <Tile k="Transactions" v={count(s.txs.count)} small={s.txs.allTime ? <span title={`All time, as of block ${s.txs.allTime.asOfBlock}; runs marked as tests are counted`}>{count(s.txs.allTime.total)} final all time · test runs included</span> : "total not counted yet"} sub={`in ${plural(s.blocks.count, "block")}${s.txsPerBlock.mean !== null ? ` · ${trim(s.txsPerBlock.mean, 1)} per block` : ""}${s.txs.allTime ? ` · all time as of block ${s.txs.allTime.asOfBlock}` : ""}`} />
            <Tile k="Peak rate" v={s.tps.peak !== null && s.txs.count > 0 ? trim(s.tps.peak, 1) : DASH} small={s.tps.peak !== null && s.txs.count > 0 ? "tx/s" : undefined} sub={s.tps.peakAt ? `busiest minute, ${pointTime(s.tps.peakAt, false)}` : "no transaction in this window"} />
            <Tile k="Success rate" v={s.txs.successRate !== null ? pct(s.txs.successRate) : DASH} sub={s.txs.successRate !== null ? `${count(s.txs.failed)} reverted of ${count(s.txs.count)}` : "no transaction in this window"} />
          </div>
          <Reliability s={s} />
          <div className="cols">
            <ChartCard title="Time to final" sub={`accepted to final on Canton, per ${step}`} window={window} kind="lines" fmt={secs} point={sec} parts={[{ metric: "time_to_final_p50", name: "median", tone: "a" }, { metric: "time_to_final_p95", name: "p95", tone: "b" }]} />
            <ChartCard title="Proof time" sub={`ZisK's time per block, per ${step}`} window={window} kind="lines" fmt={secs} point={sec} parts={[{ metric: "proof_time_p50", name: "median", tone: "a" }, { metric: "proof_time_p95", name: "p95", tone: "b" }]} />
            <ChartCard title="Transactions per second" sub={`per ${step}`} window={window} kind="bars" fmt={(v) => trim(v, 2)} point={(v) => `${trim(v, 2)} tx/s`} parts={[{ metric: "tps", name: "average", tone: "a", draw: "bars" }, { metric: "busiest_minute_tps", name: "busiest minute", tone: "b", draw: "lines" }]} note="The scale stops where ordinary steps can be read; a step above it is marked and named." />
            <ChartCard title={`Blocks per ${step}`} sub="final blocks, by the time of their record" window={window} kind="bars" fmt={(v) => trim(v, 1)} point={(v) => plural(v, "block")} parts={[{ metric: "blocks", name: "blocks", tone: "a" }]} note="Cut on demand: a block is cut when transactions wait and the previous block is final." />
          </div>
          <div className="cols">
            <PerBlock s={s} />
            <section className="card panel">
              <div className="list-h"><div><h3>Prover busy</h3> <span className="muted small">share of each {step} the prover spent proving</span></div></div>
              <BusyChart window={window} />
              <Rule s={s} />
            </section>
          </div>
          <FaucetCard s={s} faucetOn={!!st?.faucet.on} coin={st?.coin} />
        </>
      )}
    </>
  );
}

/** The prover chart sits inside a card that also holds the rule, so it has no card of its own. */
function BusyChart({ window }: { window: StatsWindow }) {
  const r = useQuery({ queryKey: ["stats-series", "busy_ratio", window], queryFn: () => getStatsSeries("busy_ratio", window), refetchInterval: 60_000 });
  if (r.isError && !r.data) return <p className="muted small chart-msg">This chart cannot be read right now. The page tries again in a minute.</p>;
  if (!r.data) return <p className="muted small chart-msg" aria-busy="true">Reading…</p>;
  return <Chart kind="bars" fmt={(v) => `${trim(v * 100, 1)}%`} fmtPoint={pct} from={r.data.from} to={r.data.to} step={r.data.step} label={`Prover busy, per ${STEP[window].word}`} lines={[{ name: "busy", tone: "b", points: r.data.points }]} />;
}
