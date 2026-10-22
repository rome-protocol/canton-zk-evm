import { describe, expect, it } from "vitest";
import { matchCode, MatchFailure, splitMetadata, type CompiledCode } from "./match.ts";

// Matching, on made-up codes: no compiler needed. A "metadata" here is the shape solc appends: a CBOR map, then its length in two bytes.
const meta = (tag: number): Buffer => {
  const body = Buffer.concat([Buffer.from("a264697066735822", "hex"), Buffer.alloc(34, tag), Buffer.from("64736f6c6343", "hex"), Buffer.from("00081c", "hex")]);
  return Buffer.concat([body, Buffer.from([0, body.length])]);
};
const code = (body: string, tag: number): Buffer => Buffer.concat([Buffer.from(body, "hex"), meta(tag)]);
const hex = (b: Buffer): string => b.toString("hex");
/** The code as the compiler writes it: hex, where a library's place holds its placeholder text. */
const codeHex = (bodyHex: string, tag: number): string => bodyHex + hex(meta(tag));

const RUNTIME_BODY = "6080604052348015600e575f80fd5b50600436106030575f3560e01c8063".padEnd(120, "5b");
const CREATION_HEAD = "608060405234801561000f575f80fd5b50610150806100305f395ff3fe";

function compiledHex(runtime: string, creation: string, extra: Partial<CompiledCode> = {}): CompiledCode {
  return { creation, creationLinks: {}, runtime, runtimeLinks: {}, immutables: {}, ...extra };
}
function compiledOf(runtime: Buffer, creation: Buffer, extra: Partial<CompiledCode> = {}): CompiledCode {
  return { creation: hex(creation), creationLinks: {}, runtime: hex(runtime), runtimeLinks: {}, immutables: {}, ...extra };
}
/** Creation code = head + the runtime code, as solc lays it out, then its own metadata. */
const creationOf = (runtime: Buffer, tag: number): Buffer => Buffer.concat([Buffer.from(CREATION_HEAD, "hex"), runtime, meta(tag)]);

describe("splitMetadata", () => {
  it("splits a trailing CBOR map and its length", () => {
    const c = code("6001", 7);
    const s = splitMetadata(c)!;
    expect(hex(s.body)).toBe("6001");
    expect(s.cbor.length).toBe(c.length - 2);
  });
  it("refuses code that does not end that way", () => {
    expect(splitMetadata(Buffer.from("6080604052", "hex"))).toBeNull();
    expect(splitMetadata(Buffer.from("00", "hex"))).toBeNull();
    expect(splitMetadata(Buffer.concat([Buffer.alloc(40, 1), Buffer.from([0xff, 0xff])]))).toBeNull();
  });
});

describe("matching the runtime code", () => {
  const onRuntime = code(RUNTIME_BODY, 1);

  it("is full when the code is the same, metadata included, and the genesis contract has no creation to compare", () => {
    const m = matchCode(compiledOf(onRuntime, creationOf(onRuntime, 1)), { runtimeCode: onRuntime, creationInput: null }, null);
    expect(m.kind).toBe("full");
    expect(m.creationKind).toBeNull();
    expect(m.constructorArgs).toBeNull();
  });

  it("is partial when only the metadata differs", () => {
    const compiled = code(RUNTIME_BODY, 2);
    const m = matchCode(compiledOf(compiled, creationOf(compiled, 2)), { runtimeCode: onRuntime, creationInput: null }, null);
    expect(m.kind).toBe("partial");
  });

  it("refuses code that differs anywhere else", () => {
    const other = code(RUNTIME_BODY.replace("5b5b5b", "5b5b00"), 1);
    expect(() => matchCode(compiledOf(other, creationOf(other, 1)), { runtimeCode: onRuntime, creationInput: null }, null)).toThrow(MatchFailure);
    const e = (() => { try { matchCode(compiledOf(other, creationOf(other, 1)), { runtimeCode: onRuntime, creationInput: null }, null); } catch (x) { return x as MatchFailure; } return null; })();
    expect(e?.code).toBe("runtime");
  });

  it("refuses code with no metadata that differs", () => {
    const a = Buffer.from("6001600255", "hex");
    const b = Buffer.from("6001600355", "hex");
    expect(() => matchCode(compiledOf(a, a), { runtimeCode: b, creationInput: null }, null)).toThrow(/runtime code does not match/);
    expect(matchCode(compiledOf(a, a), { runtimeCode: a, creationInput: null }, null).kind).toBe("full");
  });

  it("fills the immutables from the chain, and refuses when the rest differs", () => {
    const compiled = code("7f" + "00".repeat(32) + "6000527f" + "00".repeat(32) + "6020", 1);
    const value = "11".repeat(32);
    const chain = code("7f" + value + "6000527f" + value + "6020", 1);
    const imm = { "7": [{ start: 1, length: 32 }, { start: 37, length: 32 }] };
    expect(matchCode(compiledOf(compiled, compiled, { immutables: imm }), { runtimeCode: chain, creationInput: null }, null).kind).toBe("full");
    // The same immutable with two different values on chain is not one immutable.
    const odd = code("7f" + value + "6000527f" + "22".repeat(32) + "6020", 1);
    expect(() => matchCode(compiledOf(compiled, compiled, { immutables: imm }), { runtimeCode: odd, creationInput: null }, null)).toThrow(/different/);
    const changed = code("7f" + value + "6001527f" + value + "6020", 1);
    expect(() => matchCode(compiledOf(compiled, compiled, { immutables: imm }), { runtimeCode: changed, creationInput: null }, null)).toThrow(MatchFailure);
  });

  it("reads a library's address from the chain at the places the compiler names, and reports it", () => {
    const placeholder = "__$" + "ab".repeat(17) + "$__";
    const compiled = codeHex("73" + placeholder + "6000", 1);
    const lib = "5fbdb2315678afecb367f032d93f642f64180aa3";
    const chain = code("73" + lib + "6000", 1);
    const links = { "src/L.sol": { L: [{ start: 1, length: 20 }] } };
    const m = matchCode(compiledHex(compiled, compiled, { runtimeLinks: links }), { runtimeCode: chain, creationInput: null }, null);
    expect(m.kind).toBe("full");
    expect(m.libraries).toEqual({ "src/L.sol": { L: "0x" + lib } });
    // Code that differs outside the link is still refused.
    const bad = code("73" + lib + "6001", 1);
    expect(() => matchCode(compiledHex(compiled, compiled, { runtimeLinks: links }), { runtimeCode: bad, creationInput: null }, null)).toThrow(MatchFailure);
  });

  it("refuses a link that is outside the code", () => {
    const compiled = code("6000", 1);
    expect(() => matchCode(compiledOf(compiled, compiled, { runtimeLinks: { "a.sol": { L: [{ start: 9000, length: 20 }] } } }), { runtimeCode: compiled, creationInput: null }, null)).toThrow(MatchFailure);
  });
});

