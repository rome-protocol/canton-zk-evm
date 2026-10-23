/**
 * The FatReturn token of the W1 flood (test/fixtures/Flood.sol) must be able to answer what it is there to show: a read whose answer is longer than 4 KB. A read pays
 * its intrinsic gas (21,000 plus 16 for each non-zero byte of calldata and 4 for each zero one) and then memory expansion, 3 gas a 32-byte word plus words^2 / 512, out of
 * the default 100,000: the longest read, `balanceOf` (36 bytes of calldata), leaves room for about 179 KB; the fixture keeps 170 KB for a margin. The fixture once returned 700,000 bytes, which costs about
 * 1 Mgas, and its reads ran out of gas: the flood counted them as failed for that reason and never met the answer bound at all.
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
  it("answers within the gas of every read it gets (metadata and balanceOf), so that its failure is the answer bound and not an out-of-gas", () => {
    // A 4-byte selector, and the worst 36 bytes: balanceOf of an address whose 12 padding bytes are zero and whose 20 bytes are not.
    const calldataGas = (zero: number, nonZero: number) => 4 * zero + 16 * nonZero;
    for (const [name, gas] of [["a metadata read", calldataGas(0, 4)], ["balanceOf", calldataGas(12, 24)]] as const)
      expect(21_000 + gas + memoryGas(returned()) + 6, name).toBeLessThan(DEFAULT_READ_CALL_GAS * 0.95);
  });
  it("is the 170 KB the docs name", () => {
    expect(returned()).toBe(170_000);
  });
});
