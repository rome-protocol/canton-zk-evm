import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain, type SyntheticChain } from "../../test/synthetic-chain.ts";
import { createIndexer, type Indexer } from "./indexer.ts";
import { createJournal, joinAttempts, parseLine } from "./journal.ts";
import { RUN1, RUN2, RUN3, Run, appendLines, iso, makeFolder, putFile, removeFolders } from "./journal-fixtures.ts";

afterAll(removeFolders);

const opened: Indexer[] = [];
async function inDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  await withDatabase(async (pool) => {
    try {
      await migrate(pool);
      await fn(pool);
    } finally {
      for (const i of opened.splice(0)) await i.close().catch(() => undefined);
    }
  });
}
async function start(pool: Pool, chain: SyntheticChain, over: Partial<Parameters<typeof createIndexer>[0]> = {}): Promise<Indexer> {
  const ix = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline", ...over });
  opened.push(ix);
  await ix.open();
  return ix;
}
const hb = (h: string) => Buffer.from(h.slice(2), "hex");
const one = async (pool: Pool, sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];
const count = async (pool: Pool, table: string) => Number((await one(pool, `select count(*) as n from ${table}`)).n);
const health = async (pool: Pool, id: string) => one(pool, "select status, value, detail from health_checks where check_id = $1", [id]);
const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);
const loader = (pool: Pool, folder: string | null) => createJournal({ pool, folder });
const lifecycle = (pool: Pool, hash: string) => one(pool, "select * from tx_lifecycle where tx_hash = $1", [hb(hash)]);

describe("a journal line", () => {
  it("is format 1 with a run, a sequence, a time and an event; anything else is told apart", () => {
    const ok = JSON.stringify({ v: 1, run: RUN1, seq: 3, time: "2026-10-21T00:00:00.000Z", event: "pool", waiting: 2 });
    expect(parseLine(ok)).toMatchObject({ line: { event: "pool", seq: 3 } });
    expect(parseLine("{\"v\":1,\"run\":\"" + RUN1)).toEqual({ bad: "malformed" });
    expect(parseLine(JSON.stringify({ v: 2, run: RUN1, seq: 1, time: "2026-10-21T00:00:00.000Z", event: "x" }))).toEqual({ bad: "version" });
    expect(parseLine(JSON.stringify({ v: 1, run: "not-a-uuid", seq: 1, time: "2026-10-21T00:00:00.000Z", event: "x" }))).toEqual({ bad: "malformed" });
    expect(parseLine("[1]")).toEqual({ bad: "malformed" });
    // A time that is not a moment after 1970 (no time, an unreadable one, the epoch itself, a date before it) is no line: the rollups and the pages would carry it as a date.
    for (const time of [undefined, "", "yesterday", "1970-01-01T00:00:00.000Z", "1969-12-31T23:59:59.999Z", "0001-01-01T00:00:00.000Z", 1792784000000])
      expect(parseLine(JSON.stringify({ v: 1, run: RUN1, seq: 1, time, event: "x" })), String(time)).toEqual({ bad: "malformed" });
    expect(parseLine(JSON.stringify({ v: 1, run: RUN1, seq: 1, time: "1970-01-01T00:00:00.001Z", event: "x" }))).toHaveProperty("line");
  });
});

