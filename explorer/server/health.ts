/**
 * The health model (design section 6.5), in one place: what each row of `health_checks` is, which role writes it, the worst word it may carry, how often it is
 * refreshed, and what it counts as when its writer stops. `/api/health` shows every row through `evaluate`, and `/api/status` and `/healthz` take their
 * problems and their 503 from the same function, so the three cannot disagree.
 */

export type Status = "ok" | "degraded" | "down";
export type Role = "indexer" | "api" | "verifier";

/** One row as the database holds it, with its ages worked out by the database's clock (so that a skewed clock of this process cannot make a row look old). */
export interface RawRow {
  id: string; status: string; value: unknown; threshold: unknown; detail: string | null;
  /** Seconds since the status last changed, and since the row was last refreshed. */
  sinceSeconds: number; ageSeconds: number;
  changedAt: string; refreshedAt: string;
}

export interface CheckSpec {
  role: Role;
  /** The worst word this check may carry: a check that is `degraded` at worst never turns the overall word `down`. */
  worst: Status;
  /** How often its writer refreshes the row, in seconds. A row not refreshed within three intervals counts as failed. Absent: the row is written only when something happens. */
  intervalSeconds?: number;
  /** What a row that is not refreshed counts as. */
  stale?: Status;
}

/** How many of its own intervals a row may go without a refresh. */
export const STALE_AFTER_INTERVALS = 3;
/** The interval of the API instances' own checks (reth and Canton from the instance, the faucet, the tracker). */
export const API_INTERVAL_SECONDS = 5;

const INDEXER_ROUND = 2;
/** How often the custody loop writes its rows when a row does not say (`CUSTODY_MS` is 30 s unless set). The indexer writes its own interval into the row's threshold (`intervalSeconds`), so the API never has to know the setting. */
export const CUSTODY_INTERVAL_SECONDS = 30;
/** The rows whose writer says its own interval in the row's threshold. */
const OWN_INTERVAL = new Set(["custody", "registered_legs"]);
/** The interval a row is held to: the one the row says for the custody loop's rows, else the check's own. */
function intervalOf(id: string, threshold: unknown, spec: CheckSpec): number | undefined {
  const said = OWN_INTERVAL.has(id) && threshold !== null && typeof threshold === "object" ? (threshold as { intervalSeconds?: unknown }).intervalSeconds : undefined;
  return typeof said === "number" && Number.isFinite(said) && said >= 1 ? said : spec.intervalSeconds;
}
const ROUND: CheckSpec = { role: "indexer", worst: "degraded", intervalSeconds: INDEXER_ROUND, stale: "degraded" };
/** The indexer's own rows. C1, C2, C3 and C7 are written when they fail, and the indexer stops at that block, so they are `down` and have no interval. */
const SPECS: Record<string, CheckSpec> = {
  C1: { role: "indexer", worst: "down" }, C2: { role: "indexer", worst: "down" }, C3: { role: "indexer", worst: "down" }, C7: { role: "indexer", worst: "down" },
  // A stopped indexer means final data is stale, so the rows it refreshes on every round turn `down` when they stop.
  C4: { ...ROUND, stale: "down" }, C5: { role: "indexer", worst: "down", intervalSeconds: INDEXER_ROUND, stale: "down" },
  derive_lag: { ...ROUND, stale: "down" }, C10: { ...ROUND, stale: "down" },
  C6: { role: "indexer", worst: "degraded", intervalSeconds: 600, stale: "degraded" },
  C8: { ...ROUND, intervalSeconds: 10 }, C9: ROUND,
  // The id columns: down above 90% of a type's range, and stale rows only degrade, as the check is a warning ahead of the failure.
  db_ids: { role: "indexer", worst: "down", intervalSeconds: INDEXER_ROUND, stale: "degraded" },
  producer_alive: ROUND, producer_state: ROUND, prover: ROUND,
  journal: { role: "indexer", worst: "degraded" }, reth_reads: { role: "indexer", worst: "degraded" },
  // The custody read and the leg index of the registered gateways are written from the custody loop, which is off unless the gateway party is set: the rows are not expected, and are never down. A row that
  // the loop stops refreshing (the read hangs, or the loop is gone) turns degraded after three of the loop's own intervals, so a freeze is never silent.
  custody: { role: "indexer", worst: "degraded", intervalSeconds: CUSTODY_INTERVAL_SECONDS, stale: "degraded" },
  registered_legs: { role: "indexer", worst: "degraded", intervalSeconds: CUSTODY_INTERVAL_SECONDS, stale: "degraded" },
  // The shared rows of the API: the instance that holds the faucet's or the tracker's lock writes them.
  faucet: { role: "api", worst: "degraded", intervalSeconds: API_INTERVAL_SECONDS, stale: "degraded" },
  tracker: { role: "api", worst: "degraded", intervalSeconds: API_INTERVAL_SECONDS, stale: "degraded" },
};
const API_INSTANCE: CheckSpec = { role: "api", worst: "down", intervalSeconds: API_INTERVAL_SECONDS, stale: "degraded" };
const VERIFIER: CheckSpec = { role: "verifier", worst: "degraded", intervalSeconds: 15, stale: "degraded" };
/** A name no numbered check covers is a stop the indexer wrote (`chain_instance`, a reader that moved): `down`, with no interval. */
const UNKNOWN: CheckSpec = { role: "indexer", worst: "down" };

