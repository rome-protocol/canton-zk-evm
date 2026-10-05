import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePins } from "./config.ts";
import { checkProofFacts, PROOF_BYTES, readProofFacts } from "./proof.ts";

const repo = (p: string) => new URL(`../../${p}`, import.meta.url);
const recorded = readFileSync(repo("demo/results/run1-proof.hex"), "utf8").trim();
const run1 = readFileSync(repo("demo/results/run1.txt"), "utf8");
const BLOCK_HASH = /^block_hash=(.*)$/m.exec(run1)![1]!;
const pins = parsePins(readFileSync(repo("prover/fixtures/session.txt"), "utf8"), "session.txt");

describe("the facts a proof carries", () => {
  it("reads the program key, the ZisK release and the block hash from the recorded proof, and they are this chain's pins", () => {
    expect(PROOF_BYTES).toBe(1344);
    const facts = readProofFacts(recorded);
    expect(facts).toEqual({ programVK: pins.programVK, rootC: pins.rootC, blockHash: BLOCK_HASH });
    expect(checkProofFacts(facts!, pins, BLOCK_HASH)).toEqual({
      programVK: { value: pins.programVK, ok: true }, rootC: { value: pins.rootC, ok: true }, blockHash: { value: BLOCK_HASH, ok: true },
    });
  });

  it("shows the value it read and says no when the pins are other pins", () => {
    const other = { ...pins, programVK: "0x" + "ab".repeat(32), rootC: "0x" + "cd".repeat(32) };
    const c = checkProofFacts(readProofFacts(recorded)!, other, BLOCK_HASH);
    expect(c.programVK).toEqual({ value: pins.programVK, ok: false });
    expect(c.rootC).toEqual({ value: pins.rootC, ok: false });
    expect(c.blockHash.ok).toBe(true);
  });

  it("says no when the proof commits to another block than the one asked about", () => {
    expect(checkProofFacts(readProofFacts(recorded)!, pins, "0x" + "00".repeat(32)).blockHash).toEqual({ value: BLOCK_HASH, ok: false });
  });

  it("reads no block hash from public values that do not have the one valid layout, such as the rehearsal's stand-in", () => {
    const standIn = readProofFacts("ee".repeat(PROOF_BYTES));
    expect(standIn).toEqual({ programVK: "0x" + "ee".repeat(32), rootC: "0x" + "ee".repeat(32), blockHash: null });
    expect(checkProofFacts(standIn!, pins, BLOCK_HASH)).toMatchObject({ blockHash: { value: null, ok: false }, programVK: { ok: false } });
    // One slot with a non-zero upper half, and a hash followed by something other than zeros, are both refused too.
    const flipped = recorded.slice(0, 1664 + 8) + "01" + recorded.slice(1664 + 10);
    expect(readProofFacts(flipped)?.blockHash).toBeNull();
    const trailing = recorded.slice(0, 2688 - 16) + "01000000" + recorded.slice(2688 - 8);
    expect(readProofFacts(trailing)?.blockHash).toBeNull();
  });

  it("reads nothing from a proof that is not 1,344 bytes of lowercase hex", () => {
    expect(readProofFacts(recorded.slice(2))).toBeNull();
    expect(readProofFacts(recorded + "00")).toBeNull();
    expect(readProofFacts("")).toBeNull();
    expect(readProofFacts(recorded.toUpperCase())).toBeNull();
    expect(readProofFacts("zz" + recorded.slice(2))).toBeNull();
  });
});
