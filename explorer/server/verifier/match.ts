/**
 * Matching compiled code against the code on chain (design section 6.3, point 4). Pure: no compiler, no database.
 *
 * The runtime code decides. The compiled runtime code is filled with what only the chain knows (the immutables' values, and the addresses of linked libraries, both read
 * from the on-chain code at the places the compiler names), then compared with the chain's code. Equal byte for byte is a **full** match. Equal except for the
 * metadata at the end (the CBOR the compiler appends, which holds a hash of the sources and of the settings) is a **partial** match: the code is the same,
 * the source differs in something that does not reach the code (comments, names of private things, paths). When the creation code is known (a contract that a
 * transaction or a factory made), the creation code must match too, in the same way, and what follows the compiled creation code is the constructor arguments.
 * A contract with no creation (a genesis contract, such as the gateway) is matched on its runtime code only.
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
  /** What follows the compiled creation code in the creation input (the arguments the creator sent), else the ones that were given, else null. */
  constructorArgs: Buffer | null;
  /** The library addresses in the code, by source file and name, as 0x addresses (the ones the request gave, and the ones read from the chain). */
  libraries: Record<string, Record<string, string>>;
}

/** A submission that does not match: `reason` is for the person who submitted it. */
export class MatchFailure extends Error {
  readonly code: "runtime" | "creation" | "arguments" | "libraries" | "short";
  constructor(code: MatchFailure["code"], reason: string) {
    super(reason);
    this.code = code;
  }
}

const MAX_CBOR = 1024;

/** Splits the metadata that solc appends (CBOR, then its length in two bytes) off the end of code; null when the code does not end that way. */
export function splitMetadata(code: Buffer): { body: Buffer; cbor: Buffer } | null {
  if (code.length < 4) return null;
  const n = code.readUInt16BE(code.length - 2);
  if (n < 8 || n > MAX_CBOR || n + 2 > code.length) return null;
  const start = code.length - 2 - n;
  const head = code[start]!;
  if (head < 0xa1 || head > 0xaf) return null; // a CBOR map of up to 15 pairs
  return { body: code.subarray(0, start), cbor: code.subarray(start) };
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

/** Compares two codes that have the same length except for the metadata: full when equal, partial when equal without it, else null. */
function compare(compiled: Buffer, onChain: Buffer): MatchKind | null {
  if (compiled.equals(onChain)) return "full";
  // The metadata is the only thing left out: code that has none (compiled with the metadata off) matches the same code that has it.
  const a = splitMetadata(compiled);
  const b = splitMetadata(onChain);
  if (!a && !b) return null;
  return (a?.body ?? compiled).equals(b?.body ?? onChain) ? "partial" : null;
}

/**
 * The creation code, matched with the start of the creation input. Everything is compared except the places where the compiled code holds its metadata (the creation
 * code holds it twice: at the end of the embedded runtime code, and at its own end), so that a different metadata hash is a partial match.
 */
function compareCreation(compiled: Buffer, input: Buffer, cbor: Buffer | null): MatchKind | null {
  if (input.length < compiled.length) return null;
  const head = input.subarray(0, compiled.length);
  if (compiled.equals(head)) return "full";
  if (!cbor) return null;
  const a = Buffer.from(compiled);
  const b = Buffer.from(head);
  let found = false;
  for (let at = a.indexOf(cbor); at >= 0; at = a.indexOf(cbor, at + 1)) {
    a.fill(0, at, at + cbor.length);
    b.fill(0, at, at + cbor.length);
    found = true;
  }
  return found && a.equals(b) ? "partial" : null;
}

/**
 * Matches one compiled contract with the chain. `given` are the constructor arguments the submitter sent (null when none): when the creation input is known they must be
 * what the creation input holds after the compiled creation code, else the submission is refused. Throws MatchFailure when the code does not match.
 */
export function matchCode(compiled: CompiledCode, onChain: OnChain, given: Buffer | null): Matched {
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
  const kind = compare(runtime, onChain.runtimeCode);
  if (!kind) throw new MatchFailure("runtime", "the runtime code does not match the code on chain");

  if (!onChain.creationInput) {
    return { kind, creationKind: null, constructorArgs: given && given.length > 0 ? given : null, libraries: libs };
  }
  const creation = toBytes(compiled.creation, compiled.creationLinks, "creation code");
  const input = onChain.creationInput;
  note(fill(creation, input, libPlaces(compiled.creationLinks), "library address", "libraries"));
  if (input.length < creation.length) throw new MatchFailure("short", "the creation input is shorter than the compiled creation code");
  const cbor = splitMetadata(runtime)?.cbor ?? splitMetadata(creation)?.cbor ?? null;
  const creationKind = compareCreation(creation, input, cbor);
  if (!creationKind) throw new MatchFailure("creation", "the creation code does not match the creation input on chain");
  const args = Buffer.from(input.subarray(creation.length));
  if (given && !given.equals(args)) {
    throw new MatchFailure("arguments", `the constructor arguments do not match the creation input on chain (it holds ${args.length} bytes after the creation code, the submission has ${given.length})`);
  }
  return { kind: kind === "full" && creationKind === "full" ? "full" : "partial", creationKind, constructorArgs: args.length > 0 ? args : null, libraries: libs };
}