describe("matching the creation code and the constructor arguments", () => {
  const runtime = code(RUNTIME_BODY, 1);
  const creation = creationOf(runtime, 1);
  const args = Buffer.from("00".repeat(31) + "2a", "hex");

  it("takes what follows the creation code as the arguments", () => {
    const m = matchCode(compiledOf(runtime, creation), { runtimeCode: runtime, creationInput: Buffer.concat([creation, args]) }, null);
    expect(m.kind).toBe("full");
    expect(m.creationKind).toBe("full");
    expect(m.constructorArgs?.equals(args)).toBe(true);
  });

  it("accepts arguments that are the ones in the creation input", () => {
    const m = matchCode(compiledOf(runtime, creation), { runtimeCode: runtime, creationInput: Buffer.concat([creation, args]) }, args);
    expect(m.constructorArgs?.equals(args)).toBe(true);
  });

  it("refuses arguments that are not the ones in the creation input", () => {
    const wrong = Buffer.from("00".repeat(31) + "2b", "hex");
    try {
      matchCode(compiledOf(runtime, creation), { runtimeCode: runtime, creationInput: Buffer.concat([creation, args]) }, wrong);
      expect.unreachable();
    } catch (e) {
      expect((e as MatchFailure).code).toBe("arguments");
    }
    // Arguments given for a creation that took none are wrong too.
    expect(() => matchCode(compiledOf(runtime, creation), { runtimeCode: runtime, creationInput: creation }, args)).toThrow(/arguments/);
  });

  it("is partial when the creation code differs only in its metadata, and refuses when it differs elsewhere", () => {
    const rt2 = code(RUNTIME_BODY, 2);
    const m = matchCode(compiledOf(rt2, creationOf(rt2, 2)), { runtimeCode: runtime, creationInput: Buffer.concat([creation, args]) }, null);
    expect(m.kind).toBe("partial");
    expect(m.creationKind).toBe("partial");
    expect(m.constructorArgs?.equals(args)).toBe(true);
    const other = Buffer.concat([Buffer.from(CREATION_HEAD.replace("0f", "10"), "hex"), runtime, meta(1)]);
    try {
      matchCode(compiledOf(runtime, creation), { runtimeCode: runtime, creationInput: Buffer.concat([other, args]) }, null);
      expect.unreachable();
    } catch (e) {
      expect((e as MatchFailure).code).toBe("creation");
    }
  });

  it("refuses a creation input shorter than the compiled creation code", () => {
    expect(() => matchCode(compiledOf(runtime, creation), { runtimeCode: runtime, creationInput: creation.subarray(0, 20) }, null)).toThrow(MatchFailure);
  });

  it("takes a library's address from the creation input, and refuses two addresses for one library", () => {
    const placeholder = "__$" + "cd".repeat(17) + "$__";
    const lib = "5fbdb2315678afecb367f032d93f642f64180aa3";
    const compiledRt = codeHex("73" + placeholder + "6000", 1);
    const chainRt = code("73" + lib + "6000", 1);
    const c: CompiledCode = {
      creation: "6080" + "73" + placeholder + "6000", creationLinks: { "L.sol": { L: [{ start: 3, length: 20 }] } },
      runtime: compiledRt, runtimeLinks: { "L.sol": { L: [{ start: 1, length: 20 }] } }, immutables: {},
    };
    const m = matchCode(c, { runtimeCode: chainRt, creationInput: Buffer.from("6080" + "73" + lib + "6000", "hex") }, null);
    expect(m.libraries).toEqual({ "L.sol": { L: "0x" + lib } });
    const other = Buffer.from("6080" + "73" + "11".repeat(20) + "6000", "hex");
    expect(() => matchCode(c, { runtimeCode: chainRt, creationInput: other }, null)).toThrow(/library L/);
  });
});