/** The row id of one of the API instance's own checks: `api/<instance>/reth`, `api/<instance>/canton`. */
export const apiRowId = (instance: string, check: string): string => `api/${instance}/${check}`;

/** The instance an `api/<instance>/<check>` row belongs to, or null for any other row. */
export function instanceOf(id: string): string | null {
  const m = /^api\/(.+)\/[^/]+$/.exec(id);
  return m ? m[1]! : null;
}

export function specOf(id: string): CheckSpec {
  const known = SPECS[id];
  if (known) return known;
  if (instanceOf(id) !== null) return API_INSTANCE;
  if (id.startsWith("verifier/")) return VERIFIER;
  return UNKNOWN;
}

/** The checks the indexer refreshes on every round, which a started indexer must have written whatever their status says. */
export const REFRESHED_CHECKS: readonly string[] = ["C4", "C5", "derive_lag", "C10"];

const RANK: Record<Status, number> = { ok: 0, degraded: 1, down: 2 };
const worse = (a: Status, b: Status): Status => (RANK[a] >= RANK[b] ? a : b);
const asStatus = (s: string): Status => (s === "ok" || s === "degraded" || s === "down" ? s : "down");

export interface HealthEntry {
  id: string; role: Role;
  /** The word this row counts for, after the check's worst and a stopped writer are taken into account. */
  status: Status;
  /** What the row itself says, when it differs from `status`. */
  written?: string;
  value: unknown; threshold: unknown; detail: string | null;
  /** Seconds since the status last changed, and when. */
  sinceSeconds: number; changedAt: string | null;
  /** When the writer last looked, and how long ago in seconds. */
  refreshedAt: string | null; refreshedAgoSeconds: number;
  intervalSeconds: number | null;
  /** True when the writer has not refreshed the row within three of its intervals. */
  stale: boolean;
  /** True for a row of another API instance: it is shown, but it cannot turn this instance's answer `down`. */
  elsewhere: boolean;
}

export interface Evaluation { status: Status; checks: HealthEntry[]; problems: string[]; down: boolean }

export interface EvaluateOptions {
  /** The API instance that is answering: its own rows count in full, another instance's rows at most `degraded`. */
  instance?: string;
  /** True once the indexer has written a record: a refreshed check with no row has then not been looked at, and counts as `down`. */
  started?: boolean;
}

