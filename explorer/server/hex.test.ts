/**
 * The byte-string check has no stack limit: a regular expression with a group in a loop (`^(?:[0-9a-f]{2})*$` with a capture) runs out of
 * stack past about 4 MB of input in V8, and a 5 MB answer would then read as a crash, not as bad data. reth's answers can be 32 MB.
 */
import { describe, expect, it } from "vitest";
import { isHexBytes } from "./hex.ts";

describe("isHexBytes", () => {
  it("takes whole bytes, with or without the prefix as asked", () => {
    expect(isHexBytes("0x")).toBe(true);
    expect(isHexBytes("0xabcd09")).toBe(true);
    expect(isHexBytes("0xabc")).toBe(false);
    expect(isHexBytes("abcd")).toBe(false);
    expect(isHexBytes("0xABCD")).toBe(false);
    expect(isHexBytes("0xABCD", { upper: true })).toBe(true);
    expect(isHexBytes("0xabcg")).toBe(false);
    expect(isHexBytes("abcd", { prefix: "none" })).toBe(true);
    expect(isHexBytes("0xabcd", { prefix: "none" })).toBe(false);
    expect(isHexBytes("0xabcd", { prefix: "optional" })).toBe(true);
    expect(isHexBytes("abcd", { prefix: "optional" })).toBe(true);
    expect(isHexBytes("", { prefix: "none" })).toBe(true);
    expect(isHexBytes("", { prefix: "none", empty: false })).toBe(false);
    expect(isHexBytes("0x", { empty: false })).toBe(false);
    expect(isHexBytes("0x\n")).toBe(false);
  });

  it("does not run out of stack on 40 MB, and still says no to one bad digit at the end", () => {
    const big = "0x" + "ab".repeat(20 * 1024 * 1024);
    expect(isHexBytes(big)).toBe(true);
    expect(isHexBytes(big + "zz")).toBe(false);
    expect(isHexBytes(big.slice(0, -1))).toBe(false);
  });

  it("is what the readers use: a regex with a group in a loop throws on this input", () => {
    const big = "0x" + "ab".repeat(8 * 1024 * 1024);
    expect(() => /^0x([0-9a-f]{2})*$/.test(big)).toThrow(RangeError);
  });
});
