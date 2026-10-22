/**
 * L4's budgets (design section 9, B5), as pure code so a test holds them without a browser: for Home, Block and Transaction the largest contentful paint,
 * the gzipped script of the first route and the API calls made before the first paint; Address and Contract are measured and reported, never held.
 * Every page is opened `repeat` times, each in a fresh browser context (a cold cache). The median of the runs is held to the budget (a single run on a
 * shared runner varies by more than the budget's margin); the slowest run is reported beside it.
 */
export const B5_LCP_MS = 2000;
export const B5_SCRIPT_GZIP_BYTES = 200 * 1024;
export const B5_API_CALLS_BEFORE_PAINT = 3;
/** The pages that B5 holds. */
export const HELD = ["home", "block", "transaction"] as const;

export interface Run { lcpMs: number | null; fcpMs: number | null; scriptGzipBytes: number; scriptWireBytes: number; apiBeforeFcp: number; apiBeforeLcp: number; apiTotal: number }
export interface PageResult { name: string; path: string; held: boolean; note?: string; runs: Run[]; median: Record<string, number | null>; worst: Record<string, number | null> }

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function column(runs: Run[], key: keyof Run): number[] {
  return runs.map((r) => r[key]).filter((v): v is number => typeof v === "number");
}

export function summarize(name: string, path: string, runs: Run[], note?: string): PageResult {
  const keys: (keyof Run)[] = ["lcpMs", "fcpMs", "scriptGzipBytes", "scriptWireBytes", "apiBeforeFcp", "apiBeforeLcp", "apiTotal"];
  const median_: Record<string, number | null> = {};
  const worst: Record<string, number | null> = {};
  for (const k of keys) {
    const v = column(runs, k);
    median_[k] = median(v);
    worst[k] = v.length ? Math.max(...v) : null;
  }
  const result: PageResult = { name, path, held: (HELD as readonly string[]).includes(name), runs, median: median_, worst };
  if (note) result.note = note;
  return result;
}

/** The budgets a set of pages broke; a held page with no measurement (no paint) is a failure, not a pass. */
export function judge(pages: PageResult[]): string[] {
  const failures: string[] = [];
  for (const held of HELD) {
    const p = pages.find((x) => x.name === held);
    if (!p) { failures.push(`${held}: not measured`); continue; }
    const lcp = p.median.lcpMs;
    if (lcp === null) failures.push(`${held}: no largest contentful paint was recorded`);
    else if (lcp > B5_LCP_MS) failures.push(`${held}: median LCP ${Math.round(lcp)} ms > ${B5_LCP_MS} ms`);
    const js = p.median.scriptGzipBytes;
    if (js === null || js === 0) failures.push(`${held}: no script was measured`);
    else if (js > B5_SCRIPT_GZIP_BYTES) failures.push(`${held}: ${Math.round(js)} bytes of gzipped script > ${B5_SCRIPT_GZIP_BYTES}`);
    const api = p.median.apiBeforeFcp;
    if (api === null) failures.push(`${held}: no first paint was recorded`);
    else if (api > B5_API_CALLS_BEFORE_PAINT) failures.push(`${held}: ${api} API calls before the first paint > ${B5_API_CALLS_BEFORE_PAINT}`);
  }
  return failures;
}
