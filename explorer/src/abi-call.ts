import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, toEventSelector, toFunctionSelector, type Abi } from "viem";
import { typeOf, type AbiEntry, type AbiParam } from "./abi.ts";

export type { AbiEntry, AbiParam };
export interface Shown { name: string; type: string; value: string }

/** The functions to read (view and pure) or to write (the rest) in an ABI. */
export const callable = (abi: AbiEntry[], mode: "read" | "write"): AbiEntry[] =>
  abi.filter((e) => e.type === "function" && e.name && ((e.stateMutability === "view" || e.stateMutability === "pure") === (mode === "read")));

/** A value of an ABI type as text: a number as its digits, an address in lower case, a list or a tuple as JSON. Text only, so it is never read as markup. */
export function shown(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" ? JSON.stringify(x) : shown(x))).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${typeof x === "string" ? JSON.stringify(x) : shown(x)}`).join(",")}}`;
  return String(v);
}

const bad = (type: string, why: string) => new Error(`${type}: ${why}`);
const BITS = /^(u?int)(\d*)$/, FIXED = /^bytes([1-9]|[12]\d|3[0-2])$/, ARRAY = /^(.*)\[(\d*)\]$/;

/**
 * Typed JSON with every bare whole number turned into its own digits as text, before JSON reads it: JSON.parse would round a number
 * above 2^53 to a double and the wallet would be asked to send an amount other than the one typed. A number with a fraction or an
 * exponent is refused, since no ABI integer takes one.
 */
function digitsKept(text: string, type: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) { out += c; i++; continue; }
      if (m[1] || m[2]) throw bad(type, "type each number as whole digits, with no fraction or exponent");
      out += `"${m[0]}"`; i += m[0].length;
    } else { out += c; i++; }
  }
  return out;
}

/** What was typed in a field, as the value the ABI coder takes. A list or a tuple is typed as JSON. Throws a plain message that names the type. */
export function parseArg(p: AbiParam, text: string): unknown {
  const a = ARRAY.exec(p.type);
  if (a) {
    let list: unknown;
    try { list = JSON.parse(digitsKept(text, p.type)); } catch (e) { throw e instanceof Error && e.message.startsWith(p.type) ? e : bad(p.type, "type a list as JSON, like [1, 2]"); }
    if (!Array.isArray(list)) throw bad(p.type, "type a list as JSON, like [1, 2]");
    if (a[2] && list.length !== Number(a[2])) throw bad(p.type, `the list has ${list.length} values, not ${a[2]}`);
    return list.map((x) => parseArg({ ...p, type: a[1]! }, typeof x === "string" ? x : shown(x)));
  }
  if (p.type === "tuple") {
    let list: unknown;
    try { list = JSON.parse(digitsKept(text, p.type)); } catch (e) { throw e instanceof Error && e.message.startsWith(p.type) ? e : bad(p.type, "type a tuple as a JSON list of its parts"); }
    const parts = p.components ?? [];
    if (!Array.isArray(list) || list.length !== parts.length) throw bad(p.type, `type a JSON list of its ${parts.length} parts`);
    return parts.map((c, i) => parseArg(c, typeof list[i] === "string" ? (list[i] as string) : shown(list[i])));
  }
  const t = text.trim();
  if (p.type === "address") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw bad(p.type, "an address is 0x and 40 hex digits");
    return t.toLowerCase();
  }
  if (p.type === "bool") {
    if (t !== "true" && t !== "false") throw bad(p.type, "type true or false");
    return t === "true";
  }
  const n = BITS.exec(p.type);
  if (n) {
    if (!/^-?\d+$/.test(t)) throw bad(p.type, "type a whole number, in digits");
    const bits = BigInt(n[2] || 256), v = BigInt(t);
    const [lo, hi] = n[1] === "uint" ? [0n, (1n << bits) - 1n] : [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
    if (v < lo || v > hi) throw bad(p.type, `the number must be from ${lo} to ${hi}`);
    return v;
  }
  const f = FIXED.exec(p.type);
  if (f) {
    if (!new RegExp(`^0x[0-9a-fA-F]{${Number(f[1]) * 2}}$`).test(t)) throw bad(p.type, `${p.type} is 0x and ${Number(f[1]) * 2} hex digits`);
    return t;
  }
  if (p.type === "bytes") {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(t)) throw bad(p.type, "bytes are 0x and whole bytes of hex digits");
    return t;
  }
  return text; // a string is as typed, spaces and all
}

