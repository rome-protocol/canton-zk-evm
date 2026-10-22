import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";
import { createApiHealth, FAUCET_STUCK_MS, GONE_AFTER_MINUTES } from "./api-health.ts";
import { createChainDb } from "./chain-db.ts";
import { loadConfig } from "./config.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "./db/testing.ts";
import { FAKE_READER } from "../test/fake-ledger.ts";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

checkRequired();
const databases: TestDatabase[] = [];
afterEach(async () => { for (const d of databases.splice(0)) await d.drop(); });

const settings = "programVK=0x" + "cd".repeat(32) + "\nrootC=0x" + "ef".repeat(32) + "\n";
const ROUND = ["C4", "C5", "derive_lag", "C10"];

interface World { reth?: boolean; canton?: boolean; started?: boolean; round?: boolean; faucet?: { balance: string | null; amount?: string; queue?: number; /** When the oldest waiting request was made; by default, when the test began. */ since?: number }; tracker?: { open: number; droppedLastHour: number } }

/** An API instance `a` over a database of its own. Its reth and Canton answer unless the test says they do not; the indexer has written its four rounds unless it says it has not. */
async function boot(w: World = {}) {
  const db = await makeDatabase(true);
  databases.push(db);
  const clock = { now: 1_000_000 }, start = clock.now;
  const state = { reth: w.reth ?? true, canton: w.canton ?? true, faucet: w.faucet, tracker: w.tracker };
  if (w.started ?? true) await db.pool.query("insert into cursors (stream, position, updated_at) values ('reader_updates', 1, now())");
  if ((w.started ?? true) && (w.round ?? true)) await writeRound(db, "ok");
  const health = createApiHealth({
    pool: db.pool, instance: "a", now: () => clock.now,
    reth: { block: async () => { if (!state.reth) throw new Error("connect ECONNREFUSED 127.0.0.1:8545"); return { number: 5 } as never; } },
    ledger: { ledgerEnd: async () => { if (!state.canton) throw new Error("http://ledger.invalid:7575 refused"); return 9; } },
    faucet: { on: true, isLeading: () => state.faucet !== undefined, info: async () => ({ balance: state.faucet!.balance, amount: state.faucet!.amount ?? "100", queue: state.faucet!.queue ?? 0 }) as never,
      oldestQueued: () => (state.faucet?.queue ? state.faucet.since ?? start : null) },
    tracker: { isLeading: () => state.tracker !== undefined, stats: () => state.tracker! },
  });
  const config = loadConfig({ READER_PARTY: FAKE_READER, PINS_FILE: "guest.txt" }, () => settings);
  const reth = { block: async () => ({ number: 5 }) } as never, ledger = { ledgerEnd: async () => 9 } as never;
  const api = createApi({ config, reth, ledger, chain: createChainDb(db.pool), health });
  /** Asks like a client does, after the instance's timer has run once (the route itself only reads the table). */
  const get = async (path = "/api/health") => { await health.refresh(); return asked(path); };
  /** Asks without the timer having run. */
  const asked = async (path = "/api/health") => { const a = await api("GET", path); return { status: a.status, body: a.body as Obj, headers: a.headers }; };
  return { db, pool: db.pool, get, asked, clock, state, health, api };
}

const writeRound = (db: TestDatabase, status: string, age = "0 seconds") =>
  db.pool.query(
    `insert into health_checks (check_id, status, changed_at, checked_at) select c, $2, now() - interval '${age}', now() - interval '${age}' from unnest($1::text[]) as c
       on conflict (check_id) do update set status = excluded.status, changed_at = excluded.changed_at, checked_at = excluded.checked_at`, [ROUND, status]);
const put = (pool: TestDatabase["pool"], id: string, status: string, detail: string | null = null, age = "0 seconds", since = age) =>
  pool.query(
    `insert into health_checks (check_id, status, detail, changed_at, checked_at) values ($1, $2, $3, now() - interval '${since}', now() - interval '${age}')
       on conflict (check_id) do update set status = excluded.status, detail = excluded.detail, changed_at = excluded.changed_at, checked_at = excluded.checked_at`, [id, status, detail]);
const check = (b: Obj, id: string): Obj => (b.checks as Obj[]).find((c) => c.id === id) as Obj;

