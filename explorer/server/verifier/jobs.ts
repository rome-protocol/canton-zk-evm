/**
 * The verification job queue, in the table `verification_jobs` (design sections 5.2 and 6.3). A submission is checked early (the address, the size of the source,
 * the client's hourly limit, the number of jobs waiting) and answers at once with a GUID; a verifier role takes one job at a time, with a lease, so that a job
 * whose role died goes back in the queue. A job that has ended keeps its result and loses its sources.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { MAX_SOURCE_BYTES, type VerifyRequest } from "./request.ts";

/** A submission that is refused: `status` is the HTTP status the route answers with. */
export class SubmitRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface QueueLimits { maxSourceBytes: number; perClientPerHour: number; maxWaiting: number }
export const DEFAULT_LIMITS: QueueLimits = { maxSourceBytes: MAX_SOURCE_BYTES, perClientPerHour: 30, maxWaiting: 200 };

export type JobStatus = "pending" | "running" | "pass" | "fail" | "already";
export interface JobView { guid: string; status: JobStatus; result: string }
/** `attempts` is how many times the job was put back before this claim. */
export interface Claimed { guid: string; request: VerifyRequest; createdAt: Date; attempts: number }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** What `checkverifystatus` says while a job has not ended (Etherscan's words). */
export const PENDING_TEXT = "Pending in queue";

export class JobQueue {
  private readonly pool: Pool;
  private readonly limits: QueueLimits;
  constructor(pool: Pool, limits: Partial<QueueLimits> = {}) {
    this.pool = pool;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Queues a request and returns its GUID. `clientKey` is the keyed hash of the client's address. */
  async submit(req: VerifyRequest, clientKey: Buffer): Promise<string> {
    if (!ADDRESS.test(req.address ?? "")) throw new SubmitRefused(400, "The contract address is not an address.");
    if (typeof req.sourceCode !== "string" || req.sourceCode === "") throw new SubmitRefused(400, "No source code was sent.");
    const sourceBytes = Buffer.byteLength(req.sourceCode);
    if (sourceBytes > this.limits.maxSourceBytes) throw new SubmitRefused(413, `The source code is ${sourceBytes} bytes; the most that is taken is ${this.limits.maxSourceBytes}.`);
    const json = JSON.stringify(req);
    const guid = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // One submission at a time, so that two at once cannot both pass the same count.
      await client.query("select pg_advisory_xact_lock(hashtext('verification_jobs_submit'))");
      const counts = (await client.query<{ mine: string; waiting: string }>(
        `select count(*) filter (where client_key = $1 and created_at > now() - interval '1 hour') as mine,
                count(*) filter (where status in ('pending', 'running')) as waiting from verification_jobs`, [clientKey])).rows[0]!;
      if (Number(counts.mine) >= this.limits.perClientPerHour) throw new SubmitRefused(429, `At most ${this.limits.perClientPerHour} verifications an hour from one client.`);
      if (Number(counts.waiting) >= this.limits.maxWaiting) throw new SubmitRefused(503, "Too many verifications are waiting; try again later.");
      await client.query(
        `insert into verification_jobs (guid, kind, address, request, request_bytes, status, client_key, created_at)
         values ($1, 'source', $2, $3::jsonb, $4, 'pending', $5, now())`,
        [guid, Buffer.from(req.address.slice(2), "hex"), json, Buffer.byteLength(json), clientKey],
      );
      await client.query("commit");
      return guid;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Records a proxy verification that was answered on the spot (the slots were just read at the final head), as an ended job of kind `proxy`, so that
   * `checkproxyverification` has a GUID to answer by. It counts against the client's hourly limit like a source does. No verifier takes it: only waiting jobs are claimed.
   */
  async recordProxy(address: string, clientKey: Buffer, status: "pass" | "fail", result: string): Promise<string> {
    if (!ADDRESS.test(address)) throw new SubmitRefused(400, "The contract address is not an address.");
    const guid = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('verification_jobs_submit'))");
      const mine = (await client.query<{ n: string }>("select count(*) as n from verification_jobs where client_key = $1 and created_at > now() - interval '1 hour'", [clientKey])).rows[0]!;
      if (Number(mine.n) >= this.limits.perClientPerHour) throw new SubmitRefused(429, `At most ${this.limits.perClientPerHour} verifications an hour from one client.`);
      await client.query(
        `insert into verification_jobs (guid, kind, address, request, request_bytes, status, result, client_key, created_at, started_at, finished_at)
         values ($1, 'proxy', $2, '{}'::jsonb, 2, $3, $4, $5, now(), now(), now())`,
        [guid, Buffer.from(address.slice(2), "hex"), status, result, clientKey],
      );
      await client.query("commit");
      return guid;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** What `checkverifystatus` answers, or null for a GUID no job has. `kind` keeps the two checks apart: a source's GUID is not a proxy's. */
  async status(guid: string, kind: "source" | "proxy" = "source"): Promise<JobView | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) return null;
    const r = (await this.pool.query<{ status: JobStatus; result: string | null }>("select status, result from verification_jobs where guid = $1 and kind = $2", [guid, kind])).rows[0];
    if (!r) return null;
    const waiting = r.status === "pending" || r.status === "running";
    return { guid, status: r.status, result: waiting ? PENDING_TEXT : (r.result ?? (r.status === "pass" ? "Pass - Verified" : "Fail - Unable to verify")) };
  }

  /** Takes the oldest waiting job whose time to try has come, for `leaseMs`, or returns null when none is ready. Jobs whose lease ran out are put back first. */
  async claim(leaseMs: number): Promise<Claimed | null> {
    await this.pool.query(
      "update verification_jobs set status = 'pending', lease_until = null where status = 'running' and lease_until < now()");
    const r = (await this.pool.query<{ guid: string; request: VerifyRequest; created_at: Date; attempts: number }>(
      `update verification_jobs set status = 'running', started_at = now(), lease_until = now() + ($1::int * interval '1 millisecond')
       where guid = (select guid from verification_jobs where status = 'pending' and (not_before is null or not_before <= now())
                      order by created_at limit 1 for update skip locked)
       returning guid, request, created_at, attempts`, [leaseMs])).rows[0];
    return r ? { guid: r.guid, request: r.request, createdAt: r.created_at, attempts: r.attempts } : null;
  }

  /** Ends a job with its result; its sources are dropped. A job that is not running any more (its lease ran out and another role has it) is left alone. */
  async finish(guid: string, status: "pass" | "fail" | "already", result: string): Promise<boolean> {
    const r = await this.pool.query(
      `update verification_jobs set status = $2, result = $3, request = '{}'::jsonb, lease_until = null, finished_at = now() where guid = $1 and status = 'running'`,
      [guid, status, result]);
    return r.rowCount === 1;
  }

  /** Puts a job back in the queue, for a compiler or sandbox that could not be had, or a contract that is not in the index yet. It is taken again after its backoff: 5 s, doubled for each attempt, at most 2 minutes. */
  async release(guid: string): Promise<void> {
    await this.pool.query(
      `update verification_jobs set status = 'pending', lease_until = null, attempts = attempts + 1,
         not_before = now() + (least(5000 * power(2, least(attempts, 10)), 120000)::int * interval '1 millisecond')
       where guid = $1 and status = 'running'`, [guid]);
  }

  /** The queue as the health row reads it. */
  async stats(): Promise<{ waiting: number; running: number; oldestWaitingSeconds: number }> {
    const r = (await this.pool.query<{ waiting: string; running: string; oldest: number | null }>(
      `select count(*) filter (where status = 'pending') as waiting, count(*) filter (where status = 'running') as running,
              extract(epoch from now() - min(created_at) filter (where status = 'pending'))::float8 as oldest from verification_jobs
       where status in ('pending', 'running')`)).rows[0]!;
    return { waiting: Number(r.waiting), running: Number(r.running), oldestWaitingSeconds: r.oldest ?? 0 };
  }

  /** Jobs are kept 30 days (design 8). */
  async prune(days = 30): Promise<number> {
    const r = await this.pool.query("delete from verification_jobs where status not in ('pending', 'running') and finished_at < now() - ($1::int * interval '1 day')", [days]);
    return r.rowCount ?? 0;
  }
}
