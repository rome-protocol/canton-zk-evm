import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "../db/testing.ts";
import { JobQueue } from "./jobs.ts";
import { RequestError, type VerifyRequest } from "./request.ts";
import { Verifier } from "./verify.ts";
import { addContract, outputFor, SandboxError, StubCompile } from "./verify-fixtures.ts";
import { VerifierWorker } from "./worker.ts";

checkRequired();
const suite = TEST_URL ? describe : describe.skip;

const meta = (tag: number): Buffer => {
  const body = Buffer.concat([Buffer.from("a264697066735822", "hex"), Buffer.alloc(34, tag), Buffer.from("64736f6c6343", "hex"), Buffer.from("00081c", "hex")]);
  return Buffer.concat([body, Buffer.from([0, body.length])]);
};
const runtime = Buffer.concat([Buffer.from("6080604052348015600e575f80fd5b50600436106030575f3560e01c8063".padEnd(120, "5b"), "hex"), meta(1)]);
const creation = Buffer.concat([Buffer.from("608060405234801561000f575f80fd5b50610150806100305f395ff3fe", "hex"), runtime, meta(1)]);
const A = "0x" + "a1".repeat(20);
const req = (address: string): VerifyRequest => ({ address, codeFormat: "solidity-single-file", sourceCode: "// SPDX-License-Identifier: MIT\ncontract Box {}", contractName: "Box", compilerVersion: "v0.8.28+commit.7893614a", optimizationUsed: "1", runs: "200" });
const key = Buffer.alloc(32, 7);

