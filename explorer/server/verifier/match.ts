/**
 * Matching compiled code against the code on chain (design section 6.3, point 4). Pure: no compiler, no database.
 *
 * The runtime code decides. The compiled runtime code is filled with what only the chain knows (the immutables' values, and the addresses of linked libraries, both read
 * from the on-chain code at the places the compiler names), then compared with the chain's code. Equal byte for byte, with a metadata hash that pins the sources,
 * is a **full** match. Equal except for the hash values in the metadata at the end (the CBOR the compiler appends, which holds a hash of the sources and of the
 * settings) is a **partial** match: the code is the same, the source differs in something that does not reach the code (comments, names of private things,
 * paths). So is code that is equal but has no metadata hash to pin its source (compiled without the CBOR, or with `bytecodeHash: none`): the code is proved, the
 * source is not. What may differ is decided from what the compiler produced, never from the on-chain code: the metadata is found only when the settings say the
 * compiler appended it, it must be a CBOR map of the shape solc writes with the version of the compiler that ran, and only the bytes of its hash values are left
 * out of the comparison. When the creation code is known (a contract that a transaction or a factory made), the creation code must match too, in the same way,
 * and what follows the compiled creation code is the constructor arguments. A contract with no creation (a genesis contract, such as the gateway) is matched on
 * its runtime code only, and keeps no constructor arguments.
 */

export type MatchKind = "full" | "partial";
export type LinkReferences = Record<string, Record<string, { start: number; length: number }[]>>;
export type ImmutableReferences = Record<string, { start: number; length: number }[]>;

/** What the compiler gave for one contract (standard JSON output, `evm.bytecode` and `evm.deployedBytecode`). */
export interface CompiledCode {
  creation: string;
  creationLinks: LinkReferences;
  runtime: string;
  runtimeLinks: LinkReferences;
  immutables: ImmutableReferences;
}

export interface OnChain {
  runtimeCode: Buffer;
  /** The creation input (a transaction's input, or the init code of a factory's creation); null for a genesis contract or when it is not known. */
  creationInput: Buffer | null;
}

export interface Matched {
  kind: MatchKind;
  /** How the creation code matched; null when there is no creation code to compare. */
  creationKind: MatchKind | null;
  /** What follows the compiled creation code in the creation input (the arguments the creator sent); null when there are none, and for a contract with no creation input. */
  constructorArgs: Buffer | null;
  /** The library addresses in the code, by source file and name, as 0x addresses (the ones the request gave, and the ones read from the chain). */
  libraries: Record<string, Record<string, string>>;
}

/** A submission that does not match: `reason` is for the person who submitted it. */
export class MatchFailure extends Error {
  readonly code: "runtime" | "creation" | "arguments" | "libraries";
  constructor(code: MatchFailure["code"], reason: string) {
    super(reason);
    this.code = code;
  }
}

/** What the matcher needs of the compile: whether the settings made the compiler append its metadata, and the version that ran (`0.8.28+commit.7893614a`). */
export interface MatchContext { appendCbor: boolean; version: string }

export interface Metadata {
  /** Where the CBOR map starts: it ends two bytes before the end of the code. */
  start: number;
  /** The bytes of the hash values (`ipfs`, `bzzr0`, `bzzr1`), the only part that may differ in a partial match. */
  hashes: { start: number; length: number }[];
}

const KEY_LENGTH: Record<string, number | "bool" | "solc"> = { ipfs: 34, bzzr0: 32, bzzr1: 32, experimental: "bool", solc: "solc" };
const HASH_KEYS = new Set(["ipfs", "bzzr0", "bzzr1"]);

/**
 * Reads the metadata at the end of code the way solc writes it: a CBOR map (1 to 5 pairs) of text keys `ipfs`, `bzzr0`, `bzzr1`, `experimental` and `solc`, each once,
 * with a value of the length solc gives it, the map ending exactly where its two length bytes begin, and `solc` equal to the compiler that ran. Null when the end of the
 * code is anything else. Only for code the compiler produced with the CBOR appended: anything at the end of other code is code or data.
 */
