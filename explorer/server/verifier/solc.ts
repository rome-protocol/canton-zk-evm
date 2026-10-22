import type { CompilerStore } from "./compilers.ts";
import { SandboxError, type DockerSandbox } from "./sandbox.ts";

export interface Compiled {
  /** solc's standard JSON output, as it gave it (its own errors and warnings are in `errors`). */
  output: Record<string, unknown>;
  /** The version the compiler was asked for, as the list names it, and the hash of the binary that ran. */
  compiler: { version: string; sha256: string };
  ms: number;
}

/** The compiler store and the sandbox together: `compile` is the one call the verifier's jobs make. */
export class SolcRunner {
  private readonly store: CompilerStore;
  private readonly sandbox: DockerSandbox;
  constructor(store: CompilerStore, sandbox: DockerSandbox) {
    this.store = store;
    this.sandbox = sandbox;
  }

  /** Compiles standard JSON input with the given version, in the sandbox. A compile that solc itself reports errors for still returns: the errors are in the output. */
  async compile(version: string, input: object | string): Promise<Compiled> {
    const compiler = await this.store.get(version);
    const run = await this.sandbox.run(compiler.path, ["--standard-json"], typeof input === "string" ? input : JSON.stringify(input));
    let output: unknown;
    try { output = JSON.parse(run.stdout); } catch { output = null; }
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      throw new SandboxError("failed", `the compiler did not answer with standard JSON (exit ${run.exitCode}): ${(run.stderr || run.stdout).trim().slice(0, 300)}`, run.exitCode);
    }
    return { output: output as Record<string, unknown>, compiler: { version: compiler.version, sha256: compiler.sha256 }, ms: run.ms };
  }
}
