/** For the verifier's tests: contracts in a test database, and a counting stand-in for the compiler. */
import type { Pool } from "pg";
import { keccak256 } from "viem";
import { CompilerError } from "./compilers.ts";
import { SandboxError } from "./sandbox.ts";
import type { Compile } from "./verify.ts";
import type { Compiled } from "./solc.ts";

export const hexOf = (b: Buffer): string => b.toString("hex");
export const hashOf = (b: Buffer): Buffer => Buffer.from(keccak256(b).slice(2), "hex");

/** A contract row: a contract that a transaction made (with its creation input), or, with no creation input, a genesis contract. */
export async function addContract(pool: Pool, address: string, runtime: Buffer, creation: Buffer | null): Promise<void> {
  await pool.query("insert into bytecodes (code_hash, code, size) values ($1, $2, $3) on conflict do nothing", [hashOf(runtime), runtime, runtime.length]);
  if (creation) await pool.query("insert into bytecodes (code_hash, code, size) values ($1, $2, $3) on conflict do nothing", [hashOf(creation), creation, creation.length]);
  if (creation) {
    await pool.query(
      `insert into contracts (address, origin, creator, creation_block, creation_tx_index, creation_trace_address, runtime_code_hash, creation_code_hash)
       values ($1, 'create', $2, 5, 0, '{}', $3, $4)`,
      [Buffer.from(address.slice(2), "hex"), Buffer.alloc(20, 1), hashOf(runtime), hashOf(creation)],
    );
  } else {
    await pool.query("insert into contracts (address, origin, runtime_code_hash) values ($1, 'genesis', $2)", [Buffer.from(address.slice(2), "hex"), hashOf(runtime)]);
  }
}

/** The compiler stand-in: gives `output` (or throws `fail`) and counts its calls. */
export class StubCompile implements Compile {
  calls = 0;
  inputs: unknown[] = [];
  output: Record<string, unknown> = {};
  fail: Error | null = null;
  async compile(version: string, input: object | string): Promise<Compiled> {
    this.calls++;
    this.inputs.push(input);
    if (this.fail) throw this.fail;
    // The library finds where the metadata is by compiling the source again with a space added at the end of each file: the output of that compile has other hashes.
    const sources = ((typeof input === "string" ? JSON.parse(input) : input) as { sources?: Record<string, { content: string }> }).sources ?? {};
    const edited = Object.values(sources).some((s) => s.content.endsWith(" "));
    return { output: edited ? editedOutput(this.output) : this.output, compiler: { version, sha256: "00".repeat(32) }, ms: 1 };
  }
}
export { CompilerError, SandboxError };

/** The auxdata (the CBOR map and its two length bytes) at the end of a made-up runtime code, as hex; null when it does not end in one that solc would write. */
function auxdataOf(runtime: string): string | null {
  const b = Buffer.from(runtime, "hex");
  if (b.length < 2) return null;
  const n = b.readUInt16BE(b.length - 2) + 2;
  if (n > b.length) return null;
  const tail = b.subarray(b.length - n).toString("hex");
  return tail.startsWith("a2") && tail.includes("64736f6c63") ? tail : null;
}

/** Standard JSON output for one contract, as the compiler gives it, with the auxdata that solc lists in `legacyAssembly` (the end of the runtime code, when it has a CBOR there). */
export function outputFor(path: string, name: string, c: { creation: string; runtime: string; immutables?: object; runtimeLinks?: object; creationLinks?: object; /** false: the compile appended no metadata (the output lists no auxdata) */ auxdata?: boolean }): Record<string, unknown> {
  const aux = c.auxdata === false ? null : auxdataOf(c.runtime);
  return {
    contracts: { [path]: { [name]: {
      abi: [{ type: "constructor", inputs: [{ type: "uint256", name: "v" }], stateMutability: "nonpayable" }, { type: "function", name: "get", inputs: [], outputs: [], stateMutability: "view" }],
      metadata: JSON.stringify({ language: "Solidity", version: 1 }),
      evm: {
        legacyAssembly: aux ? { ".code": [], ".data": { "0": { ".auxdata": aux } } } : { ".code": [] },
        bytecode: { object: c.creation, linkReferences: c.creationLinks ?? {} }, deployedBytecode: { object: c.runtime, linkReferences: c.runtimeLinks ?? {}, immutableReferences: c.immutables ?? {} },
      },
    } } },
  };
}

/** What the compiler gives for the same source with a space added at the end: the same code, with other hashes in the auxdata. */
export function editedOutput(output: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(output)) as { contracts: Record<string, Record<string, { evm: { legacyAssembly: { ".data"?: Record<string, { ".auxdata": string }> }; bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  for (const byName of Object.values(out.contracts ?? {})) {
    for (const c of Object.values(byName)) {
      const aux = c.evm.legacyAssembly[".data"]?.["0"]?.[".auxdata"];
      if (!aux) continue;
      const other = aux.slice(0, 24) + (aux.slice(24, 26) === "ee" ? "dd" : "ee") + aux.slice(26);
      c.evm.legacyAssembly[".data"]!["0"]![".auxdata"] = other;
      c.evm.bytecode.object = c.evm.bytecode.object.split(aux).join(other);
      c.evm.deployedBytecode.object = c.evm.deployedBytecode.object.split(aux).join(other);
    }
  }
  return out;
}
