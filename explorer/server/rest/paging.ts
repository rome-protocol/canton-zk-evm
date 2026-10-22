/**
 * Keyset paging for every list of the REST API (design 6.1): `?before=<key>&limit=`, never an offset. A key is the sort key of the last row a client has seen,
 * written as its parts joined by ":" (`<block>:<index>` for transactions), and a page is the rows that sort strictly after it, newest first.
 */

/** A request the client got wrong: the routes answer 400 with this message. */
export class BadRequest extends Error {}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * The part kinds a key can have, each the shape of the column it is compared with, so that a key the database would refuse is a 400 here:
 * `int` a non-negative integer in a JavaScript safe range (a bigint column), `int4` one that fits a 32-bit column, `uint` a decimal number up to 2^256 - 1 (a token
 * amount or id), `addr` a lowercase 0x address, `text` a token of lowercase letters and digits (an update id), or a trace address, "t" and its indexes
 * (each a 32-bit integer) joined by "-" (t0-1).
 */
export type Part = "int" | "int4" | "uint" | "addr" | "text" | "trace";
const INT = /^(0|[1-9][0-9]{0,15})$/, TEXT = /^[0-9a-z]{1,128}$/, ADDR = /^0x[0-9a-f]{40}$/, UINT = /^(0|[1-9][0-9]{0,77})$/, TRACE = /^t([0-9]{1,10}(-[0-9]{1,10})*)?$/;
const INT4_MAX = 2 ** 31 - 1;
const isInt = (p: string): boolean => INT.test(p) && Number.isSafeInteger(Number(p));
const isInt4 = (p: string): boolean => /^(0|[1-9][0-9]{0,9})$/.test(p) && Number(p) <= INT4_MAX;
/** True for "t" and indexes that each fit a 32-bit integer. */
export const isTrace = (p: string): boolean => TRACE.test(p) && p.slice(1).split("-").every((i) => i === "" || isInt4(i));
const FITS: Record<Part, (p: string) => boolean> = {
  int: isInt, int4: isInt4, uint: (p) => UINT.test(p) && BigInt(p) < 2n ** 256n, addr: (p) => ADDR.test(p), text: (p) => TEXT.test(p), trace: isTrace,
};
const WORDS: Record<Part, string> = { int: "a number", int4: "a number", uint: "a number", addr: "an address", text: "a key", trace: "a trace address" };

/** `limit` from the query: absent means the default; more than the cap is the cap; anything that is not a positive whole number is refused. */
export function limitOf(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  if (!isInt(raw) || Number(raw) < 1) throw new BadRequest(`limit is a whole number from 1 to ${MAX_LIMIT}.`);
  return Math.min(Number(raw), MAX_LIMIT);
}

export const AROUND_DEFAULT = 3, AROUND_MAX = 10;
/** `n` from the query: how many rows on each side. Absent means the default; more than the cap is the cap; anything that is not a positive whole number is refused. */
export function aroundOf(raw: string | null): number {
  if (raw === null) return AROUND_DEFAULT;
  if (!isInt(raw) || Number(raw) < 1) throw new BadRequest(`n is a whole number from 1 to ${AROUND_MAX}.`);
  return Math.min(Number(raw), AROUND_MAX);
}

/** `before` from the query as its parts, or null when it is absent (the first page). The parts must be those the route sorts by. */
export function cursorOf(raw: string | null, shape: readonly Part[]): (number | string)[] | null {
  if (raw === null || raw === "") return null;
  const parts = raw.split(":");
  const ok = parts.length === shape.length && parts.every((p, i) => FITS[shape[i] as Part](p));
  if (!ok) throw new BadRequest(`before is ${shape.map((s) => WORDS[s]).join(" then ")}, joined by ":".`);
  return parts.map((p, i) => (shape[i] === "int" || shape[i] === "int4" ? Number(p) : p));
}

export const keyOf = (...parts: (number | string)[]): string => parts.join(":");

export interface Page<T> { items: T[]; next: string | null }

/** A page from the rows a query fetched with `limit + 1`: the extra row only says that there is more, and the key of the last row shown is the next page's `before`. */
export function pageOf<T>(rows: T[], limit: number, key: (row: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? key(items[items.length - 1] as T) : null };
}
