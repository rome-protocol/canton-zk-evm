/** The axes of the stats charts. Pure, so that the scale a chart draws can be tested without drawing it. */

const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
/** The least of 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 and 10 times a power of ten that is not below `x` (x above 0). */
export function niceCeil(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = STEPS.find((s) => s * p >= x * (1 - 1e-9)) ?? 10;
  return Math.round(m * p * 1e9) / 1e9;
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/**
 * The top of the axis, and the indexes of the values above it. The top fits the largest value, unless that is more than twice what nine in ten values reach: then the
 * axis stops at twice that, so that ordinary hours can be read, and the values above are marked on the chart and named below it. Nothing is cut off unmarked.
 */
export function scaleOf(values: readonly (number | null)[]): { top: number; off: number[] } {
  const v = values.filter((x): x is number => x !== null);
  const max = v.length ? Math.max(...v) : 0;
  if (max <= 0) return { top: 1, off: [] };
  const ordinary = quantile([...v].sort((a, b) => a - b), 0.9);
  const cap = ordinary > 0 ? niceCeil(2 * ordinary) : null;
  if (cap === null || max <= cap) return { top: niceCeil(max), off: [] };
  return { top: cap, off: values.flatMap((x, i) => (x !== null && x > cap ? [i] : [])) };
}

export const axisTicks = (top: number): number[] => [0, 1, 2, 3, 4].map((k) => (top * k) / 4);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3_600_000, DAY = 24 * HOUR;
/** The marks of the time axis over [from, to): ten minutes over an hour, an hour over six, four hours over a day, a day over a week, five days over more (all UTC). */
export function timeTicks(from: number, to: number): { at: number; label: string }[] {
  const span = to - from;
  const every = span <= HOUR ? HOUR / 6 : span <= 6 * HOUR ? HOUR : span <= DAY ? 4 * HOUR : span <= 8 * DAY ? DAY : 5 * DAY;
  const out: { at: number; label: string }[] = [];
  for (let at = Math.ceil(from / every) * every; at < to; at += every) {
    const d = new Date(at);
    const label = every < DAY ? d.toISOString().slice(11, 16) : every === DAY ? `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    out.push({ at, label });
  }
  return out;
}
