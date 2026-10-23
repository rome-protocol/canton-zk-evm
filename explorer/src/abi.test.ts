import { describe, expect, it } from "vitest";
import { decodeArgs, signature } from "./abi.ts";

describe("signature", () => {
  it("writes functions, events and errors the way Solidity does", () => {
    expect(signature({ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] })).toBe("function balanceOf(address a) view returns (uint256)");
    expect(signature({ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [] })).toBe("function mint()");
    expect(signature({ type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] })).toBe("event Transfer(address indexed from, uint256 value)");
    expect(signature({ type: "error", name: "Nope", inputs: [{ type: "tuple[]", components: [{ type: "uint8" }, { type: "bool" }] }] })).toBe("error Nope((uint8,bool)[])");
    expect(signature({ type: "receive", stateMutability: "payable" })).toBe("receive() payable");
  });
});

describe("decodeArgs", () => {
  const word = (h: string) => h.padStart(64, "0");
  it("reads an address, a bool and a number from their words", () => {
    const r = decodeArgs([{ name: "o", type: "address" }, { name: "b", type: "bool" }, { name: "n", type: "uint256" }], "0x" + word("e3".repeat(20)) + word("1") + word("ff"));
    expect(r).toEqual([{ name: "o", type: "address", value: "0x" + "e3".repeat(20) }, { name: "b", type: "bool", value: "true" }, { name: "n", type: "uint256", value: "255" }]);
  });
  it("reads a bytesN from the front of its word", () => {
    expect(decodeArgs([{ type: "bytes4" }], "0x" + "12345678" + "00".repeat(28))?.[0]?.value).toBe("0x12345678");
  });
  it("gives up on a dynamic type and on arguments of the wrong length", () => {
    expect(decodeArgs([{ type: "string" }], "0x" + word("20"))).toBeNull();
    expect(decodeArgs([{ type: "address" }], "0x1234")).toBeNull();
  });
});
