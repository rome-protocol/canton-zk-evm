import { describe, expect, it } from "vitest";
import { compilerErrors, pickContract, prepare, RequestError, unwrapStandardJson, type VerifyRequest } from "./request.ts";

const ADDR = "0x" + "AB".repeat(20);
const base: VerifyRequest = { address: ADDR, codeFormat: "solidity-single-file", sourceCode: "// SPDX-License-Identifier: MIT\ncontract A {}", contractName: "A", compilerVersion: "v0.8.28+commit.7893614a" };

describe("a single file", () => {
  it("becomes one source with the settings the fields give", () => {
    const p = prepare({ ...base, optimizationUsed: "1", runs: "999", evmVersion: "cancun", constructorArguments: "0x00ff" });
    expect(p.address).toBe(ADDR.toLowerCase());
    expect(p.input.sources).toEqual({ "A.sol": { content: base.sourceCode } });
    expect(p.input.settings).toMatchObject({ optimizer: { enabled: true, runs: 999 }, evmVersion: "cancun" });
    expect(p.settings).not.toHaveProperty("outputSelection");
    expect(p.given?.toString("hex")).toBe("00ff");
    expect(p.license).toBe("MIT");
  });
  it("leaves the optimizer off and the EVM version to the compiler when the fields say so", () => {
    const p = prepare({ ...base, optimizationUsed: "0", runs: "200", evmVersion: "default" });
    expect(p.settings).toEqual({ optimizer: { enabled: false } });
  });
  it("puts the libraries into the settings, by file and name", () => {
    const l = "0x" + "11".repeat(20);
    expect(prepare({ ...base, libraries: [{ name: "L", address: l }, { name: "x/M.sol:M", address: l }] }).settings.libraries).toEqual({ "A.sol": { L: l }, "x/M.sol": { M: l } });
    expect(() => prepare({ ...base, libraries: [{ name: "L", address: "0x12" }] })).toThrow(RequestError);
  });
  it("refuses what cannot be run", () => {
    expect(() => prepare({ ...base, address: "0x12" })).toThrow(/address/);
    expect(() => prepare({ ...base, compilerVersion: "latest" })).toThrow(/version/);
    expect(() => prepare({ ...base, constructorArguments: "0xzz" })).toThrow(/hex/);
    expect(() => prepare({ ...base, contractName: "A B" })).toThrow(/name/);
    expect(() => prepare({ ...base, codeFormat: "vyper" })).toThrow(/format/);
    expect(() => prepare({ ...base, sourceCode: "x".repeat(2000) }, 1000)).toThrow(/over 0 KB|KB/);
  });
});

describe("standard JSON", () => {
  const json = { language: "Solidity", sources: { "contracts/A.sol": { content: "// SPDX-License-Identifier: GPL-3.0\ncontract A {}" } }, settings: { optimizer: { enabled: true, runs: 1 }, outputSelection: { "*": { "*": ["*"] } } } };
  const req = (j: unknown, extra: Partial<VerifyRequest> = {}): VerifyRequest => ({ ...base, codeFormat: "solidity-standard-json-input", sourceCode: typeof j === "string" ? j : JSON.stringify(j), contractName: "contracts/A.sol:A", ...extra });

  it("is taken as it is, with the output selection ours", () => {
    const p = prepare(req(json));
    expect(p.path).toBe("contracts/A.sol");
    expect(p.name).toBe("A");
    expect(p.settings).toEqual({ optimizer: { enabled: true, runs: 1 } });
    expect(p.input.settings.outputSelection).not.toEqual(json.settings.outputSelection);
    expect(p.sources["contracts/A.sol"]).toContain("contract A");
    expect(p.license).toBe("GPL-3.0");
  });
  it("takes Etherscan's double braces too", () => {
    expect(unwrapStandardJson("{{ \"a\": 1 }}")).toBe('{ "a": 1 }');
    expect(prepare(req("{" + JSON.stringify(json) + "}")).name).toBe("A");
  });
  it("refuses a source that names a file or an address, another language, and nonsense", () => {
    expect(() => prepare(req({ ...json, sources: { "a.sol": { urls: ["/etc/passwd"] } } }))).toThrow(/content/);
    expect(() => prepare(req({ ...json, language: "Vyper" }))).toThrow(/Solidity/);
    expect(() => prepare(req({ ...json, sources: {} }))).toThrow(/no sources/);
    expect(() => prepare(req("not json"))).toThrow(/standard JSON/);
  });
});

describe("the compiler's output", () => {
  const out = (extra: object = {}) => ({
    contracts: { "a.sol": { A: { abi: [{ type: "constructor" }], metadata: '{"language":"Solidity"}', evm: { bytecode: { object: "6080", linkReferences: {} }, deployedBytecode: { object: "6001", linkReferences: {}, immutableReferences: { "3": [{ start: 1, length: 32 }] } } } } }, "b.sol": { A: { evm: { deployedBytecode: { object: "60" } } } } },
    ...extra,
  });
  it("gives the contract the request names", () => {
    const p = pickContract(out(), { path: "a.sol", name: "A" });
    expect(p).toEqual({ path: "a.sol", name: "A" });
  });
  it("refuses a name that is in two files, a missing contract, and one with no code", () => {
    expect(() => pickContract(out(), { path: null, name: "A" })).toThrow(/more than one/);
    expect(() => pickContract(out(), { path: "a.sol", name: "B" })).toThrow(/no contract/);
    expect(() => pickContract({ contracts: { "a.sol": { I: { evm: { deployedBytecode: { object: "" } } } } } }, { path: null, name: "I" })).toThrow(/no code/);
  });
  it("reports errors, not warnings", () => {
    expect(compilerErrors({ errors: [{ severity: "warning", formattedMessage: "w" }] })).toBeNull();
    expect(compilerErrors({ errors: [{ severity: "warning", formattedMessage: "w" }, { severity: "error", formattedMessage: "ParserError: x" }] })).toBe("ParserError: x");
  });
});
