// The load driver's one door to the chain's RPC. The public RPC allows about 300 calls a minute per client and a batch counts each call in it, so every call, a
// send, a receipt read or a view, is counted here against one shared budget (a sliding minute) and waits when the budget is used up.
import { RPC } from "./lib.mjs";
import { createLimiter } from "./limiter.mjs";

export const UA = "Rome Protocol rome@romeprotocol.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

export const stats = { calls: 0, httpLimited: 0, waits: 0, waitedMs: 0, errors: 0 };
// first come, first served (see limiter.mjs): a batch is not starved by single sends
const limiter = createLimiter({ limit: 285, sleep, stats }); // a little under the 300 the RPC allows
export const setBudget = limiter.setLimit;
/** Calls made in the last minute. */
export const used = limiter.used;
/** Calls still free in this minute. */
export const left = limiter.left;
const acquire = limiter.acquire;

async function post(body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    if (attempt > 0) await acquire(Array.isArray(body) ? body.length : 1); // a retry spends the server's budget again
    try {
      res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (e) { stats.errors++; if (attempt > 5) throw e; await sleep(1000); continue; }
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = null; }
    const limited = res.status === 429 || (j && !Array.isArray(j) && j.error && /rate|limit|too many/i.test(j.error.message ?? ""));
    if (limited) { stats.httpLimited++; if (attempt > 8) throw new Error("rpc: still rate limited"); await sleep(4000 + 2000 * attempt); continue; }
    if (!j) throw new Error(`rpc: HTTP ${res.status} ${text.slice(0, 120)}`);
    return j;
  }
}

/** One call. Throws an Error (with .code) for a JSON-RPC error. */
export async function rpc(method, params = []) {
  await acquire(1);
  const j = await post({ jsonrpc: "2.0", id: 1, method, params });
  if (j.error) { const e = new Error(j.error.message ?? "rpc error"); e.code = j.error.code; e.data = j.error.data; throw e; }
  return j.result;
}

/** Up to 20 calls in one request. Returns one { result } or { error } per call. */
export async function rpcBatch(calls) {
  if (calls.length > 20) throw new Error("a batch is at most 20 calls");
  await acquire(calls.length);
  const j = await post(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c[0], params: c[1] ?? [] })));
  const out = new Array(calls.length).fill({ error: { message: "no answer" } });
  for (const r of Array.isArray(j) ? j : []) out[r.id] = r;
  return out;
}
