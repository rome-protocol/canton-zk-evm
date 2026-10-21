/**
 * Against a real reth. Skipped unless EXPLORER_TEST_RETH_URL is set: no CI job of this repository starts a reth for the explorer yet.
 *
 * reth must be started only through network/reth/launch.sh (discovery off), serve `trace` on its HTTP port, and hold a block, named by
 * EXPLORER_TEST_REVERT_BLOCK, with transactions that failed in this order: test/fixtures/Reverts.sol's reason(), overflow() and custom(),
 * with other transactions allowed before them. The test proves what design section 4.1 asks of the trace read: that
 * trace_replayBlockTransactions carries the revert data for Error(string), Panic(uint256) and a custom error.
 */
import { describe, expect, it } from "vitest";
import { createFinalReads } from "./reads.ts";
import { revertReason } from "./stage2.ts";

const URL_ = process.env.EXPLORER_TEST_RETH_URL;
const BLOCK = Number(process.env.EXPLORER_TEST_REVERT_BLOCK ?? "");

describe.skipIf(!URL_)("revert data on a real reth", () => {
  it("has the output of a failed transaction, for Error(string), Panic(uint256) and a custom error", async () => {
    expect(Number.isInteger(BLOCK) && BLOCK > 0, "set EXPLORER_TEST_REVERT_BLOCK to the block with the three failed transactions").toBe(true);
    const reads = createFinalReads(URL_ as string, 10_000);
    const [receipts, traces] = await Promise.all([reads.receipts(BLOCK), reads.traces(BLOCK)]);
    expect(receipts).not.toBeNull();
    expect(traces).not.toBeNull();
    expect(traces!.map((t) => t.transactionHash)).toEqual(receipts!.map((r) => r.transactionHash));
    const failed = traces!.filter((_, k) => receipts![k]!.status === 0);
    expect(failed.length).toBeGreaterThanOrEqual(3);
    const [reason, panic, custom] = failed.slice(-3);
    expect(reason!.output.startsWith("0x08c379a0")).toBe(true);
    expect(revertReason(reason!.output)).toBe("not allowed");
    expect(panic!.output.startsWith("0x4e487b71")).toBe(true);
    expect(revertReason(panic!.output)).toBe("Panic(0x11): arithmetic overflow or underflow");
    expect(custom!.output.length).toBeGreaterThan(10);
    expect(revertReason(custom!.output)).toBeNull();
    expect(failed.every((t) => t.error !== null)).toBe(true);
  });
});
