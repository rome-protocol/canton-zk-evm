/**
 * The verifier role's loop: take one job from the queue at a time, verify it, and write the result; keep the role's rows of `health_checks`
 * (`verifier/compilers`, the compiler cache, and `verifier/queue`) fresh. A job that cannot be run for want of the compiler or the sandbox goes back in the
 * queue, until it has waited `giveUpMs`, and then fails with the reason. A job that takes longer than `jobTimeoutMs` fails.
 */
import type { Pool } from "pg";
import type { JobQueue } from "./jobs.ts";
import { RequestError, type VerifyRequest } from "./request.ts";
import type { Outcome } from "./verify.ts";

export interface WorkerOptions {
  leaseMs?: number;
  /** The most one job may take, the compile and the compiler's download included. */
  jobTimeoutMs?: number;
  pollMs?: number;
  /** A job that could not be run, or whose contract is not in the index, is tried again for this long, counted from its submission. */
  giveUpMs?: number;
  /** The queue is `degraded` when the oldest job has waited this long. */
  stuckSeconds?: number;
  /** Whether the compiler cache can be used (its folder is there and can be written). */
  cacheUsable: () => Promise<string | null>;
  log?: (line: string) => void;
}

export type Step = "idle" | "ended" | "again";

export class VerifierWorker {
  private readonly pool: Pool;
  private readonly queue: JobQueue;
  private readonly verifier: { verify(req: VerifyRequest): Promise<Outcome> };
  private readonly o: Required<Omit<WorkerOptions, "cacheUsable">> & Pick<WorkerOptions, "cacheUsable">;
  constructor(pool: Pool, queue: JobQueue, verifier: { verify(req: VerifyRequest): Promise<Outcome> }, opts: WorkerOptions) {
    this.pool = pool;
    this.queue = queue;
    this.verifier = verifier;
    this.o = { leaseMs: 180_000, jobTimeoutMs: 150_000, pollMs: 1000, giveUpMs: 10 * 60_000, stuckSeconds: 300, log: (l) => console.error(l), ...opts };
  }

  /** Takes and runs one job, if one waits. */
  async step(): Promise<Step> {
    const job = await this.queue.claim(this.o.leaseMs);
    if (!job) return "idle";
    const age = Date.now() - job.createdAt.getTime();
    let outcome: Outcome | { status: "fail"; result: string };
    let timer: NodeJS.Timeout | undefined;
    try {
      outcome = await Promise.race([
        this.verifier.verify(job.request),
        new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("timeout")), this.o.jobTimeoutMs); }),
      ]);
    } catch (e) {
      const m = (e as Error).message;
      if (e instanceof RequestError) outcome = { status: "fail", result: `Fail - Unable to verify. ${m}` };
      else if (m === "timeout") outcome = { status: "fail", result: "Fail - Unable to verify. The verification took too long." };
      else {
        this.o.log(`verifier: job ${job.guid} failed: ${m}`);
        outcome = { status: "fail", result: "Fail - Unable to verify. The verifier could not run this job." };
      }
    } finally {
      clearTimeout(timer);
    }
    if (outcome.status === "retry" || outcome.status === "unknown") {
      if (age < this.o.giveUpMs) { await this.queue.release(job.guid); return "again"; }
      await this.queue.finish(job.guid, "fail", outcome.status === "unknown" ? outcome.result : `Fail - Unable to verify. ${outcome.result}`);
      return "ended";
    }
    await this.queue.finish(job.guid, outcome.status, outcome.result);
    return "ended";
  }

  /** The role's rows of health_checks. */
  async health(): Promise<void> {
    const bad = await this.o.cacheUsable().catch((e: Error) => e.message);
    await this.row("verifier/compilers", bad ? "degraded" : "ok", { usable: !bad }, bad);
    const s = await this.queue.stats();
    const stuck = s.oldestWaitingSeconds > this.o.stuckSeconds;
    await this.row("verifier/queue", stuck ? "degraded" : "ok", s, stuck ? `the oldest job has waited ${Math.round(s.oldestWaitingSeconds)} s` : null,
      { oldestWaitingSeconds: this.o.stuckSeconds });
  }

  private async row(id: string, status: string, value: object, detail: string | null, threshold: object | null = null): Promise<void> {
    await this.pool.query(
      `insert into health_checks (check_id, status, value, threshold, changed_at, checked_at, detail) values ($1, $2, $3::jsonb, $4::jsonb, now(), now(), $5)
       on conflict (check_id) do update set value = excluded.value, threshold = excluded.threshold, checked_at = now(), detail = excluded.detail,
         changed_at = case when health_checks.status = excluded.status then health_checks.changed_at else now() end, status = excluded.status`,
      [id, status, JSON.stringify(value), threshold && JSON.stringify(threshold), detail],
    );
  }

  /** Runs until `signal` aborts; the job in hand is finished first. */
  async run(signal: AbortSignal): Promise<void> {
    let lastHealth = 0;
    while (!signal.aborted) {
      if (Date.now() - lastHealth >= 5000) { lastHealth = Date.now(); await this.health().catch((e: Error) => this.o.log(`verifier: health: ${e.message}`)); }
      let step: Step = "idle";
      try { step = await this.step(); } catch (e) { this.o.log(`verifier: ${(e as Error).message}`); }
      if (step !== "ended") await new Promise<void>((done) => {
        const t = setTimeout(done, step === "again" ? Math.max(this.o.pollMs, 5000) : this.o.pollMs);
        signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
      });
    }
  }
}
