import { describe, expect, it } from "vitest";
import { evaluate, httpStatusOf, specOf, type RawRow } from "./health.ts";

/** A row as the database reads it: `age` seconds since it was refreshed. */
const row = (id: string, status: string, age = 1, detail: string | null = null): RawRow => ({
  id, status, value: null, threshold: null, detail, sinceSeconds: age, ageSeconds: age, changedAt: "2026-10-22T10:00:00.000Z", refreshedAt: "2026-10-22T10:00:00.000Z",
});
const ROUND = ["C4", "C5", "derive_lag", "C10"];
const fresh = (): RawRow[] => ROUND.map((id) => row(id, "ok"));

describe("the health model (design 6.5)", () => {
  it("is ok when every check is ok, and a quiet chain is ok: its checks are refreshed and nothing is written for a block that never came", () => {
    const e = evaluate([...fresh(), row("producer_alive", "ok"), row("producer_state", "ok"), row("prover", "ok")]);
    expect(e.status).toBe("ok");
    expect(e.problems).toEqual([]);
    expect(httpStatusOf(e.status)).toBe(200);
    // C1, C2, C3, C7 and C6 are written when they fail: a quiet chain has no rows of them, and that is not a failure
    expect(e.checks.map((c) => c.id)).toEqual(["C10", "C4", "C5", "derive_lag", "producer_alive", "producer_state", "prover"]);
  });

  it("is down for a failure of C1, C2, C3 or C7: the indexer stops at that block", () => {
    for (const id of ["C1", "C2", "C3", "C7"]) {
      const e = evaluate([...fresh(), row(id, "down", 500, "stopped at block 9")]);
      expect(e.status, id).toBe("down");
      expect(e.problems, id).toEqual([`${id}: stopped at block 9`]);
      expect(httpStatusOf(e.status)).toBe(503);
    }
  });

  it("is degraded for C4, C6, C8, C9 and C10, the producer's rows and the prover, and never down: they are not needed for final data", () => {
    for (const id of ["C4", "C6", "C8", "C9", "C10", "producer_alive", "producer_state", "prover", "journal", "registered_legs", "custody"]) {
      const e = evaluate([...fresh().filter((r) => r.id !== id), row(id, "degraded", 1, "failed")]);
      expect(e.status, id).toBe("degraded");
      expect(httpStatusOf(e.status), id).toBe(200);
      // a writer that says `down` for a check whose worst is degraded is read as degraded, and the entry keeps its word
      const loud = evaluate([...fresh().filter((r) => r.id !== id), row(id, "down", 1, "failed")]);
      expect(loud.status, id).toBe("degraded");
      expect(loud.checks.find((c) => c.id === id)).toMatchObject({ status: "degraded", written: "down" });
    }
  });

  it("turns the custody and registered_legs rows degraded, never down, when the custody loop stops refreshing them", () => {
    for (const id of ["custody", "registered_legs"]) {
      expect(evaluate([...fresh(), row(id, "ok", 5)]).status, id).toBe("ok");
      const stale = evaluate([...fresh(), row(id, "ok", 10_000)]);
      expect(stale.status, id).toBe("degraded");
      expect(httpStatusOf(stale.status), id).toBe(200);
    }
  });

  it("holds the custody rows to the interval the indexer wrote into the row, not to a setting of the API", () => {
    for (const id of ["custody", "registered_legs"]) {
      const slow = (age: number): RawRow => ({ ...row(id, "ok", age), threshold: { intervalSeconds: 120 } });
      // 100 s old: stale at the default 30 s interval, fresh at the 120 s the row says
      expect(evaluate([...fresh(), row(id, "ok", 100)]).status, id).toBe("degraded");
      expect(evaluate([...fresh(), slow(100)]).status, id).toBe("ok");
      expect(evaluate([...fresh(), slow(400)]).status, id).toBe("degraded");
      expect(evaluate([...fresh(), slow(100)]).checks.find((c) => c.id === id)?.intervalSeconds, id).toBe(120);
    }
  });

  it("is degraded for db_ids above 50% and down above 90%, in the words the indexer wrote, and degraded (not down) when its row stops", () => {
    expect(evaluate([...fresh(), row("db_ids", "ok")]).status).toBe("ok");
    const warn = evaluate([...fresh(), row("db_ids", "degraded", 1, "canton_parties.id has used 61% of its ids")]);
    expect(warn.status).toBe("degraded");
    expect(warn.problems).toEqual(["db_ids: canton_parties.id has used 61% of its ids"]);
    const out = evaluate([...fresh(), row("db_ids", "down", 1, "canton_parties.id has used 95% of its ids")]);
    expect(out.status).toBe("down");
    expect(httpStatusOf(out.status)).toBe(503);
    expect(evaluate([...fresh(), row("db_ids", "ok", 10)]).status).toBe("degraded");
  });

  it("is degraded for C5 over 5 s and down over 30 s, in the words the indexer wrote", () => {
    expect(evaluate([...fresh().filter((r) => r.id !== "C5"), row("C5", "degraded", 1, "the index is 2 blocks behind")]).status).toBe("degraded");
    const down = evaluate([...fresh().filter((r) => r.id !== "C5"), row("C5", "down", 1, "the index is 9 blocks behind")]);
    expect(down.status).toBe("down");
    expect(down.problems).toEqual(["C5: the index is 9 blocks behind"]);
  });

  it("is down when reth or Canton cannot be reached from the instance that answers, and degraded when it is another instance that cannot", () => {
    const own = evaluate([...fresh(), row("api/a/reth", "down", 1, "reth does not answer"), row("api/a/canton", "ok")], { instance: "a" });
    expect(own.status).toBe("down");
    expect(own.checks.find((c) => c.id === "api/a/reth")).toMatchObject({ status: "down", role: "api", elsewhere: false });
    const other = evaluate([...fresh(), row("api/b/reth", "down", 1, "reth does not answer")], { instance: "a" });
    expect(other.status).toBe("degraded");
    expect(other.checks.find((c) => c.id === "api/b/reth")).toMatchObject({ status: "degraded", written: "down", elsewhere: true });
  });

  it("does not read as healthy when the answering instance has written no reth or Canton row yet", () => {
    const none = evaluate([...fresh()], { instance: "a" });
    expect(none.status).toBe("degraded");
    for (const id of ["api/a/reth", "api/a/canton"]) expect(none.checks.find((c) => c.id === id)).toMatchObject({ status: "degraded", detail: "this instance has not checked yet" });
    const half = evaluate([...fresh(), row("api/a/reth", "ok")], { instance: "a" });
    expect(half.checks.map((c) => c.id)).toContain("api/a/canton");
    expect(half.checks.find((c) => c.id === "api/a/reth")).toMatchObject({ status: "ok" });
    // Asked without an instance (/api/status, /healthz) the API's own rows are not required.
    expect(evaluate([...fresh()]).status).toBe("ok");
  });

  it("is degraded for a faucet, a tracker or a verifier that is empty, stuck or unusable, and never down", () => {
    for (const id of ["faucet", "tracker", "verifier/compilers", "verifier/queue"]) {
      const e = evaluate([...fresh(), row(id, "down", 1, "empty")]);
      expect(e.status, id).toBe("degraded");
    }
  });

  it("counts a row as failed when its writer stopped: three intervals, and no sooner", () => {
    // the indexer's rounds are 2 s: 6 s is still fresh, 7 s is stale, and a stale ok never stays ok
    expect(evaluate(fresh().map((r) => ({ ...r, ageSeconds: 6 }))).status).toBe("ok");
    const stale = evaluate(fresh().map((r) => ({ ...r, ageSeconds: 7 })));
    expect(stale.status).toBe("down");
    expect(stale.checks.every((c) => c.stale)).toBe(true);
    expect(stale.problems).toContain("C5: the indexer has not checked in 7 s");
  });

  it("makes a stale row of a stopped API instance or verifier degraded, with its own words about how long ago", () => {
    const e = evaluate([...fresh(), row("api/a/reth", "ok", 16), row("api/a/canton", "ok", 14), row("verifier/compilers", "ok", 46), row("verifier/queue", "ok", 44)], { instance: "a" });
    expect(e.checks.filter((c) => c.stale).map((c) => c.id)).toEqual(["api/a/reth", "verifier/compilers"]);
    expect(e.status).toBe("degraded");
    expect(e.checks.find((c) => c.id === "verifier/compilers")).toMatchObject({ status: "degraded", detail: "the verifier has not checked in 46 s", refreshedAgoSeconds: 46, intervalSeconds: 15 });
    expect(e.checks.find((c) => c.id === "api/a/reth")?.detail).toBe("the API has not checked in 16 s");
  });

  it("keeps what a stale row last said, so the reason is not lost with the writer", () => {
    const e = evaluate([...fresh().filter((r) => r.id !== "C4"), row("C4", "degraded", 20, "reth's finalized block is 3 behind")]);
    expect(e.checks.find((c) => c.id === "C4")?.detail).toBe("the indexer has not checked in 20 s; it last said: reth's finalized block is 3 behind");
    expect(e.status).toBe("down");
  });

  it("gives the indexer's checks that are written only when they fail no staleness: an old ok C1 is an indexer that never failed", () => {
    expect(evaluate([...fresh(), row("C1", "ok", 7200)]).status).toBe("ok");
    expect(specOf("C1").intervalSeconds).toBeUndefined();
  });

  it("is down for a started indexer with no row for a refreshed check, and for an indexer that has not written at all", () => {
    const missing = evaluate([], { started: true });
    expect(missing.status).toBe("down");
    expect(missing.problems).toEqual(ROUND.map((c) => `${c}: the indexer has not checked yet`));
    expect(missing.checks.map((c) => c.id)).toEqual(["C10", "C4", "C5", "derive_lag"]);
    // before the first record the rows are not asked for: the route says the indexer has not started
    expect(evaluate([], { started: false }).checks).toEqual([]);
  });

  it("treats a name it does not know as a stop the indexer wrote: down, with no staleness", () => {
    const e = evaluate([...fresh(), row("chain_instance", "down", 9999, "a new chain instance")]);
    expect(e.status).toBe("down");
    expect(e.checks.find((c) => c.id === "chain_instance")).toMatchObject({ stale: false, intervalSeconds: null });
  });

  it("says since when: the time since the status changed, apart from the time since the row was refreshed", () => {
    const e = evaluate([{ ...row("C5", "degraded", 1, "behind"), sinceSeconds: 120.4 }, ...fresh().filter((r) => r.id !== "C5")]);
    expect(e.checks.find((c) => c.id === "C5")).toMatchObject({ sinceSeconds: 120, refreshedAgoSeconds: 1, changedAt: "2026-10-22T10:00:00.000Z", refreshedAt: "2026-10-22T10:00:00.000Z" });
  });
});
