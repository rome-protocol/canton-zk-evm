import { readFileSync } from "node:fs";

/** What the buy worker publishes about the paid path (its `buy-status.json`), as the explorer serves it: the price (Canton Coin for one coin), the least buy (Canton Coin), the party to send to, and `open` or `sold out`. Both amounts are plain decimal text. */
export interface PaidPath { price: string; minBuy: string; party: string; state: "open" | "sold out" }

/** The file is read again when what the server holds of it is this old (ms). */
export const PAID_PATH_REREAD_MS = 3000;
/** A file the worker wrote longer ago than this (ms) is not shown: the worker writes it at the end of every poll (every 10 s by default), so an old one means it has stopped or is off. */
export const PAID_PATH_STALE_MS = 300_000;
/** The largest file the server reads, in characters. A larger one gives nothing. */
export const PAID_PATH_FILE_MAX = 10_000;

const AMOUNT = /^\d{1,28}(\.\d{1,20})?$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/** The paid path a file's text holds at `nowMs`; null for a file that is not the worker's (version 1), has a field that is not as the worker writes it, has no readable time, is older than PAID_PATH_STALE_MS or is dated in the future. */
export function parsePaidPath(raw: string, nowMs: number): PaidPath | null {
  if (raw.length > PAID_PATH_FILE_MAX) return null;
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return null; }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const f = json as { version?: unknown; updatedAt?: unknown; price?: unknown; minBuy?: unknown; party?: unknown; state?: unknown };
  if (f.version !== 1 || typeof f.updatedAt !== "string" || !TIME.test(f.updatedAt)) return null;
  const age = nowMs - Date.parse(f.updatedAt);
  if (!(age <= PAID_PATH_STALE_MS) || age < -60_000) return null;
  if (typeof f.price !== "string" || !AMOUNT.test(f.price) || typeof f.minBuy !== "string" || !AMOUNT.test(f.minBuy)) return null;
  if (typeof f.party !== "string" || f.party.length === 0 || f.party.length > 300) return null;
  if (f.state !== "open" && f.state !== "sold out") return null;
  return { price: f.price, minBuy: f.minBuy, party: f.party, state: f.state };
}

export interface PaidPathOptions {
  /** The worker's `buy-status.json` (PAID_PATH_FILE); null reads nothing, and then the paid path is never shown. */
  file: string | null;
  now?: () => number;
  readFile?: (path: string) => string;
}

/** The paid path to show now, from the worker's file; null while the file is not set, not there, not readable or stale (the status then shows nothing for it). */
export function createPaidPath({ file, now = Date.now, readFile = (p) => readFileSync(p, "utf8") }: PaidPathOptions): () => PaidPath | null {
  if (file === null) return () => null;
  let held: PaidPath | null = null, readAt = -Infinity;
  return () => {
    const t = now();
    if (t - readAt >= PAID_PATH_REREAD_MS || t < readAt) {
      readAt = t;
      try { held = parsePaidPath(readFile(file), t); } catch { held = null; }
    }
    return held;
  };
}
