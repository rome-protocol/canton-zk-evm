/**
 * Against a real reth. Skipped unless EXPLORER_TEST_RETH_URL is set. The rehearsal job (tests/demo_rehearsal.sh, run by .github/workflows/demo.yml)
 * runs both tests on its own chain: reth started only through network/reth/launch.sh (discovery off), blocks cut by the real builder, and the
 * real Canton.
 *
 * 1. Revert data. reth holds a block, named by EXPLORER_TEST_REVERT_BLOCK, with transactions that failed in this order: test/fixtures/Reverts.sol's
 *    reason(), overflow() and custom(), with other transactions allowed before them. The test proves what design section 4.1 asks of the trace
 *    read: that trace_replayBlockTransactions carries the revert data for Error(string), Panic(uint256) and a custom error.
 * 2. The trace reading (design sections 4.3 and 5.2). reth holds the blocks of test/fixtures/Lab.sol, named by EXPLORER_TEST_LAB (the address),
 *    EXPLORER_TEST_LAB_BUILD_BLOCK, EXPLORER_TEST_LAB_UNDONE_BLOCK and EXPLORER_TEST_LAB_KILL_BLOCK: contracts made with CREATE and CREATE2, clones, a
 *    contract made and destroyed in one transaction, a failed creation, work a failing parent undid, a self-destruct in a later block, and a proxy of
 *    each kind. The test indexes the chain and checks the internal calls, contracts and proxies reth's own traces give, then reads blocks again.
 *    Needs the same ledger and database variables as W1.
 * 3. W1 (docs/METRICS.md, "The indexer on a real chain (W1)"). The indexer runs over the whole chain, with reth's own blocks, Canton's own records and a database of its own, and
 *    the block named by EXPLORER_TEST_W1_BLOCK (test/fixtures/Stress.sol, filling a block under the gas cap) is timed, reads and stages apart.
 *    Needs EXPLORER_TEST_LEDGER_URL, READER_PARTY, GATEWAY_ADDRESS, CHAIN_ID and EXPLORER_TEST_DATABASE_URL. The rehearsal's proofs are stand-ins, so the
 *    pins are what the chain's first proof carries; that is the only thing the stand-in changes.
 */
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { B1_MS, B2_MS, B2_RUNNER_MS } from "../../test/budgets.ts";
import type { Pool } from "pg";
import { createLedger } from "../ledger.ts";
import { readProofFacts } from "../proof.ts";
import { checkRequired, withDatabase } from "../db/testing.ts";
import { createIndexer, type Timing } from "./indexer.ts";
import { createFinalReads } from "./reads.ts";
import { reindexRange } from "./reindex.ts";
import { revertReason, stage2 } from "./stage2.ts";

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

const LAB = (process.env.EXPLORER_TEST_LAB ?? "").toLowerCase();
const LAB_BUILD = Number(process.env.EXPLORER_TEST_LAB_BUILD_BLOCK ?? "");
const LAB_UNDONE = Number(process.env.EXPLORER_TEST_LAB_UNDONE_BLOCK ?? "");
const LAB_KILL = Number(process.env.EXPLORER_TEST_LAB_KILL_BLOCK ?? "");
const MADE = keccak256(toHex("Made(uint8,address)"));
const bytea = (a: string) => Buffer.from(a.replace(/^0x/, ""), "hex");

