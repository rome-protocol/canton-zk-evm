import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "../db/testing.ts";
import { addContract, CompilerError, hashOf, outputFor, SandboxError, StubCompile } from "./verify-fixtures.ts";
import { RequestError, type VerifyRequest } from "./request.ts";
import { Verifier } from "./verify.ts";

checkRequired();
const suite = TEST_URL ? describe : describe.skip;

// The verification flow against a database, with a stand-in for the compiler that gives made-up code (the real compiler is in verify-solc.test.ts).
const meta = (tag: number): Buffer => {
  const body = Buffer.concat([Buffer.from("a264697066735822", "hex"), Buffer.alloc(34, tag), Buffer.from("64736f6c6343", "hex"), Buffer.from("00081c", "hex")]);
  return Buffer.concat([body, Buffer.from([0, body.length])]);
};
const BODY = "6080604052348015600e575f80fd5b50600436106030575f3560e01c8063".padEnd(120, "5b");
const runtime = Buffer.concat([Buffer.from(BODY, "hex"), meta(1)]);
const HEAD = Buffer.from("608060405234801561000f575f80fd5b50610150806100305f395ff3fe", "hex");
const creation = Buffer.concat([HEAD, runtime, meta(1)]);
const args = Buffer.from("00".repeat(31) + "2a", "hex");

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
const req = (address: string, extra: Partial<VerifyRequest> = {}): VerifyRequest => ({
  address, codeFormat: "solidity-single-file", sourceCode: "// SPDX-License-Identifier: MIT\ncontract Box {}", contractName: "Box", compilerVersion: "v0.8.28+commit.7893614a", optimizationUsed: "1", runs: "200", ...extra,
});

