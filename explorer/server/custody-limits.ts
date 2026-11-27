import { readFileSync } from "node:fs";

/** The least of an instrument that the custody worker enforces, `least` as decimal text in the instrument's own units. */
export interface Least { instrumentAdmin: string; instrumentId: string; least: string }
/**
 * What the custody worker publishes about the limits it runs with (its `custody-limits.json`), as the explorer serves it. `updatedAt` is when the worker wrote it (UTC). A part that is not
 * switched on, or that cannot be read, is null: `minDeposits` (the intake's least deposit per instrument), `minPayouts` (the payouts' least) and `maxOffers` (0: no limit).
 */
export interface CustodyLimits { updatedAt: string; minDeposits: Least[] | null; minPayouts: Least[] | null; maxOffers: number | null }

/** The file is read again when what the server holds of it is this old (ms). */
export const CUSTODY_LIMITS_REREAD_MS = 3000;
/** A file the worker wrote longer ago than this (ms) is not shown: the worker writes it at the start of every round (every 10 s by default), so an old one means it has stopped. */
export const CUSTODY_LIMITS_STALE_MS = 300_000;
/** The largest file the server reads, in characters. A larger one gives nothing. */
export const CUSTODY_LIMITS_FILE_MAX = 200_000;
/** The most instruments one list holds. */
const LISTED_MAX = 100;

const LEAST = /^\d{1,28}(\.\d{1,20})?$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** A list of least amounts, or null when the part is off (null in the file) or any entry is not `{instrumentAdmin, instrumentId, least}` with `least` plain decimal text: a list that cannot be read whole is not shown in part. */
function leastList(v: unknown): Least[] | null {
  if (!Array.isArray(v) || v.length > LISTED_MAX) return null;
  const out: Least[] = [];
  for (const e of v as unknown[]) {
    const x = e as { instrumentAdmin?: unknown; instrumentId?: unknown; least?: unknown } | null;
    if (!x || !text(x.instrumentAdmin, 300) || !text(x.instrumentId, 200) || typeof x.least !== "string" || !LEAST.test(x.least)) return null;
    out.push({ instrumentAdmin: x.instrumentAdmin, instrumentId: x.instrumentId, least: x.least });
  }
  return out;
}

/** The limits a file's text holds at `nowMs`; null for a file that is not the worker's (version 1), has no readable time, is older than CUSTODY_LIMITS_STALE_MS or is dated in the future. */
export function parseCustodyLimits(raw: string, nowMs: number): CustodyLimits | null {
  if (raw.length > CUSTODY_LIMITS_FILE_MAX) return null;
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return null; }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const f = json as { version?: unknown; updatedAt?: unknown; minDeposits?: unknown; minPayouts?: unknown; maxOffers?: unknown };
  if (f.version !== 1 || typeof f.updatedAt !== "string" || !TIME.test(f.updatedAt)) return null;
  const age = nowMs - Date.parse(f.updatedAt);
  if (!(age <= CUSTODY_LIMITS_STALE_MS) || age < -60_000) return null;
  return { updatedAt: f.updatedAt, minDeposits: leastList(f.minDeposits), minPayouts: leastList(f.minPayouts), maxOffers: typeof f.maxOffers === "number" && Number.isSafeInteger(f.maxOffers) && f.maxOffers >= 0 ? f.maxOffers : null };
}

export interface CustodyLimitsOptions {
  /** The worker's `custody-limits.json` (CUSTODY_LIMITS_FILE); null reads nothing, and then there is never a limit. */
  file: string | null;
  now?: () => number;
  readFile?: (path: string) => string;
}

/** The limits to show now, from the worker's file; null while the file is not set, not there, not readable or stale (the page then makes no check). */
export function createCustodyLimits({ file, now = Date.now, readFile = (p) => readFileSync(p, "utf8") }: CustodyLimitsOptions): () => CustodyLimits | null {
  if (file === null) return () => null;
  let held: CustodyLimits | null = null, readAt = -Infinity;
  return () => {
    const t = now();
    if (t - readAt >= CUSTODY_LIMITS_REREAD_MS || t < readAt) {
      readAt = t;
      try { held = parseCustodyLimits(readFile(file), t); } catch { held = null; }
    }
    return held;
  };
}
