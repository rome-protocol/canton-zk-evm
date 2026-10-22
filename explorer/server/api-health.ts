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

/** A probe of reth, Canton or the faucet's balance that has not answered in this long counts as failed: the checks run in the background, and one that hangs must still be written. */
export const PROBE_TIMEOUT_MS = 2000;

export interface ApiHealthDeps {
  pool: Pool; instance: string;
  reth: Pick<Reth, "block">; ledger: Pick<Ledger, "ledgerEnd">;
  faucet?: Pick<Faucet, "on" | "isLeading" | "info" | "oldestQueued">; tracker?: Pick<Tracker, "isLeading" | "stats">;
  now?: () => number; probeTimeoutMs?: number;
}

/**
 * The checks the API can see (design 6.5): reth and Canton from this instance (`api/<instance>/reth`, `api/<instance>/canton`), and, in the instance that holds
 * their lock, the faucet (its balance and its queue) and the tracker (what it follows, and what it dropped in the last hour). Each instance writes its own rows
 * every few seconds from a timer, in the background; `/api/health` only reads them, so it answers at once even when reth or Canton hang, and a timer that has
 * stopped shows as stale rows. The probes run side by side, each with its own short timeout.
 */
export function createApiHealth({ pool, instance, reth, ledger, faucet, tracker, now = Date.now, probeTimeoutMs = PROBE_TIMEOUT_MS }: ApiHealthDeps) {
  let last = -Infinity;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

  /** Rejects when `p` has not answered in `probeTimeoutMs`. */
  function probe<T>(p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, no) => { t = setTimeout(() => no(new Error("no answer")), probeTimeoutMs); });
    return Promise.race([p, late]).finally(() => clearTimeout(t));
  }

  async function rows(): Promise<HealthRow[]> {
    const leading = Boolean(faucet?.on && faucet.isLeading());
    const [block, end, info] = await Promise.all([
      probe(Promise.resolve().then(() => reth.block("latest"))).then((b) => ({ b }), () => null),
      probe(Promise.resolve().then(() => ledger.ledgerEnd())).then((e) => ({ e }), () => null),
      leading ? probe(Promise.resolve().then(() => faucet!.info())).then((i) => ({ i }), () => null) : Promise.resolve(undefined),
    ]);
    const out: HealthRow[] = [
      block ? { id: apiRowId(instance, "reth"), status: "ok", value: { latest: block.b?.number ?? null } } : { id: apiRowId(instance, "reth"), status: "down", detail: "reth does not answer" },
      end ? { id: apiRowId(instance, "canton"), status: "ok", value: { ledgerEnd: end.e } } : { id: apiRowId(instance, "canton"), status: "down", detail: "Canton's ledger end cannot be read" },
    ];
    if (leading) {
      // Stuck is the age of the oldest request still waiting, not the length of the queue: a busy faucet whose queue is never empty is fine while batches go out.
      const oldest = faucet!.oldestQueued();
      const waited = oldest === null ? 0 : Math.max(0, now() - oldest);
      const f = info?.i;
      const balance = f?.balance == null ? null : BigInt(f.balance);
      const why: string[] = [];
      if (!f || balance === null) why.push("the faucet's balance cannot be read");
      else if (balance < BigInt(f.amount)) why.push("the faucet is empty: its balance is below one payout");
      if (waited > FAUCET_STUCK_MS) why.push(`the oldest of ${f?.queue ?? "the"} waiting requests has been waiting ${Math.round(waited / 1000)} s without a batch going out`);
      out.push({
        id: "faucet", status: why.length ? "degraded" : "ok", value: { balance: f?.balance ?? null, queue: f?.queue ?? null, oldestWaitMs: waited }, threshold: { payout: f?.amount ?? null, stuckMs: FAUCET_STUCK_MS },
        detail: why.join("; ") || null,
      });
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
        // A faucet that has been turned off must not leave its row to go stale for ever.
        if (faucet && !faucet.on) await pool.query("delete from health_checks where check_id = 'faucet'");
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
