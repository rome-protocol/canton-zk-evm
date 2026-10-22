import type { StatsSeries } from "../api.ts";
import { axisTicks, scaleOf, timeTicks } from "../chart-scale.ts";

/** `draw` gives one line its own form where the chart holds both bars and a line; without it the chart's `kind` is used. */
export interface Line { name: string; tone: "a" | "b"; points: StatsSeries["points"]; draw?: "bars" | "lines" }

const W = 600, H = 200, L = 44, R = 8, T = 10, B = 24;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "20 Oct 12:00", UTC. A daily point has no time of day worth giving. */
export const pointTime = (iso: string, daily: boolean) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${daily ? "" : ` ${iso.slice(11, 16)}`}`; };

/**
 * One metric over a window: lines or bars, a point for each step of `from` to `to`. A step with no fact is a gap, never a zero. A value above the scale
 * (see scaleOf) is drawn at the top with a caret and named under the chart. Drawn as plain SVG in the page's colours.
 */
export function Chart({ lines, kind, fmt, fmtPoint = fmt, from, to, step, label }: { lines: Line[]; kind: "lines" | "bars"; fmt: (v: number) => string; fmtPoint?: (v: number) => string; from: string; to: string; step: string; label: string }) {
  const n = Math.max(1, ...lines.map((l) => l.points.length));
  const f = Date.parse(from), t = Date.parse(to);
  const scale = scaleOf(lines.flatMap((l) => l.points.map((p) => p.value)));
  // `scale.off` indexes the flat list of all lines' values; keep the line and the point of each.
  const flat = lines.flatMap((l) => l.points.map((p, i) => ({ l, p, i })));
  const offList = scale.off.map((k) => flat[k]!);
  const iw = W - L - R, ih = H - T - B, slot = iw / n;
  const x = (i: number) => L + slot * (i + 0.5), y = (v: number) => T + ih - (Math.min(v, scale.top) / scale.top) * ih;
  const daily = step === "1d";
  const cls = (tone: string) => `ch-${tone}`;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {axisTicks(scale.top).map((v) => (
          <g key={v}><line className="ch-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text className="ch-ax" x={L - 6} y={y(v) + 3.5} textAnchor="end">{fmt(v)}</text></g>
        ))}
        {timeTicks(f, t).map((k) => (
          <text key={k.at} className="ch-ax" x={L + ((k.at - f) / (t - f)) * iw} y={H - 6} textAnchor="middle">{k.label}</text>
        ))}
        {lines.filter((l) => (l.draw ?? kind) === "bars").map((l) => l.points.map((p, i) => p.value === null ? null : (
          <rect key={`${l.name}${i}`} className={cls(l.tone)} x={x(i) - Math.max(0.5, slot * 0.4)} width={Math.max(1, slot * 0.8)} y={y(p.value)} height={T + ih - y(p.value)} />
        )))}
        {lines.filter((l) => (l.draw ?? kind) === "lines").map((l) => {
          const runs: { i: number; v: number }[][] = [];
          l.points.forEach((p, i) => { if (p.value === null) runs.push([]); else { if (!runs.length) runs.push([]); runs[runs.length - 1]!.push({ i, v: p.value }); } });
          return runs.filter((r) => r.length).map((r, k) => r.length === 1
            ? <circle key={`${l.name}${k}`} className={cls(l.tone)} cx={x(r[0]!.i)} cy={y(r[0]!.v)} r={1.6} />
            : <polyline key={`${l.name}${k}`} className={`ch-line ${cls(l.tone)}`} fill="none" points={r.map((q) => `${x(q.i)},${y(q.v)}`).join(" ")} />);
        })}
        {offList.map(({ l, p, i }) => <path key={`${l.name}${i}`} className={`ch-caret ${cls(l.tone)}`} d={`M${x(i) - 4},${T + 8} L${x(i)},${T} L${x(i) + 4},${T + 8} Z`} />)}
      </svg>
      {offList.length > 0 && (
        <figcaption className="ch-off small muted">
          Above the scale, drawn at the top with a caret: {offList.slice(0, 4).map(({ l, p }) => `${pointTime(p.at, daily)}, ${lines.length > 1 ? `${l.name} ` : ""}${fmtPoint(p.value!)}`).join("; ")}{offList.length > 4 ? `; and ${offList.length - 4} more` : ""}.
        </figcaption>
      )}
    </figure>
  );
}
