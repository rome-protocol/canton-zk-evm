import { readFileSync } from "node:fs";

/** The least of an instrument the bridge takes in one deposit: `floor` is decimal text in the instrument's own units, `readAt` when the builder read it. */
export interface Minimum { instrumentAdmin: string; floor: string; readAt: string | null }

/** The status file is read again when what the server holds of it is this old (ms). */
export const MINIMUMS_REREAD_MS = 3000;
/** The largest status file the server reads, in characters. A larger one gives no minimums. */
export const MINIMUMS_FILE_MAX = 4_000_000;

const FLOOR = /^\d{1,20}(\.\d{1,10})?$/;

/** The minimums a status file's text holds: the `floor` of each `custody.<admin>`. An entry whose floor is not decimal text is left out, and a file that cannot be read gives none. */
export function parseMinimums(raw: string): Minimum[] {
  if (raw.length > MINIMUMS_FILE_MAX) return [];
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return []; }
  const custody = (json as { custody?: unknown } | null)?.custody;
  if (typeof custody !== "object" || custody === null || Array.isArray(custody)) return [];
  return Object.entries(custody as Record<string, { floor?: unknown; readAt?: unknown } | null>)
    .flatMap(([instrumentAdmin, c]) => (typeof c?.floor === "string" && FLOOR.test(c.floor) ? [{ instrumentAdmin, floor: c.floor, readAt: typeof c.readAt === "string" ? c.readAt : null }] : []))
    .sort((a, b) => (a.instrumentAdmin < b.instrumentAdmin ? -1 : 1));
}

export interface MinimumsOptions {
  /** The builder's status file (PRODUCER_STATUS_FILE); null reads nothing, and then there is never a minimum. */
  file: string | null;
  now?: () => number;
  readFile?: (path: string) => string;
}

/** The minimums to show now, from the builder's status file; none while the file is not set, not there or not readable (the page then makes no check). */
export function createMinimums({ file, now = Date.now, readFile = (p) => readFileSync(p, "utf8") }: MinimumsOptions): () => Minimum[] {
  if (file === null) return () => [];
  let held: Minimum[] = [], readAt = -Infinity;
  return () => {
    const t = now();
    if (t - readAt >= MINIMUMS_REREAD_MS || t < readAt) {
      readAt = t;
      try { held = parseMinimums(readFile(file)); } catch { held = []; }
    }
    return held;
  };
}
