import { STANDARD_ABI } from "./standard-abi.ts";

/** One entry of an ABI as the compiler writes it; only the parts the page reads. */
export interface AbiParam { name?: string; type: string; indexed?: boolean; components?: AbiParam[] }
export interface AbiEntry { type?: string; name?: string; stateMutability?: string; inputs?: AbiParam[]; outputs?: AbiParam[]; anonymous?: boolean }

/** The type of a parameter as it is written in a signature: a tuple is its components in brackets, an array keeps its suffix. */
export function typeOf(p: AbiParam): string {
  if (!p.type.startsWith("tuple")) return p.type;
  return `(${(p.components ?? []).map(typeOf).join(",")})${p.type.slice("tuple".length)}`;
}
const list = (ps: AbiParam[] | undefined, events = false) => (ps ?? []).map((p) => [typeOf(p), events && p.indexed ? "indexed" : "", p.name ?? ""].filter(Boolean).join(" ")).join(", ");

/** The entry as one line of Solidity, the way a person would read it. */
export function signature(e: AbiEntry): string {
  const kind = e.type ?? "function";
  if (kind === "fallback" || kind === "receive") return `${kind}() ${e.stateMutability ?? ""}`.trim();
  if (kind === "constructor") return `constructor(${list(e.inputs)})${e.stateMutability === "payable" ? " payable" : ""}`;
  if (kind === "event") return `event ${e.name}(${list(e.inputs, true)})${e.anonymous ? " anonymous" : ""}`;
  if (kind === "error") return `error ${e.name}(${list(e.inputs)})`;
  const outs = e.outputs?.length ? ` returns (${list(e.outputs)})` : "";
  return `function ${e.name}(${list(e.inputs)})${e.stateMutability && e.stateMutability !== "nonpayable" ? ` ${e.stateMutability}` : ""}${outs}`;
}

export interface DecodedArg { name: string; type: string; value: string }
const STATIC = /^(address|bool|uint\d*|bytes([1-9]|[12]\d|3[0-2]))$/;

/** The constructor arguments word by word, or null when they cannot be read that way: a type that is not one word (string, bytes, an array, a tuple, a signed int), or arguments of another length. */
export function decodeArgs(inputs: AbiParam[], hex: string): DecodedArg[] | null {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!inputs.every((p) => STATIC.test(p.type)) || h.length !== inputs.length * 64) return null;
  return inputs.map((p, i) => {
    const w = h.slice(i * 64, i * 64 + 64);
    const value = p.type === "address" ? "0x" + w.slice(24) : p.type === "bool" ? (BigInt("0x" + w) === 0n ? "false" : "true") : p.type.startsWith("uint") ? BigInt("0x" + w).toString() : "0x" + w.slice(0, Number(p.type.slice(5)) * 2);
    return { name: p.name ?? "", type: p.type, value };
  });
}

/** The verified ABI when the contract has one, else the standard one (tokens, the gateway, proxies), so that no page shows raw bytes for a plain `transfer`. */
export const abiOrStandard = (verified: AbiEntry[] | null | undefined): AbiEntry[] => (verified && verified.length > 0 ? verified : STANDARD_ABI);

/**
 * The ABI with only the events a log of this many topics can be (the first topic names the event, each indexed input has one more). ERC-20's and
 * ERC-721's `Transfer` share a name and a hash and differ only in how many inputs are indexed, so a log is read with the ones that fit.
 */
export const eventsFor = (abi: AbiEntry[], topicCount: number): AbiEntry[] =>
  abi.filter((e) => e.type !== "event" || (e.anonymous ? false : (e.inputs ?? []).filter((i) => i.indexed).length === topicCount - 1));
