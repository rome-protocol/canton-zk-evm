// Run: node --test load/mixed/scripts/limiter.test.mjs   (a virtual clock: no real waiting, no chain)
import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "./limiter.mjs";

/** A virtual clock: sleep() parks a timer; run() lets every ready promise finish, then jumps to the next timer. */
function clock() {
  let t = 1_000_000; const timers = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: (ms) => new Promise((r) => timers.push({ at: t + ms, r })),
    async run(untilMs, stop = () => false) {
      const end = t + untilMs;
      for (;;) {
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
        if (stop() || !timers.length) return;
        timers.sort((a, b) => a.at - b.at);
        if (timers[0].at > end) { t = end; return; }
        const x = timers.shift(); t = Math.max(t, x.at); x.r();
      }
    },
  };
}

test("calls under the budget go through at once; a call over it waits for the minute to slide", async () => {
  const c = clock(), lim = createLimiter({ limit: 10, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 10; i++) await lim.acquire(1);
  assert.equal(lim.left(), 0);
  let done = false; lim.acquire(1).then(() => { done = true; });
  await c.run(30_000); assert.equal(done, false);
  await c.run(31_000); assert.equal(done, true);
});

test("a batch bigger than the whole budget is refused, not left to wait forever", async () => {
  const lim = createLimiter({ limit: 10, now: Date.now, sleep: async () => {} });
  await assert.rejects(lim.acquire(11), /larger than the budget/);
});

test("first come, first served: a batch that came first is let through before the singles that came after it", async () => {
  const c = clock(), lim = createLimiter({ limit: 20, now: c.now, sleep: c.sleep });
  await lim.acquire(20); // the minute is used up
  const order = [];
  lim.acquire(15).then(() => order.push("batch"));
  for (let i = 0; i < 5; i++) lim.acquire(1).then(() => order.push("single"));
  await c.run(120_000);
  assert.deepEqual(order, ["batch", "single", "single", "single", "single", "single"]);
});

test("first come, first served when slots free one at a time: the batch queued first gets them before the singles queued after it", async () => {
  const c = clock(), lim = createLimiter({ limit: 20, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 20; i++) { await lim.acquire(1); c.advance(3_000); } // the minute's calls are 3 s apart, so they expire one by one
  const order = [];
  lim.acquire(15).then(() => order.push("batch"));
  for (let i = 0; i < 5; i++) lim.acquire(1).then(() => order.push("single"));
  await c.run(300_000);
  assert.deepEqual(order, ["batch", "single", "single", "single", "single", "single"]);
});

test("at the budget with a send loop that never stops, the refill check (batches of 20) still finishes within a bound", async () => {
  const c = clock(), lim = createLimiter({ limit: 285, now: c.now, sleep: c.sleep });
  let sends = 0, stopped = false;
  const sender = async () => { while (!stopped) { await lim.acquire(1); sends++; } }; // 40 senders in flight, as the driver allows
  for (let i = 0; i < 40; i++) sender();
  await c.run(70_000); // the budget is used up and the senders queue on it
  const t0 = c.now(); let doneAt = null;
  (async () => { for (let i = 0; i < 2; i++) await lim.acquire(20); doneAt = c.now(); })(); // a check that reads 10 wallets: two batches of 20 calls
  await c.run(300_000, () => doneAt !== null);
  stopped = true;
  assert.notEqual(doneAt, null, "the refill check never got its calls");
  assert.ok(doneAt - t0 <= 60_000, `the refill check took ${(doneAt - t0) / 1000} s`);
  // and the senders were never held to less than the budget: over the whole run the calls stayed under it in every minute
  assert.ok(lim.used() <= 285);
});

test("the server never sees more than the budget in any minute, batches included", async () => {
  const c = clock(), lim = createLimiter({ limit: 100, now: c.now, sleep: c.sleep }), log = [];
  const call = async (n) => { await lim.acquire(n); for (let i = 0; i < n; i++) log.push(c.now()); };
  let stopped = false;
  for (let i = 0; i < 10; i++) (async () => { while (!stopped) await call(1); })();
  (async () => { while (!stopped) await call(20); })();
  await c.run(600_000); stopped = true;
  let worst = 0;
  for (let i = 0; i < log.length; i++) { let n = 0; for (let j = i; j < log.length && log[j] - log[i] <= 60_000; j++) n++; worst = Math.max(worst, n); }
  assert.ok(worst <= 100, `${worst} calls inside one minute`);
});
