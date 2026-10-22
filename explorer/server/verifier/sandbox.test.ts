import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox, SandboxError } from "./sandbox.ts";

const IMAGE = "docker.invalid/busybox@sha256:" + "0".repeat(64);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "verifier-sandbox-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the docker program: records every call in a log and then does what the run's body says. */
function fakeDocker(name: string, runBody: string): { bin: string; log: () => string[] } {
  const bin = join(dir, name), logFile = join(dir, `${name}.log`);
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${logFile}'\ncase "$1" in\n  run) ${runBody} ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(bin, 0o755);
  return { bin, log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : []) };
}
const nameOf = (line: string): string => /--name (\S+)/.exec(line)![1]!;
const failing = async (p: Promise<unknown>): Promise<SandboxError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(SandboxError);
  return e as SandboxError;
};

describe("the run command", () => {
  const args = new DockerSandbox({ image: IMAGE }).runArgs("n1", "/c/solc", ["--standard-json"]).join(" ");
  it("asks for every limit", () => {
    for (const want of ["--network none", "--read-only", "--memory 2147483648", "--memory-swap 2147483648", "--cpus 1", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 65534:65534", "--pull never", "--rm", "--pids-limit 128"])
      expect(args).toContain(want);
    expect(args).toMatch(/--tmpfs \/tmp:rw,noexec,nosuid,nodev,size=\d+/);
    expect(args).toContain("-v /c/solc:/solc:ro");
    expect(args).toMatch(/--entrypoint timeout \S+@sha256:0+ -s KILL 70 \/solc --standard-json$/);
  });
  it("gives the container no network and no published port, whatever the settings", () => {
    const loose = new DockerSandbox({ image: IMAGE, memoryBytes: 1, cpus: 4, timeoutMs: 5000 }).runArgs("n2", "/c/solc", []).join(" ");
    expect(loose).toContain("--network none");
    expect(loose).not.toMatch(/ -p | --publish|--privileged|--network host/);
  });
  it("refuses an image that is not named by digest", () => {
    expect(() => new DockerSandbox({ image: "busybox:latest" })).toThrow(/digest/);
  });
  it("refuses a program path that could add a mount option", async () => {
    const s = new DockerSandbox({ image: IMAGE, dockerBin: "/nonexistent" });
    expect((await failing(s.run("/c/solc,rw", [], ""))).kind).toBe("failed");
    expect((await failing(s.run("relative/solc", [], ""))).kind).toBe("failed");
  });
});

describe("a run, with a stand-in for docker", () => {
  it("gives the output and the exit code, and sends the input", async () => {
    const d = fakeDocker("echo", "cat; echo err >&2; exit 3");
    const r = await new DockerSandbox({ image: IMAGE, dockerBin: d.bin }).run("/c/solc", ["--standard-json"], "hello");
    expect(r).toMatchObject({ stdout: "hello", stderr: "err\n", exitCode: 3 });
  });
  it("reports docker's own failure as unavailable", async () => {
    const d = fakeDocker("nodaemon", "echo 'Cannot connect to the Docker daemon' >&2; exit 125");
    const e = await failing(new DockerSandbox({ image: IMAGE, dockerBin: d.bin }).run("/c/solc", [], ""));
    expect(e.kind).toBe("unavailable");
    expect(e.message).toContain("Docker daemon");
    expect((await failing(new DockerSandbox({ image: IMAGE, dockerBin: join(dir, "missing") }).run("/c/solc", [], ""))).kind).toBe("unavailable");
  });
  it("stops a run over the time limit, and removes its container by name", async () => {
    const d = fakeDocker("slow", "exec sleep 30");
    const t = Date.now();
    const e = await failing(new DockerSandbox({ image: IMAGE, dockerBin: d.bin, timeoutMs: 300 }).run("/c/solc", [], "x"));
    expect(e.kind).toBe("timeout");
    expect(Date.now() - t).toBeLessThan(5000);
    const log = d.log();
    expect(log[1]).toBe(`rm -f -v ${nameOf(log[0]!)}`);
  });
  it("stops a run that gives more output than the cap, and removes its container", async () => {
    const d = fakeDocker("flood", "exec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const e = await failing(new DockerSandbox({ image: IMAGE, dockerBin: d.bin, maxOutputBytes: 100_000, timeoutMs: 20_000 }).run("/c/solc", [], ""));
    expect(e.kind).toBe("output-too-large");
    const log = d.log();
    expect(log[1]).toBe(`rm -f -v ${nameOf(log[0]!)}`);
  });
  it("refuses an input over the cap before it starts anything", async () => {
    const d = fakeDocker("never", "exit 0");
    const e = await failing(new DockerSandbox({ image: IMAGE, dockerBin: d.bin, maxInputBytes: 10 }).run("/c/solc", [], "x".repeat(11)));
    expect(e.kind).toBe("input-too-large");
    expect(d.log()).toEqual([]);
  });
  it("accepts output just under the cap", async () => {
    const d = fakeDocker("under", "head -c 900 /dev/zero | tr '\\0' a");
    const r = await new DockerSandbox({ image: IMAGE, dockerBin: d.bin, maxOutputBytes: 1000 }).run("/c/solc", [], "");
    expect(r.stdout.length).toBe(900);
  });
});

// The real thing: a throwaway compiler (a shell script, which the pinned image can run) in a real container. These need Docker and the image
// that PINS pins for the sandbox. A job that must run them sets EXPLORER_TEST_REQUIRE_SANDBOX=1, so that a missing Docker fails instead of skipping.
const pins = readFileSync(resolve(import.meta.dirname, "../../../PINS"), "utf8");
const REAL_IMAGE = /^BUSYBOX_IMAGE=(\S+)$/m.exec(pins)![1]!;
let haveDocker = false;
try { execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", REAL_IMAGE], { stdio: "pipe" }); haveDocker = true; } catch { /* skipped below */ }
const REQUIRED = process.env.EXPLORER_TEST_REQUIRE_SANDBOX === "1";
const real = haveDocker || REQUIRED ? describe : describe.skip;

real("a run in a real container", () => {
  const prefix = `explorer-sandbox-test-${randomBytes(4).toString("hex")}`;
  const sandbox = (extra: Record<string, unknown> = {}): DockerSandbox => new DockerSandbox({ image: REAL_IMAGE, namePrefix: prefix, ...extra });
  const program = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const leftovers = (): string => execFileSync("docker", ["ps", "-a", "-q", "--filter", `name=${prefix}`], { encoding: "utf8" }).trim();
  beforeAll(() => { expect(haveDocker, "Docker and the pinned image are needed").toBe(true); });
  afterAll(() => { if (haveDocker) for (const id of leftovers().split("\n").filter(Boolean)) execFileSync("docker", ["rm", "-f", "-v", id]); });

  it("runs the program with its input and gives its output", async () => {
    const r = await sandbox().run(program("cat", "cat; echo done >&2"), [], "{\"a\":1}");
    expect(r).toMatchObject({ stdout: "{\"a\":1}", stderr: "done\n", exitCode: 0 });
    expect(leftovers()).toBe("");
  });

  it("has no network: no route out exists, and a request to an outside address fails", async () => {
    const body = "echo tools: $(command -v wget >/dev/null && echo wget-present)\necho routes: $(tail -n +2 /proc/net/route | wc -l)\nif wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; then echo REACHED; else echo NOT-REACHED; fi";
    const r = await sandbox().run(program("net", body), [], "");
    expect(r.stdout).toContain("tools: wget-present");
    expect(r.stdout).toContain("routes: 0\n");
    expect(r.stdout).toContain("NOT-REACHED");
    expect(r.stdout).not.toMatch(/(^|\n)REACHED/);
  });

  it("has a read-only filesystem apart from the temporary folder, and runs as nobody", async () => {
    const body = "echo uid: $(id -u)\necho x > /etc/x 2>/dev/null && echo ETC-WRITABLE || echo etc-readonly\necho x > /solc 2>/dev/null && echo SOLC-WRITABLE || echo solc-readonly\necho x > /tmp/ok && echo tmp-writable";
    const r = await sandbox().run(program("fs", body), [], "");
    expect(r.stdout).toContain("uid: 65534");
    expect(r.stdout).toContain("etc-readonly");
    expect(r.stdout).toContain("solc-readonly");
    expect(r.stdout).toContain("tmp-writable");
    expect(r.stdout).not.toMatch(/WRITABLE/);
  });

  it("sees none of this process's environment", async () => {
    process.env.VERIFIER_TEST_SECRET = "s3cret";
    try {
      const r = await sandbox().run(program("env", "env"), [], "");
      expect(r.stdout).not.toContain("s3cret");
    } finally { delete process.env.VERIFIER_TEST_SECRET; }
  });

  it("stops a compile over the time limit and leaves no container", async () => {
    const t = Date.now();
    const e = await failing(sandbox({ timeoutMs: 2000 }).run(program("slow", "sleep 60"), [], ""));
    expect(e.kind).toBe("timeout");
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(leftovers()).toBe("");
  });

  it("stops a compile whose output is over the cap and leaves no container", async () => {
    const e = await failing(sandbox({ maxOutputBytes: 200_000, timeoutMs: 30_000 }).run(program("flood", "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), [], ""));
    expect(e.kind).toBe("output-too-large");
    expect(leftovers()).toBe("");
  });

  it("kills a compile that takes more memory than it may", async () => {
    const r = await sandbox({ memoryBytes: 64 * 1024 ** 2 }).run(program("hog", "x=$(head -c 400000000 /dev/zero | tr '\\0' a)\necho survived"), [], "");
    expect(r.stdout).not.toContain("survived");
    expect(r.exitCode).not.toBe(0);
  });

  it("reports a missing image as unavailable, and never pulls it", async () => {
    const e = await failing(new DockerSandbox({ image: "docker.invalid/none@sha256:" + "1".repeat(64), namePrefix: prefix }).run(program("x", "true"), [], ""));
    expect(e.kind).toBe("unavailable");
  });

  it("check() says whether the image is there", async () => {
    expect((await sandbox().check()).ok).toBe(true);
    expect((await new DockerSandbox({ image: "docker.invalid/none@sha256:" + "1".repeat(64) }).check()).ok).toBe(false);
  });
});
