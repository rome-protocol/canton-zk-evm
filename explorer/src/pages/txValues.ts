import type { Label } from "../api.ts";
import { units } from "../format.ts";

/** The names an ERC-20 gives the amount of a call or an event. */
const AMOUNT_NAME = /^(value|values|amount|amounts|wad)$/i;
const WHOLE = /^\d+$/;

/** An amount in whole units with the token's symbol ("5,000 tUSD"), or null where the token's decimals are not known. */
export function inUnits(raw: string, label: Label | null | undefined): string | null {
  if (!label || label.decimals === null || !WHOLE.test(raw)) return null;
  return `${units(raw, label.decimals)}${label.symbol ? ` ${label.symbol}` : ""}`;
}

/** The whole-unit text of an argument that is an amount of the token (uint256 or uint256[] named value, amount or wad), one line per element, or null when it is not one. */
export function amountLines(a: { name: string; type: string; value: string }, token: Label | null | undefined): string[] | null {
  if (!AMOUNT_NAME.test(a.name) || (a.type !== "uint256" && a.type !== "uint256[]")) return null;
  const raws = a.type === "uint256" ? [a.value] : listOf(a.value);
  if (!raws) return null;
  const lines = raws.map((r) => inUnits(r, token));
  return lines.every((l): l is string => l !== null) ? lines : null;
}

/**
 * The elements of a list that `shown` wrote as text: whole numbers bare, strings in quotes. Read by splitting, never by JSON.parse, which
 * would round a number above 2^53. Null when it is not a flat list of such values.
 */
export function listOf(value: string): string[] | null {
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const body = value.slice(1, -1);
  if (body === "") return [];
  const parts = body.split(",");
  return parts.every((x) => /^(\d+|"[^",\\]*")$/.test(x)) ? parts.map((x) => (x.startsWith('"') ? x.slice(1, -1) : x)) : null;
}
