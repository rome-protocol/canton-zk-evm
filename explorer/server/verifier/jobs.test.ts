import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "../db/testing.ts";
import { JobQueue, PENDING_TEXT, SubmitRefused } from "./jobs.ts";
import type { VerifyRequest } from "./request.ts";

checkRequired();
const suite = TEST_URL ? describe : describe.skip;

const req = (extra: Partial<VerifyRequest> = {}): VerifyRequest => ({
  address: "0x" + "a1".repeat(20), codeFormat: "solidity-single-file", sourceCode: "contract Box {}", contractName: "Box", compilerVersion: "v0.8.28+commit.7893614a", ...extra,
});
const client = (n: number) => Buffer.alloc(32, n);

suite("the verification job queue", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await makeDatabase(true); });
  afterAll(async () => { await db.drop(); });
  beforeEach(async () => { await db.pool.query("truncate verification_jobs"); });

  it("answers a submission with a GUID, and the job waits as pending in queue", async () => {
    const q = new JobQueue(db.pool);
    const guid = await q.submit(req(), client(1));
    expect(await q.status(guid)).toEqual({ guid, status: "pending", result: PENDING_TEXT });
    expect(await q.status("not-a-guid")).toBeNull();
    expect(await q.status("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("refuses too large a source before anything is stored, and a bad address", async () => {
    const q = new JobQueue(db.pool, { maxSourceBytes: 100 });
    await expect(q.submit(req({ sourceCode: "x".repeat(101) }), client(1))).rejects.toMatchObject({ status: 413 });
    await expect(q.submit(req({ address: "0x12" }), client(1))).rejects.toMatchObject({ status: 400 });
    await expect(q.submit(req({ sourceCode: "" }), client(1))).rejects.toBeInstanceOf(SubmitRefused);
    expect((await db.pool.query("select count(*)::int as n from verification_jobs")).rows[0].n).toBe(0);
  });

  it("limits a client for the hour and the jobs waiting in all", async () => {
    const q = new JobQueue(db.pool, { perClientPerHour: 2, maxWaiting: 3 });
    await q.submit(req(), client(1));
    await q.submit(req(), client(1));
    await expect(q.submit(req(), client(1))).rejects.toMatchObject({ status: 429 });
    await q.submit(req(), client(2));
    await expect(q.submit(req(), client(3))).rejects.toMatchObject({ status: 503 });
  });

  it("gives the oldest job to one taker, and ends it with its result and without its sources", async () => {
    const q = new JobQueue(db.pool);
    const first = await q.submit(req(), client(1));
    const second = await q.submit(req(), client(2));
    const a = await q.claim(60_000), b = await q.claim(60_000);
    expect([a?.guid, b?.guid]).toEqual([first, second]);
    expect(await q.claim(60_000)).toBeNull();
    expect(a?.request.contractName).toBe("Box");
    expect(await q.finish(first, "pass", "Pass - Verified")).toBe(true);
    expect(await q.finish(first, "fail", "again")).toBe(false);
    expect(await q.status(first)).toEqual({ guid: first, status: "pass", result: "Pass - Verified" });
    expect((await db.pool.query("select request from verification_jobs where guid = $1", [first])).rows[0].request).toEqual({});
  });

  it("puts a job whose lease ran out back, and one that was released", async () => {
    const q = new JobQueue(db.pool);
    const guid = await q.submit(req(), client(1));
    expect((await q.claim(60_000))?.guid).toBe(guid);
    await db.pool.query("update verification_jobs set lease_until = now() - interval '1 second'");
    expect((await q.claim(60_000))?.guid).toBe(guid);
    await q.release(guid);
    expect(await q.stats()).toMatchObject({ waiting: 1, running: 0 });
  });

  it("prunes ended jobs after thirty days and keeps the rest", async () => {
    const q = new JobQueue(db.pool);
    const done = await q.submit(req(), client(1));
    await q.submit(req(), client(2));
    await q.claim(60_000);
    await q.finish(done, "fail", "Fail - Unable to verify");
    await db.pool.query("update verification_jobs set finished_at = now() - interval '31 days' where guid = $1", [done]);
    expect(await q.prune()).toBe(1);
    expect((await db.pool.query("select count(*)::int as n from verification_jobs")).rows[0].n).toBe(1);
  });
});
