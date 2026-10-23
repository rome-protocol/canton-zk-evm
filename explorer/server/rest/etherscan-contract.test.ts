import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createIndexer } from "../indexer/indexer.ts";
import type { Reth } from "../reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createVerifyApi, PROXY_TEXTS } from "../verifier/api.ts";
import { JobQueue } from "../verifier/jobs.ts";
import { Verifier } from "../verifier/verify.ts";
import { addContract, fakeProbe, outputFor, StubCompile } from "../verifier/verify-fixtures.ts";
import { EIP1822_SLOT, EIP1967_IMPLEMENTATION_SLOT } from "../indexer/proxies.ts";
import { VerifierWorker } from "../verifier/worker.ts";
import { createEtherscanRest } from "./etherscan-rest.ts";
import { MODULES, TEXTS } from "./etherscan.ts";
import { NOT_VERIFIED, sourceCodeFields, type ContractSourceRow } from "./etherscan-contract-rest.ts";

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const meta = (tag: number): Buffer => {
  const body = Buffer.concat([Buffer.from("a264697066735822", "hex"), Buffer.alloc(34, tag), Buffer.from("64736f6c6343", "hex"), Buffer.from("00081c", "hex")]);
  return Buffer.concat([body, Buffer.from([0, body.length])]);
};
const runtime = Buffer.concat([Buffer.from("6080604052348015600e575f80fd5b50600436106030575f3560e01c8063".padEnd(120, "5b"), "hex"), meta(1)]);
const creation = Buffer.concat([Buffer.from("608060405234801561000f575f80fd5b50610150806100305f395ff3fe", "hex"), runtime, meta(1)]);
const A = "0x" + "a1".repeat(20), B = "0x" + "a2".repeat(20), FACTORY = "0x" + "f1".repeat(20), GENESIS = "0x" + "9b".repeat(20), IMPL = "0x" + "c3".repeat(20);
const SOURCE = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.28;\ncontract Box {\n    uint256 public v;\n}\n";
const VERSION = "v0.8.28+commit.7893614a";

