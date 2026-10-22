import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "../db/testing.ts";
import { CompilerStore } from "./compilers.ts";
import { FakeMirror } from "./fake-mirror.ts";
import { reservedAddresses, seedGateway } from "./gateway.ts";
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
    expect(await v.verify(req(A, { libraries: [{ name: "MathLib", address: LIB }] }))).toMatchObject({ status: "pass", match: "full", similar: 1 });
    expect((await db.pool.query("select match_type from contracts where address = $1", [Buffer.from(B.slice(2), "hex")])).rows[0].match_type).toBe("similar");
    const n = counted.calls;
    expect(await v.verify(req(A, { libraries: [{ name: "MathLib", address: LIB }] }))).toEqual({ status: "already", result: "Already Verified" });
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
    // The gateway has no metadata hash (--no-cbor-metadata): nothing pins its source, so the match is partial, never full.
    expect(o).toMatchObject({ status: "pass", match: "partial", creationMatch: null });
    const c = (await db.pool.query("select name, origin, match_type, creation_code_hash from contracts where address = $1", [Buffer.from(GATEWAY.slice(2), "hex")])).rows[0];
    expect(c).toMatchObject({ name: "Gateway", origin: "genesis", match_type: "partial", creation_code_hash: null });
    expect((await stored())[0]).toMatchObject({ creation_match: null, args: null });
  });

  describe("the gateway's source, published by the deployment", () => {
    const g = { address: GATEWAY, sourceFile: join(root, "gateway/Gateway.sol"), compiler: "0.8.28" };
    const forged = readFileSync(g.sourceFile, "utf8").replace("contract Gateway", "/// @notice OFFICIAL REFUND ADDRESS: send funds to 0x000000000000000000000000000000000000dEaD\ncontract Gateway");
    const claim = req(GATEWAY, {
      codeFormat: "solidity-standard-json-input", contractName: "Gateway.sol:Gateway",
      sourceCode: JSON.stringify({ language: "Solidity", sources: { "Gateway.sol": { content: forged } }, settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, metadata: { appendCBOR: false } } }),
    });
    const gatewayRuntime = (): Buffer => Buffer.from(readFileSync(join(root, "gateway/Gateway.bin-runtime"), "utf8").trim(), "hex");

    it("reserves the gateway's address, and only that", () => {
      expect(reservedAddresses(g)).toEqual([GATEWAY]);
      expect(reservedAddresses(null)).toEqual([]);
    });

    it("waits while the gateway is not in the index, then verifies it from gateway/ with the compiler, and stays done", async () => {
      const guarded = new Verifier(db.pool, counted, undefined, reservedAddresses(g));
      expect(await seedGateway(db.pool, guarded, g)).toBe("waiting");
      await addContract(db.pool, GATEWAY, gatewayRuntime(), null);
      expect(await seedGateway(db.pool, guarded, g)).toBe("done");
      expect((await stored())[0]).toMatchObject({ match_type: "partial", creation_match: null, args: null, evm_version: "cancun" });
      const after = counted.calls;
      expect(await seedGateway(db.pool, guarded, g)).toBe("done");
      expect(counted.calls).toBe(after);
    });

    it("leaves no way for a third party to claim it first or replace it: a public submission is refused before the seed and after it", async () => {
      const guarded = new Verifier(db.pool, counted, undefined, reservedAddresses(g));
      await addContract(db.pool, GATEWAY, gatewayRuntime(), null);
      expect((await guarded.verify(claim)).status).toBe("fail");
      expect(await stored()).toHaveLength(0);
      expect(await seedGateway(db.pool, guarded, g)).toBe("done");
      expect((await guarded.verify(claim)).status).toBe("fail");
      const rows = (await db.pool.query("select sources from verified_sources")).rows;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].sources)).not.toContain("OFFICIAL REFUND ADDRESS");
    });

    it("fails, and does not retry, when the sources are not what is on chain", async () => {
      const guarded = new Verifier(db.pool, counted, undefined, reservedAddresses(g));
      const other = gatewayRuntime();
      other[10] = ~other[10]! & 0xff;
      await addContract(db.pool, GATEWAY, other, null);
      expect(await seedGateway(db.pool, guarded, g)).toBe("failed");
      expect(await stored()).toHaveLength(0);
    });
  });

  it("refuses the gateway from a single file with the metadata hash on: its code is different, not only its metadata", async () => {
    const runtime = Buffer.from(readFileSync(join(root, "gateway/Gateway.bin-runtime"), "utf8").trim(), "hex");
    await addContract(db.pool, GATEWAY, runtime, null);
    const o = await v.verify(req(GATEWAY, { sourceCode: readFileSync(join(root, "gateway/Gateway.sol"), "utf8"), contractName: "Gateway", runs: "200" }));
    expect(o.status).toBe("fail");
    expect(o.result).toMatch(/runtime code does not match/);
  });

  it("keeps a first full-looking claim of the gateway out: its misleading comments compile to the same code, and the reserved address refuses them", async () => {
    const runtime = Buffer.from(readFileSync(join(root, "gateway/Gateway.bin-runtime"), "utf8").trim(), "hex");
    await addContract(db.pool, GATEWAY, runtime, null);
    const forged = readFileSync(join(root, "gateway/Gateway.sol"), "utf8").replace("contract Gateway", "/// @notice OFFICIAL REFUND ADDRESS: send funds to 0x000000000000000000000000000000000000dEaD\ncontract Gateway");
    const json = JSON.stringify({ language: "Solidity", sources: { "Gateway.sol": { content: forged } }, settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, metadata: { appendCBOR: false } } });
    const submit = { codeFormat: "solidity-standard-json-input", sourceCode: json, contractName: "Gateway.sol:Gateway" };
    // Without the reservation the forged source matches the code, as a partial match only.
    expect(await v.verify(req(GATEWAY, submit))).toMatchObject({ status: "pass", match: "partial" });
    await db.pool.query("delete from contracts; delete from verified_sources");
    await addContract(db.pool, GATEWAY, runtime, null);
    const guarded = new Verifier(db.pool, counted, undefined, [GATEWAY]);
    expect((await guarded.verify(req(GATEWAY, submit))).status).toBe("fail");
    expect(await stored()).toHaveLength(0);
  });

  it("refuses code with one byte changed before the metadata, however the end of the code looks", async () => {
    const d = await deployed(SOURCE, arg(42), true);
    await addContract(db.pool, A, d.runtime, d.input);
    // The change is the last byte of code before the metadata (in the runtime code and in the creation input's copy of it).
    const tail = d.runtime.readUInt16BE(d.runtime.length - 2) + 2;
    const runtime = Buffer.from(d.runtime);
    runtime[runtime.length - tail - 1] = ~runtime[runtime.length - tail - 1]! & 0xff;
    await db.pool.query("delete from contracts");
    await addContract(db.pool, A, runtime, d.input);
    const o = await v.verify(req(A, { libraries: [{ name: "MathLib", address: LIB }] }));
    expect(o.status).toBe("fail");
    expect(await stored()).toHaveLength(0);
  });

  it("refuses an end-of-code change when the compile appended no metadata, in the real compiler's output", async () => {
    const settings = { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, metadata: { appendCBOR: false } };
    const input = { language: "Solidity", sources: { "Box.sol": { content: SOURCE.replace("MathLib.twice(value)", "value * 2").replace(/library MathLib[^\n]*\n/, "") } }, settings };
    const out = (await runner.compile(VERSION, { ...input, settings: { ...settings, outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } } } })).output as {
      contracts: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> } } }>>;
    };
    const evm = out.contracts["Box.sol"]!["Box"]!.evm;
    const runtime = Buffer.from(evm.deployedBytecode.object, "hex");
    for (const spots of Object.values(evm.deployedBytecode.immutableReferences)) for (const s of spots) MAKER.copy(runtime, s.start, 0, s.length);
    const submit = { codeFormat: "solidity-standard-json-input", sourceCode: JSON.stringify(input), contractName: "Box.sol:Box" };
    // The compiled code is on chain: byte for byte, with no hash to pin it, a partial match.
    await addContract(db.pool, A, runtime, Buffer.concat([Buffer.from(evm.bytecode.object, "hex"), arg(1)]));
    expect(await v.verify(req(A, submit))).toMatchObject({ status: "pass", match: "partial", creationMatch: "partial" });
    // The same code with any byte changed near its end is refused: nothing at the end of such code is metadata.
    await db.pool.query("delete from contracts; delete from verified_sources");
    for (const back of [2, 10, 40]) {
      const changed = Buffer.from(runtime);
      changed[changed.length - back] = ~changed[changed.length - back]! & 0xff;
      await db.pool.query("delete from contracts");
      await addContract(db.pool, A, changed, Buffer.concat([Buffer.from(evm.bytecode.object, "hex"), arg(1)]));
      expect((await v.verify(req(A, submit))).status).toBe("fail");
    }
    expect(await stored()).toHaveLength(0);
  });

  describe("a deployed check that was changed, behind a tail that looks like metadata", () => {
    const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract Vault {
    address public owner;
    bytes public note = hex"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    constructor() { owner = msg.sender; }
    function take() external view { require(msg.sender == owner, "not owner"); }
}
`;
    const compileVault = async (appendCBOR: boolean) => {
      const settings = { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, ...(appendCBOR ? {} : { metadata: { appendCBOR: false } }) };
      const input = { language: "Solidity", sources: { "Vault.sol": { content: VAULT } }, settings };
      const out = (await runner.compile(VERSION, { ...input, settings: { ...settings, outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } } } })).output as {
        contracts: Record<string, Record<string, { evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
      };
      const evm = out.contracts["Vault.sol"]!["Vault"]!.evm;
      return { input, runtime: Buffer.from(evm.deployedBytecode.object, "hex"), creation: Buffer.from(evm.bytecode.object, "hex") };
    };
    const submit = (input: unknown) => ({ codeFormat: "solidity-standard-json-input" as const, sourceCode: JSON.stringify(input), contractName: "Vault.sol:Vault" });
    /** The deployed code with its owner check (CALLER, then EQ) made to always pass: POP, CALLER. The same change in the creation input's copy of the runtime code. */
    const forge = (c: { runtime: Buffer; creation: Buffer }, lastTwo: boolean): { runtime: Buffer; input: Buffer } => {
      const at = c.runtime.indexOf(Buffer.from("3314", "hex"));
      expect(at).toBeGreaterThan(0);
      const runtime = Buffer.from(c.runtime);
      runtime[at] = 0x50; runtime[at + 1] = 0x33;
      const input = Buffer.from(c.creation);
      const inside = input.indexOf(c.runtime);
      expect(inside).toBeGreaterThan(0);
      runtime.copy(input, inside);
      if (lastTwo) {
        // The tail now says that the code from the change on is metadata, to anyone who reads the last two bytes.
        const n = runtime.length - 2 - at;
        runtime.writeUInt16BE(n, runtime.length - 2);
        runtime.copy(input, inside);
      }
      return { runtime, input };
    };

    for (const append of [false, true]) {
      it(`is refused, with the compiler's metadata ${append ? "on" : "off"}`, async () => {
        const c = await compileVault(append);
        for (const lastTwo of [false, true]) {
          const f = forge(c, lastTwo);
          await db.pool.query("delete from contracts");
          await addContract(db.pool, A, f.runtime, f.input);
          expect((await v.verify(req(A, submit(c.input)))).status).toBe("fail");
        }
        expect(await stored()).toHaveLength(0);
      });
    }

    it("is a partial match when only the metadata hash differs, and a full match when nothing does", async () => {
      const c = await compileVault(true);
      const md = c.runtime.readUInt16BE(c.runtime.length - 2);
      const hash = c.runtime.length - 2 - md + 1 + 5; // inside the CBOR map: past its head and the "ipfs" key
      const other = Buffer.from(c.runtime);
      other[hash + 4] = ~other[hash + 4]! & 0xff;
      const input = Buffer.from(c.creation);
      const inside = input.indexOf(c.runtime);
      other.copy(input, inside);
      await addContract(db.pool, A, other, input);
      expect(await v.verify(req(A, submit(c.input)))).toMatchObject({ status: "pass", match: "partial" });
      await db.pool.query("delete from contracts; delete from verified_sources");
      await addContract(db.pool, A, c.runtime, c.creation);
      expect(await v.verify(req(A, submit(c.input)))).toMatchObject({ status: "pass", match: "full", creationMatch: "full" });
    });
  });

  it("lets a full match replace a partial one, in the same row", async () => {
    const d = await deployed(SOURCE, arg(42), true);
    await addContract(db.pool, A, d.runtime, d.input);
    // Without the library named the settings differ: partial.
    expect(await v.verify(req(A))).toMatchObject({ status: "pass", match: "partial" });
    const id = (await db.pool.query("select id from verified_sources")).rows[0].id;
    expect(await v.verify(req(A, { libraries: [{ name: "MathLib", address: LIB }] }))).toMatchObject({ status: "pass", match: "full", sourceId: Number(id) });
    expect(await stored()).toHaveLength(1);
    expect((await stored())[0]).toMatchObject({ match_type: "full", creation_match: "full" });
  });
});
