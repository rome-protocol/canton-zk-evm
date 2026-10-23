import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Why a run did not give an answer. `kind` is what the caller tells the job: a timeout, too much output, too much input, or a failure to run. */
export class SandboxError extends Error {
  readonly kind: "timeout" | "output-too-large" | "input-too-large" | "unavailable" | "failed";
  readonly exitCode: number | null;
  constructor(kind: SandboxError["kind"], message: string, exitCode: number | null = null) {
    super(message);
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

export interface SandboxOptions {
  /** The image the compiler runs in, by digest (PINS' SOLC_SANDBOX_IMAGE: the official linux-amd64 compilers need glibc's shared libraries, which busybox does not have). Never pulled by the sandbox. */
  image: string;
  dockerBin?: string;
  /** At most this long from the start of the run, the container's start included. */
  timeoutMs?: number;
  memoryBytes?: number;
  cpus?: number;
  tmpBytes?: number;
  maxPids?: number;
  /** Standard output and standard error together; a run that gives more is stopped. */
  maxOutputBytes?: number;
  maxInputBytes?: number;
  /** Containers are named `<prefix>-<random>`. */
  namePrefix?: string;
}

export interface RunResult { stdout: string; stderr: string; exitCode: number; ms: number }

const IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

/**
 * Runs one program in a container that has no network, a read-only filesystem apart from one temporary folder, a memory limit, one
 * CPU, a process limit, no capabilities, and an unprivileged user. The program is the compiler, mounted read-only; the input is written to its
 * standard input and the answer read from its standard output. One run is one container, removed (with its volumes) when the run ends,
 * however it ends. The image must be there already: `--pull never` keeps the sandbox from making an outside request.
 *
 * The compiler's file must be somewhere the Docker daemon can see at the same path (the compiler cache is a folder of this machine).
 */
export class DockerSandbox {
  private readonly o: Required<SandboxOptions>;

  constructor(opts: SandboxOptions) {
    if (!IMAGE.test(opts.image)) throw new SandboxError("failed", "the sandbox image must be named by digest (name@sha256:...)");
    this.o = { dockerBin: "docker", timeoutMs: 60_000, memoryBytes: 2 * 1024 ** 3, cpus: 1, tmpBytes: 256 * 1024 ** 2, maxPids: 128, maxOutputBytes: 16 * 1024 ** 2, maxInputBytes: 2 * 1024 ** 2, namePrefix: "explorer-sandbox", ...opts };
  }

  /** The `docker run` arguments for a container of this name: public so that a test can check every limit is asked for. */
  runArgs(name: string, binary: string, args: string[]): string[] {
    const o = this.o;
    // The compiler is run through `timeout`, a backstop that ends it inside the container even if this process is gone. The run's own timer is the exact one.
    const backstop = String(Math.ceil(o.timeoutMs / 1000) + 10);
    return [
      "run", "--rm", "--name", name, "-i", "--pull", "never",
      "--network", "none", "--read-only", "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${o.tmpBytes}`,
      "--memory", String(o.memoryBytes), "--memory-swap", String(o.memoryBytes), "--cpus", String(o.cpus), "--pids-limit", String(o.maxPids),
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--workdir", "/tmp",
      // A bind mount that fails when the file is not there: `-v` would make a root-owned folder at that path in the compiler cache.
      "--mount", `type=bind,src=${binary},dst=/solc,readonly`, "--entrypoint", "timeout", o.image, "-s", "KILL", backstop, "/solc", ...args,
    ];
  }

  private docker(args: string[]): Promise<{ code: number; out: string }> {
    return new Promise((ok) => {
      const p = spawn(this.o.dockerBin, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" } });
      let out = "";
      p.stdout.on("data", (c: Buffer) => { if (out.length < 4096) out += c.toString(); });
      p.stderr.on("data", (c: Buffer) => { if (out.length < 4096) out += c.toString(); });
      p.on("error", (e) => ok({ code: -1, out: e.message }));
      p.on("close", (code) => ok({ code: code ?? -1, out }));
    });
  }

  /** Whether the daemon answers and has the image: for the verifier's health row. */
  async check(): Promise<{ ok: boolean; detail: string }> {
    const r = await this.docker(["image", "inspect", "--format", "{{.Id}}", this.o.image]);
    return r.code === 0 ? { ok: true, detail: r.out.trim() } : { ok: false, detail: r.out.trim().slice(0, 300) || "docker did not answer" };
  }

  /**
   * Runs `binary args` with `stdin` as its input. Rejects with a SandboxError on a timeout, output or input over the cap, or a run that could not start.
   * When `signal` aborts, the container is stopped and removed, and the run rejects as a timeout.
   */
  async run(binary: string, args: string[], stdin: string, signal?: AbortSignal): Promise<RunResult> {
    if (!binary.startsWith("/") || /[,:\s]/.test(binary)) throw new SandboxError("failed", "the program's path must be absolute, without commas, colons or spaces");
    const input = Buffer.from(stdin);
    if (input.length > this.o.maxInputBytes) throw new SandboxError("input-too-large", `the input is ${input.length} bytes, over the limit of ${this.o.maxInputBytes}`);
    const name = `${this.o.namePrefix}-${randomBytes(8).toString("hex")}`;
    const started = Date.now();
    return new Promise<RunResult>((ok, fail) => {
      let child: ChildProcess;
      try {
        child = spawn(this.o.dockerBin, this.runArgs(name, binary, args), { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" } });
      } catch (e) { fail(new SandboxError("unavailable", `docker could not be started: ${(e as Error).message}`)); return; }
      const out: Buffer[] = [], err: Buffer[] = [];
      let size = 0, settled = false, timer: NodeJS.Timeout | undefined;
      const finish = (f: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        f();
      };
      // Ends the container by its own name: killing the docker client alone would leave the container running.
      const stop = (why: SandboxError): void => finish(() => {
        child.kill("SIGKILL");
        void this.docker(["rm", "-f", "-v", name]).then(() => fail(why));
      });
      timer = setTimeout(() => stop(new SandboxError("timeout", `the compiler ran for more than ${Math.round(this.o.timeoutMs / 1000)} s and was stopped`)), this.o.timeoutMs);
      if (signal) {
        const onAbort = (): void => stop(new SandboxError("timeout", "the job was stopped before the compiler finished"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const take = (into: Buffer[]) => (c: Buffer): void => {
        size += c.length;
        if (size > this.o.maxOutputBytes) { stop(new SandboxError("output-too-large", `the compiler gave more than ${this.o.maxOutputBytes} bytes of output and was stopped`)); return; }
        into.push(c);
      };
      child.stdout!.on("data", take(out));
      child.stderr!.on("data", take(err));
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(input);
      child.on("error", (e) => finish(() => fail(new SandboxError("unavailable", `docker could not be started: ${e.message}`))));
      child.on("close", (code) => finish(() => {
        const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8");
        // 125 to 127 are docker's own failures (it could not run the container or the program), not the program's.
        if (code === 125 || code === 126 || code === 127 || code === null) { fail(new SandboxError("unavailable", `the sandbox could not run the compiler: ${stderr.trim().slice(0, 300)}`, code)); return; }
        ok({ stdout, stderr, exitCode: code, ms: Date.now() - started });
      }));
    });
  }
}
