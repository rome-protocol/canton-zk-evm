import { describe, expect, it } from "vitest";
import { encodeFunctionData, encodeAbiParameters, toEventSelector } from "viem";
import { callable, decodeEventOf, decodeInputOf, decodeOutputs, encodeCall, parseArg, shown, type AbiEntry } from "./abi-call.ts";

const ME = "0xe320e2a3c7cd875ef139c442f006e2400aef19de", OTHER = "0xe6adf865cfaa8c66134a71dae5dcd8e028a91f2a";
const erc20: AbiEntry[] = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256" }] },
  { type: "constructor", inputs: [] },
];

describe("which functions a contract offers to read and to write", () => {
  it("reads view and pure, writes the rest, and leaves out events and the constructor", () => {
    expect(callable(erc20, "read").map((e) => e.name)).toEqual(["balanceOf", "name"]);
    expect(callable(erc20, "write").map((e) => e.name)).toEqual(["transfer", "deposit"]);
  });
});

describe("what is typed into a field", () => {
  it("reads an address, a number, a bool, bytes, a string and an array of them", () => {
    expect(parseArg({ type: "address" }, ME.toUpperCase().replace("0X", "0x"))).toBe(ME);
    expect(parseArg({ type: "uint256" }, "1000")).toBe(1000n);
    expect(parseArg({ type: "int8" }, "-5")).toBe(-5n);
    expect(parseArg({ type: "bool" }, "true")).toBe(true);
    expect(parseArg({ type: "bytes4" }, "0xa9059cbb")).toBe("0xa9059cbb");
    expect(parseArg({ type: "string" }, " hi ")).toBe(" hi ");
    expect(parseArg({ type: "uint256[]" }, "[1, 2, \"3\"]")).toEqual([1n, 2n, 3n]);
    expect(parseArg({ type: "tuple", components: [{ name: "a", type: "address" }, { name: "n", type: "uint8" }] }, JSON.stringify([ME, 7]))).toEqual([ME, 7n]);
  });
  it("says in plain words what is wrong", () => {
    expect(() => parseArg({ type: "address" }, "0x12")).toThrow(/address/i);
    expect(() => parseArg({ type: "uint8" }, "256")).toThrow(/uint8/);
    expect(() => parseArg({ type: "uint256" }, "-1")).toThrow(/uint256/);
    expect(() => parseArg({ type: "uint256" }, "1.5")).toThrow(/whole number/);
    expect(() => parseArg({ type: "bool" }, "yes")).toThrow(/true or false/);
    expect(() => parseArg({ type: "bytes4" }, "0x12")).toThrow(/bytes4/);
    expect(() => parseArg({ type: "uint256[]" }, "nope")).toThrow(/list/);
    expect(() => parseArg({ type: "uint256[2]" }, "[1]")).toThrow(/2/);
  });
});

describe("the call a field set makes", () => {
  it("encodes the way the compiler's own ABI coder does", () => {
    const e = erc20[2]!;
    expect(encodeCall(e, [OTHER, "5000"])).toBe(encodeFunctionData({ abi: [e], functionName: "transfer", args: [OTHER, 5000n] } as never));
    expect(encodeCall(erc20[1]!, [])).toBe("0x06fdde03");
  });
  it("decodes the answer into named, typed, readable values", () => {
    const out = decodeOutputs(erc20[0]!, encodeAbiParameters([{ type: "uint256" }], [995000000000000000000000n]));
    expect(out).toEqual([{ name: "", type: "uint256", value: "995000000000000000000000" }]);
    expect(decodeOutputs(erc20[1]!, encodeAbiParameters([{ type: "string" }], ["Test USD"]))[0]!.value).toBe("Test USD");
  });
  it("says so when the answer is not what the ABI says", () => {
    expect(() => decodeOutputs(erc20[0]!, "0x")).toThrow(/returned no data/);
  });
  it("shows a nested value as JSON, with its numbers as text", () => {
    expect(shown([1n, [2n, ME]])).toBe(`[1,[2,"${ME}"]]`);
  });
});

describe("decoding what is on chain with a contract's ABI", () => {
  it("reads a transaction's input", () => {
    const input = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [OTHER, 400n] } as never);
    const d = decodeInputOf(erc20, input)!;
    expect(d.name).toBe("transfer");
    expect(d.signature).toBe("transfer(address,uint256)");
    expect(d.args.map((a) => [a.name, a.type, a.value])).toEqual([["to", "address", OTHER], ["value", "uint256", "400"]]);
    expect(decodeInputOf(erc20, "0xdeadbeef")).toBeNull();
    expect(decodeInputOf(erc20, "0x")).toBeNull();
  });
  it("reads an event's topics and data", () => {
    const topic0 = toEventSelector("Transfer(address,address,uint256)");
    const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
    const d = decodeEventOf(erc20, [topic0, pad(ME), pad(OTHER)], encodeAbiParameters([{ type: "uint256" }], [400n]))!;
    expect(d.name).toBe("Transfer");
    expect(d.args.map((a) => [a.name, a.value])).toEqual([["from", ME], ["to", OTHER], ["value", "400"]]);
    expect(decodeEventOf(erc20, ["0x" + "11".repeat(32)], "0x")).toBeNull();
  });
});