export function findMetadata(code: Buffer, version: string): Metadata | null {
  if (code.length < 4) return null;
  const n = code.readUInt16BE(code.length - 2);
  const end = code.length - 2;
  if (n < 1 || n > end) return null;
  const start = end - n;
  const head = code[start]!;
  if (head < 0xa1 || head > 0xa5) return null;
  let at = start + 1;
  const hashes: { start: number; length: number }[] = [];
  const seen = new Set<string>();
  const len = (): number | null => {
    // The length of a text or byte string, in the one or two bytes solc uses.
    const b = code[at];
    if (b === undefined) return null;
    const low = b & 0x1f;
    if (low < 24) { at += 1; return low; }
    if (low === 24 && at + 1 < end) { const v = code[at + 1]!; at += 2; return v; }
    return null;
  };
  for (let i = 0; i < head - 0xa0; i++) {
    if (at >= end || (code[at]! & 0xe0) !== 0x60) return null;
    const kl = len();
    if (kl === null || at + kl > end) return null;
    const key = code.subarray(at, at + kl).toString("latin1");
    at += kl;
    const want = KEY_LENGTH[key];
    if (want === undefined || seen.has(key)) return null;
    seen.add(key);
    if (want === "bool") {
      if (code[at] !== 0xf4 && code[at] !== 0xf5) return null;
      at += 1;
      continue;
    }
    const major = code[at]! & 0xe0;
    if (want === "solc" ? major !== 0x40 && major !== 0x60 : major !== 0x40) return null;
    const vl = len();
    if (vl === null || at + vl > end) return null;
    if (want === "solc") {
      const v = code.subarray(at, at + vl);
      const core = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
      if (!core) return null;
      if (major === 0x40 ? vl !== 3 || v[0] !== Number(core[1]) || v[1] !== Number(core[2]) || v[2] !== Number(core[3]) : !v.toString("latin1").startsWith(`${core[1]}.${core[2]}.${core[3]}`)) return null;
    } else {
      if (vl !== want) return null;
      if (HASH_KEYS.has(key)) hashes.push({ start: at, length: vl });
    }
    at += vl;
  }
  if (at !== end) return null;
  return { start, hashes };
}

/** What the compiler's metadata is in this compile: nothing when the settings did not ask for it. */
function metadataOf(code: Buffer, ctx: MatchContext): Metadata | null {
  return ctx.appendCbor ? findMetadata(code, ctx.version) : null;
}

/** Whether two codes of one length are equal outside the places. */
function equalOutside(a: Buffer, b: Buffer, places: { start: number; length: number }[]): boolean {
  if (a.length !== b.length) return false;
  if (places.length === 0) return a.equals(b);
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  for (const p of places) { x.fill(0, p.start, p.start + p.length); y.fill(0, p.start, p.start + p.length); }
  return x.equals(y);
}

/** The hex the compiler gave, with the link placeholders turned to zeros (at the places the compiler names them). */
function toBytes(hex: string, links: LinkReferences, what: string): Buffer {
  let h = hex.replace(/^0x/, "");
  for (const file of Object.values(links)) {
    for (const refs of Object.values(file)) {
      for (const r of refs) {
        if (r.start < 0 || r.length < 1 || (r.start + r.length) * 2 > h.length) throw new MatchFailure("libraries", `the compiler's link reference is outside the ${what}`);
        h = h.slice(0, r.start * 2) + "00".repeat(r.length) + h.slice((r.start + r.length) * 2);
      }
    }
  }
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new MatchFailure("libraries", `the compiled ${what} still has a placeholder the compiler did not name`);
  return Buffer.from(h, "hex");
}

/** Copies the on-chain bytes at each place into `into`; the same value must stand at every place that belongs together. Returns the values by key. */
function fill(into: Buffer, from: Buffer, places: Map<string, { start: number; length: number }[]>, what: string, code: MatchFailure["code"]): Map<string, Buffer> {
  const values = new Map<string, Buffer>();
  for (const [key, spots] of places) {
    for (const s of spots) {
      if (s.start + s.length > from.length || s.start + s.length > into.length) throw new MatchFailure(code, `the ${what} named by the compiler is beyond the code on chain`);
      const v = from.subarray(s.start, s.start + s.length);
      const before = values.get(key);
      if (before && !before.equals(v)) throw new MatchFailure(code, `${key} has different ${what} in different places of the code on chain`);
      values.set(key, Buffer.from(v));
      v.copy(into, s.start);
    }
  }
  return values;
}

const hex = (b: Buffer): string => "0x" + b.toString("hex");

/** Compares the compiled runtime code with the chain's: full when equal and the metadata pins the source, partial when equal but for the hash values, else null. */
function compare(compiled: Buffer, onChain: Buffer, ctx: MatchContext): MatchKind | null {
  const md = metadataOf(compiled, ctx);
  const hashed = Boolean(md && md.hashes.length > 0);
  if (compiled.equals(onChain)) return hashed ? "full" : "partial";
  return hashed && equalOutside(compiled, onChain, md!.hashes) ? "partial" : null;
}

/**
 * The creation code, matched with the start of the creation input. Everything is compared except the hash values in the compiled code's metadata (the creation
 * code holds it twice: at the end of the embedded runtime code, and at its own end), so that a different metadata hash is a partial match.
 */
