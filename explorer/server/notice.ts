import { readFileSync } from "node:fs";

/** A link a notice may carry, to a page that explains it: an http(s) address and the words for it. */
export interface NoticeLink { url: string; label: string }

/** What a notice says: plain text, the two times (ISO 8601, UTC) between which it runs, and optionally a level ("major" is the large banner) and a link. */
export interface Notice { text: string; startsAt: string; endsAt: string; level?: "major"; link?: NoticeLink }

/** The longest text a notice may have, in characters. A longer one is refused, not cut: a sentence cut in the middle would say something else. */
export const NOTICE_TEXT_MAX = 300;
/** The longest link address and link label, in characters. */
export const NOTICE_URL_MAX = 500;
export const NOTICE_LABEL_MAX = 60;
/** The most notices a file may hold. */
export const NOTICES_MAX = 5;
/** The largest notice file the server reads, in characters. */
export const NOTICE_FILE_MAX = 4096;
/** The notice file is read again when what the server holds of it is this old (ms), so a notice that is set or cleared shows within a few seconds, with no restart. */
export const NOTICE_REREAD_MS = 3000;

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const plain = (s: string) => s.replace(/\s+/g, " ").trim();

/** The link an http(s) address and a label make, or the reason they do not. The address is checked as the text is: it is a string, never HTML; it has no white space or control characters and no user name or password. */
function parseLink(v: unknown): NoticeLink | string {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "link must be an object with url and label";
  const l = v as Record<string, unknown>;
  if (typeof l.url !== "string" || typeof l.label !== "string") return "link needs a url and a label, both strings";
  if (l.url.length > NOTICE_URL_MAX) return `link url is longer than ${NOTICE_URL_MAX} characters`;
  if (/[\s\u0000-\u001f\u007f]/.test(l.url)) return "link url has white space or control characters";
  let u: URL;
  try { u = new URL(l.url); } catch { return "link url is not an address"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "link url must be http or https";
  if (u.username !== "" || u.password !== "") return "link url must not carry a user name or password";
  const label = plain(l.label);
  if (label === "") return "link label is empty";
  if (label.length > NOTICE_LABEL_MAX) return `link label is longer than ${NOTICE_LABEL_MAX} characters`;
  return { url: u.href, label };
}

/** One notice from a parsed JSON value, or the reason it is not one. The times must name a zone, so that they mean one moment; the text is plain text, with its white space folded to single spaces. */
function parseOne(json: unknown): Notice | string {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return "a notice must be a JSON object";
  const o = json as Record<string, unknown>;
  if (typeof o.text !== "string") return "text must be a string";
  const text = plain(o.text);
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
  const out: Notice = { text, startsAt: new Date(times[0]!).toISOString(), endsAt: new Date(times[1]!).toISOString() };
  if (o.level !== undefined) {
    if (o.level !== "major") return 'level must be "major" when it is set';
    out.level = "major";
  }
  if (o.link !== undefined) {
    const link = parseLink(o.link);
    if (typeof link === "string") return link;
    out.link = link;
  }
  return out;
}

/** The notices a file's text holds, or the reason it holds none: one JSON object (the single form) or a list of them, at most NOTICES_MAX. One notice that is not valid refuses the whole file, so the log says so and a half-shown file never hides a notice by chance. */
export function parseNotices(raw: string): Notice[] | string {
  if (raw.length > NOTICE_FILE_MAX) return `the file is longer than ${NOTICE_FILE_MAX} characters`;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "the file is not JSON";
  }
  if (!Array.isArray(json)) {
    if (json === null || typeof json !== "object") return "the file must hold a JSON object or a list of them";
    const one = parseOne(json);
    return typeof one === "string" ? one : [one];
  }
  if (json.length > NOTICES_MAX) return `the file holds more than ${NOTICES_MAX} notices`;
  const out: Notice[] = [];
  for (const [i, item] of json.entries()) {
    const one = parseOne(item);
    if (typeof one === "string") return `notice ${i + 1}: ${one}`;
    out.push(one);
  }
  return out;
}

/** The order to show them in: major ones first, the rest after them, each group in the file's order. */
export const byLevel = <T extends { level?: string }>(list: readonly T[]): T[] => [...list.filter((n) => n.level === "major"), ...list.filter((n) => n.level !== "major")];

export interface NoticeOptions {
  /** The notice file (OSTIA_NOTICE_FILE); null reads nothing, and then there is never a notice. */
  file: string | null;
  now?: () => number;
  readFile?: (path: string) => string;
  /** Where a refused file is said once (default console.error). */
  warn?: (message: string) => void;
}

/**
 * The notices to show now: the file's, major first, those that have not ended. A file that is not there is no notice. A file that is not valid is no notice either, and is said once in the log
 * (not on every look), so a mistake in it cannot stop the explorer or put anything on a page. A notice is dropped once its endsAt has passed.
 */
export function createNotices({ file, now = Date.now, readFile = (p) => readFileSync(p, "utf8"), warn = (m) => console.error(m) }: NoticeOptions): () => Notice[] {
  if (file === null) return () => [];
  let held: Notice[] = [], readAt = -Infinity, said = "";
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
      const parsed = text === null ? null : parseNotices(text);
      held = typeof parsed === "string" || parsed === null ? [] : byLevel(parsed);
      const problem = typeof parsed === "string" ? parsed : "";
      if (problem !== said) { said = problem; if (problem) warn(`notice: ${file} is not shown: ${problem}`); }
    }
    return held.filter((n) => t < Date.parse(n.endsAt));
  };
}
