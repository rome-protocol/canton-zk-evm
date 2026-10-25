// The RPC call budget: a sliding minute, shared by every caller. Plain code with no imports, so a unit test runs it on a virtual clock.
//
// It is first come, first served. A caller that needs n calls (a batch) joins the queue and takes slots as they free up, one after another, while the
// callers behind it wait: single sends can not take every freed slot and starve a batch. A batch's calls are stamped when it is let through (all at that
// moment), so the window the server sees is never wider than the budget.

export function createLimiter({ limit = 285, now = Date.now, sleep, stats = {} } = {}) {
  let max = limit;
  const stamps = [];
  const waiters = [];
  let running = false;
  stats.calls ??= 0; stats.waits ??= 0; stats.waitedMs ??= 0;
  const prune = (t) => { while (stamps.length && t - stamps[0] > 60_000) stamps.shift(); };
  /** Calls made in the last minute, with the slots a waiting batch has reserved. */
  const used = () => { prune(now()); return stamps.length + (waiters[0]?.got ?? 0); };
  const left = () => max - used();

  async function run() {
    running = true;
    try {
      while (waiters.length) {
        const w = waiters[0], t = now();
        prune(t);
        const take = Math.min(max - stamps.length - w.got, w.n - w.got);
        if (take > 0) w.got += take;
        if (w.got >= w.n) {
          for (let i = 0; i < w.n; i++) stamps.push(t);
          stats.calls += w.n;
          waiters.shift();
          w.resolve();
          continue;
        }
        const wait = Math.max(5, stamps.length ? stamps[0] + 60_000 - t + 5 : 1000);
        stats.waits++; stats.waitedMs += wait;
        await sleep(wait);
      }
    } finally { running = false; }
  }

  /** Resolves when n calls may be made. A batch larger than the whole budget could never be let through, so it is refused. */
  function acquire(n) {
    if (n > max) return Promise.reject(new Error(`a batch of ${n} calls is larger than the budget of ${max} a minute`));
    const t = now();
    prune(t);
    if (!waiters.length && stamps.length + n <= max) { for (let i = 0; i < n; i++) stamps.push(t); stats.calls += n; return Promise.resolve(); }
    return new Promise((resolve) => { waiters.push({ n, got: 0, resolve }); if (!running) run(); });
  }
  return { acquire, used, left, setLimit: (n) => { max = n; }, stats };
}
