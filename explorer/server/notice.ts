import { readFileSync } from "node:fs";

/** What a notice says: plain text, and the two times (ISO 8601, UTC) between which the work is planned. */
export interface Notice { text: string; startsAt: string; endsAt: string }

/** The longest text a notice may have, in characters. A longer one is refused, not cut: a sentence cut in the middle would say something else. */
export const NOTICE_TEXT_MAX = 300;
/** The largest notice file the server reads, in characters. */
export const NOTICE_FILE_MAX = 4096;
/** The notice file is read again when what the server holds of it is this old (ms), so a notice that is set or cleared shows within a few seconds, with no restart. */
export const NOTICE_REREAD_MS = 3000;

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The notice a file's text holds, or the reason it is not one. The times must name a zone, so that they mean one moment; the text is plain text, with its white space folded to single spaces. */
export function parseNotice(raw: string): Notice | string {
  if (raw.length > NOTICE_FILE_MAX) return `the file is longer than ${NOTICE_FILE_MAX} characters`;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "the file is not JSON";
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return "the file must hold one JSON object";
  const o = json as Record<string, unknown>;
  if (typeof o.text !== "string") return "text must be a string";
  const text = o.text.replace(/\s+/g, " ").trim();
  if (text === "") return "text is empty";
  if (text.length > NOTICE_TEXT_MAX) return `text is longer than ${NOTICE_TEXT_MAX} characters`;
  const times: number[] = [];
  for (const name of ["startsAt", "endsAt"] as const) {
    const t = o[name];
    const ms = typeof t === "string" && TIME.test(t) ? Date.parse(t) : NaN;
    if (Number.isNaN(ms)) return `${name} must be an ISO time with its zone, such as 2026-11-14T09:00:00Z`;
    times.push(ms);
  }
  if (times[1]! <= times[0]!) return "endsAt must be after startsAt";
  return { text, startsAt: new Date(times[0]!).toISOString(), endsAt: new Date(times[1]!).toISOString() };
}

export interface NoticeOptions {
  /** The notice file (OSTIA_NOTICE_FILE); null reads nothing, and then there is never a notice. */
  file: string | null;
  now?: () => number;
  readFile?: (path: string) => string;
  /** Where a refused file is said once (default console.error). */
  warn?: (message: string) => void;
}

/**
 * The notice to show now: the file's, or null. A file that is not there is no notice. A file that is not a valid notice is no notice either, and is said once in the log
 * (not on every look), so a mistake in it cannot stop the explorer or put anything on a page. A notice is dropped once its endsAt has passed.
 */
export function createNotice({ file, now = Date.now, readFile = (p) => readFileSync(p, "utf8"), warn = (m) => console.error(m) }: NoticeOptions): () => Notice | null {
  if (file === null) return () => null;
  let held: Notice | null = null, readAt = -Infinity, said = "";
  return () => {
    const t = now();
    if (t - readAt >= NOTICE_REREAD_MS || t < readAt) {
      readAt = t;
      let text: string | null = null;
      try {
        text = readFile(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") warn(`notice: ${file} cannot be read: ${(e as Error).message}`);
      }
      const parsed = text === null ? null : parseNotice(text);
      held = typeof parsed === "string" || parsed === null ? null : parsed;
      const problem = typeof parsed === "string" ? parsed : "";
      if (problem !== said) { said = problem; if (problem) warn(`notice: ${file} is not shown: ${problem}`); }
    }
    return held && t < Date.parse(held.endsAt) ? held : null;
  };
}
