import { describe, expect, it } from "vitest";
import { pinsAt } from "./pins.ts";

const A = "0x" + "aa".repeat(32), B = "0x" + "bb".repeat(32), C = "0x" + "cc".repeat(32), D = "0x" + "dd".repeat(32);

describe("pinsAt", () => {
  it("is the one key when the server sends no ranges", () => {
    expect(pinsAt({ programVK: A, rootC: B, file: "p.txt" }, 99)).toEqual({ fromBlock: 0, programVK: A, rootC: B, file: "p.txt" });
  });
  it("takes the last range that starts at or before the block", () => {
    const pins = { programVK: C, rootC: D, file: "p.txt", keys: [{ fromBlock: 0, programVK: A, rootC: B }, { fromBlock: 500, programVK: C, rootC: D }] };
    expect(pinsAt(pins, 0).programVK).toBe(A);
    expect(pinsAt(pins, 499).programVK).toBe(A);
    expect(pinsAt(pins, 500)).toEqual({ fromBlock: 500, programVK: C, rootC: D, file: "p.txt" });
    expect(pinsAt(pins, 9000).rootC).toBe(D);
  });
});
