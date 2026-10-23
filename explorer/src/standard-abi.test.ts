import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toEventSelector, toFunctionSelector } from "viem";
import { decodeEventOf, decodeInputOf, methodNames } from "./abi-call.ts";
import { abiOrStandard, eventsFor } from "./abi.ts";
import { STANDARD_ABI } from "./standard-abi.ts";

const word = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const A = "0x" + "ab".repeat(20), B = "0x" + "cd".repeat(20);

describe("the standard ABI", () => {
  it("holds the selectors the chains know: transfer, approve, transferFrom, safeTransferFrom, setApprovalForAll", () => {
    const names = methodNames(STANDARD_ABI);
    expect(names.get("0xa9059cbb")).toBe("transfer");
    expect(names.get("0x095ea7b3")).toBe("approve");
    expect(names.get("0x23b872dd")).toBe("transferFrom");
    expect(names.get("0x42842e0e")).toBe("safeTransferFrom");
    expect(names.get("0xa22cb465")).toBe("setApprovalForAll");
    expect(names.get("0xf242432a")).toBe("safeTransferFrom");
    expect(names.get("0xa1448194")).toBe("safeMint");
  });
  it("holds every external function and every event of the gateway source (gateway/Gateway.sol)", () => {
    const src = readFileSync(new URL("../../gateway/Gateway.sol", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    const types = (params: string) => params.split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean).join(",");
    const functions = [...src.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*external/g)].map((m) => `${m[1]}(${types(m[2] ?? "")})`);
    const events = [...src.matchAll(/event\s+(\w+)\s*\(([^)]*)\)/g)].map((m) => `${m[1]}(${types(m[2] ?? "")})`);
    expect(functions.length).toBeGreaterThanOrEqual(6);
    expect(events).toContain("Leg(uint8,bytes32,address,address,uint256,string)");
    const names = methodNames(STANDARD_ABI);
    for (const s of functions) expect(names.get(toFunctionSelector(s)), s).toBe(s.slice(0, s.indexOf("(")));
    const topics = new Set(STANDARD_ABI.filter((e) => e.type === "event").map((e) => toEventSelector(`${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`)));
    for (const s of events) expect(topics.has(toEventSelector(s)), s).toBe(true);
  });
  it("names the OpenZeppelin burn(uint256) and burnFrom(address,uint256) that ERC20Burnable and ERC721Burnable carry", () => {
    const names = methodNames(STANDARD_ABI);
    expect(names.get("0x42966c68")).toBe("burn");
    expect(names.get("0x79cc6790")).toBe("burnFrom");
  });
  it("holds the proxy events of EIP-1967", () => {
    const ev = new Set(STANDARD_ABI.filter((e) => e.type === "event").map((e) => e.name));
    for (const n of ["Upgraded", "AdminChanged", "BeaconUpgraded"]) expect(ev.has(n)).toBe(true);
    expect(STANDARD_ABI.some((e) => e.type === "function" && e.name === "proxiableUUID")).toBe(true);
  });
  it("lists no entry twice", () => {
    const keys = STANDARD_ABI.map((e) => `${e.type}:${e.name}(${(e.inputs ?? []).map((i) => i.type + (i.indexed ? "!" : "")).join(",")})`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("reading with the standard ABI", () => {
  it("decodes a real ERC-20 transfer input", () => {
    const input = "0xa9059cbb" + word(B) + word((5_000n * 10n ** 10n).toString(16));
    const d = decodeInputOf(STANDARD_ABI, input);
    expect(d?.name).toBe("transfer");
    expect(d?.signature).toBe("transfer(address,uint256)");
    expect(d?.args.map((a) => a.value)).toEqual([B, "50000000000000"]);
    expect(d?.args.map((a) => a.name)).toEqual(["to", "value"]);
  });
  it("decodes a real ERC-20 Transfer log (two indexed topics)", () => {
    const topics = [toEventSelector("Transfer(address,address,uint256)"), "0x" + word(A), "0x" + word(B)];
    const d = decodeEventOf(eventsFor(STANDARD_ABI, topics.length), topics, "0x" + word("1388"));
    expect(d?.name).toBe("Transfer");
    expect(d?.args.map((a) => [a.name, a.value])).toEqual([["from", A], ["to", B], ["value", "5000"]]);
  });
  it("tells the same Transfer of an ERC-721 (three indexed topics) from an ERC-20's", () => {
    const topics = [toEventSelector("Transfer(address,address,uint256)"), "0x" + word(A), "0x" + word(B), "0x" + word("3")];
    const d = decodeEventOf(eventsFor(STANDARD_ABI, topics.length), topics, "0x");
    expect(d?.args.map((a) => [a.name, a.value])).toEqual([["from", A], ["to", B], ["tokenId", "3"]]);
  });
  it("gives null for a selector or topic it does not hold", () => {
    expect(decodeInputOf(STANDARD_ABI, "0x12345678" + word("1"))).toBeNull();
    expect(decodeEventOf(eventsFor(STANDARD_ABI, 1), ["0x" + "11".repeat(32)], "0x")).toBeNull();
  });
});

describe("abiOrStandard", () => {
  it("is the verified ABI when there is one, and the standard one when there is none", () => {
    const verified = [{ type: "function", name: "ping", inputs: [] }];
    expect(abiOrStandard(verified)).toBe(verified);
    expect(abiOrStandard([])).toBe(STANDARD_ABI);
    expect(abiOrStandard(null)).toBe(STANDARD_ABI);
    expect(abiOrStandard(undefined)).toBe(STANDARD_ABI);
  });
});
