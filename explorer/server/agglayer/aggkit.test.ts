import { describe, expect, it } from "vitest";
import { AGGKIT_PATHS, AGGKIT_TIMEOUT_MS, AGGKIT_USER_AGENT, AggkitError, createAggkitReader } from "./aggkit.ts";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const leaf = (over: Record<string, unknown> = {}) => ({
  deposit_count: 7, tx_hash: H(1), block_timestamp: 1_700_000_000, block_finalized: true, leaf_type: 0, global_index: "18446744073709551623", origin_network: 0, origin_address: A(0),
  destination_network: 75, destination_address: A(0xbeef), amount: "2000000000000000", metadata: "0x", ...over,
});
const proof = { l1_info_tree_leaf: { mainnet_exit_root: H(2), rollup_exit_root: H(3) }, proof_local_exit_root: Array.from({ length: 32 }, (_, i) => H(100 + i)), proof_rollup_exit_root: Array.from({ length: 32 }, (_, i) => H(200 + i)) };

interface Seen { url: string; init: RequestInit | undefined }
/** A fetch that answers from `routes` (a function of the path and query), and keeps every request. */
function fake(routes: (path: string, q: URLSearchParams) => Response | undefined) {
  const seen: Seen[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const u = new URL(String(url));
    return routes(u.pathname, u.searchParams) ?? new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const BASE = "http://127.0.0.1:5578";
const reader = (routes: Parameters<typeof fake>[0], extra: Partial<Parameters<typeof createAggkitReader>[0]> = {}) => {
  const f = fake(routes);
  let t = 0;
  return { ...f, now: () => t, advance: (ms: number) => (t += ms), api: createAggkitReader({ baseUrl: BASE, fetch: f.fetcher, now: () => t, ...extra }) };
};

describe("the reader of AggKit's bridge service", () => {
  it("asks only the fixed routes, with a GET that follows no redirect, the project's User-Agent and a timeout of about a second and a half", async () => {
    expect(AGGKIT_TIMEOUT_MS).toBe(1500);
    expect(Object.values(AGGKIT_PATHS).sort()).toEqual(["/bridge/v1/bridges", "/bridge/v1/claim-proof", "/bridge/v1/injected-l1-info-leaf", "/bridge/v1/l1-info-tree-index", "/bridge/v1/settlements", "/bridge/v1/sync-status", "/health"]);
    const r = reader((p) => (p === "/bridge/v1/bridges" ? json({ bridges: [leaf()], count: 1 }) : undefined));
    await r.api.bridge(0, 7);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.url).toBe(`${BASE}/bridge/v1/bridges?network_id=0&deposit_count=7`);
    expect(r.seen[0]!.init).toMatchObject({ redirect: "error", headers: { "user-agent": "Rome Protocol rome@romeprotocol.com" } });
    expect(r.seen[0]!.init?.method).toBeUndefined();
    expect(r.seen[0]!.init?.signal).toBeDefined();
    expect(AGGKIT_USER_AGENT).toBe("Rome Protocol rome@romeprotocol.com");
  });

  it("reads a deposit with its numbers validated, and says nothing for one the service does not have yet", async () => {
    const r = reader((p, q) => (p === "/bridge/v1/bridges" ? json(q.get("deposit_count") === "7" ? { bridges: [leaf()], count: 1 } : { bridges: [], count: 0 }) : undefined));
    expect(await r.api.bridge(0, 7)).toEqual({
      depositCount: 7, txHash: H(1), blockTimestamp: 1_700_000_000, leafType: 0, globalIndex: "18446744073709551623", originNetwork: 0, originAddress: A(0),
      destinationNetwork: 75, destinationAddress: A(0xbeef), amount: "2000000000000000", metadata: "0x",
    });
    expect(await r.api.bridge(0, 8)).toBeUndefined();
  });

  it("refuses a deposit whose fields are not what the bridge writes", async () => {
    for (const bad of [{ amount: "-1" }, { amount: 5 }, { global_index: "x" }, { tx_hash: "0x12" }, { origin_address: "0xzz" }, { destination_network: "75" }, { metadata: "0xabc" }, { leaf_type: 1.5 }, { block_timestamp: -1 }, { metadata: "0x" + "00".repeat(5000) }]) {
      const r = reader(() => json({ bridges: [leaf(bad)] }));
      await expect(r.api.bridge(0, 7), JSON.stringify(bad)).rejects.toThrow(AggkitError);
    }
    await expect(reader(() => json({ bridges: "no" })).api.bridge(0, 7)).resolves.toBeUndefined();
  });

  it("takes only whole numbers that fit the bridge's uint32 into a request", async () => {
    const r = reader(() => json({}));
    for (const bad of [-1, 1.5, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY]) await expect(r.api.bridge(bad, 1)).rejects.toThrow(TypeError);
    await expect(r.api.bridge(0, 2 ** 32)).rejects.toThrow(TypeError);
    await expect(r.api.claimProof(0, -1, 1)).rejects.toThrow(TypeError);
    expect(r.seen).toHaveLength(0);
  });

  it("reads the index, the injected leaf and the claim proof, and treats 404 and 503 as not ready", async () => {
    const r = reader((p, q) => {
      if (p === "/bridge/v1/l1-info-tree-index") return q.get("deposit_count") === "7" ? json(41) : json({ error: "not found" }, 404);
      if (p === "/bridge/v1/injected-l1-info-leaf") {
        if (q.get("leaf_index") === "99") return json({}, 503);
        return json(q.get("network_id") === "75" ? { l1_info_tree_index: 42, block_num: 12_345, timestamp: 1_700_000_100, injected_l2_block_timestamp: 1_700_000_200 } : { l1_info_tree_index: 42, block_num: 12_345, timestamp: 1_700_000_100 });
      }
      if (p === "/bridge/v1/claim-proof") return json(proof);
      return undefined;
    });
    expect(await r.api.l1InfoTreeIndex(0, 7)).toBe(41);
    expect(await r.api.l1InfoTreeIndex(0, 8)).toBeUndefined();
    expect(await r.api.injectedLeaf(75, 41)).toEqual({ index: 42, blockNumber: 12_345, timestamp: 1_700_000_100, injectedAt: 1_700_000_200 });
    expect(await r.api.injectedLeaf(0, 41)).toEqual({ index: 42, blockNumber: 12_345, timestamp: 1_700_000_100, injectedAt: undefined });
    expect(await r.api.injectedLeaf(0, 99)).toBeUndefined();
    const p = await r.api.claimProof(0, 42, 7);
    expect(p).toEqual({ proofLocal: proof.proof_local_exit_root, proofRollup: proof.proof_rollup_exit_root, mainnetExitRoot: H(2), rollupExitRoot: H(3) });
    expect(r.seen.at(-1)!.url).toBe(`${BASE}/bridge/v1/claim-proof?network_id=0&leaf_index=42&deposit_count=7`);
  });

  it("is not ready for a layer-two leaf that has no injection time yet, and refuses a proof that is not 32 hashes of 32 bytes", async () => {
    const early = reader(() => json({ l1_info_tree_index: 42, block_num: 1, timestamp: 2 }));
    expect(await early.api.injectedLeaf(75, 41)).toBeUndefined();
    for (const bad of [{ ...proof, proof_local_exit_root: [H(1)] }, { ...proof, proof_rollup_exit_root: Array(32).fill("0x12") }, { ...proof, l1_info_tree_leaf: { mainnet_exit_root: "x", rollup_exit_root: H(3) } }, { proof_local_exit_root: [] }]) {
      await expect(reader(() => json(bad)).api.claimProof(0, 42, 7)).rejects.toThrow(AggkitError);
    }
  });

  it("lists the newest settlements and says whether the service is healthy", async () => {
    const r = reader((p) => {
      if (p === "/bridge/v1/settlements") return json({ settlements: [{ tx_hash: H(9), block_number: 12_000, block_timestamp: 1_700_000_300 }, { block_number: 11_990 }, { bad: true }], total: 3 });
      if (p === "/health") return json({ status: "ok" });
      return undefined;
    });
    expect(await r.api.settlements()).toEqual([{ txHash: H(9), blockNumber: 12_000, blockTimestamp: 1_700_000_300 }, { txHash: null, blockNumber: 11_990, blockTimestamp: null }]);
    expect(await r.api.healthy()).toBe(true);
    expect(await reader((p) => (p === "/health" ? json({}, 500) : undefined)).api.healthy()).toBe(false);
  });

  it("reads the syncers' positions and halts from the sync status, under the service's own field names", async () => {
    const status = (body: unknown) => reader((p) => (p === "/bridge/v1/sync-status" ? json(body) : undefined)).api.syncStatus();
    const syncer = (last: number, over: Record<string, unknown> = {}) => ({ is_synced: true, last_processed_block: last, network_block: 1000, is_halted: false, ...over });
    expect(await status({ l1_info: syncer(5), l2_info: syncer(990), claim_l2_info: { last_processed_block: 985 }, l1_info_tree_info: syncer(6) })).toEqual({ halted: false, ostiaBlock: 985, ostiaHead: 1000 });
    expect(await status({ l1_info: syncer(5), l2_info: syncer(990, { is_halted: true }), l1_info_tree_info: syncer(6) })).toMatchObject({ halted: true, ostiaBlock: 990 });
    expect(await status({ l1_info: syncer(5, { is_halted: true }), l2_info: syncer(990) })).toMatchObject({ halted: true });
    expect(await status({ l2_info: { last_processed_block: "77", network_block: "80" } })).toEqual({ halted: null, ostiaBlock: 77, ostiaHead: 80 });
    expect(await status({ l2_info: { last_processed_block: -1, network_block: "x" }, l1_info: { is_halted: "no" } })).toEqual({ halted: null, ostiaBlock: null, ostiaHead: null });
    expect(await status({ nothing: 1 })).toEqual({ halted: null, ostiaBlock: null, ostiaHead: null });
    expect(await reader(() => json({}, 404)).api.syncStatus()).toBeNull();
    await expect(status([1])).rejects.toThrow(AggkitError);
  });

  it("says in words, as an AggkitError, when the answer's body stalls or breaks after its headers came", async () => {
    const broken = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); c.error(new TypeError("terminated")); } }), { status: 200 });
    const e = await reader(broken).api.bridge(0, 1).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(AggkitError);
    expect((e as Error).message).toBe("the bridge service's answer could not be read");
    const stalled = createAggkitReader({ baseUrl: BASE, timeoutMs: 20, fetch: (async (_u: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason)); } }), { status: 200 })) as unknown as typeof fetch });
    expect(await stalled.bridge(0, 1).catch((x: unknown) => x)).toBeInstanceOf(AggkitError);
  });

  it("says in words, never with the address, what went wrong, and does not follow a redirect", async () => {
    const down = createAggkitReader({ baseUrl: BASE, fetch: (async () => { throw new TypeError(`fetch failed ${BASE}`); }) as unknown as typeof fetch });
    const e = await down.bridge(0, 1).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(AggkitError);
    expect((e as Error).message).not.toContain("127.0.0.1");
    const slow = await reader(() => json({}, 500)).api.bridge(0, 1).catch((x: unknown) => x as Error);
    expect((slow as Error).message).toBe("the bridge service answered HTTP 500");
    const notJson = await reader(() => new Response("<html>", { status: 200 })).api.bridge(0, 1).catch((x: unknown) => x as Error);
    expect((notJson as Error).message).toBe("the bridge service did not answer with JSON");
    const big = await reader(() => new Response("x".repeat(2 * 1024 * 1024))).api.bridge(0, 1).catch((x: unknown) => x as Error);
    expect((big as Error).message).toBe("the bridge service's answer is too long");
  });

  it("keeps an answer for a few seconds and asks once for requests that arrive together, and never keeps a failure", async () => {
    let calls = 0;
    const r = reader((p) => { calls++; return p === "/bridge/v1/l1-info-tree-index" ? json(5) : undefined; });
    const [a, b] = await Promise.all([r.api.l1InfoTreeIndex(0, 1), r.api.l1InfoTreeIndex(0, 1)]);
    expect([a, b, calls]).toEqual([5, 5, 1]);
    r.advance(2900);
    await r.api.l1InfoTreeIndex(0, 1);
    expect(calls).toBe(1);
    r.advance(200);
    await r.api.l1InfoTreeIndex(0, 1);
    expect(calls).toBe(2);
    let n = 0;
    const flaky = reader(() => (++n === 1 ? json({}, 500) : json(5)));
    await expect(flaky.api.l1InfoTreeIndex(0, 1)).rejects.toThrow(AggkitError);
    expect(await flaky.api.l1InfoTreeIndex(0, 1)).toBe(5);
  });

  it("keeps 'not there yet' for one second only, so a deposit that arrives is seen", async () => {
    let there = false;
    const r = reader(() => (there ? json(9) : json({}, 404)));
    expect(await r.api.l1InfoTreeIndex(0, 1)).toBeUndefined();
    there = true;
    r.advance(900);
    expect(await r.api.l1InfoTreeIndex(0, 1)).toBeUndefined();
    r.advance(200);
    expect(await r.api.l1InfoTreeIndex(0, 1)).toBe(9);
  });

  it("holds a bounded number of answers", async () => {
    const r = reader(() => json(1), { maxEntries: 3 });
    for (let i = 0; i < 10; i++) await r.api.l1InfoTreeIndex(0, i);
    expect(r.api.cached()).toBeLessThanOrEqual(3);
  });
});
