/**
 * Matching compiled code against the code on chain (design section 6.3, point 4), done by lib-sourcify (`@ethereum-sourcify/lib-sourcify`, MIT) and not by code of
 * ours: where the compiler's metadata sits in the code, what may differ in a partial match, and the match kinds (full, partial; creation and runtime) are the
 * library's. Hand-written position logic let forged code through twice, so none is left here.
 *
 * What is ours: the compiler the library runs (the pinned, verified binary in the sandbox, through `SandboxSolc`), and the chain it reads (`ChainOfRows`: the
 * runtime code and the creation input the indexer stored, so that nothing leaves the machine at verify time). The library recompiles with the edited source
 * to find the metadata positions, so one verification is two or three compiles in the sandbox, one after another.
 *
 * The rules on top of the library's answer: the runtime code must match; a contract with a creation input must match on it too (a creation input whose
 * trailing bytes are not ABI-encoded constructor arguments is refused); the arguments the submitter sent must be the ones on chain; a library stands at the same
 * address in the runtime and the creation code; and a match is `full` only when everything that was compared is a full match.
 */
import {
  AbstractCompilation, findContractInCompilerOutput, SolidityCompilation, Verification, setLibSourcifyLoggerLevel,
  type ISolidityCompiler, type SourcifyChain,
} from "@ethereum-sourcify/lib-sourcify";
import type { SolidityJsonInput, SolidityOutput, SolidityOutputContract } from "@ethereum-sourcify/compilers-types";
// The library's own two functions that find the auxdata in the compiler's output and in the code (not exported by its index; the version is pinned).
import { findAuxdatasInLegacyAssembly, findAuxdataPositions } from "@ethereum-sourcify/lib-sourcify/build/main/Compilation/auxdataUtils.js";
import { compilerErrors } from "./request.ts";
import type { Compile } from "./verify.ts";

// The library logs through its own logger: only its errors are wanted here.
setLibSourcifyLoggerLevel(0);

export type MatchKind = "full" | "partial";

export interface OnChain {
  runtimeCode: Buffer;
  /** The creation input (a transaction's input, or the init code of a factory's creation); null for a genesis contract or when it is not known. */
  creationInput: Buffer | null;
}

export interface Matched {
  kind: MatchKind;
  /** How the creation code matched; null when there is no creation input to compare. */
  creationKind: MatchKind | null;
  /** The ABI-encoded arguments after the compiled creation code; null when there are none, and for a contract with no creation input. */
  constructorArgs: Buffer | null;
  /** The library addresses in the code, by source file and name, as 0x addresses. */
  libraries: Record<string, Record<string, string>>;
  /** What the library verified: the sources it kept (the ones the match needs), the ABI and the compiler's metadata of the contract. */
  sources: Record<string, string>;
  abi: unknown[];
  metadata: Record<string, unknown> | null;
}

/** A submission that does not match: `reason` is for the person who submitted it. */
export class MatchFailure extends Error {
  readonly code: "runtime" | "creation" | "arguments" | "libraries" | "compile" | "target";
  constructor(code: MatchFailure["code"], reason: string) {
    super(reason);
    this.code = code;
  }
}

/** The compiler the library runs: the verifier's own (the pinned binary, in the sandbox). Its first failure and its first report of solc's errors are kept for the caller. */
export class SandboxSolc implements ISolidityCompiler {
  /** The first error the compile or the sandbox threw (a CompilerError or a SandboxError, or the abort), for the caller to name; the library hides it in its own errors. */
  failure: unknown = null;
  /** solc's own errors, as one text, when its output had some. */
  reported: string | null = null;
  /** The compiler that ran, as the list names it. */
  version: string | null = null;
  private readonly runner: Compile;
  private readonly signal: AbortSignal | undefined;
  constructor(runner: Compile, signal?: AbortSignal) {
    this.runner = runner;
    this.signal = signal;
  }
  async compile(version: string, input: SolidityJsonInput): Promise<SolidityOutput> {
    try {
      const c = await this.runner.compile(version, input, this.signal);
      this.version ??= c.compiler.version;
      const errors = compilerErrors(c.output);
      if (errors) { this.reported ??= errors; throw new Error(errors); }
      return c.output as unknown as SolidityOutput;
    } catch (e) {
      this.failure ??= e;
      throw e;
    }
  }
}

/**
 * The library's SolidityCompilation, with one change: where the metadata sits is always found by compiling twice (the source with a space added at the end of
 * each file has other hashes, so the bytes that differ between the two outputs are the hashes) and never from the end of the creation code. The library takes
 * the end of the creation code when the compiler lists one auxdata, but a constructor's data (a bytes literal, written by the submitter) can end the creation
 * code shaped like metadata, and the bytes it names would then be left out of the comparison. A literal is the same in both compiles, so it never shows as a difference.
 * Without a compile that lists auxdata (`appendCBOR` false, or a compiler before 0.4.12) there is none: the code must be equal byte for byte, and is a partial match.
 */
