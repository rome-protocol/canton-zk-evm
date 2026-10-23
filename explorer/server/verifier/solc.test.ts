import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompilerStore } from "./compilers.ts";
import { FakeMirror } from "./fake-mirror.ts";
import { DockerSandbox, SandboxError } from "./sandbox.ts";
import { SolcRunner } from "./solc.ts";

// The store and the sandbox together, with compilers that are shell scripts served by a mirror on this machine's loopback: the compiler is
// downloaded, checked and cached by the store, and run by a real container. Needs Docker and the pinned image (see sandbox.test.ts).
const pins = readFileSync(resolve(import.meta.dirname, "../../../PINS"), "utf8");
const IMAGE = /^SOLC_SANDBOX_IMAGE=(\S+)$/m.exec(pins)![1]!;
let haveDocker = false;
try { execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { stdio: "pipe" }); haveDocker = true; } catch { /* skipped below */ }
const real = haveDocker || process.env.EXPLORER_TEST_REQUIRE_SANDBOX === "1" ? describe : describe.skip;

const script = (body: string): Buffer => Buffer.from(`#!/bin/sh\n${"# padding\n".repeat(200)}${body}\n`);
const V = (n: number): string => `0.8.${n}+commit.0000000${n % 10}`;

real("the compiler store with the sandbox", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "verifier-solc-")));
  const mirror = new FakeMirror();
  const prefix = `explorer-sandbox-test-${randomBytes(4).toString("hex")}`;
  beforeAll(async () => { await mirror.start(); });
  afterAll(async () => {
    await mirror.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const runner = (extra: Record<string, unknown> = {}): SolcRunner =>
    new SolcRunner(new CompilerStore({ listUrl: mirror.url, userAgent: "Test test@example.invalid", cacheDir: join(dir, "cache") }), new DockerSandbox({ image: IMAGE, namePrefix: prefix, ...extra }));

  it("downloads a compiler, caches it, and compiles the input with it", async () => {
    mirror.entries = [{ longVersion: V(28), body: script(`cat >/dev/null\necho '{"contracts":{"a.sol":{"A":{"evm":{"deployedBytecode":{"object":"6080"}}}}}}'`) }];
    const r = runner();
    const a = await r.compile(`v${V(28)}`, { language: "Solidity", sources: { "a.sol": { content: "x" } } });
    expect(JSON.stringify(a.output)).toContain("6080");
    expect(a.compiler.version).toBe(V(28));
    await r.compile(V(28), "{}");
    expect(mirror.downloads()).toBe(1);
  });

  it("sends the input to the compiler, and returns what it answers", async () => {
    mirror.entries = [{ longVersion: V(29), body: script(`printf '{"errors":[],"received":%s}' "$(wc -c)"`) }];
    const a = await runner().compile(V(29), { language: "Solidity" });
    expect(a.output).toEqual({ errors: [], received: 23 });
  });

  it("refuses a compiler whose download is not what the list says, and runs nothing", async () => {
    mirror.entries = [{ longVersion: V(30), body: script("echo ran >&2"), sha256: "ab".repeat(32) }];
    await expect(runner().compile(V(30), "{}")).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(dir, "cache", "bin", "ab".repeat(32)))).toBe(false);
  });

  it("stops a compile over the time limit", async () => {
    mirror.entries = [{ longVersion: V(31), body: script("sleep 60") }];
    const e = await runner({ timeoutMs: 2000 }).compile(V(31), "{}").then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxError);
    expect((e as SandboxError).kind).toBe("timeout");
  });

  it("refuses a compile whose output is over the cap", async () => {
    mirror.entries = [{ longVersion: V(32), body: script("yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }];
    const e = await runner({ maxOutputBytes: 100_000 }).compile(V(32), "{}").then(() => null, (x: unknown) => x);
    expect((e as SandboxError).kind).toBe("output-too-large");
  });

  it("fails a compile that tries to reach the network", async () => {
    mirror.entries = [{ longVersion: V(33), body: script(`cat >/dev/null\nif wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; then echo '{"reached":true}'; else echo '{"reached":false}'; fi`) }];
    const a = await runner().compile(V(33), "{}");
    expect(a.output).toEqual({ reached: false });
  });

  it("fails when the compiler does not answer with JSON", async () => {
    mirror.entries = [{ longVersion: V(34), body: script("echo not json; exit 1") }];
    await expect(runner().compile(V(34), "{}")).rejects.toThrow(/standard JSON/);
  });
});