/** The call data of a function with the fields typed for it. */
export function encodeCall(e: AbiEntry, fields: string[]): string {
  const args = (e.inputs ?? []).map((p, i) => parseArg(p, fields[i] ?? ""));
  return encodeFunctionData({ abi: [e] as Abi, functionName: e.name!, args });
}

const lower = (type: string, v: string) => (type === "address" ? v.toLowerCase() : v);
const list = (params: AbiParam[] | undefined, values: unknown[]): Shown[] =>
  (params ?? []).map((p, i) => ({ name: p.name ?? "", type: typeOf(p), value: lower(p.type, shown(values[i] ?? "")) }));

/** What a call answered, one value per output of the function. */
export function decodeOutputs(e: AbiEntry, data: string): Shown[] {
  const outs = e.outputs ?? [];
  if (outs.length === 0) return [];
  if (data === "0x") throw new Error("The call returned no data: nothing at this address answers this function.");
  const r = decodeFunctionResult({ abi: [e] as Abi, functionName: e.name!, data: data as `0x${string}` });
  return list(outs, outs.length === 1 ? [r] : (r as unknown[]));
}

/** `indexed` is set for an event: which of the arguments sit in the topics. */
export interface Decoded { name: string; signature: string; args: Shown[]; indexed?: boolean[] }
const sig = (e: AbiEntry) => `${e.name}(${(e.inputs ?? []).map(typeOf).join(",")})`;

/** A transaction's input read with the ABI, or null when it is not a call of a function in it. */
export function decodeInputOf(abi: AbiEntry[], input: string): Decoded | null {
  if (input.length < 10) return null;
  try {
    const d = decodeFunctionData({ abi: abi as Abi, data: input as `0x${string}` });
    const e = abi.find((x) => x.type === "function" && x.name === d.functionName && toFunctionSelector(sig(x)) === input.slice(0, 10).toLowerCase());
    return e ? { name: e.name!, signature: sig(e), args: list(e.inputs, [...((d.args ?? []) as unknown[])]) } : null;
  } catch { return null; }
}

/** A log read with the ABI, or null when it is not an event in it. */
export function decodeEventOf(abi: AbiEntry[], topics: string[], data: string): Decoded | null {
  if (topics.length === 0) return null;
  try {
    const d = decodeEventLog({ abi: abi as Abi, topics: topics as [`0x${string}`], data: data as `0x${string}`, strict: false });
    const e = abi.find((x) => x.type === "event" && x.name === d.eventName && (x.inputs ?? []).filter((i) => i.indexed).length === topics.length - 1);
    if (!e) return null;
    const a = d.args as Record<string, unknown> | unknown[] | undefined;
    const vals = (e.inputs ?? []).map((p, i) => (Array.isArray(a) ? a[i] : (a as Record<string, unknown> | undefined)?.[p.name ?? ""]));
    return { name: e.name!, signature: sig(e), args: list(e.inputs, vals), indexed: (e.inputs ?? []).map((p) => p.indexed === true) };
  } catch { return null; }
}

/** The 4-byte id of each function in the ABIs, to its name: what names a transaction's method. */
export function methodNames(abi: AbiEntry[]): Map<string, string> {
  return new Map(abi.filter((e) => e.type === "function" && e.name).map((e) => [toFunctionSelector(sig(e)), e.name!]));
}

/** The events in the ABIs, each once, with the topic its logs carry first. */
export function eventKinds(abi: AbiEntry[]): { name: string; signature: string; topic0: string }[] {
  const seen = new Map<string, { name: string; signature: string; topic0: string }>();
  for (const e of abi) if (e.type === "event" && e.name && !e.anonymous) seen.set(toEventSelector(sig(e)), { name: e.name, signature: sig(e), topic0: toEventSelector(sig(e)) });
  return [...seen.values()];
}
