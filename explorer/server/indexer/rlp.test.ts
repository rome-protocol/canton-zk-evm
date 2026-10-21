import { describe, expect, it } from "vitest";
import { keccak256, serializeTransaction } from "viem";
import { IndexerStop } from "./errors.ts";
import { transactionHashes } from "./rlp.ts";

const SIG = { r: ("0x" + "11".repeat(32)) as `0x${string}`, s: ("0x" + "22".repeat(32)) as `0x${string}` };
const to = ("0x" + "ab".repeat(20)) as `0x${string}`;
const legacy = serializeTransaction({ type: "legacy", chainId: 770101, nonce: 1, gasPrice: 7n, gas: 21000n, to, value: 5n }, { ...SIG, v: 1540239n });
const typed = serializeTransaction({ type: "eip1559", chainId: 770101, nonce: 2, maxFeePerGas: 9n, maxPriorityFeePerGas: 1n, gas: 21000n, to, value: 6n, data: "0x" + "ff".repeat(100) as `0x${string}` }, { ...SIG, yParity: 1 });
const list = (...items: string[]) => {
  // The RLP list of the given items: a legacy one goes in as it is, a typed one as a byte string.
  const enc = (h: string, isLegacy: boolean) => {
    const b = Buffer.from(h.slice(2), "hex");
    if (isLegacy) return b;
    const head = b.length < 56 ? Buffer.from([0x80 + b.length]) : b.length < 256 ? Buffer.from([0xb8, b.length]) : Buffer.from([0xb9, b.length >> 8, b.length & 255]);
    return Buffer.concat([head, b]);
  };
  const body = Buffer.concat(items.map((h) => enc(h, h === legacy)));
  const n = body.length;
  const head = n < 56 ? Buffer.from([0xc0 + n]) : n < 256 ? Buffer.from([0xf8, n]) : Buffer.from([0xf9, n >> 8, n & 255]);
  return Buffer.concat([head, body]).toString("hex");
};

describe("the transaction hashes in a block record", () => {
  it("is empty for a block with no transactions", () => {
    expect(transactionHashes("", 1)).toEqual([]);
  });

  it("hashes a legacy transaction whole and a typed one by its content, in order", () => {
    expect(transactionHashes(list(legacy, typed, legacy), 1)).toEqual([keccak256(legacy), keccak256(typed), keccak256(legacy)]);
  });

  it("stops, naming check C3, on a list that is cut short or has bytes after it", () => {
    const good = list(legacy, typed);
    for (const bad of [good.slice(0, -4), good + "00", "80", "zz".repeat(3).replace(/z/g, "0")]) {
      expect(() => transactionHashes(bad, 9)).toThrow(IndexerStop);
    }
    try { transactionHashes(good.slice(0, -4), 9); } catch (e) { expect((e as IndexerStop).check).toBe("C3"); expect((e as IndexerStop).block).toBe(9); }
  });
});
