/**
 * Against a real reth. Skipped unless EXPLORER_TEST_RETH_URL is set. The rehearsal job (tests/demo_rehearsal.sh, run by .github/workflows/demo.yml)
 * runs both tests on its own chain: reth started only through network/reth/launch.sh (discovery off), blocks cut by the real builder, and the
 * real Canton.
 *
 * 1. Revert data. reth holds a block, named by EXPLORER_TEST_REVERT_BLOCK, with transactions that failed in this order: test/fixtures/Reverts.sol's
 *    reason(), overflow() and custom(), with other transactions allowed before them. The test proves what design section 4.1 asks of the trace
 *    read: that trace_replayBlockTransactions carries the revert data for Error(string), Panic(uint256) and a custom error.
 * 2. W1 (design section 9). The indexer runs over the whole chain, with reth's own blocks, Canton's own records and a database of its own, and
 *    the block named by EXPLORER_TEST_W1_BLOCK (test/fixtures/Stress.sol, filling a block under the gas cap) is timed, reads and stages apart.
 *    Needs EXPLORER_TEST_LEDGER_URL, READER_PARTY, GATEWAY_ADDRESS, CHAIN_ID and EXPLORER_TEST_DATABASE_URL. The rehearsal's proofs are stand-ins, so the
 *    pins are what the chain's first proof carries; that is the only thing the stand-in changes.
 */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createLedger } from "../ledger.ts";
import { readProofFacts } from "../proof.ts";
import { checkRequired, withDatabase } from "../db/testing.ts";
import { createIndexer, type Timing } from "./indexer.ts";
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

const LEDGER = process.env.EXPLORER_TEST_LEDGER_URL;
const W1_BLOCK = Number(process.env.EXPLORER_TEST_W1_BLOCK ?? "");
const DATABASE = process.env.EXPLORER_TEST_DATABASE_URL;

describe.skipIf(!URL_ || !LEDGER || !DATABASE)("W1: the indexer over a real chain", () => {
  checkRequired();

  it("indexes every block of the chain, and says what the worst-case block cost", async () => {
    expect(Number.isInteger(W1_BLOCK) && W1_BLOCK > 0, "set EXPLORER_TEST_W1_BLOCK to the block that Stress.sol filled").toBe(true);
    const gateway = (process.env.GATEWAY_ADDRESS ?? "").toLowerCase();
    expect(gateway).toMatch(/^0x[0-9a-f]{40}$/);
    // Stage 2 inline is the default; the measurements below are for both shapes of the design's section 4.3, so the second is run as `behind`.
    for (const shape of ["inline", "behind"] as const) {
      await withDatabase(async (pool: Pool) => {
        const { migrate } = await import("../db/migrate.ts");
        await migrate(pool);
        const reads = createFinalReads(URL_ as string, 10_000, 120_000);
        const ledger = createLedger(LEDGER as string, 10_000, process.env.READER_PARTY ?? null);
        const end = await ledger.ledgerEnd();
        const first = (await ledger.recordPages(0, end).next()).value?.[0];
        expect(first, "Canton has no block record").toBeTruthy();
        const facts = readProofFacts(first!.proofHex);
        expect(facts, "the first record's proof is not 1,344 bytes").not.toBeNull();
        const chainId = Number(process.env.CHAIN_ID);
        expect(Number.isInteger(chainId) && chainId > 0, "set CHAIN_ID to the chain's id").toBe(true);
        const timings: Timing[] = [];
        const indexer = createIndexer({
          pool, reads, ledger, pins: { programVK: facts!.programVK, rootC: facts!.rootC, file: "the first proof" }, chainId, gateway, derive: shape,
          onTiming: (t) => timings.push(t),
        });
        await indexer.open();
        try {
          const run = await indexer.runOnce();
          expect(run.state, JSON.stringify(run)).toBe("caught-up");
          if (shape === "behind") expect(await indexer.deriveOnce()).toMatchObject({ state: "caught-up" });
          const head = Number((await pool.query("select max(number) as n from blocks")).rows[0].n);
          expect(head).toBeGreaterThanOrEqual(W1_BLOCK);
          expect(Number((await pool.query("select position from cursors where stream = 'derive'")).rows[0].position)).toBe(head);

          // Section 4.1's open risk: the revert data of the failed transactions, from reth's replay.
          const reverted = (await pool.query("select revert_reason, length(revert_data) as len from tx_traces where revert_data is not null order by block_number, tx_index")).rows;
          const reasons = reverted.map((r) => r.revert_reason);
          if (Number.isInteger(BLOCK) && BLOCK > 0) {
            expect(reasons).toContain("not allowed");
            expect(reasons).toContain("Panic(0x11): arithmetic overflow or underflow");
            expect(reasons).toContain(null);
          }

          const w1 = timings.filter((t) => t.block === W1_BLOCK);
          const s1 = w1.find((t) => t.stage === 1)!;
          const s2 = w1.find((t) => t.stage === 2)!;
          const block = (await pool.query("select tx_count, log_count, gas_used from blocks where number = $1", [W1_BLOCK])).rows[0];
          const shape1 = (await pool.query(
            `select count(*) filter (where t.status = 1) as ok, count(*) filter (where t.status = 0) as failed, coalesce(sum(x.call_count), 0) as calls,
                    (select count(*) from logs l where l.block_number = $1) as logs
             from transactions t left join tx_traces x on x.block_number = t.block_number and x.tx_index = t.tx_index where t.block_number = $1`, [W1_BLOCK])).rows[0];
          console.log(`W1 ${shape} block's shape: ${shape1.ok} transactions succeeded, ${shape1.failed} failed, ${shape1.calls} internal calls, ${shape1.logs} logs`);
          expect(Number(shape1.ok), "the Stress calls must succeed, or the block is not the costly one").toBeGreaterThan(0);
          expect(Number(shape1.logs)).toBeGreaterThan(0);
          const t0 = Date.now();
          const [b, r, tr] = [await reads.block(W1_BLOCK), await reads.receipts(W1_BLOCK), await reads.traces(W1_BLOCK)];
          const readMs = Date.now() - t0;
          expect(b && r && tr).toBeTruthy();
          const t1 = Date.now();
          await reads.traces(W1_BLOCK);
          const traceMs = Date.now() - t1;
          console.log(`W1 ${shape}: block ${W1_BLOCK}, ${block.tx_count} txs, ${block.log_count} logs, ${block.gas_used} gas; `
            + `reads in stage 1 ${s1.readMs} ms (block, receipts${shape === "inline" ? ", traces" : ""}), stage 1 write ${s1.writeMs} ms, `
            + `stage 2 reads ${s2.readMs} ms, stage 2 write ${s2.writeMs} ms; all three reads again ${readMs} ms, the trace read alone ${traceMs} ms; `
            + `${timings.filter((t) => t.stage === 1).length} blocks in all`);
          // The design's budgets (section 9: B1 for stage 1, B2 for both stages), provisional for a block read over the network: a breach fails the rehearsal.
          expect(s1.readMs + s1.writeMs, "B1: stage 1 of the W1 block").toBeLessThan(1000);
          expect(s1.readMs + s1.writeMs + s2.readMs + s2.writeMs, "B2: both stages of the W1 block").toBeLessThan(3000);
        } finally {
          await indexer.close();
        }
      });
    }
  }, 600_000);
});