suite("verifying a contract", () => {
  let db: TestDatabase;
  const stub = new StubCompile();
  let v: Verifier;
  beforeAll(async () => { db = await makeDatabase(true); });
  afterAll(async () => { await db.drop(); });
  beforeEach(async () => {
    await db.pool.query("delete from contracts");
    await db.pool.query("delete from verified_sources");
    stub.calls = 0; stub.fail = null;
    stub.output = outputFor("Box.sol", "Box", { creation: creation.toString("hex"), runtime: runtime.toString("hex") });
    v = new Verifier(db.pool, stub);
  });
  const sources = async () => (await db.pool.query("select encode(address, 'hex') a, match_type, creation_match, encode(constructor_args, 'hex') args, contract_name, code_format, settings, license from verified_sources order by id")).rows;

  it("answers for an address the index does not know as Etherscan does, and compiles nothing", async () => {
    const o = await v.verify(req(A));
    expect(o).toEqual({ status: "unknown", result: `Unable to locate ContractCode at ${A}` });
    expect(stub.calls).toBe(0);
  });

  it("stores a full match with its arguments, the settings and the name", async () => {
    await addContract(db.pool, A, runtime, Buffer.concat([creation, args]));
    const o = await v.verify(req(A));
    expect(o).toMatchObject({ status: "pass", result: "Pass - Verified", match: "full", creationMatch: "full" });
    const [row] = await sources();
    expect(row).toMatchObject({ a: A.slice(2), match_type: "full", creation_match: "full", args: args.toString("hex"), contract_name: "Box", code_format: "solidity-single-file", license: "MIT" });
    expect(row.settings).toEqual({ optimizer: { enabled: true, runs: 200 } });
    const c = (await db.pool.query("select name, match_type, verified_source from contracts where address = $1", [Buffer.from(A.slice(2), "hex")])).rows[0];
    expect(c.name).toBe("Box");
    expect(c.match_type).toBe("full");
    expect(Number(c.verified_source)).toBeGreaterThan(0);
  });

  it("answers 'already' for a second submission, with no new work", async () => {
    await addContract(db.pool, A, runtime, creation);
    await v.verify(req(A));
    const first = stub.calls; // the compile, and the one that finds the metadata's places
    expect(first).toBeGreaterThan(0);
    expect(await v.verify(req(A))).toEqual({ status: "already", result: "Already Verified" });
    expect(stub.calls).toBe(first);
    expect(await sources()).toHaveLength(1);
  });

  it("answers 'already' to the later of two that race, and stores one source", async () => {
    await addContract(db.pool, A, runtime, creation);
    const [x, y] = await Promise.all([v.verify(req(A)), v.verify(req(A))]);
    expect([x.status, y.status].sort()).toEqual(["already", "pass"]);
    expect(await sources()).toHaveLength(1);
  });

  it("refuses the wrong constructor arguments and stores nothing", async () => {
    await addContract(db.pool, A, runtime, Buffer.concat([creation, args]));
    const o = await v.verify(req(A, { constructorArguments: "0x" + "00".repeat(31) + "2b" }));
    expect(o.status).toBe("fail");
    expect(o.result).toMatch(/^Fail - Unable to verify\. the constructor arguments do not match/);
    expect(await sources()).toHaveLength(0);
    // The right ones pass.
    expect((await v.verify(req(A, { constructorArguments: "00".repeat(31) + "2a" }))).status).toBe("pass");
  });

  it("marks a clone the indexer wrote while the verification was committing", async () => {
    await addContract(db.pool, A, runtime, creation);
    // A pool whose clients add the clone just after the commit: neither the transaction's update nor the indexer's can have seen the other.
    const racing = {
      query: db.pool.query.bind(db.pool),
      connect: async () => {
        const c = await db.pool.connect();
        const original = c.query;
        const query = original.bind(c) as (...a: unknown[]) => Promise<unknown>;
        c.query = (async (...a: unknown[]) => {
          const r = await query(...a);
          if (a[0] === "commit") {
            c.query = original; // the client goes back to the pool, so it must be as it was
            await addContract(db.pool, B, runtime, Buffer.concat([creation, args]));
          }
          return r;
        }) as typeof c.query;
        return c;
      },
    } as unknown as typeof db.pool;
    expect(await new Verifier(racing, stub).verify(req(A))).toMatchObject({ status: "pass", similar: 1 });
    expect((await db.pool.query("select match_type from contracts where address = $1", [Buffer.from(B.slice(2), "hex")])).rows[0].match_type).toBe("similar");
  });

  it("is partial when only the metadata differs", async () => {
    const other = Buffer.concat([Buffer.from(BODY, "hex"), meta(9)]);
    await addContract(db.pool, A, other, Buffer.concat([HEAD, other, meta(9)]));
    expect(await v.verify(req(A))).toMatchObject({ status: "pass", match: "partial", creationMatch: "partial" });
    expect((await sources())[0]).toMatchObject({ match_type: "partial", creation_match: "partial" });
  });

  it("marks every other contract with the same code as a similar match, now and when verifying a second", async () => {
    await addContract(db.pool, A, runtime, creation);
    await addContract(db.pool, B, runtime, Buffer.concat([creation, args]));
    const o = await v.verify(req(A));
    expect(o).toMatchObject({ status: "pass", similar: 1 });
    const b = (await db.pool.query("select name, match_type, verified_source from contracts where address = $1", [Buffer.from(B.slice(2), "hex")])).rows[0];
    expect(b).toMatchObject({ name: "Box", match_type: "similar" });
    expect(b.verified_source).toBe((await db.pool.query("select id from verified_sources where address = $1", [Buffer.from(A.slice(2), "hex")])).rows[0].id);
    // B can still be verified in its own right: its own source replaces the similar match.
    expect(await v.verify(req(B))).toMatchObject({ status: "pass", match: "full", similar: 0 });
    expect((await db.pool.query("select match_type from contracts where address = $1", [Buffer.from(B.slice(2), "hex")])).rows[0].match_type).toBe("full");
  });

  it("leaves a contract with other code alone", async () => {
    const other = Buffer.concat([Buffer.from(BODY.replace("5b5b5b", "5b5b00"), "hex"), meta(1)]);
    await addContract(db.pool, A, runtime, creation);
    await addContract(db.pool, C, other, Buffer.concat([HEAD, other, meta(1)]));
    await v.verify(req(A));
    expect((await db.pool.query("select match_type from contracts where address = $1", [Buffer.from(C.slice(2), "hex")])).rows[0].match_type).toBeNull();
    expect(hashOf(other).equals(hashOf(runtime))).toBe(false);
  });

  it("matches a genesis contract, which has no creation, on its runtime code only", async () => {
    await addContract(db.pool, A, runtime, null);
    const o = await v.verify(req(A));
    expect(o).toMatchObject({ status: "pass", match: "full", creationMatch: null });
    expect((await sources())[0]).toMatchObject({ creation_match: null, args: null });
  });

  it("fails with the compiler's own errors", async () => {
    await addContract(db.pool, A, runtime, creation);
    stub.output = { errors: [{ severity: "error", formattedMessage: "ParserError: Expected ';'" }] };
    const o = await v.verify(req(A));
    expect(o).toMatchObject({ status: "fail" });
    expect(o.result).toContain("ParserError");
  });

  it("fails a contract whose code is not the code on chain", async () => {
    await addContract(db.pool, A, Buffer.concat([Buffer.from(BODY.replace("5b5b5b", "5b5b00"), "hex"), meta(1)]), null);
    const o = await v.verify(req(A));
    expect(o.status).toBe("fail");
    expect(o.result).toMatch(/runtime code does not match/);
    expect(await sources()).toHaveLength(0);
  });

  it("fails a compile that took too long, and one with too much output, as the submitter's failure", async () => {
    await addContract(db.pool, A, runtime, creation);
    stub.fail = new SandboxError("timeout", "the compile took longer than 60 s");
    expect(await v.verify(req(A))).toEqual({ status: "fail", result: "Fail - Unable to verify. the compile took too long" });
    stub.fail = new SandboxError("output-too-large", "x");
    expect((await v.verify(req(A))).result).toMatch(/too large/);
  });

  it("fails a compiler version the list does not have, and tries again when the compiler or the sandbox cannot be had", async () => {
    await addContract(db.pool, A, runtime, creation);
    stub.fail = new CompilerError("unknown", "the compiler list has no version v0.1.0");
    expect(await v.verify(req(A, { compilerVersion: "v0.1.0+commit.00000000" }))).toMatchObject({ status: "fail" });
    stub.fail = new CompilerError("download", "the download failed");
    expect((await v.verify(req(A))).status).toBe("retry");
    stub.fail = new SandboxError("unavailable", "docker is not running");
    expect((await v.verify(req(A))).status).toBe("retry");
    expect(await sources()).toHaveLength(0);
  });

  it("refuses a source that is too large before anything is compiled", async () => {
    await addContract(db.pool, A, runtime, creation);
    const big = new Verifier(db.pool, stub, 1000);
    await expect(big.verify(req(A, { sourceCode: "// " + "x".repeat(2000) }))).rejects.toThrow(RequestError);
    expect(stub.calls).toBe(0);
  });

  it("stores a standard JSON verification with its sources and format", async () => {
    await addContract(db.pool, A, runtime, creation);
    stub.output = outputFor("contracts/Box.sol", "Box", { creation: creation.toString("hex"), runtime: runtime.toString("hex") });
    const json = JSON.stringify({ language: "Solidity", sources: { "contracts/Box.sol": { content: "// SPDX-License-Identifier: GPL-3.0\ncontract Box {}" } }, settings: { optimizer: { enabled: false } } });
    const o = await v.verify(req(A, { codeFormat: "solidity-standard-json-input", sourceCode: json, contractName: "contracts/Box.sol:Box" }));
    expect(o.status).toBe("pass");
    const r = (await db.pool.query("select code_format, contract_path, sources, optimizer_enabled, optimizer_runs, license from verified_sources")).rows[0];
    expect(r).toMatchObject({ code_format: "solidity-standard-json-input", contract_path: "contracts/Box.sol", optimizer_enabled: false, optimizer_runs: null, license: "GPL-3.0" });
    expect(Object.keys(r.sources)).toEqual(["contracts/Box.sol"]);
    expect((stub.inputs[0] as { settings: { outputSelection: unknown } }).settings.outputSelection).toBeTruthy();
  });

  it("keeps no constructor arguments for a genesis contract, whatever the request sent", async () => {
    await addContract(db.pool, A, runtime, null);
    expect((await v.verify(req(A, { constructorArguments: "00".repeat(32) }))).status).toBe("pass");
    expect((await sources())[0]).toMatchObject({ creation_match: null, args: null });
  });

  it("lets a full match replace an earlier partial one, and answers 'already' to anything after a full one", async () => {
    const other = Buffer.concat([Buffer.from(BODY, "hex"), meta(9)]);
    await addContract(db.pool, A, other, Buffer.concat([HEAD, other, meta(9)]));
    await addContract(db.pool, B, other, Buffer.concat([HEAD, other, meta(9)]));
    expect(await v.verify(req(A))).toMatchObject({ status: "pass", match: "partial" });
    const first = (await db.pool.query("select id from verified_sources")).rows[0].id;
    // Another partial one adds nothing: already.
    expect(await v.verify(req(A))).toEqual({ status: "already", result: "Already Verified" });
    expect(await sources()).toHaveLength(1);
    // The exact code replaces it, in the same row, and the similar contract keeps pointing at that row.
    stub.output = outputFor("Box.sol", "Box", { creation: Buffer.concat([HEAD, other, meta(9)]).toString("hex"), runtime: other.toString("hex") });
    expect(await v.verify(req(A, { sourceCode: "// SPDX-License-Identifier: MIT\ncontract Box { /* the real one */ }" }))).toMatchObject({ status: "pass", match: "full", sourceId: Number(first) });
    const rows = await sources();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ match_type: "full", creation_match: "full" });
    expect((await db.pool.query("select match_type, verified_source from contracts where address = $1", [Buffer.from(A.slice(2), "hex")])).rows[0]).toMatchObject({ match_type: "full" });
    expect((await db.pool.query("select verified_source from contracts where address = $1", [Buffer.from(B.slice(2), "hex")])).rows[0].verified_source).toBe(first);
    const n = stub.calls;
    expect(await v.verify(req(A))).toEqual({ status: "already", result: "Already Verified" });
    expect(stub.calls).toBe(n);
  });

  it("matches the end of the code byte for byte when the settings say no metadata was appended", async () => {
    // The compiled code differs from the chain only in what would be a metadata hash; with appendCBOR false nothing is metadata.
    const other = Buffer.concat([Buffer.from(BODY, "hex"), meta(9)]);
    await addContract(db.pool, A, other, Buffer.concat([HEAD, other, meta(9)]));
    stub.output = outputFor("Box.sol", "Box", { creation: creation.toString("hex"), runtime: runtime.toString("hex"), auxdata: false });
    const json = JSON.stringify({ language: "Solidity", sources: { "Box.sol": { content: "contract Box {}" } }, settings: { metadata: { appendCBOR: false } } });
    const o = await v.verify(req(A, { codeFormat: "solidity-standard-json-input", sourceCode: json, contractName: "Box.sol:Box" }));
    expect(o.status).toBe("fail");
    expect(o.result).toMatch(/runtime code does not match/);
    expect(await sources()).toHaveLength(0);
  });

  it("refuses a submission for a reserved address, and takes the operator's", async () => {
    await addContract(db.pool, A, runtime, null);
    const guarded = new Verifier(db.pool, stub, undefined, [A.toUpperCase().replace("0X", "0x")]);
    const refused = await guarded.verify(req(A));
    expect(refused.status).toBe("fail");
    expect(refused.result).toMatch(/published by the operator/);
    expect(stub.calls).toBe(0);
    expect(await guarded.verify(req(A), { operator: true })).toMatchObject({ status: "pass" });
  });
});
