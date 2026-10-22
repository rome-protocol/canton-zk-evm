import type { StatsSeries } from "../api.ts";
import { scaleOf } from "../chart-scale.ts";

const W = 240, H = 40;

/**
 * A small chart of one value over time, a bar for each point and nothing for a point with no fact (a gap, never a zero). A value above the scale
 * (see scaleOf) is drawn at the full height, so one odd hour does not flatten the rest.
 */
export function Spark({ points, label }: { points: StatsSeries["points"]; label: string }) {
  const { top } = scaleOf(points.map((p) => p.value));
  const slot = W / Math.max(1, points.length);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {points.map((p, i) => {
        if (p.value === null) return null;
        const h = Math.max(1, (Math.min(p.value, top) / top) * H);
        return <rect key={p.at} className="sp-bar" x={slot * i} width={Math.max(0.5, slot * 0.8)} y={H - h} height={h} />;
      })}
    </svg>
  );
}
