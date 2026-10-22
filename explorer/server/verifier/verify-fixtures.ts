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
    return { output: this.output, compiler: { version, sha256: "00".repeat(32) }, ms: 1 };
  }
}
export { CompilerError, SandboxError };

/** Standard JSON output for one contract, as the compiler gives it. */
export function outputFor(path: string, name: string, c: { creation: string; runtime: string; immutables?: object; runtimeLinks?: object; creationLinks?: object }): Record<string, unknown> {
  return {
    contracts: { [path]: { [name]: {
      abi: [{ type: "function", name: "get", inputs: [], outputs: [], stateMutability: "view" }], metadata: JSON.stringify({ language: "Solidity", version: 1 }),
      evm: { bytecode: { object: c.creation, linkReferences: c.creationLinks ?? {} }, deployedBytecode: { object: c.runtime, linkReferences: c.runtimeLinks ?? {}, immutableReferences: c.immutables ?? {} } },
    } } },
  };
}