describe.skipIf(!TEST_URL)("the journal loaded into the lifecycle tables", () => {
  checkRequired();

  it("keeps every event of a run: the run, the attempts, their transactions, the pool and the states of the transactions", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 2 }, { txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 60_000, { gather_ms: 0, heartbeat_seconds: 0, test: true });
      r.add(T0 - 30_000, "pool", { waiting: 3 });
      r.add(T0 - 29_000, "pool", { waiting: 0 });
      r.committed(1, 1, chain, { leftOut: [{ transaction: "0x" + "ab".repeat(32), reason: "its deposit leg has no Canton side" }] });
      // attempt 2: nothing includable
      r.add(T0 + 10_000, "cut", { attempt: 2, number: 2, strategy: "on_demand", cut_reason: "retry", pool_waiting: 1, idle_before_cut_ms: 2000, in_flight_at_cut: 0 });
      r.add(T0 + 10_100, "skipped", { attempt: 2, left_out: [{ transaction: "0x" + "cd".repeat(32), reason: "held back" }], rebuilds: 1 });
      // attempt 3: built, the proof failed, the block was never submitted
      const tx = chain.blocks[1]!.block.transactions[0]!.hash;
      r.add(T0 + 20_000, "cut", { attempt: 3, number: 2, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 5, in_flight_at_cut: 0 });
      r.add(T0 + 20_100, "built", { attempt: 3, block_hash: chain.blocks[1]!.block.hash, parent_hash: chain.blocks[1]!.block.parentHash, tx_hashes: [tx], gas_used: 21000, legs: 0, rebuilds: 0, left_out: [] });
      r.add(T0 + 20_200, "proof_queued", { attempt: 3, prover: "prover-a" });
      r.add(T0 + 20_300, "proof_started", { attempt: 3, prover: "prover-a" });
      r.add(T0 + 21_000, "proof_ended", { attempt: 3, prover: "prover-a", outcome: "failed", seconds: 0.7, reason: "out of memory" });
      r.add(T0 + 21_100, "answered", { attempt: 3, outcome: "failed", reason: "the prover failed", stage: "proof_ended", update_id: null, completion_offset: null, seconds: 0, traffic_bytes: null });
      // a failure before Canton's head was read is not an attempt
      r.add(T0 + 22_000, "attempt_failed", { attempt: 4, stage: "cut", reason: "reth is down", strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
      r.add(T0 + 23_000, "excluded", { transaction: "0x" + "ee".repeat(32), until: iso(T0 + 623_000), reason: "the prover cannot finish it" });
      r.add(T0 + 24_000, "lost", { transactions: [{ transaction: "0x" + "ff".repeat(32), error: "nonce too low" }] });
      r.add(T0 + 25_000, "run_stopped", { state: "stopped" });
      putFile(dir, "2026-10-21.jsonl", r.lines);

      const res = await loader(pool, dir).load();
      expect(res).toMatchObject({ available: true, lines: r.lines.length, orphans: 0, malformed: 0, unknownVersion: 0 });
      const run = await one(pool, "select * from producer_runs where run_id = $1", [RUN1]);
      expect(run).toMatchObject({ strategy: "on_demand", source_commit: "abc1234", stop_state: "stopped", settings: { gather_ms: 0, heartbeat_seconds: 0, test: true } });
      expect(run.started_at.toISOString()).toBe(iso(T0 - 60_000));
      expect(run.stopped_at.toISOString()).toBe(iso(T0 + 25_000));
      expect(await count(pool, "block_attempts")).toBe(3);
      const a1 = await one(pool, "select * from block_attempts where run_id = $1 and attempt_seq = 1", [RUN1]);
      expect(a1).toMatchObject({
        number: "1", strategy: "on_demand", cut_reason: "pool", pool_waiting: 2, idle_before_cut_ms: 40, in_flight_at_cut: 0, tx_count: 2, legs_count: 0, rebuilds: 0, left_out_count: 1,
        prover: "prover-a", proof_outcome: "ok", command_id: expect.stringMatching(/^ostia-770101-1-[0-9a-f]{16}-1$/), argument_bytes: 4321, outcome: "committed", update_id: chain.blocks[0]!.record.updateId,
        completion_offset: "10", traffic_bytes: 2048,
      });
      expect(a1.block_hash.equals(hb(chain.blocks[0]!.block.hash))).toBe(true);
      expect(a1.parent_hash.equals(hb(chain.blocks[0]!.block.parentHash))).toBe(true);
      const t = Date.parse(chain.blocks[0]!.record.recordTime);
      expect([a1.cut_at, a1.built_at, a1.proof_queued_at, a1.proof_started_at, a1.proof_ended_at, a1.submitted_at, a1.answered_at, a1.final_seen_at].map((d: Date) => d.getTime())).toEqual(
        [t - 8000, t - 7000, t - 6900, t - 6800, t - 100, t - 50, t + 40, t + 1000]);
      const a2 = await one(pool, "select * from block_attempts where run_id = $1 and attempt_seq = 2", [RUN1]);
      expect(a2).toMatchObject({ outcome: "skipped", cut_reason: "retry", tx_count: 0, left_out_count: 1, rebuilds: 1, block_hash: null });
      const a3 = await one(pool, "select * from block_attempts where run_id = $1 and attempt_seq = 3", [RUN1]);
      expect(a3).toMatchObject({ outcome: "failed", proof_outcome: "failed", reason: "the prover failed", update_id: null, completion_offset: null });
      // the transactions of attempt 1: in order, then the one left out
      const rows = (await pool.query("select position, tx_hash, left_out_reason from attempt_transactions where attempt_id = $1 order by position", [a1.attempt_id])).rows;
      expect(rows.map((x) => [x.position, x.tx_hash.toString("hex").slice(0, 8), x.left_out_reason])).toEqual([
        [0, chain.blocks[0]!.block.transactions[0]!.hash.slice(2, 10), null], [1, chain.blocks[0]!.block.transactions[1]!.hash.slice(2, 10), null], [2, "abababab", "its deposit leg has no Canton side"]]);
      // the states: attempt 1's transactions are proving (final is the indexer's word), the one left out is pending with its reason, attempt 3's went back
      const t0 = await lifecycle(pool, chain.blocks[0]!.block.transactions[0]!.hash);
      expect(t0).toMatchObject({ state: "proving", attempts: 1 });
      expect(t0.first_included_at.getTime()).toBe(t - 7000);
      expect(await lifecycle(pool, "0x" + "ab".repeat(32))).toMatchObject({ state: "pending", attempts: 0, last_left_out_reason: "its deposit leg has no Canton side" });
      expect(await lifecycle(pool, tx)).toMatchObject({ state: "pending", state_reason: "the block was failed", attempts: 1 });
      expect(await lifecycle(pool, "0x" + "cd".repeat(32))).toMatchObject({ state: "pending", last_left_out_reason: "held back" });
      expect(await lifecycle(pool, "0x" + "ee".repeat(32))).toMatchObject({ state: "pending", last_left_out_reason: expect.stringContaining("the prover cannot finish it") });
      expect(await lifecycle(pool, "0x" + "ff".repeat(32))).toMatchObject({ state: "lost", state_reason: "nonce too low" });
      expect((await pool.query("select waiting from pool_samples order by at")).rows.map((x) => x.waiting)).toEqual([3, 0]);
      expect(await health(pool, "journal")).toMatchObject({ status: "ok", detail: null });
    });
  });

  it("settles an attempt: refused or not taken gives the transactions back; resolved committed and restarted say what became of it", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0);
      const cutBuilt = (attempt: number, n: number, ms: number) => {
        r.add(ms, "cut", { attempt, number: n, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
        r.add(ms + 10, "built", { attempt, block_hash: chain.blocks[n - 1]!.block.hash, parent_hash: chain.blocks[n - 1]!.block.parentHash, tx_hashes: [chain.blocks[n - 1]!.block.transactions[0]!.hash], gas_used: 21000, legs: 0, rebuilds: 0, left_out: [] });
      };
      cutBuilt(1, 1, T0 + 1000);
      r.add(T0 + 2000, "answered", { attempt: 1, outcome: "refused", reason: "rejected by Canton", update_id: null, completion_offset: null });
      cutBuilt(2, 2, T0 + 3000);
      r.add(T0 + 4000, "answered", { attempt: 2, outcome: "unknown", reason: "no reply", update_id: null, completion_offset: null });
      r.add(T0 + 5000, "resolved", { attempt: 2, outcome: "committed" });
      cutBuilt(3, 3, T0 + 6000);
      r.add(T0 + 7000, "answered", { attempt: 3, outcome: "unknown", reason: "no reply", update_id: null, completion_offset: null });
      r.add(T0 + 8000, "cancelled", { attempt: 3, reason: "an earlier block was refused" });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      await loader(pool, dir).load();
      const state = async (n: number) => (await lifecycle(pool, chain.blocks[n - 1]!.block.transactions[0]!.hash)).state;
      expect(await state(1)).toBe("pending");
      expect(await state(2)).toBe("proving"); // unknown, then resolved committed: waiting for Canton's record
      expect(await state(3)).toBe("pending");
      expect(await one(pool, "select outcome, resolved_outcome, resolved_at from block_attempts where attempt_seq = 2")).toMatchObject({ outcome: "unknown", resolved_outcome: "committed" });
      expect(await one(pool, "select outcome, reason from block_attempts where attempt_seq = 3")).toMatchObject({ outcome: "cancelled", reason: "an earlier block was refused" });
      // the next run closes an attempt that never got its last line, and gives its transactions back
      const r2 = new Run(RUN2);
      r2.start(T0 + 60_000);
      r2.add(T0 + 60_100, "resolved", { attempt: 2, attempt_run: RUN1, outcome: "restarted" });
      appendLines(dir, "2026-10-21.jsonl", r2.lines);
      await loader(pool, dir).load();
      expect(await one(pool, "select resolved_outcome from block_attempts where attempt_seq = 2")).toMatchObject({ resolved_outcome: "restarted" });
      expect(await state(2)).toBe("pending");
      // a commit settled by its completion after a restart: its lines name the run that made the attempt, and carry Canton's update
      const r3 = new Run(RUN3);
      r3.start(T0 + 120_000);
      r3.add(T0 + 120_100, "resolved", { attempt: 3, attempt_run: RUN1, outcome: "committed", via: "completion", update_id: "u3", completion_offset: 77 });
      r3.add(T0 + 120_200, "final_seen", { attempt: 3, attempt_run: RUN1, number: 3 });
      appendLines(dir, "2026-10-22.jsonl", r3.lines);
      await loader(pool, dir).load();
      const a3 = await one(pool, "select resolved_outcome, update_id, completion_offset, final_seen_at from block_attempts where attempt_seq = 3");
      expect(a3).toMatchObject({ resolved_outcome: "committed", update_id: "u3" });
      expect(a3.final_seen_at).not.toBeNull();
    });
  });

  it("joins the producer's attempt to the block and to Canton's update, whichever came first", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 2 }, { txs: 2 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      r.committed(1, 1, chain);
      r.committed(2, 2, chain);
      putFile(dir, "2026-10-21.jsonl", r.lines.slice(0, 1 + 8)); // run_started and attempt 1
      const ix = await start(pool, chain, { journalDir: dir, producerStatusFile: null });
      chain.ledger.ledgerHead = 1;
      chain.reads.rethHead = 2;
      await ix.runOnce(); // block 1 is indexed before its journal is loaded
      expect(await one(pool, "select attempt_id, update_id from blocks where number = 1")).toMatchObject({ attempt_id: null });
      await ix.loadJournal();
      const first = await one(pool, "select attempt_id from block_attempts where attempt_seq = 1");
      expect(await one(pool, "select attempt_id from blocks where number = 1")).toMatchObject({ attempt_id: first.attempt_id });
      expect(await one(pool, "select command_id, submitted_template, submitted_choice, argument_bytes, traffic_bytes, completion_offset from canton_updates where update_id = $1", [chain.blocks[0]!.record.updateId])).toMatchObject({
        command_id: expect.stringMatching(/^ostia-770101-1-/), submitted_template: "Zk.Chain:ZkChain", submitted_choice: "Advance", argument_bytes: 4321, traffic_bytes: 2048, completion_offset: "10" });
      // block 2: the journal line comes first, the block after
      putFile(dir, "2026-10-21.jsonl", r.lines);
      await ix.loadJournal();
      expect(await one(pool, "select count(*) as n from blocks where number = 2")).toMatchObject({ n: "0" });
      chain.ledger.ledgerHead = 2;
      await ix.runOnce();
      expect(await one(pool, "select attempt_id from blocks where number = 2")).toMatchObject({ attempt_id: null });
      await ix.loadJournal();
      const second = await one(pool, "select attempt_id from block_attempts where attempt_seq = 2");
      expect(await one(pool, "select attempt_id from blocks where number = 2")).toMatchObject({ attempt_id: second.attempt_id });
      expect(await one(pool, "select command_id from canton_updates where update_id = $1", [chain.blocks[1]!.record.updateId])).toMatchObject({ command_id: expect.stringMatching(/^ostia-770101-2-/) });
    });
  });

  it("settles an attempt whose outcome the producer never knew when its block hash is an indexed block", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      r.add(T0, "cut", { attempt: 1, number: 1, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
      r.add(T0 + 10, "built", { attempt: 1, block_hash: chain.blocks[0]!.block.hash, parent_hash: chain.blocks[0]!.block.parentHash, tx_hashes: [chain.blocks[0]!.block.transactions[0]!.hash], gas_used: 21000, legs: 0, rebuilds: 0, left_out: [] });
      r.add(T0 + 20, "submitted", { attempt: 1, command_id: "ostia-770101-1-x-1", argument_bytes: 10 });
      putFile(dir, "2026-10-21.jsonl", r.lines); // the producer stopped here
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      const a = await one(pool, "select attempt_id, outcome, resolved_outcome, update_id from block_attempts");
      expect(a).toMatchObject({ outcome: null, resolved_outcome: "committed", update_id: chain.blocks[0]!.record.updateId });
      expect(await one(pool, "select attempt_id from blocks where number = 1")).toMatchObject({ attempt_id: a.attempt_id });
    });
  });

  /** One attempt for block n of the chain, cut and built and submitted; the caller adds the answer. */
  const attemptLines = (r: Run, chain: SyntheticChain, attempt: number, n: number, ms: number) => {
    const b = chain.blocks[n - 1]!;
    r.add(ms, "cut", { attempt, number: n, strategy: "on_demand", cut_reason: "pool", pool_waiting: 1, idle_before_cut_ms: 0, in_flight_at_cut: 0 });
    r.add(ms + 10, "built", { attempt, block_hash: b.block.hash, parent_hash: b.block.parentHash, tx_hashes: [b.block.transactions[0]!.hash], gas_used: 21000, legs: 0, rebuilds: 0, left_out: [] });
    r.add(ms + 20, "submitted", { attempt, command_id: `ostia-770101-${n}-x-${attempt}`, argument_bytes: 777 });
  };

  it("an attempt the producer settled itself (unknown, then resolved committed) still gets the update id and the Canton side from the indexed block", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      attemptLines(r, chain, 1, 1, T0);
      r.add(T0 + 30, "answered", { attempt: 1, outcome: "unknown", reason: "no reply", update_id: null, completion_offset: null, traffic_bytes: 99 });
      r.add(T0 + 40, "resolved", { attempt: 1, outcome: "committed" });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.loadJournal();
      await ix.runOnce();
      await ix.loadJournal();
      const a = await one(pool, "select attempt_id, update_id, resolved_outcome from block_attempts");
      expect(a).toMatchObject({ resolved_outcome: "committed", update_id: chain.blocks[0]!.record.updateId });
      expect(await one(pool, "select attempt_id from blocks where number = 1")).toMatchObject({ attempt_id: a.attempt_id });
      expect(await one(pool, "select command_id, argument_bytes, traffic_bytes from canton_updates where update_id = $1", [chain.blocks[0]!.record.updateId])).toMatchObject({
        command_id: "ostia-770101-1-x-1", argument_bytes: 777, traffic_bytes: 99 });
    });
  });

  it("an attempt closed by the next run and then settled as committed by the index takes the block's record time, not the restart time", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      attemptLines(r, chain, 1, 1, T0);
      r.add(T0 + 30, "answered", { attempt: 1, outcome: "unknown", reason: "no reply", update_id: null, completion_offset: null });
      const r2 = new Run(RUN2);
      const restartMs = recordMs + 60_000;
      r2.start(restartMs - 100);
      r2.add(restartMs, "resolved", { attempt: 1, attempt_run: RUN1, outcome: "restarted" });
      putFile(dir, "2026-10-21.jsonl", [...r.lines, ...r2.lines]);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.loadJournal();
      expect(await one(pool, "select resolved_outcome from block_attempts")).toMatchObject({ resolved_outcome: "restarted" });
      await ix.runOnce(); // the index has the block after all
      await ix.loadJournal();
      const a = await one(pool, "select resolved_outcome, resolved_at, update_id from block_attempts");
      expect(a.resolved_outcome).toBe("committed");
      expect(new Date(a.resolved_at).getTime()).toBe(recordMs);
      expect(a.update_id).toBe(chain.blocks[0]!.record.updateId);
    });
  });

  it("an update from before the journal began is left alone by the join", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      // the journal starts long after the block's record time (more than the join's slack), so the update is one the journal cannot cover
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      r.start(recordMs + 2 * 3_600_000);
      attemptLines(r, chain, 1, 1, recordMs + 2 * 3_600_000 + 10_000);
      r.add(recordMs + 2 * 3_600_000 + 10_030, "answered", { attempt: 1, outcome: "committed", reason: null, update_id: chain.blocks[0]!.record.updateId, completion_offset: 10, traffic_bytes: 5 });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      expect(await one(pool, "select command_id from canton_updates where update_id = $1", [chain.blocks[0]!.record.updateId])).toMatchObject({ command_id: null });
    });
  });

  it("an update is joined although the producer's clock is ahead of Canton's: the first cut is a few seconds after the record time", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      // Canton's record time and the producer's cut time are two clocks: a producer ahead of Canton by a minute cuts "after" the block was recorded
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      r.start(recordMs + 4_000);
      attemptLines(r, chain, 1, 1, recordMs + 5_000);
      r.add(recordMs + 5_030, "answered", { attempt: 1, outcome: "committed", reason: null, update_id: chain.blocks[0]!.record.updateId, completion_offset: 10, traffic_bytes: 5 });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      expect(await one(pool, "select command_id, argument_bytes, traffic_bytes from canton_updates where update_id = $1", [chain.blocks[0]!.record.updateId])).toMatchObject({
        command_id: expect.stringMatching(/^ostia-770101-1-/), traffic_bytes: 5 });
    });
  });

  it("the traffic of a block reaches its update when the block is indexed before the producer's answered line is read (the mixed load's gap)", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const id = (n: number) => chain.blocks[n - 1]!.record.updateId;
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      const r = new Run(RUN1);
      r.start(recordMs - 1_000);
      attemptLines(r, chain, 1, 1, recordMs - 500);
      attemptLines(r, chain, 2, 2, recordMs - 400);
      // Canton committed both blocks and the reader has them; the journal's file holds each block's lines up to `submitted` only
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      // the join settled both attempts from the indexed blocks and copied what it knew: no traffic yet
      expect(await one(pool, "select command_id, argument_bytes, traffic_bytes, completion_offset from canton_updates where update_id = $1", [id(1)])).toMatchObject({
        command_id: expect.stringMatching(/^ostia-770101-1-/), argument_bytes: 777, traffic_bytes: null, completion_offset: null });
      // the answered lines come in a later read: the traffic, and the offset, reach the update although its command id is set
      const r2 = new Run(RUN1);
      r2.seq = r.seq;
      r2.add(recordMs + 30, "answered", { attempt: 1, outcome: "committed", reason: null, update_id: id(1), completion_offset: 10, traffic_bytes: 7_001 });
      r2.add(recordMs + 40, "answered", { attempt: 2, outcome: "committed", reason: null, update_id: id(2), completion_offset: 20, traffic_bytes: null }); // no traffic reported: stays null
      appendLines(dir, "2026-10-21.jsonl", r2.lines);
      await ix.loadJournal();
      expect(await one(pool, "select command_id, traffic_bytes, completion_offset from canton_updates where update_id = $1", [id(1)])).toMatchObject({
        command_id: expect.stringMatching(/^ostia-770101-1-/), traffic_bytes: 7_001, completion_offset: "10" });
      expect(await one(pool, "select traffic_bytes, completion_offset from canton_updates where update_id = $1", [id(2)])).toMatchObject({ traffic_bytes: null, completion_offset: "20" });
    });
  });

  it("the late path: a commit whose paid traffic comes on its own line after the next block's lines gets its traffic on the attempt and the update, and a known value stays", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const id = (n: number) => chain.blocks[n - 1]!.record.updateId;
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      const r = new Run(RUN1);
      r.start(recordMs - 1_000);
      for (let n = 1; n <= 3; n++) attemptLines(r, chain, n, n, recordMs - 500 + n);
      // each commit is answered with no traffic (the next block's Advance went first); block 3 already has a value of its own
      for (let n = 1; n <= 3; n++) r.add(recordMs + 30 * n, "answered", { attempt: n, outcome: "committed", reason: null, update_id: id(n), completion_offset: n * 10, traffic_bytes: n === 3 ? 333 : null, traffic_before: null, traffic_after: null });
      // the paid traffic follows, after the next attempt's submitted line; block 3's line must not overwrite 333, and a line for no known attempt is an orphan
      r.add(recordMs + 200, "paid_traffic", { attempt: 1, traffic_bytes: 4_001 });
      r.add(recordMs + 210, "paid_traffic", { attempt: 3, traffic_bytes: 999 });
      r.add(recordMs + 220, "paid_traffic", { attempt: 99, traffic_bytes: 5 });
      r.add(recordMs + 230, "paid_traffic", { attempt: 2, traffic_bytes: null }); // nothing read: stays null
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      expect((await health(pool, "journal")).value).toMatchObject({ orphans: 1 }); // the line of attempt 99
      const a = async (n: number) => one(pool, "select traffic_bytes from block_attempts where run_id = $1 and attempt_seq = $2", [RUN1, n]);
      expect(await a(1)).toMatchObject({ traffic_bytes: 4_001 });
      expect(await a(2)).toMatchObject({ traffic_bytes: null });
      expect(await a(3)).toMatchObject({ traffic_bytes: 333 });
      for (const [n, want] of [[1, 4_001], [2, null], [3, 333]] as const) {
        expect(await one(pool, "select traffic_bytes from canton_updates where update_id = $1", [id(n)])).toMatchObject({ traffic_bytes: want });
      }
      // a later read of a paid_traffic line for an attempt that has a value changes nothing
      const r2 = new Run(RUN1);
      r2.seq = r.seq;
      r2.add(recordMs + 300, "paid_traffic", { attempt: 1, traffic_bytes: 1 });
      appendLines(dir, "2026-10-21.jsonl", r2.lines);
      await ix.loadJournal();
      expect(await one(pool, "select traffic_bytes from canton_updates where update_id = $1", [id(1)])).toMatchObject({ traffic_bytes: 4_001 });
    });
  });

  it("the late path across loads, as in production: the commits are indexed and joined with no traffic, and the paid_traffic lines of a later load fill the updates", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const id = (n: number) => chain.blocks[n - 1]!.record.updateId;
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      const r = new Run(RUN1);
      r.start(recordMs - 1_000);
      // as the builder writes them at depth 3: answered N, submitted N+1, paid_traffic N
      for (let n = 1; n <= 3; n++) attemptLines(r, chain, n, n, recordMs - 500 + n);
      for (let n = 1; n <= 3; n++) r.add(recordMs + 30 * n, "answered", { attempt: n, outcome: "committed", reason: null, update_id: id(n), completion_offset: n * 10, traffic_bytes: null, traffic_before: null, traffic_after: null });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      for (const n of [1, 2, 3]) {
        expect(await one(pool, "select command_id, traffic_bytes from canton_updates where update_id = $1", [id(n)])).toMatchObject({
          command_id: expect.stringMatching(/^ostia-770101-/), traffic_bytes: null });
      }
      // a later load brings the paid-traffic lines, about a second after the answers
      const r2 = new Run(RUN1);
      r2.seq = r.seq;
      for (let n = 1; n <= 3; n++) r2.add(recordMs + 1_000 + n, "paid_traffic", { attempt: n, traffic_bytes: 1_000 * n });
      appendLines(dir, "2026-10-21.jsonl", r2.lines);
      await ix.loadJournal();
      for (const n of [1, 2, 3]) {
        expect(await one(pool, "select traffic_bytes from block_attempts where run_id = $1 and attempt_seq = $2", [RUN1, n])).toMatchObject({ traffic_bytes: 1_000 * n });
        expect(await one(pool, "select command_id, traffic_bytes from canton_updates where update_id = $1", [id(n)])).toMatchObject({
          command_id: expect.stringMatching(/^ostia-770101-/), traffic_bytes: 1_000 * n });
      }
      expect((await health(pool, "journal")).value).toMatchObject({ orphans: 0 });
    });
  });

  it("migration 0037 fills in the traffic of updates the join left without it, and only the nulls", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const id = (n: number) => chain.blocks[n - 1]!.record.updateId;
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      const r = new Run(RUN1);
      r.start(recordMs - 1_000);
      for (const n of [1, 2]) {
        attemptLines(r, chain, n, n, recordMs - 500);
        r.add(recordMs + 30, "answered", { attempt: n, outcome: "committed", reason: null, update_id: id(n), completion_offset: n * 10, traffic_bytes: n * 1000 });
      }
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      // the state the old join left behind: block 1 has the command and no traffic, block 2 has a value of its own
      await pool.query("update canton_updates set traffic_bytes = null, completion_offset = null where update_id = $1", [id(1)]);
      await pool.query("update canton_updates set traffic_bytes = 1 where update_id = $1", [id(2)]);
      await pool.query(readFileSync(new URL("../../db/migrations/0037_backfill_update_traffic.sql", import.meta.url), "utf8"));
      expect(await one(pool, "select traffic_bytes, completion_offset from canton_updates where update_id = $1", [id(1)])).toMatchObject({ traffic_bytes: 1000, completion_offset: "10" });
      expect(await one(pool, "select traffic_bytes, completion_offset from canton_updates where update_id = $1", [id(2)])).toMatchObject({ traffic_bytes: 1, completion_offset: "20" });
    });
  });

  it("the traffic that is on a block's update is not replaced by a later or repeated answered line", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const dir = makeFolder();
      const recordMs = Date.parse(chain.blocks[0]!.record.recordTime);
      const r = new Run(RUN1);
      r.start(recordMs - 1_000);
      attemptLines(r, chain, 1, 1, recordMs - 500);
      r.add(recordMs + 30, "answered", { attempt: 1, outcome: "committed", reason: null, update_id: chain.blocks[0]!.record.updateId, completion_offset: 10, traffic_bytes: 5 });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const ix = await start(pool, chain, { journalDir: dir });
      await ix.runOnce();
      await ix.loadJournal();
      await pool.query("update canton_updates set traffic_bytes = 9");
      // a second committed answered line for the same attempt, with other traffic, is read after the update has its own
      const read = r.lines.length;
      r.add(recordMs + 60, "answered", { attempt: 1, outcome: "committed", reason: null, update_id: chain.blocks[0]!.record.updateId, completion_offset: 10, traffic_bytes: 77 });
      appendLines(dir, "2026-10-21.jsonl", r.lines.slice(read));
      await ix.loadJournal();
      expect(await one(pool, "select traffic_bytes from block_attempts")).toMatchObject({ traffic_bytes: 77 }); // the line was read
      expect(await one(pool, "select traffic_bytes from canton_updates")).toMatchObject({ traffic_bytes: 9 });
    });
  });

  it("the blocks table is searched by attempt id through an index", async () => {
    await inDb(async (pool) => {
      const c = await pool.connect();
      try {
        await c.query("set enable_seqscan = off");
        const plan = (await c.query("explain select 1 from blocks b where b.attempt_id = 1")).rows.map((x) => x["QUERY PLAN"]).join("\n");
        expect(plan).toContain("blocks_attempt_id_idx");
      } finally {
        c.release();
      }
    });
  });

  it("takes lines repeated, out of order, or read again from the start without a change", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 2 }, { txs: 2 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      r.add(T0 - 500, "pool", { waiting: 2 });
      r.committed(1, 1, chain);
      r.committed(2, 2, chain);
      const shuffled = [...r.lines].reverse(); // the whole file backwards, then every line twice
      putFile(dir, "2026-10-21.jsonl", [...shuffled, ...r.lines]);
      const res = await loader(pool, dir).load();
      expect(res).toMatchObject({ orphans: 0, gaps: 0 });
      const snapshot = async () => ({
        attempts: (await pool.query("select run_id, attempt_seq, number, outcome, command_id, final_seen_at from block_attempts order by attempt_seq")).rows,
        txs: (await pool.query("select tx_hash, state, attempts, first_included_at from tx_lifecycle order by tx_hash")).rows,
        links: await count(pool, "attempt_transactions"), pool: await count(pool, "pool_samples"),
      });
      const before = await snapshot();
      expect(before.attempts).toHaveLength(2);
      expect(before.links).toBe(4);
      expect(before.pool).toBe(1);
      expect(before.txs.map((x) => x.attempts)).toEqual([1, 1, 1, 1]);
      await pool.query("delete from cursors where stream = 'journal'"); // read again from the start
      await loader(pool, dir).load();
      expect(await snapshot()).toEqual(before);
      expect(await one(pool, "select position from cursors where stream = 'journal'")).toMatchObject({ position: String(Buffer.byteLength([...shuffled, ...r.lines].join("\n") + "\n")) });
    });
  });

  it("reads a rotated journal in order, keeps its place in the file and the byte offset, and leaves a half-written line until it is whole", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      r.committed(1, 1, chain);
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const j = loader(pool, dir);
      await j.load();
      const cursor = async () => one(pool, "select position, detail from cursors where stream = 'journal'");
      expect(await cursor()).toMatchObject({ position: String(Buffer.byteLength(r.lines.join("\n") + "\n")), detail: { file: "2026-10-21.jsonl", run: RUN1, seq: r.seq } });
      // the next day: attempt 2 is cut on day 1 and answered on day 2; a line is half written at the end of day 2
      const mark = r.lines.length;
      r.committed(2, 2, chain);
      const lines = r.lines.slice(mark);
      appendLines(dir, "2026-10-21.jsonl", lines.slice(0, 3));
      putFile(dir, "2026-10-22.jsonl", lines.slice(3));
      const half = JSON.stringify({ v: 1, run: RUN1, seq: r.seq + 1, time: iso(T0 + 99_000), event: "pool", waiting: 9 });
      appendFileSync(join(dir, "2026-10-22.jsonl"), half.slice(0, 20));
      await j.load();
      expect(await count(pool, "block_attempts")).toBe(2);
      expect(await one(pool, "select outcome from block_attempts where attempt_seq = 2")).toMatchObject({ outcome: "committed" });
      expect(await cursor()).toMatchObject({ detail: { file: "2026-10-22.jsonl", seq: r.seq } });
      expect(await count(pool, "pool_samples")).toBe(0);
      appendFileSync(join(dir, "2026-10-22.jsonl"), half.slice(20) + "\n");
      await j.load();
      expect(await count(pool, "pool_samples")).toBe(1);
      expect(await cursor()).toMatchObject({ detail: { file: "2026-10-22.jsonl", seq: r.seq + 1 } });
      // a third file, and a cursor whose file was removed goes on with the first file after it
      const r3 = new Run(RUN2);
      r3.start(T0 + 200_000);
      putFile(dir, "2026-10-24.jsonl", r3.lines);
      await pool.query("update cursors set detail = jsonb_set(detail, '{file}', '\"2026-10-20.jsonl\"') where stream = 'journal'");
      await j.load();
      expect(await count(pool, "producer_runs")).toBe(2);
      expect(await cursor()).toMatchObject({ detail: { file: "2026-10-24.jsonl", run: RUN2 } });
    });
  });

  it("drops the last line of an older file that was cut short for good, and counts it", async () => {
    await inDb(async (pool) => {
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0);
      putFile(dir, "2026-10-21.jsonl", r.lines);
      appendFileSync(join(dir, "2026-10-21.jsonl"), '{"v":1,"run":"' + RUN1 + '","seq":2,"ti');
      const r2 = new Run(RUN2);
      r2.start(T0 + 90_000_000);
      putFile(dir, "2026-10-22.jsonl", r2.lines);
      const res = await loader(pool, dir).load();
      expect(res.malformed).toBe(1);
      expect(await count(pool, "producer_runs")).toBe(2);
    });
  });

  it("starts the sequence again with a new run: nothing is lost and the cursor follows the run", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      r.committed(1, 1, chain);
      r.add(T0 + 5000, "run_stopped", { state: "crashed" });
      putFile(dir, "2026-10-21.jsonl", r.lines);
      const j = loader(pool, dir);
      await j.load();
      const r2 = new Run(RUN2); // seq and attempt numbers start again
      r2.start(T0 + 10_000);
      r2.committed(1, 2, chain);
      appendLines(dir, "2026-10-21.jsonl", r2.lines);
      const res = await j.load();
      expect(res).toMatchObject({ gaps: 0, orphans: 0, lines: r2.lines.length });
      expect((await pool.query("select run_id, attempt_seq, number from block_attempts order by number")).rows.map((x) => [x.run_id, x.attempt_seq, x.number])).toEqual([[RUN1, 1, "1"], [RUN2, 1, "2"]]);
      expect(await one(pool, "select stop_state from producer_runs where run_id = $1", [RUN1])).toMatchObject({ stop_state: "crashed" });
      expect(await one(pool, "select detail from cursors where stream = 'journal'")).toMatchObject({ detail: { run: RUN2, seq: r2.seq } });
    });
  });

  it("says a lost line (a gap in the sequence), a line of an attempt with no cut, and a format it does not know", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 1000);
      r.lose();
      r.add(T0, "pool", { waiting: 1 });
      r.add(T0 + 1, "built", { attempt: 7, block_hash: chain.blocks[0]!.block.hash, parent_hash: chain.blocks[0]!.block.parentHash, tx_hashes: [], gas_used: 0, legs: 0, rebuilds: 0, left_out: [] });
      putFile(dir, "2026-10-21.jsonl", [...r.lines, JSON.stringify({ v: 2, run: RUN1, seq: 9, time: iso(T0), event: "pool" })]);
      let now = Date.parse(r.lines[2]!.match(/"time":"([^"]+)"/)![1]!) + 60_000;
      const j = createJournal({ pool, folder: dir, now: () => now });
      const res = await j.load();
      expect(res).toMatchObject({ gaps: 1, orphans: 1, unknownVersion: 1 });
      const h = await health(pool, "journal");
      expect(h.status).toBe("degraded");
      expect(h.detail).toMatch(/1 journal lines of the producer's run were lost/);
      expect(h.detail).toMatch(/1 journal lines belong to attempts with no cut line/);
      expect(h.detail).toMatch(/1 journal lines are of a format/);
      // the next load reads no new line, and the row still says them: they are kept in the cursor
      now += 1_000;
      const again = await j.load();
      expect(again).toMatchObject({ lines: 0, orphans: 0, unknownVersion: 0 });
      const h2 = await health(pool, "journal");
      expect(h2.status).toBe("degraded");
      expect(h2.detail).toMatch(/1 journal lines belong to attempts with no cut line/);
      expect(h2.detail).toMatch(/1 journal lines are of a format/);
      expect(h2.value).toMatchObject({ orphans: 1, unknownVersion: 1, malformed: 0 });
      // they are shown for an hour, as the gap is
      now += 3_700_000;
      await j.load();
      expect(String((await health(pool, "journal")).detail ?? "")).not.toMatch(/were lost|no cut line|format/);
      expect((await health(pool, "journal")).status).toBe("ok");
    });
  });

  it("a malformed line is kept in the cursor and said until an hour after", async () => {
    await inDb(async (pool) => {
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0);
      putFile(dir, "2026-10-21.jsonl", r.lines);
      appendFileSync(join(dir, "2026-10-21.jsonl"), "this is not json\n");
      let now = T0 + 5_000;
      const j = createJournal({ pool, folder: dir, now: () => now });
      expect((await j.load()).malformed).toBe(1);
      now += 1_000;
      expect((await j.load()).malformed).toBe(0);
      expect(await health(pool, "journal")).toMatchObject({ status: "degraded", detail: expect.stringMatching(/1 journal lines could not be read/) });
      now += 3_700_000;
      await j.load();
      expect((await health(pool, "journal")).status).toBe("ok");
    });
  });

  it("joins only when a line was applied or the indexed head moved", async () => {
    await inDb(async (pool) => {
      const chain = makeChain([{ txs: 1 }, { txs: 1 }]);
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0 - 60_000);
      r.committed(1, 1, chain);
      putFile(dir, "2026-10-21.jsonl", r.lines);
      chain.ledger.ledgerHead = 1;
      const ix = await start(pool, chain, { journalDir: dir, producerStatusFile: null });
      await ix.runOnce();
      await ix.loadJournal();
      const joined = async () => Number((await one(pool, "select count(*) as n from blocks where attempt_id is not null")).n);
      expect(await joined()).toBe(1);
      // a spy on the pool: a load that reads nothing and sees the same head runs none of the three updates
      const seen: string[] = [];
      const q = pool.query.bind(pool) as (...a: unknown[]) => unknown;
      (pool as unknown as { query: unknown }).query = (...a: unknown[]) => { if (typeof a[0] === "string") seen.push(a[0]); return q(...a); };
      try {
        await ix.loadJournal();
        expect(seen.some((x) => /select coalesce\(max\(number\)/.test(x))).toBe(true); // the spy sees the loader's queries
        expect(seen.filter((x) => /^\s*update (block_attempts|blocks|canton_updates)/.test(x))).toEqual([]);
        // the head moves: the join runs again, and the second block (no attempt in the journal) stays unjoined
        chain.ledger.ledgerHead = 2;
        seen.length = 0;
        await ix.runOnce();
        expect(Number((await one(pool, "select max(number) as n from blocks")).n)).toBe(2);
        await ix.loadJournal();
        expect(seen.filter((x) => /^\s*update (block_attempts|blocks)/.test(x)).length).toBeGreaterThan(0);
      } finally {
        (pool as unknown as { query: unknown }).query = q;
      }
    });
  });

  it("with no journal at all: blocks are still indexed, the lifecycle is blank, and the health says so", async () => {
    for (const kind of ["unset", "missing", "empty"] as const) {
      await inDb(async (pool) => {
        const chain = makeChain([{ txs: 2 }, { txs: 1 }]);
        const dir = kind === "unset" ? null : kind === "missing" ? join(makeFolder(), "not-made") : makeFolder();
        const ix = await start(pool, chain, { journalDir: dir });
        await ix.runOnce();
        await ix.loadJournal();
        await ix.checkOnce();
        expect(await count(pool, "blocks")).toBe(2);
        expect(await count(pool, "block_attempts")).toBe(0);
        expect(await count(pool, "producer_runs")).toBe(0);
        expect((await pool.query("select attempt_id from blocks")).rows.every((x) => x.attempt_id === null)).toBe(true);
        // stage 1's own word is there: the transactions are final, with no acceptance or inclusion time
        expect(await lifecycle(pool, chain.blocks[0]!.block.transactions[0]!.hash)).toMatchObject({ state: "final", accepted_at: null, first_included_at: null, attempts: 0 });
        const j = await health(pool, "journal");
        expect(j.status).toBe("degraded");
        expect(j.detail).toMatch(kind === "unset" ? /no journal folder is set/ : kind === "missing" ? /cannot be read/ : /no journal file/);
        expect(await health(pool, "C8")).toMatchObject({ status: "degraded", detail: expect.stringContaining("no producer journal") });
      });
    }
  });

  it("deletes the pool samples older than 30 days", async () => {
    await inDb(async (pool) => {
      await pool.query("insert into pool_samples (at, waiting) values (now() - interval '31 days', 1), (now() - interval '1 day', 2)");
      const dir = makeFolder();
      const r = new Run(RUN1);
      r.start(T0);
      putFile(dir, "2026-10-21.jsonl", r.lines);
      await loader(pool, dir).load();
      expect((await pool.query("select waiting from pool_samples")).rows.map((x) => x.waiting)).toEqual([2]);
    });
  });

  it("joinAttempts is safe to run on an empty database and twice", async () => {
    await inDb(async (pool) => {
      await joinAttempts(pool);
      await joinAttempts(pool);
      expect(await count(pool, "blocks")).toBe(0);
      writeFileSync(join(makeFolder(), "unused"), "");
    });
  });
});