suite("the verifier role", () => {
  let db: TestDatabase;
  const stub = new StubCompile();
  const queue = () => new JobQueue(db.pool);
  const worker = (verifier: { verify(r: VerifyRequest): Promise<never> | Promise<any> }, extra = {}) =>
    new VerifierWorker(db.pool, queue(), verifier, { cacheUsable: async () => null, log: () => undefined, ...extra });
  beforeAll(async () => { db = await makeDatabase(true); });
  afterAll(async () => { await db.drop(); });
  beforeEach(async () => {
    await db.pool.query("truncate verification_jobs, verified_sources, contracts, bytecodes, health_checks cascade");
    stub.calls = 0; stub.fail = null;
    stub.output = outputFor("Box.sol", "Box", { creation: creation.toString("hex"), runtime: runtime.toString("hex") });
    await addContract(db.pool, A, runtime, creation);
  });

  it("verifies a submission from the queue to a stored source, against the fixtures' chain", async () => {
    const q = queue();
    const guid = await q.submit(req(A), key);
    const w = worker(new Verifier(db.pool, stub));
    expect(await w.step()).toBe("ended");
    expect(await q.status(guid)).toMatchObject({ status: "pass" });
    expect((await db.pool.query("select match_type from verified_sources where address = $1", [Buffer.from(A.slice(2), "hex")])).rowCount).toBe(1);
    expect(await w.step()).toBe("idle");
  });

  it("answers Already Verified for a second submission, without compiling", async () => {
    const q = queue();
    const w = worker(new Verifier(db.pool, stub));
    await q.submit(req(A), key); await w.step();
    const calls = stub.calls;
    const again = await q.submit(req(A), key);
    await w.step();
    expect(await q.status(again)).toMatchObject({ status: "already", result: "Already Verified" });
    expect(stub.calls).toBe(calls);
  });

  it("fails a job that takes longer than its time, and a request that cannot be run, and goes on", async () => {
    const q = queue();
    const slow = await q.submit(req(A), key);
    const w = worker({ verify: () => new Promise(() => undefined) }, { jobTimeoutMs: 50, stopGraceMs: 20 });
    expect(await w.step()).toBe("ended");
    expect(await q.status(slow)).toMatchObject({ status: "fail", result: expect.stringContaining("took too long") });
    const bad = await q.submit(req(A), key);
    await worker({ verify: async () => { throw new RequestError("the contract name is not in the source"); } }).step();
    expect(await q.status(bad)).toMatchObject({ status: "fail", result: "Fail - Unable to verify. the contract name is not in the source" });
  });

  it("fails a compile that the sandbox stopped for time, with the reason", async () => {
    stub.fail = new SandboxError("timeout", "the compile took 60 s");
    const q = queue();
    const guid = await q.submit(req(A), key);
    await worker(new Verifier(db.pool, stub)).step();
    expect(await q.status(guid)).toMatchObject({ status: "fail", result: expect.stringContaining("took too long") });
  });

  it("puts a job back when the sandbox is not available, and fails it once it has waited too long", async () => {
    stub.fail = new SandboxError("unavailable", "no docker");
    const q = queue();
    const guid = await q.submit(req(A), key);
    const lines: string[] = [];
    expect(await worker(new Verifier(db.pool, stub), { log: (l) => lines.push(l) }).step()).toBe("again");
    expect(await q.status(guid)).toMatchObject({ status: "pending" });
    // The operator can see why a job waits: the log says it, with the reason.
    expect(lines.join("\n")).toMatch(new RegExp(`job ${guid} is put back.*no docker`));
    await db.pool.query("update verification_jobs set not_before = null");
    expect(await worker(new Verifier(db.pool, stub), { giveUpMs: 0 }).step()).toBe("ended");
    expect(await q.status(guid)).toMatchObject({ status: "fail", result: expect.stringContaining("sandbox is not available") });
  });

  it("fails a job that was put back too many times; one that keeps failing does not stop the others", async () => {
    const q = queue();
    const B = "0x" + "b2".repeat(20);
    const stuck = await q.submit(req(B), key);
    const good = await q.submit(req(A), key);
    const w = worker({ verify: async (r: VerifyRequest) => r.address === B ? { status: "unknown", result: "Fail - the contract is not in the index" } : { status: "pass", result: "Pass - Verified" } }, { maxAttempts: 2 });
    expect(await w.step()).toBe("again"); // the oldest is put back, with a wait
    expect(await w.step()).toBe("ended"); // the next one is taken, not the oldest again
    expect(await q.status(good)).toMatchObject({ status: "pass" });
    expect(await w.step()).toBe("idle");
    await db.pool.query("update verification_jobs set not_before = null");
    expect(await w.step()).toBe("ended"); // its second try: the attempts are used up
    expect(await q.status(stuck)).toMatchObject({ status: "fail", result: "Fail - the contract is not in the index" });
  });

  it("writes its health rows: ok, then degraded for an unusable cache and for a stuck queue", async () => {
    const w = worker({ verify: async () => { throw new Error("unused"); } }, { stuckSeconds: 1 });
    await w.health();
    const rows = async () => Object.fromEntries((await db.pool.query("select check_id, status from health_checks where check_id like 'verifier/%'")).rows.map((r) => [r.check_id, r.status]));
    expect(await rows()).toEqual({ "verifier/compilers": "ok", "verifier/queue": "ok" });
    await queue().submit(req(A), key);
    await db.pool.query("update verification_jobs set created_at = now() - interval '10 seconds'");
    await worker({ verify: async () => { throw new Error("unused"); } }, { stuckSeconds: 1, cacheUsable: async () => "the cache folder cannot be written" }).health();
    expect(await rows()).toEqual({ "verifier/compilers": "degraded", "verifier/queue": "degraded" });
  });

  it("stops a job that is over its time: the compile is told to stop, nothing is stored, and the next job starts after it", async () => {
    let running = 0, most = 0, aborted = 0;
    const slow = {
      calls: 0,
      async compile(_v: string, _i: object | string, signal?: AbortSignal) {
        slow.calls++;
        running++; most = Math.max(most, running);
        try {
          await new Promise<void>((ok, no) => {
            if (slow.calls > 1) { setTimeout(ok, 10); return; } // the second job is quick
            signal?.addEventListener("abort", () => { aborted++; setTimeout(() => no(signal.reason), 30); }, { once: true });
          });
          return { output: stub.output, compiler: { version: "0.8.28+commit.7893614a", sha256: "00".repeat(32) }, ms: 1 };
        } finally { running--; }
      },
    };
    const q = queue();
    const first = await q.submit(req(A), key);
    const w = worker(new Verifier(db.pool, slow), { jobTimeoutMs: 100, stopGraceMs: 2000 });
    const started = Date.now();
    expect(await w.step()).toBe("ended");
    // It ended when the job stopped (30 ms after the signal), not at the end of the grace.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(aborted).toBe(1);
    expect(await q.status(first)).toMatchObject({ status: "fail", result: expect.stringContaining("took too long") });
    expect((await db.pool.query("select count(*)::int n from verified_sources")).rows[0].n).toBe(0);
    // The next job runs, and the two compiles never ran together.
    await db.pool.query("delete from verification_jobs");
    const second = await q.submit(req(A), key);
    expect(await w.step()).toBe("ended");
    expect(await q.status(second)).toMatchObject({ status: "pass" });
    expect(most).toBe(1);
  });

  it("keeps its health rows fresh while a job runs", async () => {
    await queue().submit(req(A), key);
    const slow = { verify: () => new Promise<any>((ok) => setTimeout(() => ok({ status: "fail", result: "Fail - x" }), 700)) };
    const w = worker(slow, { healthMs: 100, pollMs: 50 });
    const stop = new AbortController();
    const run = w.run(stop.signal);
    await new Promise((r) => setTimeout(r, 300));
    const a = (await db.pool.query("select checked_at from health_checks where check_id = 'verifier/compilers'")).rows[0].checked_at as Date;
    await new Promise((r) => setTimeout(r, 300));
    const b = (await db.pool.query("select checked_at from health_checks where check_id = 'verifier/compilers'")).rows[0].checked_at as Date;
    // Both reads were made while the 700 ms job was still running.
    expect(b.getTime()).toBeGreaterThan(a.getTime());
    stop.abort();
    await run;
  });
});