function compareCreation(compiled: Buffer, runtime: Buffer, input: Buffer, ctx: MatchContext): MatchKind | null {
  if (input.length < compiled.length) return null;
  const head = input.subarray(0, compiled.length);
  const own = metadataOf(compiled, ctx);
  const places: { start: number; length: number }[] = [];
  if (own) places.push(...own.hashes);
  const inner = metadataOf(runtime, ctx);
  if (inner && inner.hashes.length > 0) {
    const cbor = runtime.subarray(inner.start, runtime.length - 2);
    for (let at = compiled.indexOf(cbor); at >= 0; at = compiled.indexOf(cbor, at + 1)) {
      for (const h of inner.hashes) places.push({ start: at + h.start - inner.start, length: h.length });
    }
  }
  // A hash anywhere in the creation code pins the source: a creation code that ends in data (a constant's initial value) has its hash only in the runtime code it holds.
  if (compiled.equals(head)) return places.length > 0 ? "full" : "partial";
  return places.length > 0 && equalOutside(compiled, head, places) ? "partial" : null;
}

/**
 * Matches one compiled contract with the chain. `given` are the constructor arguments the submitter sent (null when none): when the creation input is known they must be
 * what the creation input holds after the compiled creation code, else the submission is refused. Throws MatchFailure when the code does not match.
 */
export function matchCode(compiled: CompiledCode, onChain: OnChain, given: Buffer | null, ctx: MatchContext): Matched {
  const runtime = toBytes(compiled.runtime, compiled.runtimeLinks, "runtime code");
  // Immutables: their values come from the chain; a compiled runtime code has zeros there.
  const imm = new Map<string, { start: number; length: number }[]>();
  for (const [id, spots] of Object.entries(compiled.immutables ?? {})) imm.set(id, spots);
  fill(runtime, onChain.runtimeCode, imm, "immutable", "runtime");
  // Libraries: the address at each place, by name.
  const libs: Record<string, Record<string, string>> = {};
  const libPlaces = (links: LinkReferences): Map<string, { start: number; length: number }[]> => {
    const m = new Map<string, { start: number; length: number }[]>();
    for (const [file, names] of Object.entries(links)) for (const [name, spots] of Object.entries(names)) m.set(`${file}\u0000${name}`, spots);
    return m;
  };
  const note = (values: Map<string, Buffer>): void => {
    for (const [key, v] of values) {
      const [file, name] = key.split("\u0000") as [string, string];
      const address = hex(v);
      const had = libs[file]?.[name];
      if (had && had !== address) throw new MatchFailure("libraries", `the library ${name} stands at ${had} in the runtime code and at ${address} in the creation code`);
      (libs[file] ??= {})[name] = address;
    }
  };
  note(fill(runtime, onChain.runtimeCode, libPlaces(compiled.runtimeLinks), "library address", "libraries"));
  const kind = compare(runtime, onChain.runtimeCode, ctx);
  if (!kind) throw new MatchFailure("runtime", "the runtime code does not match the code on chain");

  if (!onChain.creationInput) {
    return { kind, creationKind: null, constructorArgs: null, libraries: libs };
  }
  const creation = toBytes(compiled.creation, compiled.creationLinks, "creation code");
  const input = onChain.creationInput;
  // A library known from the runtime code stands at the same address in the creation code; the creation code is compared with it, so that another creation
  // code is refused as one, not as a library. A library only the creation code names is read from the creation input.
  const unknown = new Map<string, { start: number; length: number }[]>();
  for (const [key, spots] of libPlaces(compiled.creationLinks)) {
    const [file, name] = key.split("\u0000") as [string, string];
    const known = libs[file]?.[name];
    if (!known) { unknown.set(key, spots); continue; }
    const address = Buffer.from(known.slice(2), "hex");
    for (const sp of spots) address.copy(creation, sp.start, 0, Math.min(sp.length, address.length));
  }
  note(fill(creation, input, unknown, "library address", "libraries"));
  if (input.length < creation.length) throw new MatchFailure("creation", "the creation code does not match the creation input on chain (the input is shorter than the compiled creation code)");
  const creationKind = compareCreation(creation, runtime, input, ctx);
  if (!creationKind) throw new MatchFailure("creation", "the creation code does not match the creation input on chain");
  const args = Buffer.from(input.subarray(creation.length));
  if (given && !given.equals(args)) {
    throw new MatchFailure("arguments", `the constructor arguments do not match the creation input on chain (it holds ${args.length} bytes after the creation code, the submission has ${given.length})`);
  }
  return { kind: kind === "full" && creationKind === "full" ? "full" : "partial", creationKind, constructorArgs: args.length > 0 ? args : null, libraries: libs };
}