/** Etherscan's three fields and nothing else. */
const shape = (a: Answer) => {
  expect(a.status).toBe(200);
  expect(Object.keys(a.body as object)).toEqual(["status", "message", "result"]);
  return a.body as { status: string; message: string; result: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const NOTOK = (result: string) => ({ status: "0", message: "NOTOK", result });
const OK = (result: unknown) => ({ status: "1", message: "OK", result });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What `forge verify-contract` sends: a form, with the action in it. */
const form = (fields: Record<string, string>) => new URLSearchParams({ module: "contract", ...fields }).toString();
const FIELDS = ["SourceCode", "ABI", "ContractName", "CompilerVersion", "OptimizationUsed", "Runs", "ConstructorArguments", "EVMVersion", "Library", "LicenseType", "Proxy", "Implementation", "SwarmSource"];

describe("the contract module's table", () => {
  it("lists the seven actions of Etherscan's contract module that Ostia answers", () => {
    expect(Object.keys(MODULES.contract!).sort()).toEqual(["checkproxyverification", "checkverifystatus", "getabi", "getcontractcreation", "getsourcecode", "verifyproxycontract", "verifysourcecode"]);
  });
});

describe("getsourcecode's fields", () => {
  const verified = (over: Partial<NonNullable<ContractSourceRow["verified"]>> = {}): ContractSourceRow => ({
    held: true, implementation: null,
    verified: { matchType: "full", format: "solidity-single-file", contractName: "Box", compilerVersion: VERSION, optimizer: true, runs: 200, evmVersion: null, license: "MIT", settings: {}, sources: { "Box.sol": SOURCE }, abi: [{ type: "function", name: "v" }], constructorArgs: null, libraries: null, ...over },
  });
  it("gives a single file as it is, and standard JSON between a second pair of braces", () => {
    expect(sourceCodeFields(verified())).toEqual({
      SourceCode: SOURCE, ABI: '[{"type":"function","name":"v"}]', ContractName: "Box", CompilerVersion: VERSION, OptimizationUsed: "1", Runs: "200", ConstructorArguments: "", EVMVersion: "Default", Library: "", LicenseType: "MIT",
      Proxy: "0", Implementation: "", SwarmSource: "",
    });
    const json = sourceCodeFields(verified({ format: "solidity-standard-json-input", settings: { optimizer: { enabled: true, runs: 200 } }, sources: { "a.sol": "A", "b.sol": "B" }, evmVersion: "cancun", constructorArgs: "00ff", libraries: { "a.sol": { L: "0x" + "11".repeat(20) } } }));
    expect(json.SourceCode.startsWith("{{") && json.SourceCode.endsWith("}}")).toBe(true);
    expect(JSON.parse(json.SourceCode.slice(1, -1))).toEqual({ language: "Solidity", sources: { "a.sol": { content: "A" }, "b.sol": { content: "B" } }, settings: { optimizer: { enabled: true, runs: 200 } } });
    expect(json).toMatchObject({ EVMVersion: "cancun", ConstructorArguments: "00ff", Library: "L:0x" + "11".repeat(20) });
  });
  it("gives the compiler's version with the v that Etherscan writes, whichever way it was stored (the verifier stores the compiler's own, with no v)", () => {
    expect(sourceCodeFields(verified({ compilerVersion: VERSION.slice(1) })).CompilerVersion).toBe(VERSION);
    expect(sourceCodeFields(verified({ compilerVersion: VERSION })).CompilerVersion).toBe(VERSION);
  });
  it("is the same fields, empty, with the text in ABI, for a contract that is not verified, and carries the proxy", () => {
    const empty = sourceCodeFields({ held: true, verified: null, implementation: IMPL });
    expect(Object.keys(empty)).toEqual(FIELDS);
    expect(empty).toMatchObject({ SourceCode: "", ABI: NOT_VERIFIED, ContractName: "", Proxy: "1", Implementation: IMPL });
  });
});

describe.skipIf(!TEST_URL)("the Etherscan-compatible /api: the contract module", () => {
  checkRequired();
  let db: TestDatabase, pool: Pool;
  const stub = new StubCompile();
  const probes = fakeProbe();
  const config = () => loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
  const hash = (c: string) => c.padEnd(64, "0").replace(/[^0-9a-f]/g, "0").slice(0, 64);
  const api = (limits = {}) => createApi({
    config: config(), reth: {} as unknown as Reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), etherscanRest: createEtherscanRest(pool),
    verify: createVerifyApi({ pool, queue: new JobQueue(pool, limits), clientHash: hash, probe: probes.probe }),
  });
  const get = async (target: string) => shape(await api()("GET", target));
  const post = async (fields: Record<string, string>, ip = "203.0.113.5", limits = {}) => shape(await api(limits)("POST", "/api", form(fields), ip));
  const sql = (text: string, values: unknown[] = []) => pool.query(text, values);
  const running = () => sql("insert into health_checks (check_id, status, value, changed_at, checked_at) values ('verifier/compilers', 'ok', '{}'::jsonb, now(), now()) on conflict (check_id) do update set checked_at = now()");
  const worker = () => new VerifierWorker(pool, new JobQueue(pool), new Verifier(pool, stub), { cacheUsable: async () => null, log: () => undefined });
  const single = (over: Record<string, string> = {}) => ({
    action: "verifysourcecode", contractaddress: A, sourceCode: SOURCE, codeformat: "solidity-single-file", contractname: "Box", compilerversion: VERSION, optimizationUsed: "1", runs: "200",
    constructorArguements: "", evmversion: "default", licenseType: "3", apikey: "any", ...over,
  });

  beforeAll(async () => {
    db = await makeDatabase();
    pool = db.pool;
    await migrate(pool);
    const chain = makeChain([{ txs: 0 }, { txs: 5, leg: 2 }, { txs: 7 }]);
    const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }
  });
  afterAll(async () => { await db.drop(); });
  beforeEach(async () => {
    await sql("truncate verification_jobs, verified_sources, contracts, bytecodes, health_checks cascade");
    stub.calls = 0; stub.fail = null;
    stub.output = outputFor("Box.sol", "Box", { creation: creation.toString("hex"), runtime: runtime.toString("hex") });
    await addContract(pool, A, runtime, creation);
    await sql("update contracts set creation_block = 2, creation_tx_index = 0 where address = $1", [Buffer.from(A.slice(2), "hex")]);
  });

  describe("verifysourcecode and checkverifystatus", () => {
    it("takes a single file as forge sends it, answers a GUID, then Etherscan's texts, and getsourcecode and getabi follow", async () => {
      await running();
      const sent = await post(single({ libraryname1: "Lib", libraryaddress1: "0x" + "11".repeat(20) }));
      expect(sent).toMatchObject({ status: "1", message: "OK" });
      expect(sent.result).toMatch(GUID);
      expect(await get(`/api?module=contract&action=checkverifystatus&guid=${sent.result}`)).toEqual(NOTOK("Pending in queue"));
      expect(await worker().step()).toBe("ended");
      expect(await get(`/api?module=contract&action=checkverifystatus&guid=${sent.result}`)).toEqual(OK("Pass - Verified"));
      // The compiler was given the source byte for byte (a trailing newline changes the metadata hash), and the library.
      const input = stub.inputs[0] as { sources: Record<string, { content: string }>; settings: { libraries?: unknown } };
      expect(Object.values(input.sources)[0]!.content).toBe(SOURCE);
      expect(input.settings.libraries).toEqual({ "Box.sol": { Lib: "0x" + "11".repeat(20) } });
      const src = await get(`/api?module=contract&action=getsourcecode&address=${A.toUpperCase().replace("0X", "0x")}`);
      expect(src.status).toBe("1");
      expect(src.message).toBe("OK");
      expect(src.result).toHaveLength(1);
      expect(Object.keys(src.result[0])).toEqual(FIELDS);
      expect(src.result[0]).toMatchObject({ SourceCode: SOURCE, ContractName: "Box", CompilerVersion: VERSION, OptimizationUsed: "1", Runs: "200", ConstructorArguments: "", Library: "Lib:0x" + "11".repeat(20), Proxy: "0", Implementation: "", SwarmSource: "" });
      const abi = await get(`/api?module=contract&action=getabi&address=${A}`);
      expect(abi).toEqual(OK(src.result[0].ABI));
      expect(JSON.parse(abi.result)[1]).toMatchObject({ name: "get" });
      // Once it is verified, another submission is refused up front.
      expect(await post(single())).toEqual(NOTOK("Contract source code already verified"));
    });

    it("takes standard JSON input in either brace form, and getsourcecode gives it back in the double braces", async () => {
      await running();
      const input = JSON.stringify({ language: "Solidity", sources: { "Box.sol": { content: SOURCE } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } });
      const sent = await post(single({ codeformat: "solidity-standard-json-input", contractname: "Box.sol:Box", sourceCode: "{" + input + "}", constructorArguements: "0x" }));
      expect(sent.status).toBe("1");
      await worker().step();
      expect(await get(`/api?module=contract&action=checkverifystatus&guid=${sent.result}`)).toEqual(OK("Pass - Verified"));
      const [row] = (await get(`/api?module=contract&action=getsourcecode&address=${A}`)).result;
      expect(row.SourceCode.startsWith("{{") && row.SourceCode.endsWith("}}")).toBe(true);
      expect(JSON.parse(row.SourceCode.slice(1, -1)).sources).toEqual({ "Box.sol": { content: SOURCE } });
      expect(row).toMatchObject({ ContractName: "Box", EVMVersion: "cancun", OptimizationUsed: "1", Runs: "200" });
      // Hardhat sends the bare JSON and the same fields in the query's own spelling `constructorArguments`.
      const again = await post(single({ codeformat: "solidity-standard-json-input", contractname: "Box.sol:Box", sourceCode: input, constructorArguments: "" }), "203.0.113.6");
      expect(again).toEqual(NOTOK("Contract source code already verified"));
    });

    it("answers a contract that came back as already verified by the job, and a failure with its reason", async () => {
      await running();
      stub.output = outputFor("Box.sol", "Box", { creation: "6001", runtime: "6002" });
      const sent = await post(single());
      await worker().step();
      const failed = await get(`/api?module=contract&action=checkverifystatus&guid=${sent.result}`);
      expect(failed.status).toBe("0");
      expect(failed.message).toBe("NOTOK");
      expect(failed.result).toMatch(/^Fail - Unable to verify/);
    });

    it("refuses what Etherscan refuses, in its words", async () => {
      await running();
      expect(await post(single({ contractaddress: "0x12" }))).toEqual(NOTOK(TEXTS.address));
      expect(await post(single({ contractaddress: B }))).toEqual(NOTOK(`Unable to locate ContractCode at ${B}`));
      for (const field of ["sourceCode", "contractname", "compilerversion"]) {
        const f = single(); delete (f as Record<string, string>)[field];
        expect(await post(f)).toEqual(NOTOK(`Missing or invalid ${field}`));
      }
      expect(await post(single({ codeformat: "vyper-json" }))).toEqual(NOTOK(TEXTS.unsupported));
      expect(await post(single({ constructorArguements: "xyz" }))).toEqual(NOTOK("Missing or invalid constructorArguements"));
      expect(await get("/api?module=contract&action=checkverifystatus&guid=nope")).toEqual(NOTOK("Unknown UID"));
      expect(await get("/api?module=contract&action=checkverifystatus")).toEqual(NOTOK("Unknown UID"));
      expect(await get("/api?module=contract&action=checkverifystatus&guid=00000000-0000-4000-8000-000000000000")).toEqual(NOTOK("Unknown UID"));
      expect(stub.calls).toBe(0);
    });

    it("keeps the verifier's own limits: the source's size, the client's hour and the verifier being off", async () => {
      expect(await post(single())).toEqual(NOTOK("Verification is not running."));
      await running();
      expect(await post(single({ sourceCode: "x".repeat(600) }), "203.0.113.7", { maxSourceBytes: 500 })).toMatchObject({ status: "0", message: "NOTOK", result: expect.stringMatching(/most that is taken is 500/) });
      expect((await post(single(), "203.0.113.8", { perClientPerHour: 1 })).status).toBe("1");
      expect(await post(single(), "203.0.113.8", { perClientPerHour: 1 })).toEqual(NOTOK("At most 1 verifications an hour from one client."));
    });

    it("answers a name's other case, as the door does for every action, and a POST's query as well as its form", async () => {
      await running();
      const r = shape(await api()("POST", "/api?module=contract&action=VERIFYSOURCECODE", new URLSearchParams(single()).toString().replace("action=verifysourcecode&", ""), "203.0.113.9"));
      expect(r.status).toBe("1");
    });
  });

  describe("getsourcecode and getabi for what is not verified", () => {
    it("gives the empty fields with Etherscan's text, for a contract and for an address that is none", async () => {
      for (const a of [A, B]) {
        const r = await get(`/api?module=contract&action=getsourcecode&address=${a}`);
        expect(r.status).toBe("1");
        expect(r.result).toEqual([{ SourceCode: "", ABI: NOT_VERIFIED, ContractName: "", CompilerVersion: "", OptimizationUsed: "", Runs: "", ConstructorArguments: "", EVMVersion: "Default", Library: "", LicenseType: "", Proxy: "0", Implementation: "", SwarmSource: "" }]);
        expect(await get(`/api?module=contract&action=getabi&address=${a}`)).toEqual(NOTOK(NOT_VERIFIED));
      }
      expect(await get("/api?module=contract&action=getsourcecode&address=0x12")).toEqual(NOTOK(TEXTS.address));
      expect(await get("/api?module=contract&action=getabi")).toEqual(NOTOK(TEXTS.address));
    });

    it("gives the source of a similar match without its constructor arguments, which are another address's", async () => {
      await running();
      await post(single({ constructorArguements: "" }));
      await worker().step();
      await addContract(pool, B, runtime, creation);
      await sql("update contracts set verified_source = (select verified_source from contracts where address = $1), match_type = 'similar', name = 'Box' where address = $2", [Buffer.from(A.slice(2), "hex"), Buffer.from(B.slice(2), "hex")]);
      await sql("update verified_sources set constructor_args = '\\x00ff'");
      const [a] = (await get(`/api?module=contract&action=getsourcecode&address=${A}`)).result, [b] = (await get(`/api?module=contract&action=getsourcecode&address=${B}`)).result;
      expect(a.ConstructorArguments).toBe("00ff");
      expect(b).toMatchObject({ SourceCode: SOURCE, ContractName: "Box", ConstructorArguments: "" });
    });
  });

  describe("getcontractcreation", () => {
    it("gives the creator, the transaction, the block and the creation code, for up to five addresses in the order asked", async () => {
      const [tx] = (await sql("select t.hash, t.from_address, extract(epoch from b.timestamp)::bigint as ts from transactions t join blocks b on b.number = t.block_number where t.block_number = 2 and t.tx_index = 0")).rows;
      const hex = (b: Buffer) => "0x" + b.toString("hex");
      // A was made by the transaction itself; C by a factory that the transaction called (trace address {0}); the genesis contract has no creation.
      const C = "0x" + "a3".repeat(20);
      await addContract(pool, C, runtime, null);
      await sql("update contracts set origin = 'create', creator = $2, creation_block = 2, creation_tx_index = 0, creation_trace_address = '{0}' where address = $1", [Buffer.from(C.slice(2), "hex"), Buffer.from(FACTORY.slice(2), "hex")]);
      await addContract(pool, GENESIS, runtime, null);
      const r = await get(`/api?module=contract&action=getcontractcreation&contractaddresses=${[C, GENESIS, A, B].join(",")}`);
      expect(r.status).toBe("1");
      expect(r.message).toBe("OK");
      expect(r.result).toHaveLength(3);
      for (const x of r.result) expect(Object.keys(x)).toEqual(["contractAddress", "contractCreator", "txHash", "blockNumber", "timestamp", "contractFactory", "creationBytecode"]);
      expect(r.result[0]).toEqual({ contractAddress: C, contractCreator: hex(tx.from_address), txHash: hex(tx.hash), blockNumber: "2", timestamp: String(tx.ts), contractFactory: FACTORY, creationBytecode: "" });
      expect(r.result[2]).toEqual({ contractAddress: A, contractCreator: "0x" + "01".repeat(20), txHash: hex(tx.hash), blockNumber: "2", timestamp: String(tx.ts), contractFactory: "", creationBytecode: hex(creation) });
      // Etherscan's own answer for a contract that is in the genesis allocation: the creator is GENESIS, and so is the start of the transaction's name.
      const first = (await sql("select extract(epoch from timestamp)::bigint as ts from blocks order by number limit 1")).rows[0];
      expect(r.result[1]).toEqual({ contractAddress: GENESIS, contractCreator: "GENESIS", txHash: "GENESIS_" + "9b".repeat(20), blockNumber: "0", timestamp: String(first.ts), contractFactory: "", creationBytecode: "" });
    });

    it("refuses more than five addresses, a bad one and none, and has no data for addresses that are no contracts", async () => {
      expect(await get(`/api?module=contract&action=getcontractcreation&contractaddresses=${[A, A, A, A, A, A].join(",")}`)).toEqual(NOTOK("Error! Max 5 addresses per call"));
      expect(await get(`/api?module=contract&action=getcontractcreation&contractaddresses=${A},0x12`)).toEqual(NOTOK(TEXTS.address));
      expect(await get("/api?module=contract&action=getcontractcreation")).toEqual(NOTOK(TEXTS.address));
      expect(await get(`/api?module=contract&action=getcontractcreation&contractaddresses=${B}`)).toEqual({ status: "0", message: TEXTS.noData, result: [] });
    });
  });

  describe("verifyproxycontract and checkproxyverification", () => {
    const P = A;
    const proxy = (fields: Record<string, string> = {}) => post({ action: "verifyproxycontract", address: P, ...fields });
    it("records the implementation of a proxy the indexer found, and answers by GUID in Etherscan's words", async () => {
      const none = await proxy();
      expect(none).toMatchObject({ status: "1", message: "OK" });
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${none.result}`)).toEqual(NOTOK(PROXY_TEXTS.none));
      // The proxy's implementation slot, read at the final head by the call itself (nothing is in `proxies` until then).
      probes.setSlot(P, EIP1967_IMPLEMENTATION_SLOT, IMPL);
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${none.result}`)).toEqual(NOTOK(PROXY_TEXTS.none));
      const wrong = await proxy({ expectedimplementation: B });
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${wrong.result}`)).toEqual(NOTOK(PROXY_TEXTS.mismatch(IMPL, B)));
      expect((await sql("select verified_at from proxies")).rows[0].verified_at).toBeNull();
      const good = await proxy({ expectedimplementation: IMPL });
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${good.result}`)).toEqual(OK(PROXY_TEXTS.done(P, IMPL)));
      expect((await sql("select verified_at from proxies")).rows[0].verified_at).not.toBeNull();
      // getsourcecode now says what the proxy points at.
      expect((await get(`/api?module=contract&action=getsourcecode&address=${P}`)).result[0]).toMatchObject({ Proxy: "1", Implementation: IMPL });
    });
    it("reads the slots at the final head: an EIP-1822 proxy upgraded with no log is seen, and the old implementation is not answered", async () => {
      const NEW = "0x" + "e7".repeat(20);
      await sql("delete from proxies");
      // The indexer saw the proxy once, pointing at IMPL; then `updateCodeAddress` moved it, which emits no event, so the row is stale.
      await sql("insert into proxies (proxy, kind, implementation, checked_block) values ($1, 'eip1822', $2, 1)", [Buffer.from(P.slice(2), "hex"), Buffer.from(IMPL.slice(2), "hex")]);
      probes.setSlot(P, EIP1967_IMPLEMENTATION_SLOT, null);
      probes.setSlot(P, EIP1822_SLOT, NEW);
      probes.heads.length = 0;
      const stale = await proxy({ expectedimplementation: IMPL });
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${stale.result}`)).toEqual(NOTOK(PROXY_TEXTS.mismatch(NEW, IMPL)));
      const fresh = await proxy({ expectedimplementation: NEW });
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${fresh.result}`)).toEqual(OK(PROXY_TEXTS.done(P, NEW)));
      const row = (await sql("select encode(implementation, 'hex') as i, kind, checked_block from proxies")).rows;
      expect(row).toEqual([{ i: NEW.slice(2), kind: "eip1822", checked_block: expect.anything() }]);
      expect(Number(row[0].checked_block)).toBeGreaterThan(1);
      expect(new Set(probes.heads).size).toBe(1);
      expect((await get(`/api?module=contract&action=getsourcecode&address=${P}`)).result[0]).toMatchObject({ Proxy: "1", Implementation: NEW });
      // A proxy that is no proxy at the head any more loses its row, and the answer says none was detected.
      probes.setSlot(P, EIP1822_SLOT, null);
      const gone = await proxy();
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${gone.result}`)).toEqual(NOTOK(PROXY_TEXTS.none));
      expect((await sql("select 1 from proxies")).rowCount).toBe(0);
      expect((await get(`/api?module=contract&action=getsourcecode&address=${P}`)).result[0]).toMatchObject({ Proxy: "0", Implementation: "" });
    });
    it("keeps proxy GUIDs and source GUIDs apart, and refuses a bad address, an unknown contract and a bad expectation", async () => {
      await running();
      const p = await proxy();
      const s = await post(single());
      expect(await get(`/api?module=contract&action=checkverifystatus&guid=${p.result}`)).toEqual(NOTOK("Unknown UID"));
      expect(await get(`/api?module=contract&action=checkproxyverification&guid=${s.result}`)).toEqual(NOTOK("Unknown UID"));
      expect(await post({ action: "verifyproxycontract", address: "0x12" })).toEqual(NOTOK(TEXTS.address));
      expect(await post({ action: "verifyproxycontract", address: B })).toEqual(NOTOK(`Unable to locate ContractCode at ${B}`));
      expect(await proxy({ expectedimplementation: "0x12" })).toEqual(NOTOK(TEXTS.address));
      expect(await get("/api?module=contract&action=checkproxyverification")).toEqual(NOTOK("Unknown UID"));
    });
  });
});
