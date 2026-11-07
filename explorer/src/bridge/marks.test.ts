import { describe, expect, it } from "vitest";
import type { ApiTx } from "../api.ts";
import { FINAL_MARKS, marksOf, merge, NO_MARKS } from "./marks.ts";

const tx = (o: Record<string, unknown>) => ({ status: "waiting", success: null, lifecycle: null, block: null, legs: [], ...o }) as unknown as ApiTx;
const lifecycle = (proofEndedAt: string | null) => ({ state: "x", reason: null, acceptedAt: null, acceptedVia: null, includedAt: null, attempts: 1, leftOutReason: null, proofStartedAt: "2026-11-07T10:00:00Z", proofEndedAt, submittedAt: null, committedAt: null, finalAt: null, finalBlock: null, timeToFinalMs: null });

describe("the marks of a move, from the explorer's own answer", () => {
  it("has none before the transaction is sent, and Sent once the wallet has given its hash", () => {
    expect(marksOf(null, false)).toEqual(NO_MARKS);
    expect(marksOf(null, true)).toEqual({ ...NO_MARKS, sent: true });
  });
  it("is Sent while the transaction waits in the pool", () => {
    expect(marksOf(tx({ status: "waiting" }), true)).toEqual({ ...NO_MARKS, sent: true });
  });
  it("is Sent, not yet Proven, while its block is being proven, and names the block", () => {
    expect(marksOf(tx({ status: "proving", block: { number: 7, hash: null, updateId: null }, lifecycle: lifecycle(null) }), true)).toEqual({ sent: true, proven: false, final: false, block: 7, updateId: null });
  });
  it("is Proven once the block's proof has ended, before Canton holds the block", () => {
    expect(marksOf(tx({ status: "proving", block: { number: 7, hash: null, updateId: null }, lifecycle: lifecycle("2026-11-07T10:00:07Z") }), true)).toEqual({ sent: true, proven: true, final: false, block: 7, updateId: null });
  });
  it("is Proven, and not yet Final, for a block Canton holds that the explorer has not indexed", () => {
    expect(marksOf(tx({ status: "unindexed", block: { number: 7, hash: null, updateId: "u1" } }), true)).toMatchObject({ sent: true, proven: true, final: false, block: 7, updateId: "u1" });
  });
  it("is Final when the block is final on Canton, with the Canton update that holds it", () => {
    expect(marksOf(tx({ status: "final", success: true, block: { number: 7, hash: null, updateId: "u1" } }), true)).toEqual({ sent: true, proven: true, final: true, block: 7, updateId: "u1" });
  });
  it("takes the Canton update from the transaction's leg when the block does not name it", () => {
    const leg = { updateId: "u9" };
    expect(marksOf(tx({ status: "final", success: true, block: { number: 7, hash: null, updateId: null }, legs: [leg] }), true).updateId).toBe("u9");
  });
  it("is not Final when the transaction failed, and has no block or proof when it was replaced or dropped", () => {
    expect(marksOf(tx({ status: "final", success: false, block: { number: 7, hash: null, updateId: "u1" } }), true).final).toBe(false);
    for (const status of ["replaced", "dropped"]) expect(marksOf(tx({ status, block: { number: 7, hash: null, updateId: null }, lifecycle: lifecycle("2026-11-07T10:00:07Z") }), true)).toEqual({ ...NO_MARKS, sent: true });
  });
  it("keeps a mark once it was reached, and takes the newer block", () => {
    const seen = merge({ ...NO_MARKS, sent: true, proven: true, block: 7 }, { ...NO_MARKS, sent: true });
    expect(seen).toEqual({ sent: true, proven: true, final: false, block: 7, updateId: null });
    expect(merge(seen, FINAL_MARKS(8, "u2"))).toEqual({ sent: true, proven: true, final: true, block: 8, updateId: "u2" });
  });
});
