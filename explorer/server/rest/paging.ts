/**
 * Keyset paging for every list of the REST API (design 6.1): `?before=<key>&limit=`, never an offset. A key is the sort key of the last row a client has seen,
 * written as its parts joined by ":" (`<block>:<index>` for transactions), and a page is the rows that sort strictly after it, newest first.
 */

/** A request the client got wrong: the routes answer 400 with this message. */
export class BadRequest extends Error {}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * The part kinds a key can have: a non-negative integer (in a JavaScript safe range), a token of lowercase letters and digits (a 0x address, or a decimal
 * number too large for an integer), or a trace address, "t" and its indexes joined by "-" (t0-1).
 */
export type Part = "int" | "text" | "trace";
const INT = /^(0|[1-9][0-9]{0,15})$/, TEXT = /^[0-9a-z]{1,128}$/, TRACE = /^t([0-9]{1,10}(-[0-9]{1,10})*)?$/;
const FITS: Record<Part, (p: string) => boolean> = { int: (p) => INT.test(p) && Number.isSafeInteger(Number(p)), text: (p) => TEXT.test(p), trace: (p) => TRACE.test(p) };

/** `limit` from the query: absent means the default; more than the cap is the cap; anything that is not a positive whole number is refused. */
export function limitOf(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  if (!INT.test(raw) || Number(raw) < 1) throw new BadRequest(`limit is a whole number from 1 to ${MAX_LIMIT}.`);
  return Math.min(Number(raw), MAX_LIMIT);
}

/** `before` from the query as its parts, or null when it is absent (the first page). The parts must be those the route sorts by. */
export function cursorOf(raw: string | null, shape: readonly Part[]): (number | string)[] | null {
  if (raw === null || raw === "") return null;
  const parts = raw.split(":");
  const ok = parts.length === shape.length && parts.every((p, i) => FITS[shape[i] as Part](p));
  if (!ok) throw new BadRequest(`before is ${shape.map((s) => (s === "int" ? "a number" : s === "trace" ? "a trace address" : "a key")).join(" then ")}, joined by ":".`);
  return parts.map((p, i) => (shape[i] === "int" ? Number(p) : p));
}

export const keyOf = (...parts: (number | string)[]): string => parts.join(":");

export interface Page<T> { items: T[]; next: string | null }

/** A page from the rows a query fetched with `limit + 1`: the extra row only says that there is more, and the key of the last row shown is the next page's `before`. */
export function pageOf<T>(rows: T[], limit: number, key: (row: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? key(items[items.length - 1] as T) : null };
}