describe.skipIf(!TEST_URL)("GET /api/health", () => {
  it("is ok on a quiet chain: no transaction, no block for a while, every check refreshed", async () => {
    const { get } = await boot();
    const { status, body, headers } = await get();
    expect(status).toBe(200);
    expect(headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(body).toMatchObject({ status: "ok", instance: "a", starting: false, problems: [] });
    // this instance's own two checks were written by its timer, with when they were looked at
    expect(check(body, "api/a/reth")).toMatchObject({ role: "api", status: "ok", stale: false, intervalSeconds: 5, value: { latest: 5 } });
    expect(check(body, "api/a/canton")).toMatchObject({ status: "ok", value: { ledgerEnd: 9 } });
    expect(typeof check(body, "C5").refreshedAt).toBe("string");
    expect(check(body, "C5")).toMatchObject({ role: "indexer", sinceSeconds: expect.any(Number), refreshedAgoSeconds: expect.any(Number), intervalSeconds: 2 });
  });

  it("is down and 503 for a failure that stops the indexer, naming it and since when", async () => {
    const { get, pool } = await boot();
    await put(pool, "C3", "down", "block 3: the record does not hash to reth's transactions", "1 second", "90 seconds");
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.problems).toEqual(["C3: block 3: the record does not hash to reth's transactions"]);
    expect(check(body, "C3").sinceSeconds).toBeGreaterThanOrEqual(90);
  });

  it("is down for the index over 30 s behind, and degraded (still 200) for 5 s", async () => {
    const { get, pool } = await boot();
    await put(pool, "C5", "degraded", "the index is 2 blocks behind");
    expect(await get()).toMatchObject({ status: 200, body: { status: "degraded", problems: ["C5: the index is 2 blocks behind"] } });
    await put(pool, "C5", "down", "the index is 40 blocks behind");
    expect(await get()).toMatchObject({ status: 503, body: { status: "down" } });
  });

  it.each(["C4", "C6", "C8", "C9", "C10", "derive_lag", "producer_alive", "producer_state", "prover"])("is degraded, and 200, for a failure of %s", async (id) => {
    const { get, pool } = await boot();
    await put(pool, id, "degraded", `${id} failed`);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.problems).toEqual([`${id}: ${id} failed`]);
  });

  it("is down when reth cannot be reached from this instance, and does not repeat what reth's error said", async () => {
    const { get, state } = await boot();
    state.reth = false;
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(check(body, "api/a/reth")).toMatchObject({ status: "down", detail: "reth does not answer" });
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });

  it("is down when Canton's ledger end cannot be read from this instance, and does not repeat the address", async () => {
    const { get, state } = await boot();
    state.canton = false;
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(check(body, "api/a/canton")).toMatchObject({ status: "down" });
    expect(JSON.stringify(body)).not.toMatch(/ledger\.invalid/);
  });

  it("is down, said by the API itself, when it cannot read the database, and never names it", async () => {
    const { get, pool } = await boot();
    await pool.query("alter table health_checks rename to health_checks_moved");
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "down", problems: ["database: the database cannot be read"], checks: [{ id: "database", status: "down" }] });
    expect(JSON.stringify(body)).not.toMatch(/relation|postgres|health_checks/);
  });

  it("is down before the indexer has written its first record, and says it is starting", async () => {
    const { get } = await boot({ started: false });
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "down", starting: true });
    expect(body.problems[0]).toBe("indexer: the indexer has not written its first record yet");
  });

  it("is down for a started indexer that has written no round, as after a rebuild from an export", async () => {
    const { get } = await boot({ round: false });
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body.problems).toEqual(ROUND.map((c) => `${c}: the indexer has not checked yet`));
  });

  describe("a row whose writer stopped", () => {
    it("goes stale after three of the indexer's two-second rounds, is down, and says so and for how long", async () => {
      const { get, pool, db } = await boot();
      await writeRound(db, "ok", "7 seconds");
      const { status, body } = await get();
      expect(status).toBe(503);
      expect(check(body, "C5")).toMatchObject({ status: "down", stale: true });
      expect(check(body, "C5").detail).toMatch(/^the indexer has not checked in 7 s$/);
      expect(check(body, "C5").refreshedAgoSeconds).toBeGreaterThanOrEqual(7);
      await writeRound(db, "ok", "5 seconds");
      expect((await get()).status).toBe(200);
      void pool;
    });

    it("does not make an old ok of a check that is written only when it fails stale: C1 from two hours ago is an indexer that never failed", async () => {
      const { get, pool } = await boot();
      await put(pool, "C1", "ok", null, "2 hours");
      expect(await get()).toMatchObject({ status: 200, body: { status: "ok" } });
    });

    it("is degraded for a stopped producer check, a stopped verifier, and another API instance that stopped, and the rows are named", async () => {
      const { get, pool } = await boot();
      await put(pool, "producer_alive", "ok", null, "7 seconds");
      await put(pool, "verifier/compilers", "ok", null, "46 seconds");
      await put(pool, "api/b/reth", "ok", null, "16 seconds");
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(body.status).toBe("degraded");
      expect(body.problems.sort()).toEqual([
        "api/b/reth: the API has not checked in 16 s", "producer_alive: the indexer has not checked in 7 s", "verifier/compilers: the verifier has not checked in 46 s",
      ]);
      expect(check(body, "api/b/reth")).toMatchObject({ elsewhere: true, stale: true });
    });

    it("cannot turn this instance down when another instance says reth is down: it is shown, and counts at most degraded", async () => {
      const { get, pool } = await boot();
      await put(pool, "api/b/reth", "down", "reth does not answer");
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(check(body, "api/b/reth")).toMatchObject({ status: "degraded", written: "down", elsewhere: true });
    });

    it("is removed once its instance has been gone for a while, and not before", async () => {
      const { get, pool, clock } = await boot();
      await put(pool, "api/gone/reth", "ok", null, `${GONE_AFTER_MINUTES - 1} minutes`);
      expect(check((await get()).body, "api/gone/reth")).toMatchObject({ stale: true });
      await put(pool, "api/gone/reth", "ok", null, `${GONE_AFTER_MINUTES + 1} minutes`);
      expect(check((await get()).body, "api/gone/reth")).toBeUndefined(); // the timer's sweep removes it
    });
  });

  describe("answers from the table alone", () => {
    it("answers at once, down for reth, while a reth that hangs is still being probed, and never waits for it", async () => {
      const db = await makeDatabase(true);
      databases.push(db);
      await db.pool.query("insert into cursors (stream, position, updated_at) values ('reader_updates', 1, now())");
      await writeRound(db, "ok");
      let calls = 0;
      const hang = (): Promise<never> => { calls++; return new Promise(() => {}); };
      const health = createApiHealth({ pool: db.pool, instance: "a", reth: { block: hang }, ledger: { ledgerEnd: hang }, faucet: { on: true, isLeading: () => true, info: hang, oldestQueued: () => null }, probeTimeoutMs: 150 });
      const config = loadConfig({ READER_PARTY: FAKE_READER, PINS_FILE: "guest.txt" }, () => settings);
      const api = createApi({ config, reth: { block: async () => ({ number: 5 }) } as never, ledger: { ledgerEnd: async () => 9 } as never, chain: createChainDb(db.pool), health });
      const timer = Date.now();
      const refreshing = health.refresh(); // the background timer's work: three probes side by side, each given up on after 150 ms
      const a = await api("GET", "/api/health");
      expect(Date.now() - timer).toBeLessThan(120); // not held by the probes
      expect(a.status).toBe(200);
      await refreshing;
      expect(Date.now() - timer).toBeLessThan(450); // side by side, not one after another
      expect(calls).toBe(3);
      const b = await api("GET", "/api/health");
      expect(b).toMatchObject({ status: 503, body: { status: "down" } });
      expect(((b.body as Obj).checks as Obj[]).find((c) => c.id === "api/a/reth")).toMatchObject({ status: "down", detail: "reth does not answer" });
      expect(((b.body as Obj).checks as Obj[]).find((c) => c.id === "faucet")).toMatchObject({ status: "degraded" });
    });

    it("shows this instance's rows as stale once its timer has stopped, without a request ever refreshing them", async () => {
      const { asked, pool, health } = await boot();
      await health.refresh();
      await put(pool, "api/a/reth", "ok", null, "16 seconds");
      const { body } = await asked();
      expect(check(body, "api/a/reth")).toMatchObject({ stale: true });
      expect(body.status).toBe("degraded");
    });
  });

  describe("the faucet, the tracker and the verifier", () => {
    it("write no row for a faucet or tracker this instance does not lead, and a verifier with no rows is no failure", async () => {
      const { get } = await boot();
      const { body } = await get();
      expect(check(body, "faucet")).toBeUndefined();
      expect(check(body, "tracker")).toBeUndefined();
      expect((body.checks as Obj[]).filter((c) => c.id.startsWith("verifier/"))).toEqual([]);
      expect(body.status).toBe("ok");
    });

    it("show a faucet with coin and an empty queue as ok, with its balance and queue", async () => {
      const { get } = await boot({ faucet: { balance: "1000", amount: "100" } });
      const { body } = await get();
      expect(body.status).toBe("ok");
      expect(check(body, "faucet")).toMatchObject({ status: "ok", value: { balance: "1000", queue: 0 }, threshold: { payout: "100", stuckMs: FAUCET_STUCK_MS } });
    });

    it("show a faucet that is empty, or whose balance cannot be read, as degraded and 200", async () => {
      const empty = await boot({ faucet: { balance: "99", amount: "100" } });
      expect(await empty.get()).toMatchObject({ status: 200, body: { status: "degraded", problems: ["faucet: the faucet is empty: its balance is below one payout"] } });
      const unread = await boot({ faucet: { balance: null } });
      expect((await unread.get()).body.problems).toEqual(["faucet: the faucet's balance cannot be read"]);
    });

    it("show a faucet whose queue has not moved for two minutes as stuck, and a queue that moves as ok", async () => {
      const { get, clock, state } = await boot({ faucet: { balance: "1000", queue: 3 } });
      expect((await get()).body.status).toBe("ok");
      clock.now += FAUCET_STUCK_MS + 1000;
      const stuck = await get();
      expect(stuck.status).toBe(200);
      expect(stuck.body.problems[0]).toMatch(/^faucet: the oldest of 3 waiting requests has been waiting 121 s without a batch going out$/);
      state.faucet = { balance: "1000", queue: 0 };
      expect((await get()).body.status).toBe("ok");
    });

    it("do not call a busy faucet stuck: its queue is never empty, but its oldest request is young because batches go out", async () => {
      const { get, clock, state } = await boot({ faucet: { balance: "1000", queue: 3 } });
      for (let i = 0; i < 5; i++) {
        clock.now += FAUCET_STUCK_MS / 2; // five minutes in all, with a batch out every minute and new requests keeping the queue at 3
        state.faucet = { balance: "1000", queue: 3, since: clock.now - 5000 };
        expect((await get()).body.status).toBe("ok");
      }
    });

    it("remove the faucet's row when this instance's faucet has been turned off, so that no stale row is left behind", async () => {
      const { get, pool, health } = await boot();
      await put(pool, "faucet", "ok", null, "10 minutes");
      expect(check((await get()).body, "faucet")).toMatchObject({ stale: true });
      const off = createApiHealth({ pool, instance: "a", reth: { block: async () => ({ number: 5 }) as never }, ledger: { ledgerEnd: async () => 9 }, faucet: { on: false, isLeading: () => false, info: async () => ({}) as never, oldestQueued: () => null } });
      await off.refresh();
      expect(check((await get()).body, "faucet")).toBeUndefined();
      void health;
    });

    it("show a tracker that gave up on many transactions in the last hour as degraded, and its open count", async () => {
      const calm = await boot({ tracker: { open: 12, droppedLastHour: 5 } });
      expect(check((await calm.get()).body, "tracker")).toMatchObject({ status: "ok", value: { open: 12, droppedLastHour: 5 } });
      const busy = await boot({ tracker: { open: 12, droppedLastHour: 6 } });
      expect(await busy.get()).toMatchObject({ status: 200, body: { status: "degraded", problems: ["tracker: 6 transactions were given up on in the last hour"] } });
    });

    it("show a verifier whose compiler cache is unusable or whose queue is stuck as degraded, from the rows the verifier writes", async () => {
      const { get, pool } = await boot();
      await put(pool, "verifier/compilers", "degraded", "the compiler cache cannot be written", "3 seconds", "30 seconds");
      await put(pool, "verifier/queue", "ok", null, "3 seconds");
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(body.problems).toEqual(["verifier/compilers: the compiler cache cannot be written"]);
      expect(check(body, "verifier/compilers")).toMatchObject({ role: "verifier", status: "degraded", stale: false, intervalSeconds: 15 });
    });
  });

  it("keeps /api/status and /healthz as they were: a degraded row is 200, a down row is 503, and the API's own rows are left to /api/health", async () => {
    const { get, pool } = await boot();
    await put(pool, "api/b/reth", "down", "reth does not answer");
    await put(pool, "C8", "degraded", "there is no producer journal loaded");
    expect(await get("/healthz")).toMatchObject({ status: 200, body: { problems: ["C8: there is no producer journal loaded"] } });
    await put(pool, "C7", "down", "stopped");
    expect((await get("/api/status")).status).toBe(503);
    expect((await get("/api/health")).status).toBe(503);
  });

  it("is listed in the API description", async () => {
    const { get } = await boot();
    expect(Object.keys((await get("/api/openapi.json")).body.paths)).toContain("/api/health");
  });
});