describe.skipIf(!URL_ || !LEDGER || !DATABASE || !LAB)("the trace reading, on a real reth", () => {
  checkRequired();

  it("finds the contracts, destructions, failed calls and proxies reth reports, and counts nothing twice when blocks are read again", async () => {
    expect([LAB_BUILD, LAB_UNDONE, LAB_KILL].every((n) => Number.isInteger(n) && n > 0), "set the three EXPLORER_TEST_LAB_*_BLOCK variables").toBe(true);
    const gateway = (process.env.GATEWAY_ADDRESS ?? "").toLowerCase();
    expect(gateway).toMatch(/^0x[0-9a-f]{40}$/);
    const reads = createFinalReads(URL_ as string, 10_000, 120_000);
    // What Lab made, from its own events: kind -> address.
    const made = new Map<number, string>();
    for (const r of (await reads.receipts(LAB_BUILD))!) {
      for (const l of r.logs) if (l.address.toLowerCase() === LAB && l.topics[0] === MADE) made.set(Number(BigInt(l.topics[1]!)), "0x" + l.data.slice(-40));
    }
    expect([...made.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await withDatabase(async (pool: Pool) => {
      const { migrate } = await import("../db/migrate.ts");
      await migrate(pool);
      const ledger = createLedger(LEDGER as string, 10_000, process.env.READER_PARTY ?? null);
      const end = await ledger.ledgerEnd();
      const first = (await ledger.recordPages(0, end).next()).value?.[0];
      expect(first, "Canton has no block record").toBeTruthy();
      const facts = readProofFacts(first!.proofHex);
      expect(facts, "the first record's proof is not 1,344 bytes").not.toBeNull();
      const chainId = Number(process.env.CHAIN_ID);
      const indexer = createIndexer({ pool, reads, ledger, pins: { programVK: facts!.programVK, rootC: facts!.rootC, file: "the first proof", keys: [{ fromBlock: 0, programVK: facts!.programVK, rootC: facts!.rootC }] }, chainId, gateway, derive: "inline" });
      await indexer.open();
      try {
        const run = await indexer.runOnce();
        expect(run.state, JSON.stringify(run)).toBe("caught-up");
        const one = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
        const contract = async (kind: number) => (await one(
          "select encode(creator, 'hex') as creator, origin, creation_block::text as block, destroyed_block::text as destroyed, creation_trace_address::text as path, encode(runtime_code_hash, 'hex') as rh from contracts where address = $1",
          [bytea(made.get(kind)!)]))[0];

        // Every kind is a contract made by Lab, in the block of build(), at a place in the call tree.
        for (const kind of made.keys()) {
          expect(await contract(kind), `kind ${kind}`).toMatchObject({ creator: LAB.slice(2), origin: "create", block: String(LAB_BUILD) });
          expect((await contract(kind))!.path, `kind ${kind}`).toMatch(/^\{\d+(,\d+)*\}$/);
        }
        expect(Number((await one("select count(*) as n from contracts where creation_block = $1", [LAB_BUILD]))[0].n), "the failed creation made no contract").toBe(12);
        // The code is shared: two clones of one implementation, two proxies of one kind, two children.
        expect((await contract(3))!.rh).toBe((await contract(4))!.rh);
        expect((await contract(6))!.rh).toBe((await contract(7))!.rh);
        expect((await contract(1))!.rh).toBe((await contract(2))!.rh);
        expect((await contract(1))!.rh).not.toBe((await contract(6))!.rh);

        // Destruction. Made and destroyed in one transaction: the code is gone, in that block. Destroyed later: marked only if reth no longer holds the code.
        expect((await contract(5))!.destroyed).toBe(String(LAB_BUILD));
        expect(await reads.code(made.get(5)!, LAB_BUILD)).toBe("0x");
        const keptCode = (await reads.code(made.get(12)!, LAB_KILL)) !== "0x";
        console.log(`self-destruct outside the creation transaction: reth ${keptCode ? "keeps" : "removes"} the code`);
        expect((await contract(12))!.destroyed).toBe(keptCode ? null : String(LAB_KILL));
        const calls = await one("select call_type, encode(from_address, 'hex') as f, error from internal_calls where block_number = $1 order by tx_index, trace_address", [LAB_BUILD]);
        expect(calls.some((c) => c.call_type === "selfdestruct" && c.f === made.get(5)!.slice(2))).toBe(true);
        expect(calls.filter((c) => c.call_type === "create" && c.error !== null).length, "the creation that failed").toBeGreaterThanOrEqual(1);
        expect((await one("select count(*) as n from internal_calls where block_number = $1 and call_type = 'selfdestruct'", [LAB_KILL]))[0].n).toBe("1");

        // Work a failing parent undid: nothing made, and every call that is kept says it failed.
        expect((await one("select count(*) as n from contracts where creation_block = $1", [LAB_UNDONE]))[0].n).toBe("0");
        const undone = await one("select error from internal_calls where block_number = $1", [LAB_UNDONE]);
        expect(undone.length).toBeGreaterThan(0);
        expect(undone.every((c) => c.error !== null)).toBe(true);

        // Proxies: each kind, with its implementation, and nothing else.
        const proxy = async (kind: number) => (await one("select kind, encode(implementation, 'hex') as i, encode(beacon, 'hex') as b, checked_block::text as c from proxies where proxy = $1", [bytea(made.get(kind)!)]))[0];
        const impl = made.get(11)!.slice(2);
        expect(await proxy(3)).toEqual({ kind: "eip1167", i: impl, b: null, c: String(LAB_BUILD) });
        expect(await proxy(4)).toEqual({ kind: "eip1167", i: impl, b: null, c: String(LAB_BUILD) });
        expect(await proxy(6)).toEqual({ kind: "eip1967", i: impl, b: null, c: String(LAB_BUILD) });
        expect(await proxy(7)).toEqual({ kind: "eip1967", i: impl, b: null, c: String(LAB_BUILD) });
        expect(await proxy(9)).toEqual({ kind: "beacon", i: impl, b: made.get(8)!.slice(2), c: String(LAB_BUILD) });
        expect(await proxy(10)).toEqual({ kind: "eip1822", i: impl, b: null, c: String(LAB_BUILD) });
        for (const kind of [1, 2, 5, 8, 11, 12]) expect(await proxy(kind), `kind ${kind} is not a proxy`).toBeUndefined();
        expect((await one("select count(*) as n from proxies", []))[0].n).toBe("6");

        // Blocks read again count nothing twice: the reader's updates again, a reindex of the blocks, and stage 2's own guard.
        const snapshot = async () => ({
          contracts: await one("select encode(address, 'hex') as a, creation_block, destroyed_block, interaction_count, last_interaction_block from contracts order by address", []),
          proxies: await one("select encode(proxy, 'hex') as proxy, kind, encode(implementation, 'hex') as i, encode(beacon, 'hex') as b, checked_block from proxies order by proxy", []),
          addresses: await one("select encode(address, 'hex') as address, first_seen_block, last_active_block, sent_count, received_count, internal_count, is_contract from addresses order by address", []),
          calls: (await one("select count(*) as n from internal_calls", []))[0].n,
        });
        const before = await snapshot();
        await pool.query("update cursors set position = 0, detail = null where stream = 'reader_updates'");
        expect((await indexer.runOnce()).state).toBe("caught-up");
        expect(await snapshot()).toEqual(before);
        await reindexRange({ pool, reads, gateway }, LAB_BUILD, LAB_KILL);
        expect(await snapshot()).toEqual(before);
        const c = await pool.connect();
        try {
          await c.query("begin");
          expect(await stage2(c, LAB_BUILD, (await reads.traces(LAB_BUILD))!, reads)).toEqual({ derived: false });
          await c.query("commit");
        } finally {
          c.release();
        }
        expect(await snapshot()).toEqual(before);
      } finally {
        await indexer.close();
      }
    });
  }, 600_000);
});

describe.skipIf(!URL_ || !LEDGER || !DATABASE)("W1: the indexer over a real chain", () => {
  checkRequired();

  it("indexes every block of the chain, and says what the worst-case block cost", async () => {
    expect(Number.isInteger(W1_BLOCK) && W1_BLOCK > 0, "set EXPLORER_TEST_W1_BLOCK to the block that Stress.sol filled").toBe(true);
    const gateway = (process.env.GATEWAY_ADDRESS ?? "").toLowerCase();
    expect(gateway).toMatch(/^0x[0-9a-f]{40}$/);
    // Stage 2 `behind` is the default (W1's worst-case block takes more than B1 for both stages together inline, see docs/METRICS.md); the measurements below are for both
    // shapes of stage 2 (`inline` and `behind`), and the budgets are asserted for the default, `behind`.
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
          pool, reads, ledger, pins: { programVK: facts!.programVK, rootC: facts!.rootC, file: "the first proof", keys: [{ fromBlock: 0, programVK: facts!.programVK, rootC: facts!.rootC }] }, chainId, gateway, derive: shape,
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
          // The token traffic of the block (test/fixtures/Flood.sol): ERC-20 transfers to new holders, ERC-1155 batches, and tokens made in the block. Without it
          // stage 2's token path would not be in the time that sets INDEX_DERIVE.
          const tok = (await pool.query(
            `select (select count(*) from token_transfers where block_number = $1) as transfers,
                    (select count(*) from token_transfers where block_number = $1 and token_id is not null) as nft_legs,
                    (select count(*) from tokens where first_transfer_block = $1) as tokens,
                    (select count(*) from tokens where first_transfer_block = $1 and metadata_status = 'read') as read,
                    (select count(*) from tokens where first_transfer_block = $1 and metadata_status = 'failed') as failed,
                    (select count(distinct to_address) from token_transfers where block_number = $1) as holders`, [W1_BLOCK])).rows[0];
          console.log(`W1 ${shape} block's token traffic: ${tok.transfers} transfers (${tok.nft_legs} ERC-1155 legs) to ${tok.holders} accounts, ${tok.tokens} new tokens, ${tok.read} with their metadata read, ${tok.failed} failed (the Burners and the FatReturn)`);
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
          // After the timings are said, so that a run that falls short of the shape still prints them.
          expect(Number(tok.transfers), "the Flood calls must succeed, or the block has no token traffic").toBeGreaterThanOrEqual(70_000);
          expect(Number(tok.nft_legs), "the shared-array batches must succeed").toBeGreaterThanOrEqual(70_000);
          expect(Number(tok.read), "the new tokens' metadata must be read in the block").toBeGreaterThanOrEqual(6);
          expect(Number(tok.failed), "the Burners' reads spend all the gas they get and the FatReturn's answer is over 4 KB: all four are read as failed, and stage 2 goes on").toBeGreaterThanOrEqual(4);
          // The budgets (docs/DESIGN.md, Budgets: B1 for stage 1, B2 for both stages; docs/METRICS.md, 'B1 and B2 on the reference machine and on the runner'), provisional for a block read over the network: a breach fails the rehearsal.
          // They are asserted for `behind`, the default. `inline` is measured and said above; it would become the default only if both its stages fit B1, and they do not.
          // B2 is the reference-machine budget; this test runs on GitHub's shared runner, so it is a regression check held to B2_RUNNER_MS, 1.25 x B2
          // (docs/METRICS.md). Both numbers and the measured sum are said, so a reader sees how far the run is from each.
          if (shape === "behind") {
            const b1Ms = s1.readMs + s1.writeMs;
            const b2Sum = b1Ms + s2.readMs + s2.writeMs;
            console.log(`W1 behind: B1 ${b1Ms} ms of ${B1_MS}; B2 ${b2Sum} ms against the budget ${B2_MS} (reference machine) and the runner tolerance ${B2_RUNNER_MS}`);
            expect(b1Ms, "B1: stage 1 of the W1 block").toBeLessThan(B1_MS);
            expect(b2Sum, `B2 runner tolerance (budget ${B2_MS} ms on the reference machine): both stages of the W1 block`).toBeLessThan(B2_RUNNER_MS);
          }
        } finally {
          await indexer.close();
        }
      });
    }
  }, 600_000);
});