const synthetic = (id: string, role: Role, status: Status, detail: string): HealthEntry => ({
  id, role, status, value: null, threshold: null, detail, sinceSeconds: 0, changedAt: null, refreshedAt: null, refreshedAgoSeconds: 0, intervalSeconds: null, stale: false, elsewhere: false,
});

/** Turns the rows into the answer: every check with its word, the overall word, and the names of what is wrong. The rows are sorted by id. */
export function evaluate(rows: RawRow[], { instance, started = true }: EvaluateOptions = {}): Evaluation {
  const checks: HealthEntry[] = [];
  for (const r of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const spec = specOf(r.id);
    const interval = intervalOf(r.id, r.threshold, spec);
    const stale = interval !== undefined && r.ageSeconds > interval * STALE_AFTER_INTERVALS;
    const written = asStatus(r.status);
    // What a check writes is held to its worst word; a writer that has stopped counts for what the stop means, which can be more (a stopped indexer: final data is stale).
    const held = RANK[written] > RANK[spec.worst] ? spec.worst : written;
    const capped = stale ? worse(held, spec.stale ?? spec.worst) : held;
    const owner = instanceOf(r.id);
    const elsewhere = spec.role === "api" && (owner === null || owner !== instance) && capped === "down";
    const status: Status = elsewhere ? "degraded" : capped;
    const who = spec.role === "indexer" ? "the indexer" : spec.role === "verifier" ? "the verifier" : "the API";
    const detail = stale
      ? `${who} has not checked in ${Math.round(r.ageSeconds)} s${r.detail && written !== "ok" ? `; it last said: ${r.detail}` : ""}`
      : r.detail;
    checks.push({
      id: r.id, role: spec.role, status, ...(r.status !== status ? { written: r.status } : {}), value: r.value, threshold: r.threshold, detail,
      sinceSeconds: Math.max(0, Math.round(r.sinceSeconds)), changedAt: r.changedAt, refreshedAt: r.refreshedAt, refreshedAgoSeconds: Math.max(0, Math.round(r.ageSeconds * 10) / 10),
      intervalSeconds: interval ?? null, stale, elsewhere: spec.role === "api" && owner !== null && owner !== instance,
    });
  }
  // A refreshed check with no row has not been looked at: after a rebuild from an export, or before a new indexer's first round. No row must not read as healthy.
  if (started) {
    for (const id of REFRESHED_CHECKS) if (!checks.some((c) => c.id === id)) checks.push(synthetic(id, "indexer", "down", "the indexer has not checked yet"));
    // The same for the answering instance's own reth and Canton rows: its timer has not written them yet (or they were removed), so nothing has looked from here.
    if (instance !== undefined) {
      for (const check of ["reth", "canton"]) {
        const id = apiRowId(instance, check);
        if (!checks.some((c) => c.id === id)) checks.push(synthetic(id, "api", "degraded", "this instance has not checked yet"));
      }
    }
  }
  // The names of what is wrong follow the order of the rows, then the checks that have no row; the list of checks is then put in order by id.
  const problems = checks.filter((c) => c.status !== "ok").map((c) => `${c.id}: ${c.detail ?? c.status}`);
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const status = checks.reduce<Status>((w, c) => worse(w, c.status), "ok");
  return { status, checks, problems, down: status === "down" };
}

/** The HTTP status of an overall word: a load balancer stops sending traffic to an instance only when final data is stale or wrong. */
export const httpStatusOf = (s: Status): number => (s === "down" ? 503 : 200);

/** Before the indexer has written its first record there is nothing to be healthy about: the answer says so, and is down, as `/api/status` is. */
export function withNotStarted(e: Evaluation): Evaluation {
  const entry = synthetic("indexer", "indexer", "down", "the indexer has not written its first record yet");
  return { status: "down", checks: [entry, ...e.checks], problems: [`indexer: ${entry.detail}`, ...e.problems], down: true };
}
