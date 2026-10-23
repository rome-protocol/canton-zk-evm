import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { CompilerStore } from "./compilers.ts";
import { DockerSandbox } from "./sandbox.ts";
import { SolcRunner } from "./solc.ts";

// The compiler of the REAL list, in the real sandbox image. The other tests serve a static compiler from a stand-in mirror; this one fetches what the verifier fetches in
// production (the official linux-amd64 build, which needs glibc's shared libraries) and runs it in PINS' SOLC_SANDBOX_IMAGE, so an image that cannot run it is caught here.
// It reaches the internet, so it runs only where EXPLORER_TEST_REAL_LIST=1 (the verifier-sandbox job sets it); it also needs Docker and the pinned image.
const pins = readFileSync(resolve(import.meta.dirname, "../../../PINS"), "utf8");
const IMAGE = /^SOLC_SANDBOX_IMAGE=(\S+)$/m.exec(pins)![1]!;
const LIST = process.env.EXPLORER_TEST_REAL_LIST_URL ?? "https://binaries.soliditylang.org/linux-amd64/list.json";
const VERSION = /^SOLC_VERSION=(\S+)$/m.exec(pins)![1]!;
let haveDocker = false;
try { execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { stdio: "pipe" }); haveDocker = true; } catch { /* skipped below */ }
const wanted = process.env.EXPLORER_TEST_REAL_LIST === "1";
const real = wanted && (haveDocker || process.env.EXPLORER_TEST_REQUIRE_SANDBOX === "1") ? describe : describe.skip;

real("the real compiler list in the sandbox image", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "verifier-real-list-")));
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  it("downloads the official compiler and compiles a contract with it", async () => {
    const store = new CompilerStore({ listUrl: LIST, userAgent: "Rome Protocol rome@romeprotocol.com", cacheDir: join(dir, "cache") });
    const runner = new SolcRunner(store, new DockerSandbox({ image: IMAGE, namePrefix: `explorer-real-list-${randomBytes(4).toString("hex")}`, timeoutMs: 120_000 }));
    const input = {
      language: "Solidity",
      sources: { "A.sol": { content: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract A { uint256 public x = 7; }" } },
      settings: { outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } } },
    };
    const a = await runner.compile(VERSION, input);
    const out = a.output as { contracts?: Record<string, Record<string, { evm: { deployedBytecode: { object: string } } }>>; errors?: unknown[] };
    expect(JSON.stringify(out.errors ?? [])).not.toMatch(/shared libraries/);
    expect(out.contracts?.["A.sol"]?.A?.evm.deployedBytecode.object.length ?? 0).toBeGreaterThan(20);
  }, 180_000);
});
