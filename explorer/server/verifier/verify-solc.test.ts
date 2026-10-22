import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "../db/testing.ts";
import { CompilerStore } from "./compilers.ts";
import { FakeMirror } from "./fake-mirror.ts";
import { DockerSandbox } from "./sandbox.ts";
import { SolcRunner } from "./solc.ts";
import { Verifier, type Compile } from "./verify.ts";
import { addContract } from "./verify-fixtures.ts";
import type { VerifyRequest } from "./request.ts";

// Verification with the real compiler, in the real sandbox, against a database. The compiler is solc 0.8.28 (the one PINS names, taken out of the
// pinned image: EXPLORER_TEST_SOLC is the path of its static program), served by a mirror on this machine's loopback and run by the sandbox image.
// The "chain" is made from the compiler's own output the way a deployment makes it: the immutables' values in the runtime code, the arguments after the
// creation code. Needs the database, Docker and the program; EXPLORER_TEST_REQUIRE_SANDBOX=1 makes a missing one a failure.
const root = resolve(import.meta.dirname, "../../..");
const pins = readFileSync(join(root, "PINS"), "utf8");
const IMAGE = /^BUSYBOX_IMAGE=(\S+)$/m.exec(pins)![1]!;
const GATEWAY = /^GATEWAY_ADDRESS=(0x[0-9a-f]{40})$/m.exec(pins)![1]!;
const SOLC = process.env.EXPLORER_TEST_SOLC ?? join(root, "state/solc-0.8.28/solc");
const VERSION = "0.8.28+commit.7893614a";
let haveDocker = false;
try { execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { stdio: "pipe" }); haveDocker = true; } catch { /* skipped below */ }
const ready = Boolean(TEST_URL) && haveDocker && existsSync(SOLC);
if (process.env.EXPLORER_TEST_REQUIRE_SANDBOX === "1" && !ready) throw new Error("this run needs the database, Docker with the pinned sandbox image, and EXPLORER_TEST_SOLC");
checkRequired();
const suite = ready ? describe : describe.skip;

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
library MathLib { function twice(uint256 x) external pure returns (uint256) { return x * 2; } }
contract Box {
    uint256 public value;
    address public immutable maker;
    constructor(uint256 v) { value = v; maker = msg.sender; }
    function twice() external view returns (uint256) { return MathLib.twice(value); }
}
`;
const LIB = "0x" + "5f".repeat(20);
const MAKER = Buffer.concat([Buffer.alloc(12), Buffer.alloc(20, 0x77)]);

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const req = (address: string, extra: Partial<VerifyRequest> = {}): VerifyRequest => ({
  address, codeFormat: "solidity-single-file", sourceCode: SOURCE, contractName: "Box", compilerVersion: `v${VERSION}`, optimizationUsed: "1", runs: "200", evmVersion: "cancun", ...extra,
});

suite("verifying with the real compiler", { timeout: 240_000 }, () => {
  let db: TestDatabase;
  let dir: string;
  const mirror = new FakeMirror();
  let counted: Compile & { calls: number };
  let v: Verifier;
  let runner: SolcRunner;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "verifier-real-")));
    await mirror.start();
    mirror.entries = [{ longVersion: VERSION, body: readFileSync(SOLC) }];
    runner = new SolcRunner(
      new CompilerStore({ listUrl: mirror.url, userAgent: "Test test@example.invalid", cacheDir: join(dir, "cache") }),
      new DockerSandbox({ image: IMAGE, namePrefix: `explorer-verify-test-${randomBytes(4).toString("hex")}`, timeoutMs: 200_000 }),
    );
    db = await makeDatabase(true);
  });
  afterAll(async () => {
    await db?.drop();
    await mirror.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.pool.query("delete from contracts");
    await db.pool.query("delete from verified_sources");
    counted = { calls: 0, compile: (...a: Parameters<Compile["compile"]>) => { counted.calls++; return runner.compile(...a); } };
    v = new Verifier(db.pool, counted);
  });

  /** What a deployment of `source` makes: its creation input (with the arguments) and its runtime code (with the immutable's value), the libraries linked. */
  async function deployed(source: string, args: Buffer, libs: boolean): Promise<{ runtime: Buffer; input: Buffer }> {
    const settings: Record<string, unknown> = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } } };
    if (libs) settings.libraries = { "Box.sol": { MathLib: LIB } };
    const out = (await runner.compile(VERSION, { language: "Solidity", sources: { "Box.sol": { content: source } }, settings })).output as { contracts: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> } } }>> };
    const evm = out.contracts["Box.sol"]!["Box"]!.evm;
    const runtime = Buffer.from(evm.deployedBytecode.object, "hex");
    for (const spots of Object.values(evm.deployedBytecode.immutableReferences)) for (const s of spots) MAKER.copy(runtime, s.start, 0, s.length);
    return { runtime, input: Buffer.concat([Buffer.from(evm.bytecode.object, "hex"), args]) };
  }
  const arg = (n: number): Buffer => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
  const stored = async () => (await db.pool.query("select match_type, creation_match, encode(constructor_args, 'hex') args, libraries, evm_version, compiler_version from verified_sources order by id")).rows;

  it("verifies a single file as a full match, with the immutable, the library and the arguments", async () => {
    const d = await deployed(SOURCE, arg(42), true);
    await addContract(db.pool, A, d.runtime, d.input);
    const o = await v.verify(req(A, { libraries: [{ name: "MathLib", address: LIB }] }));
    expect(o).toMatchObject({ status: "pass", match: "full", creationMatch: "full" });
    const [row] = await stored();
    expect(row).toMatchObject({ match_type: "full", creation_match: "full", args: arg(42).toString("hex"), evm_version: "cancun", compiler_version: VERSION });
    expect(row.libraries).toEqual({ "Box.sol": { MathLib: LIB } });
  });

  it("takes the library's address from the chain when the request names none", async () => {
    const d = await deployed(SOURCE, arg(1), true);
    await addContract(db.pool, A, d.runtime, d.input);
    // The library setting is part of the metadata, so a request without it differs there: partial.
    expect(await v.verify(req(A))).toMatchObject({ status: "pass", match: "partial", creationMatch: "partial" });
    expect((await stored())[0].libraries).toEqual({ "Box.sol": { MathLib: LIB } });
  });

  it("refuses a library at another address than the one in the code", async () => {
    const d = await deployed(SOURCE, arg(1), true);
    await addContract(db.pool, A, d.runtime, d.input);
    const o = await v.verify(req(A, { libraries: [{ name: "MathLib", address: "0x" + "99".repeat(20) }] }));
    expect(o.status).toBe("fail");
    expect(await stored()).toHaveLength(0);
  });

  it("refuses the wrong constructor arguments, and accepts the right ones", async () => {
    const d = await deployed(SOURCE, arg(42), true);
    await addContract(db.pool, A, d.runtime, d.input);
    const bad = await v.verify(req(A, { constructorArguments: arg(43).toString("hex") }));
    expect(bad.status).toBe("fail");
    expect(bad.result).toMatch(/constructor arguments/);
    expect(await stored()).toHaveLength(0);
    expect((await v.verify(req(A, { constructorArguments: "0x" + arg(42).toString("hex") }))).status).toBe("pass");
  });

  it("is a partial match when the source differs only where the code does not show it", async () => {
    const onChain = SOURCE.replace("// SPDX", "// A comment that is not in the code.\n// SPDX");
    const d = await deployed(onChain, arg(7), true);
    await addContract(db.pool, A, d.runtime, d.input);
    expect(await v.verify(req(A))).toMatchObject({ status: "pass", match: "partial", creationMatch: "partial" });
    expect((await stored())[0]).toMatchObject({ match_type: "partial", creation_match: "partial", args: arg(7).toString("hex") });
  });

  it("refuses a source that is another contract", async () => {
    const d = await deployed(SOURCE, arg(7), true);
    await addContract(db.pool, A, d.runtime, d.input);
    const o = await v.verify(req(A, { sourceCode: SOURCE.replace("value = v;", "value = v + 1;") }));
    expect(o.status).toBe("fail");
    expect(o.result).toMatch(/does not match/);
  });

  it("gives a similar match to a clone, and answers 'already' without compiling again", async () => {
    const d = await deployed(SOURCE, arg(42), true);
    const other = await deployed(SOURCE, arg(43), true);
    expect(other.runtime.equals(d.runtime)).toBe(true);
    await addContract(db.pool, A, d.runtime, d.input);
    await addContract(db.pool, B, other.runtime, other.input);
    expect(await v.verify(req(A))).toMatchObject({ status: "pass", similar: 1 });
    expect((await db.pool.query("select match_type from contracts where address = $1", [Buffer.from(B.slice(2), "hex")])).rows[0].match_type).toBe("similar");
    const n = counted.calls;
    expect(await v.verify(req(A))).toEqual({ status: "already", result: "Already Verified" });
    expect(counted.calls).toBe(n);
  });

  it("verifies standard JSON, with the path:Name form of the contract name", async () => {
    const d = await deployed(SOURCE, arg(5), true);
    await addContract(db.pool, A, d.runtime, d.input);
    const json = JSON.stringify({ language: "Solidity", sources: { "Box.sol": { content: SOURCE } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", libraries: { "Box.sol": { MathLib: LIB } }, outputSelection: { "*": { "*": ["abi"] } } } });
    expect(await v.verify(req(A, { codeFormat: "solidity-standard-json-input", sourceCode: json, contractName: "Box.sol:Box" }))).toMatchObject({ status: "pass", match: "full" });
    expect((await db.pool.query("select code_format from verified_sources")).rows[0].code_format).toBe("solidity-standard-json-input");
  });

  it("verifies the gateway as a genesis contract, on its runtime code only, from the sources in gateway/", async () => {
    const runtime = Buffer.from(readFileSync(join(root, "gateway/Gateway.bin-runtime"), "utf8").trim(), "hex");
    await addContract(db.pool, GATEWAY, runtime, null);
    // The flags gateway/build.sh compiles with: Cancun, the optimizer at 200 runs, and no metadata hash at the end.
    const json = JSON.stringify({
      language: "Solidity", sources: { "Gateway.sol": { content: readFileSync(join(root, "gateway/Gateway.sol"), "utf8") } },
      settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, metadata: { appendCBOR: false } },
    });
    const o = await v.verify(req(GATEWAY, { codeFormat: "solidity-standard-json-input", sourceCode: json, contractName: "Gateway.sol:Gateway" }));
    expect(o).toMatchObject({ status: "pass", match: "full", creationMatch: null });
    const c = (await db.pool.query("select name, origin, match_type, creation_code_hash from contracts where address = $1", [Buffer.from(GATEWAY.slice(2), "hex")])).rows[0];
    expect(c).toMatchObject({ name: "Gateway", origin: "genesis", match_type: "full", creation_code_hash: null });
    expect((await stored())[0]).toMatchObject({ creation_match: null, args: null });
  });

  it("refuses the gateway from a single file with the metadata hash on: its code is different, not only its metadata", async () => {
    const runtime = Buffer.from(readFileSync(join(root, "gateway/Gateway.bin-runtime"), "utf8").trim(), "hex");
    await addContract(db.pool, GATEWAY, runtime, null);
    const o = await v.verify(req(GATEWAY, { sourceCode: readFileSync(join(root, "gateway/Gateway.sol"), "utf8"), contractName: "Gateway", runs: "200" }));
    expect(o.status).toBe("fail");
    expect(o.result).toMatch(/runtime code does not match/);
  });
});
