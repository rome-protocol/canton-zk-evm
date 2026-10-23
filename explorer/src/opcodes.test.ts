import { describe, expect, it } from "vitest";
import { disassemble } from "./opcodes.ts";

describe("disassemble", () => {
  it("reads the free memory pointer set-up", () => {
    const { ops, more } = disassemble("0x6080604052", 10);
    expect(ops).toEqual([{ pc: 0, name: "PUSH1", data: "0x80" }, { pc: 2, name: "PUSH1", data: "0x40" }, { pc: 4, name: "MSTORE", data: null }]);
    expect(more).toBe(false);
  });
  it("keeps push data out of the opcodes, so a data byte that is an opcode is not read as one", () => {
    expect(disassemble("0x60fd00", 10).ops.map((o) => o.name)).toEqual(["PUSH1", "STOP"]);
  });
  it("shows a push cut short by the end of the code with the bytes there are", () => {
    expect(disassemble("0x61ff", 10).ops).toEqual([{ pc: 0, name: "PUSH2", data: "0xff" }]);
  });
  it("names PUSH0, DUP, SWAP and LOG, and an unknown byte as INVALID", () => {
    expect(disassemble("0x5f8f9fa4ef", 10).ops.map((o) => o.name)).toEqual(["PUSH0", "DUP16", "SWAP16", "LOG4", "INVALID"]);
  });
  it("stops at the limit and says there is more", () => {
    const r = disassemble("0x0000000000", 2);
    expect(r.ops).toHaveLength(2);
    expect(r.more).toBe(true);
  });
});
