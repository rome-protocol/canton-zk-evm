import type { Pool } from "pg";
import type { Faucet } from "./faucet.ts";
import { API_INTERVAL_SECONDS, apiRowId } from "./health.ts";
import { setHealth, type HealthRow } from "./indexer/health.ts";
import type { Ledger } from "./ledger.ts";
import type { Reth } from "./reth.ts";
import type { Tracker } from "./tracker.ts";

/** A faucet whose queue has not gone down for this long is stuck. */
export const FAUCET_STUCK_MS = 120_000;
/** More transactions than this given up on in the last hour is a tracker in trouble. */
export const TRACKER_DROPPED_DEGRADED = 5;
/** An instance's rows are removed this long after its last refresh: an instance that was replaced or scaled down must not leave rows behind for ever. Until then they show as stale. */
export const GONE_AFTER_MINUTES = 10;

export interface ApiHealthDeps {
  pool: Pool; instance: string;
  reth: Pick<Reth, "block">; ledger: Pick<Ledger, "ledgerEnd">;
  faucet?: Pick<Faucet, "on" | "isLeading" | "info">; tracker?: Pick<Tracker, "isLeading" | "stats">;
  now?: () => number;
}

/**
 * The checks the API can see (design 6.5): reth and Canton from this instance (`api/<instance>/reth`, `api/<instance>/canton`), and, in the instance that holds
 * their lock, the faucet (its balance and its queue) and the tracker (what it follows, and what it dropped in the last hour). Each instance writes its own rows
 * every few seconds, and `/api/health` asks for a refresh before it answers, so its answer about this instance is never older than `maxAgeMs`.
 */
export function createApiHealth({ pool, instance, reth, ledger, faucet, tracker, now = Date.now }: ApiHealthDeps) {
  let queuedSince: number | null = null;
  let last = -Infinity;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

  async function rows(): Promise<HealthRow[]> {
    const out: HealthRow[] = [];
    out.push(await reth.block("latest").then(
      (b): HealthRow => ({ id: apiRowId(instance, "reth"), status: "ok", value: { latest: b?.number ?? null } }),
      (): HealthRow => ({ id: apiRowId(instance, "reth"), status: "down", detail: "reth does not answer" }),
    ));
    out.push(await ledger.ledgerEnd().then(
      (end): HealthRow => ({ id: apiRowId(instance, "canton"), status: "ok", value: { ledgerEnd: end } }),
      (): HealthRow => ({ id: apiRowId(instance, "canton"), status: "down", detail: "Canton's ledger end cannot be read" }),
    ));
    if (faucet?.on && faucet.isLeading()) {
      const info = await faucet.info();
      const balance = info.balance === null ? null : BigInt(info.balance);
      if (info.queue > 0) queuedSince ??= now(); else queuedSince = null;
      const stuckFor = queuedSince === null ? 0 : now() - queuedSince;
      const why: string[] = [];
      if (balance === null) why.push("the faucet's balance cannot be read");
      else if (balance < BigInt(info.amount)) why.push("the faucet is empty: its balance is below one payout");
      if (stuckFor > FAUCET_STUCK_MS) why.push(`${info.queue} requests have been waiting ${Math.round(stuckFor / 1000)} s without a batch going out`);
      out.push({
        id: "faucet", status: why.length ? "degraded" : "ok", value: { balance: info.balance, queue: info.queue, queuedForMs: stuckFor }, threshold: { payout: info.amount, stuckMs: FAUCET_STUCK_MS },
        detail: why.join("; ") || null,
      });
    } else if (faucet) {
      queuedSince = null;
    }
    if (tracker?.isLeading()) {
      const s = tracker.stats();
      out.push({
        id: "tracker", status: s.droppedLastHour > TRACKER_DROPPED_DEGRADED ? "degraded" : "ok", value: s, threshold: { droppedLastHour: TRACKER_DROPPED_DEGRADED },
        detail: s.droppedLastHour > TRACKER_DROPPED_DEGRADED ? `${s.droppedLastHour} transactions were given up on in the last hour` : null,
      });
    }
    return out;
  }

  /** Writes this instance's rows, and removes the rows of instances that have been gone for a while. Never throws: a database that cannot be written shows in the answer as stale rows. */
  function refresh(maxAgeMs = 0): Promise<void> {
    if (running) return running;
    if (now() - last < maxAgeMs) return Promise.resolve();
    running = (async () => {
      try {
        await setHealth(pool, await rows());
        await pool.query("delete from health_checks where check_id like 'api/%' and checked_at < now() - make_interval(mins => $1)", [GONE_AFTER_MINUTES]);
        last = now();
      } catch (e) {
        console.error(`health: cannot write this instance's checks: ${reason(e)}`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    instance, refresh,
    start(): void { if (!timer) { void refresh(); timer = setInterval(() => void refresh(), API_INTERVAL_SECONDS * 1000); timer.unref(); } },
    stop(): void { if (timer) clearInterval(timer); timer = undefined; },
  };
}

export type ApiHealth = ReturnType<typeof createApiHealth>;