class DiffedCompilation extends SolidityCompilation {
  override async generateCborAuxdataPositions(forceEmscripten = false): Promise<void> {
    const real = findAuxdatasInLegacyAssembly((this.contractCompilerOutput as SolidityOutputContract).evm.legacyAssembly);
    if (real.length === 0) {
      this._creationBytecodeCborAuxdata = {};
      this._runtimeBytecodeCborAuxdata = {};
      return;
    }
    const output = await this.generateEditedContract({ version: this.compilerVersion, solcJsonInput: this.jsonInput, forceEmscripten });
    const edited = findContractInCompilerOutput(output, this.compilationTarget) as SolidityOutputContract;
    const editedAuxdata = findAuxdatasInLegacyAssembly(edited.evm.legacyAssembly);
    this._runtimeBytecodeCborAuxdata = findAuxdataPositions(this.runtimeBytecode, `0x${edited.evm.deployedBytecode.object}`, real, editedAuxdata);
    this._creationBytecodeCborAuxdata = findAuxdataPositions(this.creationBytecode, `0x${edited.evm.bytecode.object}`, real, editedAuxdata);
  }
}

/** The chain as the library reads it: one contract, from the rows the indexer stored. Nothing is fetched. */
function chainOfRows(on: OnChain): SourcifyChain {
  const hex = (b: Buffer): string => "0x" + b.toString("hex");
  return {
    chainId: 0,
    getBytecode: async () => hex(on.runtimeCode),
    getTx: async () => ({ blockNumber: 0, from: "0x" + "00".repeat(20) }),
    getContractCreationBytecodeAndReceipt: async () => ({ creationBytecode: hex(on.creationInput ?? Buffer.alloc(0)), txReceipt: { index: 0 } }),
  } as unknown as SourcifyChain;
}

const ZERO_TX = "0x" + "00".repeat(32);
const ADDRESS = "0x" + "00".repeat(20);

/**
 * Verifies `input` (standard JSON, as prepared) with the library: compiles it in the sandbox through `solc`, matches `target` against `on`. `given` are the constructor
 * arguments the submitter sent (null when none). Throws MatchFailure when the code does not match.
 */
export async function matchWithSourcify(
  solc: SandboxSolc, version: string, input: SolidityJsonInput, target: { path: string; name: string }, on: OnChain, given: Buffer | null,
): Promise<Matched> {
  const compilation = new DiffedCompilation(solc, version, input, target);
  const verification = new Verification(compilation, chainOfRows(on), ADDRESS, on.creationInput ? ZERO_TX : undefined);
  try {
    await verification.verify();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (solc.reported) throw new MatchFailure("compile", solc.reported);
    if (code === "contract_not_found_in_compiler_output") throw new MatchFailure("target", `the compiler output has no contract ${target.path}:${target.name}`);
    if (code === "compiled_bytecode_is_zero") throw new MatchFailure("target", `${target.name} has no code (an interface or an abstract contract cannot be deployed)`);
    if (code === "no_match" || code === "bytecode_length_mismatch") throw new MatchFailure("runtime", "the runtime code does not match the code on chain");
    if (solc.failure) throw solc.failure;
    if (code === "extra_file_input_bug") throw new MatchFailure("runtime", "the runtime code does not match the code on chain, though the metadata hash does: the input holds files that the contract does not use, and they change the code (remove them)");
    throw new MatchFailure("runtime", `the code could not be matched with the code on chain (${code ?? (e as Error).message})`);
  }
  // A compile that the library gave up on (the edited source) is not a mismatch of the submitter's: the caller tries again.
  if (solc.failure) throw solc.failure;
  const { runtimeMatch, creationMatch } = verification.status;
  const kindOf = (s: string | null): MatchKind | null => (s === "perfect" ? "full" : s === "partial" ? "partial" : null);
  const runtime = kindOf(runtimeMatch);
  if (!runtime) throw new MatchFailure("runtime", "the runtime code does not match the code on chain");
  const creation = on.creationInput ? kindOf(creationMatch) : null;
  if (on.creationInput && !creation) throw new MatchFailure("creation", "the creation code does not match the creation input on chain (or what follows it is not the ABI-encoded constructor arguments)");

  const t = verification.transformations;
  const libraries: Record<string, Record<string, string>> = {};
  const note = (fqn: string, address: string): void => {
    const c = fqn.lastIndexOf(":");
    const file = fqn.slice(0, c);
    const name = fqn.slice(c + 1);
    const had = libraries[file]?.[name];
    if (had && had.toLowerCase() !== address.toLowerCase()) throw new MatchFailure("libraries", `the library ${name} stands at ${had} in one code and at ${address} in the other`);
    (libraries[file] ??= {})[name] = address;
  };
  for (const part of [t.runtime.values, t.creation.values]) for (const [fqn, a] of Object.entries(part?.libraries ?? {})) note(fqn, a as string);

  let args: Buffer | null = null;
  if (on.creationInput) {
    const hexArgs = t.creation.values?.constructorArguments as string | undefined;
    args = hexArgs && hexArgs !== "0x" ? Buffer.from(hexArgs.replace(/^0x/, ""), "hex") : null;
    if (given && !given.equals(args ?? Buffer.alloc(0))) {
      throw new MatchFailure("arguments", `the constructor arguments do not match the creation input on chain (it holds ${args?.length ?? 0} bytes after the creation code, the submission has ${given.length})`);
    }
  }
  const c = verification.compilation as AbstractCompilation;
  return {
    kind: runtime === "full" && (creation === null || creation === "full") ? "full" : "partial",
    creationKind: creation, constructorArgs: args, libraries,
    sources: c.sources, abi: (c.contractCompilerOutput.abi as unknown[] | undefined) ?? [], metadata: (c.metadata as Record<string, unknown> | undefined) ?? null,
  };
}
