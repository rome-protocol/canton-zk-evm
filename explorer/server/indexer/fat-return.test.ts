/**
 * The FatReturn token of the W1 flood (test/fixtures/Flood.sol) must be able to answer what it is there to show: a read whose answer is longer than 4 KB. Memory
 * expansion costs 3 gas a 32-byte word plus words^2 / 512, so a read with the default 100,000 gas can return about 220 KB at most; the fixture once returned 700,000
 * bytes, which costs about 1 Mgas, and its reads ran out of gas: the flood counted them as failed for that reason and never met the answer bound at all.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_READ_CALL_GAS, MAX_READ_ANSWER_BYTES } from "./reads.ts";

const memoryGas = (bytes: number) => { const words = Math.ceil(bytes / 32); return 3 * words + Math.floor((words * words) / 512); };
const source = readFileSync(new URL("../../test/fixtures/Flood.sol", import.meta.url), "utf8");

/** The size the fixture's runtime code returns: its PUSH3 operand, in `mstore(0, shl(200, 0x62<size>6000f3))`. */
const returned = (): number => {
  const m = /shl\(200, 0x62([0-9a-f]{6})6000f3\)/.exec(source);
  if (!m) throw new Error("the FatReturn runtime code is not where this test reads it");
  return parseInt(m[1]!, 16);
};

describe("the FatReturn fixture", () => {
  it("answers more than the 4 KB a read may carry", () => {
    expect(returned()).toBeGreaterThan(MAX_READ_ANSWER_BYTES);
  });
  it("answers within the gas of a read, so that its failure is the answer bound and not an out-of-gas", () => {
    expect(memoryGas(returned())).toBeLessThan(DEFAULT_READ_CALL_GAS * 0.9);
  });
  it("is the 180 KB the docs name", () => {
    expect(returned()).toBe(180_000);
  });
});
