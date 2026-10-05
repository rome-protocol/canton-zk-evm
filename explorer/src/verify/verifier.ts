// Loads the WebAssembly build of the sidecar's block check (explorer/verify/) and runs it. The page
// calls this only when the visitor presses Verify. The answer is the sidecar's own line: `ok ...`
// or `no <reason>`.

/** A block record's three fields, as lowercase hex without 0x, exactly as /api/block gives them. */
export interface BlockFields { proofHex: string; headerHex: string; txsHex: string }
/** The two pins, as /api/status gives them: 0x and 64 hex digits each. */
export interface Pins { programVK: string; rootC: string }
/** Runs the check and returns the sidecar's answer line. */
export type Verifier = (block: BlockFields, pins: Pins) => string;

export type Answer =
  | { ok: true; programVK: string; rootC: string; blockHash: string; parentHash: string; number: string; stateRoot: string; timestamp: string; gasLimit: string; gasUsed: string; txCount: string }
  | { ok: false; reason: string };

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  verify_block(pins: number, line: number, len: number): number;
  answer_ptr(): number;
}

/** The 64 bytes the module takes: the program key, then the ZisK release root. */
export function pinBytes(pins: Pins): Uint8Array {
  const bytes = new Uint8Array(64);
  [pins.programVK, pins.rootC].forEach((pin, i) => {
    const m = /^(?:0x)?([0-9a-f]{64})$/i.exec(pin);
    if (!m) throw new Error("A pin must be 64 hex digits, with or without 0x.");
    for (let b = 0; b < 32; b++) bytes[i * 32 + b] = parseInt(m[1]!.slice(2 * b, 2 * b + 2), 16);
  });
  return bytes;
}

/** Loads the module from its bytes, or from a fetch of the .wasm file. */
export async function loadVerifier(source: BufferSource | Response | Promise<Response>): Promise<Verifier> {
  const wasm = source instanceof Response || source instanceof Promise
    ? await WebAssembly.instantiateStreaming(source, {})
    : await WebAssembly.instantiate(source, {});
  const x = wasm.instance.exports as unknown as Exports;
  if (!(x.memory instanceof WebAssembly.Memory) || typeof x.verify_block !== "function") throw new Error("This is not the verify module.");

  return (block, pins) => {
    const line = new TextEncoder().encode(`${block.proofHex},${block.headerHex},${block.txsHex}`);
    const p = x.alloc(64);
    const l = x.alloc(line.length);
    try {
      // Take the view after both allocations: the module's memory may have grown, which makes an older view useless.
      const memory = new Uint8Array(x.memory.buffer);
      memory.set(pinBytes(pins), p);
      memory.set(line, l);
      const len = x.verify_block(p, l, line.length);
      return new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.answer_ptr(), len));
    } finally {
      x.dealloc(p, 64);
      x.dealloc(l, line.length);
    }
  };
}

/** Reads the answer line: `ok` and ten facts, or `no` and the reason. */
export function parseAnswer(line: string): Answer {
  const [word, ...rest] = line.split(" ");
  if (word === "no" && rest.length > 0) return { ok: false, reason: rest.join(" ") };
  if (word === "ok" && rest.length === 10) {
    const [programVK, rootC, blockHash, parentHash, number, stateRoot, timestamp, gasLimit, gasUsed, txCount] = rest as [string, string, string, string, string, string, string, string, string, string];
    return { ok: true, programVK, rootC, blockHash, parentHash, number, stateRoot, timestamp, gasLimit, gasUsed, txCount };
  }
  throw new Error(`The check gave an answer that is not in its form: ${line}`);
}

/** The loaded check, and the size of the file it came from. */
export interface LoadedVerifier { verify: Verifier; bytes: number }

/** Downloads the .wasm file and loads it. `bytes` is the size of the file, for the panel to show. */
export async function fetchVerifier(url: string, fetcher: typeof fetch = fetch): Promise<LoadedVerifier> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`The check could not be downloaded (${res.status}).`);
  const file = new Uint8Array(await res.arrayBuffer());
  return { verify: await loadVerifier(file), bytes: file.length };
}
