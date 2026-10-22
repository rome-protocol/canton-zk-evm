import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createIndexer } from "../indexer/indexer.ts";
import { RethTooBig, type Reth } from "../reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createChainRest } from "./chain-rest.ts";
import { CACHE_CONTROL } from "./cache.ts";
import { REST_FIELDS as F } from "./fields.ts";

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const keys = (o: object) => Object.keys(o).sort();
const same = (o: object, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());
const frame = { type: "call", action: { callType: "call", from: "0x" + "11".repeat(20), to: "0x" + "22".repeat(20), value: "0x5", gas: "0x100", input: "0xa9059cbb" }, result: { gasUsed: "0x10" }, traceAddress: [], subtraces: 0 };

describe.skipIf(!TEST_URL)("the REST routes of the chain", () => {
  checkRequired();
  let db: TestDatabase, pool: Pool, chain: ReturnType<typeof makeChain>, rethTrace: unknown[] | null;
  const get = async (target: string): Promise<Answer> => {
    const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
    const reth = {
      code: async () => "0x6080", token: async () => ({ name: "Token", symbol: "TKN", decimals: 6 }), block: async () => undefined, transaction: async () => null,
      rpc: async (m: string) => (m === "trace_transaction" ? (rethTrace === ("toobig" as never) ? Promise.reject(new RethTooBig(m, 1)) : rethTrace) : m === "eth_getTransactionReceipt" ? { status: "0x1", gasUsed: "0x5208", logs: [] } : null),
    } as unknown as Reth;
    return createApi({ config, reth, ledger: { ledgerEnd: async () => 1 } as never, chain: createChainDb(pool), rest: createChainRest(pool) })("GET", target);
  };
  const tx = (block: number, i: number) => chain.blocks[block - 1]!.block.transactions[i]!.hash;
  const setCursor = (n: number) => pool.query("update cursors set position = $1 where stream = 'derive'", [n]);
  const body = (a: Answer) => a.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    db = await makeDatabase();
    pool = db.pool;
    await migrate(pool);
    chain = makeChain([{ txs: 0 }, { txs: 5, leg: 2 }, { txs: 7 }]);
    const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "inline" });
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }
    rethTrace = [frame, { ...frame, traceAddress: [0] }];
    // The synthetic chain's token and call rows are not what these tests need: one transfer and one internal call, written as stage 2 writes them.
    const at = tx(2, 1), who = (n: number) => Buffer.alloc(20, n);
    const [t] = (await pool.query("select block_number, tx_index from tx_hashes where hash = $1", [Buffer.from(at.slice(2), "hex")])).rows;
    await pool.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount) values ($1, 90, 0, $2, $3, $4, $5, 50), ($1, 91, 1, $2, $3, $4, $5, 7)", [t.block_number, t.tx_index, who(1), who(2), who(3)]);
    await pool.query("insert into internal_calls (block_number, tx_index, trace_address, call_type, from_address, to_address, value) values ($1, $2, '{}', 'call', $3, $4, 9), ($1, $2, '{0,1}', 'call', $4, $3, 4)", [t.block_number, t.tx_index, who(2), who(3)]);
  });
  afterAll(async () => { await db?.drop(); });

  it("builds every answer from the allowlists", async () => {
    const list = body(await get("/api/blocks"));
    same(list, F.page);
    for (const b of list.items) same(b, F.blockItem);
    const b = body(await get("/api/blocks/2"));
    same(b, F.blockDetail);
    if (b.lifecycle) same(b.lifecycle, F.blockLifecycle);
    same(b.canton, F.cantonSummary);
    expect(b.legsCount).toBe(1);
    expect(b.derived).toBe(true);
    for (const t of body(await get("/api/blocks/2/transactions")).items) same(t, F.txItem);
    for (const t of body(await get("/api/blocks/2/transactions")).items) expect(t.methodId === null || /^0x[0-9a-f]{8}$/.test(t.methodId)).toBe(true);
    const legs = body(await get(`/api/blocks/${chain.blocks[1]!.block.hash}/legs`));
    expect(legs.items.length).toBe(1);
    same(legs.items[0], F.leg);
    expect(legs.items[0].kind).toBe("withdrawal");
    same(body(await get("/api/blocks/2/record")), F.record);
    for (const t of body(await get("/api/txs")).items) same(t, F.txItem);
    same(body(await get(`/api/txs/${tx(2, 1)}`)), F.txDetail);
    const logs = body(await get(`/api/txs/${tx(2, 3)}/logs`));
    expect(logs.items.length).toBeGreaterThan(1);
    for (const l of logs.items) same(l, F.log);
    for (const l of body(await get(`/api/txs/${tx(2, 3)}/logs?raw=1`)).items) same(l, F.rawLog);
    const moved = body(await get(`/api/txs/${tx(2, 1)}/token-transfers`));
    same(moved, F.derivedPage);
    expect(moved.items.length).toBeGreaterThan(0);
    for (const t of moved.items) same(t, F.transfer);
    expect(moved.items.map((x: { logIndex: number; batchIndex: number }) => [x.logIndex, x.batchIndex])).toEqual([[90, 0], [91, 1]]);
    const calls = body(await get(`/api/txs/${tx(2, 1)}/internal`));
    expect(calls.items.map((c: { traceAddress: number[] }) => c.traceAddress)).toEqual([[], [0, 1]]);
    for (const c of calls.items) same(c, F.internal);
    const trace = body(await get(`/api/txs/${tx(2, 0)}/trace`));
    same(trace, F.trace);
    expect(trace.frames).toHaveLength(2);
    for (const f of trace.frames) same(f, F.frame);
    const updates = body(await get("/api/canton/updates"));
    for (const u of updates.items) same(u, F.updateItem);
    expect(updates.items).toHaveLength(3);
    const u = body(await get(`/api/canton/updates/${chain.blocks[1]!.record.updateId}`));
    same(u, F.updateDetail);
    same(u.template, F.updateTemplate);
    expect(u.block).toBe(2);
    expect(u.signatories.map((s: { role: string }) => s.role).sort()).toEqual(["confirmer", "operator"]);
    for (const s of u.signatories) same(s, F.signatory);
  });

  it("keeps a block's and a transaction's page small: the transactions and the logs are their own pages", async () => {
    const b = body(await get("/api/blocks/2")), t = body(await get(`/api/txs/${tx(2, 1)}`));
    expect(b).not.toHaveProperty("transactions");
    expect(t).not.toHaveProperty("logs");
    expect(JSON.stringify(b).length).toBeLessThan(4000);
    // The page's query leaves out the record's transactions, which are most of its bytes.
    const light = await createChainDb(pool).block(2, false), full = await createChainDb(pool).block(2);
    expect(light?.txsHex).toBe("");
    expect(full?.txsHex.length).toBeGreaterThan(0);
  });

  it("cuts a frame's input at 1,024 bytes with its size, serves it whole with raw=1, and gives a final transaction's receipt as reth did", async () => {
    const input = "0x" + "ab".repeat(3000);
    rethTrace = [{ ...frame, action: { ...frame.action, input } }];
    try {
      const cut = body(await get(`/api/txs/${tx(2, 0)}/trace`)).frames[0];
      expect(cut.input).toBe("0x" + "ab".repeat(1024));
      expect(cut.inputSize).toBe(3000);
      expect(body(await get(`/api/txs/${tx(2, 0)}/trace?raw=1`)).frames[0].input).toBe(input);
    } finally {
      rethTrace = [frame, { ...frame, traceAddress: [0] }];
    }
    expect(body(await get(`/api/txs/${tx(2, 0)}?raw=1`))).toEqual({ status: "0x1", gasUsed: "0x5208", logs: [] });
    expect((await get(`/api/txs/0x${"00".repeat(32)}?raw=1`)).status).toBe(404);
  });

  it("never serves the builder participant's completion offset", async () => {
    await pool.query("update canton_updates set completion_offset = 4242, command_id = coalesce(command_id, 'cmd-1') where update_id = $1", [chain.blocks[1]!.record.updateId]);
    for (const target of [`/api/canton/updates/${chain.blocks[1]!.record.updateId}`, "/api/canton/updates", "/api/blocks/2", "/api/block/2"]) {
      const text = JSON.stringify((await get(target)).body);
      expect(text, target).not.toMatch(/completion_?offset/i);
      expect(text, target).not.toContain("4242");
    }
  });

  it("lists blocks with the proof time and the time to final, filtered, and as a bounded CSV", async () => {
    await pool.query("insert into producer_runs (run_id, started_at, strategy, settings, source_commit) values ('00000000-0000-0000-0000-000000000009', now(), 'rhythm', '{}', 'x') on conflict do nothing");
    const [a] = (await pool.query(
      `insert into block_attempts (run_id, attempt_seq, number, strategy, cut_reason, cut_at, proof_started_at, proof_ended_at)
       select '00000000-0000-0000-0000-000000000009', 1, 2, 'rhythm', 'pool', b.record_time - interval '8 seconds', b.record_time - interval '7.5 seconds', b.record_time - interval '0.5 seconds' from blocks b where b.number = 2 returning attempt_id`)).rows;
    await pool.query("update blocks set attempt_id = $1 where number = 2", [a.attempt_id]);
    const all = body(await get("/api/blocks"));
    const two = all.items.find((b: { number: number }) => b.number === 2), three = all.items.find((b: { number: number }) => b.number === 3);
    expect(two.proofSeconds).toBeCloseTo(7, 3);
    expect(two.finalSeconds).toBeCloseTo(8, 3);
    expect(three.proofSeconds).toBeNull();
    expect(three.finalSeconds).toBeNull();
    expect(body(await get("/api/blocks?filter=transactions")).items.map((b: { number: number }) => b.number)).toEqual([3, 2]);
    expect(body(await get("/api/blocks?filter=empty")).items.map((b: { number: number }) => b.number)).toEqual([1]);
    expect(body(await get("/api/blocks?filter=all")).items.length).toBe(3);
    const p = body(await get("/api/blocks?filter=transactions&limit=1"));
    expect(p.items.map((b: { number: number }) => b.number)).toEqual([3]);
    expect(body(await get(`/api/blocks?filter=transactions&limit=1&before=${p.next}`)).items.map((b: { number: number }) => b.number)).toEqual([2]);
    expect((await get("/api/blocks?filter=nope")).status).toBe(400);
    const csv = await get("/api/blocks?format=csv&filter=transactions");
    expect(csv.status).toBe(200);
    expect(csv.headers?.["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers?.["content-disposition"]).toMatch(/attachment; filename="blocks\.csv"/);
    const lines = String(csv.body).trim().split("\r\n");
    expect(lines[0]).toBe("block,time,transactions,gas_used,gas_limit,proof_seconds,seconds_to_final,canton_update_id,stage");
    expect(lines.length).toBe(3);
    expect(lines[2]!.split(",")[0]).toBe("2");
    expect(lines[2]!.split(",")[5]).toBe("7.000");
    expect(lines[1]!.split(",")[5]).toBe("");
    expect((await get("/api/blocks?format=xml")).status).toBe(400);
    expect((await get("/api/blocks?format=csv&limit=0")).status).toBe(400);
    expect(String(csv.body)).not.toMatch(/completion/i);
  });

  it("pages every list by keyset, in a stable order, without a repeat or a gap", async () => {
    const seen: number[] = [];
    let next: string | null = null;
    do {
      const p = body(await get(`/api/blocks?limit=1${next ? `&before=${next}` : ""}`));
      expect(p.items.length).toBeLessThanOrEqual(1);
      seen.push(...p.items.map((b: { number: number }) => b.number));
      next = p.next;
    } while (next);
    expect(seen).toEqual([3, 2, 1]);
    const hashes: string[] = [];
    next = null;
    do {
      const p = body(await get(`/api/txs?limit=4${next ? `&before=${next}` : ""}`));
      hashes.push(...p.items.map((t: { hash: string }) => t.hash));
      next = p.next;
    } while (next);
    expect(hashes).toEqual([...chain.blocks[2]!.block.transactions].reverse().concat([...chain.blocks[1]!.block.transactions].reverse()).map((t) => (typeof t === "string" ? t : t.hash)));
    const inBlock: string[] = [];
    next = null;
    do {
      const p = body(await get(`/api/blocks/3/transactions?limit=3${next ? `&after=${next}` : ""}`));
      inBlock.push(...p.items.map((t: { hash: string }) => t.hash));
      next = p.next;
    } while (next);
    expect(inBlock).toEqual(chain.blocks[2]!.block.transactions.map((t) => t.hash));
    const one = async (route: string, key: "after") => {
      const out: unknown[] = [];
      let n: string | null = null;
      do {
        const p = body(await get(`/api/txs/${tx(2, 1)}/${route}?limit=1${n ? `&${key}=${n}` : ""}`));
        out.push(...p.items);
        n = p.next;
      } while (n);
      return out;
    };
    expect(await one("token-transfers", "after")).toHaveLength(2);
    expect(await one("internal", "after")).toHaveLength(2);
    const ups: string[] = [];
    next = null;
    do {
      const p = body(await get(`/api/canton/updates?limit=2${next ? `&before=${next}` : ""}`));
      ups.push(...p.items.map((u: { updateId: string }) => u.updateId));
      next = p.next;
    } while (next);
    expect(ups).toEqual([3, 2, 1].map((n) => chain.blocks[n - 1]!.record.updateId));
  });

  it("refuses a limit or a key that is not one", async () => {
    for (const bad of ["/api/blocks?limit=0", "/api/blocks?limit=abc", "/api/blocks?before=-1", "/api/blocks?before=1:2", "/api/txs?before=5", "/api/canton/updates?before=1:ZZ", "/api/txs?before=5:9999999999", "/api/blocks/2/transactions?after=9999999999", `/api/txs/${tx(2, 0)}/internal?after=t9999999999`, `/api/txs/${tx(2, 0)}/internal?after=x`]) {
      expect((await get(bad)).status, bad).toBe(400);
    }
    expect((await get("/api/blocks/xyz")).status).toBe(400);
    expect((await get("/api/txs/0x12")).status).toBe(400);
    expect((await get("/api/canton/updates/nope")).status).toBe(400);
    expect((await get("/api/blocks/999/transactions")).status).toBe(404);
    expect((await get(`/api/txs/0x${"ab".repeat(32)}/logs`)).status).toBe(404);
    expect((await get("/api/blocks/3/legs/extra")).status).toBe(404);
  });

  it("caches what cannot change for a year, what can for seconds, and lists for a second", async () => {
    const rule = async (t: string) => (await get(t)).headers?.["cache-control"];
    expect(await rule("/api/blocks/2/record")).toBe(CACHE_CONTROL.immutable);
    expect(await rule(`/api/txs/${tx(2, 3)}/logs?raw=1`)).toBe(CACHE_CONTROL.immutable);
    expect(await rule(`/api/txs/${tx(2, 0)}/trace`)).toBe(CACHE_CONTROL.immutable);
    expect(await rule(`/api/txs/${tx(2, 0)}?raw=1`)).toBe(CACHE_CONTROL.immutable);
    expect(await rule(`/api/txs/${tx(2, 1)}/token-transfers?raw=1`)).toBe(CACHE_CONTROL.immutable);
    expect(await rule(`/api/txs/${tx(2, 1)}/token-transfers`)).toBe(CACHE_CONTROL.composite);
    for (const t of ["/api/blocks/2", "/api/blocks/2/transactions", "/api/blocks/2/legs", `/api/txs/${tx(2, 1)}`, `/api/txs/${tx(2, 3)}/logs`, `/api/txs/${tx(2, 1)}/internal`,
      `/api/canton/updates/${chain.blocks[1]!.record.updateId}`, "/api/block/2", `/api/tx/${tx(2, 1)}`]) {
      expect(await rule(t), t).toBe(CACHE_CONTROL.composite);
    }
    for (const t of ["/api/blocks", "/api/txs", "/api/canton/updates", "/api/in-flight"]) expect(await rule(t), t).toBe(CACHE_CONTROL.list);
    const a = await get("/api/blocks/2"), again = await get("/api/blocks/2");
    expect(a.headers?.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(again.headers?.etag).toBe(a.headers?.etag);
    expect((await get("/api/blocks/3")).headers?.etag).not.toBe(a.headers?.etag);
    const missing = await get("/api/blocks/999/record");
    expect(missing.status).toBe(404);
    expect(missing.headers?.["cache-control"]).toBeUndefined();
  });

  it("says 'not derived yet' for what stage 2 has not reached, and caches it as nothing final", async () => {
    await setCursor(2);
    try {
      const done = body(await get(`/api/txs/${tx(2, 1)}`)), behind = body(await get(`/api/txs/${tx(3, 1)}`));
      expect(done.derived).toBe(true);
      expect(done.callCount).toBe(0);
      expect(body(await get(`/api/txs/${tx(2, 3)}`)).callCount).toBe(3);
      expect(behind).toMatchObject({ derived: false, callCount: null, revertReason: null });
      expect(behind.hash).toBe(tx(3, 1));
      expect(body(await get("/api/blocks/3")).derived).toBe(false);
      expect(body(await get("/api/blocks/2")).derived).toBe(true);
      for (const route of ["internal", "token-transfers"]) {
        const a = await get(`/api/txs/${tx(3, 1)}/${route}?raw=1`);
        expect(a.body).toEqual({ derived: false, items: [], next: null });
        expect(a.headers?.["cache-control"]).toBe(CACHE_CONTROL.composite);
      }
      expect(body(await get(`/api/txs/${tx(3, 1)}/logs`)).items.length).toBeGreaterThan(0);
      await setCursor(0);
      expect(body(await get("/api/blocks/2")).derived).toBe(false);
    } finally {
      await setCursor(3);
    }
  });

  it("answers 404 for a trace reth does not hold", async () => {
    rethTrace = null;
    try {
      expect((await get(`/api/txs/${tx(2, 0)}/trace`)).status).toBe(404);
    } finally {
      rethTrace = [frame];
    }
  });

  it("answers 502 for a trace that is too big to serve", async () => {
    rethTrace = "toobig" as never;
    try {
      const a = await get(`/api/txs/${tx(2, 0)}/trace`);
      expect(a.status).toBe(502);
      expect(body(a).error).toBe("the trace is too big to serve");
    } finally {
      rethTrace = [frame];
    }
  });

  it("is off without the reads behind it", async () => {
    const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
    const api = createApi({ config, reth: {} as Reth, ledger: {} as never, chain: createChainDb(pool) });
    expect((await api("GET", "/api/blocks")).status).toBe(404);
  });
});
