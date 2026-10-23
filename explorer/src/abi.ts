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
