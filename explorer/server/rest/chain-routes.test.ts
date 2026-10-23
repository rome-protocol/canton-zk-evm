import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createApi, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createIndexer } from "../indexer/indexer.ts";
import { RethTooBig, type Reth } from "../reth.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createChainRest, txSelect } from "./chain-rest.ts";
import { CACHE_CONTROL } from "./cache.ts";
import { REST_FIELDS as F } from "./fields.ts";
import { TAIL_MAX_MS } from "./tx-total.ts";

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
  /** A token as stage 2 holds it: its contract (any code will do here) and its metadata row. */
  const addToken = async (address: Buffer, standard: string, name: string, symbol: string, decimals: number | null, first: number) => {
    await pool.query("insert into bytecodes (code_hash, code, size) values ($1, $2, 2) on conflict do nothing", [Buffer.alloc(32, 0x5a), Buffer.from("6080", "hex")]);
    await pool.query("insert into contracts (address, origin, runtime_code_hash, name) values ($1, 'genesis', $2, $3)", [address, Buffer.alloc(32, 0x5a), name]);
    await pool.query("insert into tokens (address, standard, name, symbol, decimals, first_transfer_block, metadata_status) values ($1, $2, $3, $4, $5, $6, 'read')", [address, standard, name, symbol, decimals, first]);
  };
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
    // One transaction is a contract creation: no recipient, a created contract, and a method id taken from its init code.
    const [made] = (await pool.query("select block_number, tx_index from tx_hashes where hash = $1", [Buffer.from(tx(3, 6).slice(2), "hex")])).rows;
    await pool.query("update transactions set to_address = null, created_contract = $3, method_id = $4 where block_number = $1 and tx_index = $2", [made.block_number, made.tx_index, who(7), Buffer.from("60806040", "hex")]);
    await pool.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount) values ($1, 90, 0, $2, $3, $4, $5, 50), ($1, 91, 1, $2, $3, $4, $5, 7)", [t.block_number, t.tx_index, who(1), who(2), who(3)]);
    await pool.query("insert into internal_calls (block_number, tx_index, trace_address, call_type, from_address, to_address, value) values ($1, $2, '{}', 'call', $3, $4, 9), ($1, $2, '{0,1}', 'call', $4, $3, 4)", [t.block_number, t.tx_index, who(2), who(3)]);
    // The first move's token is a known ERC-20 with 6 decimals; the 721 and the unknown token of the tests below are added there.
    await addToken(who(1), "ERC-20", "Test Token", "TT", 6, 2);
  });
  afterAll(async () => { await db?.drop(); });

  it("builds every answer from the allowlists", async () => {
    const list = body(await get("/api/blocks"));
    same(list, F.page);
    for (const b of list.items) same(b, F.blockItem);
    // The list carries each block's base fee, as the detail does: the header's bar reads it from the newest block.
    for (const item of list.items) expect(item.baseFee).toBe(body(await get(`/api/blocks/${item.number}`)).baseFee);
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

  it("serves the Canton updates around one: n newer and n older by the list's key, newest first, with what the producer's log says it submitted", async () => {
    const id = (n: number) => chain.blocks[n - 1]!.record.updateId;
    await pool.query("update canton_updates set submitted_template = 'Zk.Chain:ZkChain', submitted_choice = 'Advance' where update_id = $1", [id(2)]);
    const mid = body(await get(`/api/canton/updates/${id(2)}/around?n=1`));
    same(mid, F.updateAround);
    expect(mid.items.map((u: { updateId: string }) => u.updateId)).toEqual([id(3), id(2), id(1)]);
    for (const u of mid.items) same(u, F.updateAroundItem);
    const [, here, older] = mid.items;
    expect([here.submittedTemplate, here.submittedChoice, here.block]).toEqual(["Zk.Chain:ZkChain", "Advance", 2]);
    expect([older.submittedTemplate, older.submittedChoice]).toEqual([null, null]);
    expect(here.txCount).toBe(body(await get("/api/blocks/2")).txCount);
    expect(body(await get(`/api/canton/updates/${id(3)}/around?n=1`)).items.map((u: { updateId: string }) => u.updateId)).toEqual([id(3), id(2)]);
    expect(body(await get(`/api/canton/updates/${id(1)}/around?n=5`)).items.map((u: { updateId: string }) => u.updateId)).toEqual([id(3), id(2), id(1)]);
    expect(body(await get(`/api/canton/updates/${id(2)}/around`)).items).toHaveLength(3);
    expect(body(await get(`/api/canton/updates/${id(2)}/around?n=99`)).items).toHaveLength(3);
    for (const bad of ["n=0", "n=-1", "n=abc", "n=1.5"]) expect((await get(`/api/canton/updates/${id(2)}/around?${bad}`)).status, bad).toBe(400);
    expect((await get(`/api/canton/updates/nope/around`)).status).toBe(400);
    expect((await get(`/api/canton/updates/1220${"00".repeat(32)}/around`)).status).toBe(404);
    expect((await get(`/api/canton/updates/${id(2)}/around?n=1`)).headers?.["cache-control"]).toBe(CACHE_CONTROL.list);
  });

  it("never serves the builder participant's completion offset", async () => {
    await pool.query("update canton_updates set completion_offset = 4242, command_id = coalesce(command_id, 'cmd-1') where update_id = $1", [chain.blocks[1]!.record.updateId]);
    for (const target of [`/api/canton/updates/${chain.blocks[1]!.record.updateId}`, `/api/canton/updates/${chain.blocks[1]!.record.updateId}/around`, "/api/canton/updates", "/api/blocks/2", "/api/block/2"]) {
      const text = JSON.stringify((await get(target)).body);
      expect(text, target).not.toMatch(/completion_?offset/i);
      expect(text, target).not.toContain("4242");
    }
  });

  it("lists transactions filtered to the failed and to the calls, and as a bounded CSV", async () => {
    const all = body(await get("/api/txs?limit=100")).items as { hash: string; success: boolean; methodId: string | null; to: string | null }[];
    const failed = body(await get("/api/txs?filter=failed&limit=100")).items as typeof all;
    expect(failed.map((t) => t.hash)).toEqual(all.filter((t) => !t.success).map((t) => t.hash));
    // A creation carries init code, so it has a method id from the first four bytes; it is not a call into a contract.
    const creation = all.find((t) => t.to === null);
    expect(creation).toBeDefined();
    expect(creation!.methodId).not.toBeNull();
    const calls = body(await get("/api/txs?filter=calls&limit=100")).items as typeof all;
    expect(calls.map((t) => t.hash)).toEqual(all.filter((t) => t.methodId !== null && t.to !== null).map((t) => t.hash));
    expect(calls.map((t) => t.hash)).not.toContain(creation!.hash);
    for (const t of calls) same(t, F.txItem);
    expect((await get("/api/txs?filter=nope")).status).toBe(400);
    expect((await get("/api/txs?format=json")).status).toBe(400);
    const csv = await get("/api/txs?format=csv&filter=calls");
    expect(csv.status).toBe(200);
    expect(csv.headers?.["content-type"]).toMatch(/^text\/csv/);
    expect(csv.headers?.["content-disposition"]).toMatch(/attachment; filename="transactions\.csv"/);
    const lines = String(csv.body).trim().split("\r\n");
    expect(lines[0]).toMatch(/^hash,block,index,time,from,to,/);
    expect(lines.length - 1).toBe(calls.length);
  });

  it("gives the total of the transactions exact through the newest final block, and null where the rollups cannot say", async () => {
    const day = 86_400_000;
    const { rows: [b] } = await pool.query(
      `select (extract(epoch from min(record_time)) * 1000)::float8 as first, max(number) as newest, (select (extract(epoch from record_time) * 1000)::float8 from blocks order by number desc limit 1) as newest_at,
              (select count(*) from transactions)::int as direct, sum(tx_count)::int as held, count(*)::int as blocks from blocks`);
    const dayOf = Math.floor(Number(b.first) / day) * day, newestAt = Number(b.newest_at);
    expect(b.blocks).toBeGreaterThanOrEqual(3);
    expect(b.direct).toBeGreaterThan(0);
    expect(b.held).toBe(b.direct);
    const seed = (bucket: number, txs: number, test: number) => pool.query(
      `insert into stats_day (bucket, blocks, empty_blocks, busy_blocks, txs, txs_failed, gas_used, argument_bytes, accepted, lost, attempts_refused, attempts_failed, busy_gap_hist, time_to_final_hist, proof_hist, commit_hist, test_txs)
       values ($1, 0, 0, 0, $2, 0, 0, 0, 0, 0, 0, 0, '{}', '{}', '{}', '{}', $3)`, [new Date(bucket), txs, test]);
    const reset = async () => { await pool.query("delete from stats_day"); await pool.query("delete from cursors where stream = 'stats_rollup'"); };
    const cursor = (at: number) => pool.query("insert into cursors (stream, position, detail, updated_at) values ('stats_rollup', $1, '{}', $2)", [at, new Date(at + 60_000)]);
    /** Day rows seeded by hand (no minute rows), holding the blocks before a minute ahead of the cursor, the cut the total reads from; the test runs' two of them, in the first block's day. The real rollup is tested in stats-routes.test.ts. */
    const rolled = async (at: number) => {
      const { rows: [r] } = await pool.query("select coalesce(sum(tx_count), 0)::int as n from blocks where record_time < $1", [new Date(at - 60_000)]);
      await seed(dayOf, r.n - Math.min(2, r.n), Math.min(2, r.n));
      await cursor(at);
      return r.n as number;
    };
    try {
      await reset();
      // No rollup has run: the total is not known, and the page says so rather than counting.
      let p = body(await get("/api/txs"));
      same(p, F.txPage);
      expect([p.total, p.totalAsOfBlock, p.totalAsOf]).toEqual([null, null, null]);
      // Rollups that begin after the first block leave the early days uncounted: not a total.
      await seed(dayOf + day, 9, 0);
      await cursor(newestAt - 3000);
      p = body(await get("/api/txs"));
      expect([p.total, p.totalAsOfBlock, p.totalAsOf]).toEqual([null, null, null]);
      await reset();
      // The cursor a minute after the newest block (the day rows hold the blocks before the newest, the tail that block, once): the sum plus the tail is the direct count of the transactions, as of the newest block.
      const cut = newestAt + 60_000;
      const rollupSum = await rolled(cut);
      expect(rollupSum).toBeLessThan(b.direct);
      expect(rollupSum).toBeGreaterThan(0);
      p = body(await get("/api/txs"));
      expect(p.total).toBe(b.direct);
      expect(p.totalAsOfBlock).toBe(Number(b.newest));
      expect(p.totalAsOf).toBe(new Date(newestAt).toISOString());
      expect(body(await get("/api/txs?limit=1&before=3:0")).total).toBe(b.direct);
      // A cursor a block earlier: more is in the tail and less in the rollups, the same total.
      await reset();
      await rolled(newestAt - 3000);
      expect(body(await get("/api/txs")).total).toBe(b.direct);
      // A cursor two minutes past the newest block: nothing is left in the tail.
      await reset();
      await rolled(newestAt + 120_000);
      p = body(await get("/api/txs"));
      expect([p.total, p.totalAsOfBlock]).toEqual([b.direct, Number(b.newest)]);
      // Rollups that trail the newest block by more than the bound (a first build, a rebuild) cannot say: the total is null, not a total through the cursor.
      await reset();
      await rolled(newestAt - TAIL_MAX_MS - 1000);
      p = body(await get("/api/txs"));
      expect([p.total, p.totalAsOfBlock, p.totalAsOf]).toEqual([null, null, null]);
      // The same rows without the cursor that says how far they reach cannot be called a total.
      await reset();
      await rolled(cut);
      await pool.query("delete from cursors where stream = 'stats_rollup'");
      expect(body(await get("/api/txs")).total).toBeNull();
      await cursor(cut);
      // A filtered list has no rolled-up count (the failed ones of a test run are not kept apart), so it has no total.
      for (const f of ["failed", "calls"]) {
        const x = body(await get(`/api/txs?filter=${f}`));
        expect([x.total, x.totalAsOfBlock, x.totalAsOf], f).toEqual([null, null, null]);
      }
    } finally {
      await reset();
    }
  });

  it("lists blocks with the proof time and the time to final, filtered, and as a bounded CSV", async () => {
    await pool.query("insert into producer_runs (run_id, started_at, strategy, settings, source_commit) values ('00000000-0000-0000-0000-000000000009', now(), 'rhythm', '{}', 'x') on conflict do nothing");
    const [a] = (await pool.query(
      `insert into block_attempts (run_id, attempt_seq, number, strategy, cut_reason, cut_at, proof_started_at, proof_ended_at, submitted_at)
       select '00000000-0000-0000-0000-000000000009', 1, 2, 'rhythm', 'pool', b.record_time - interval '8 seconds', b.record_time - interval '7.5 seconds', b.record_time - interval '0.5 seconds', b.record_time - interval '0.4 seconds' from blocks b where b.number = 2 returning attempt_id`)).rows;
    await pool.query("update blocks set attempt_id = $1 where number = 2", [a.attempt_id]);
    const all = body(await get("/api/blocks"));
    const two = all.items.find((b: { number: number }) => b.number === 2), three = all.items.find((b: { number: number }) => b.number === 3);
    expect(two.proofSeconds).toBeCloseTo(7, 3);
    expect(two.finalSeconds).toBeCloseTo(8, 3);
    expect(three.proofSeconds).toBeNull();
    expect(three.finalSeconds).toBeNull();
    expect(two.commitSeconds).toBeCloseTo(0.4, 3);
    expect(three.commitSeconds).toBeNull();
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

  it("numbers a transaction's logs by their place among its own logs, 0-based, as well as by their place in the block, and keeps counting across pages", async () => {
    const all = body(await get(`/api/txs/${tx(2, 3)}/logs`)).items as { logIndex: number; position: number }[];
    expect(all.length).toBeGreaterThan(1);
    expect(all.map((l) => l.position)).toEqual(all.map((_, i) => i));
    const first = body(await get(`/api/txs/${tx(2, 3)}/logs?limit=1`));
    const second = body(await get(`/api/txs/${tx(2, 3)}/logs?limit=1&after=${first.next}`));
    expect(first.items[0].position).toBe(0);
    expect(second.items[0]).toMatchObject({ position: 1, logIndex: all[1]!.logIndex });
    expect(body(await get(`/api/txs/${tx(2, 3)}/logs?raw=1`)).items[0]).not.toHaveProperty("position");
  });

  it("gives a final transaction its place in its block and the fee caps the sender signed", async () => {
    expect(body(await get(`/api/txs/${tx(2, 1)}`))).toMatchObject({ index: 1, maxFeePerGas: "9", maxPriorityFeePerGas: "1" });
    expect(body(await get(`/api/txs/${tx(3, 4)}`))).toMatchObject({ index: 4 });
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
  it("gives each transaction of the lists the token moves of its logs, and null for a block stage 2 has not reached", async () => {
    const who1 = "0x" + "01".repeat(20);
    const want = { count: 2, more: false, first: { token: who1, amount: "50", tokenId: null, standard: "ERC-20", decimals: 6 } };
    const none = { count: 0, more: false, first: null };
    for (const path of ["/api/txs?limit=100", "/api/blocks/2/transactions?limit=100"]) {
      const items = body(await get(path)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const t of items) {
        same(t, F.txItem);
        same(t.tokenMoves, F.tokenMoves);
        if (t.tokenMoves.first) same(t.tokenMoves.first, F.tokenMove);
      }
      expect(items.find((t) => t.hash === tx(2, 1))!.tokenMoves, path).toEqual(want);
      expect(items.find((t) => t.hash === tx(2, 2))!.tokenMoves, path).toEqual(none);
    }
    await setCursor(2);
    try {
      const items = body(await get("/api/txs?limit=100")).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(items.filter((t) => t.block === 3).every((t) => t.tokenMoves === null)).toBe(true);
      expect(items.filter((t) => t.block === 3).length).toBe(7);
      expect(items.filter((t) => t.block === 2).every((t) => t.tokenMoves !== null)).toBe(true);
      expect(body(await get("/api/blocks/3/transactions")).items.every((t: any) => t.tokenMoves === null)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    } finally {
      await setCursor(3);
    }
  });

  it("counts at most 100 token moves for a transaction and says there are more", async () => {
    const [t] = (await pool.query("select block_number, tx_index from tx_hashes where hash = $1", [Buffer.from(tx(3, 0).slice(2), "hex")])).rows;
    await pool.query(
      "insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount) select $1, 1000 + g, 0, $2, $3, $4, $5, g from generate_series(1, 150) g",
      [t.block_number, t.tx_index, Buffer.alloc(20, 9), Buffer.alloc(20, 1), Buffer.alloc(20, 2)],
    );
    try {
      const item = (body(await get("/api/txs?limit=100")).items as Record<string, any>[]).find((x) => x.hash === tx(3, 0))!; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(item.tokenMoves).toMatchObject({ count: 100, more: true, first: { amount: "1" } });
    } finally {
      await pool.query("delete from token_transfers where block_number = $1 and log_index >= 1000", [t.block_number]);
    }
  });

  it("gives the standard and decimals of the first move's token: an ERC-721's moves carry a token id and no amount, an unknown token's have no standard and no decimals", async () => {
    const who = (n: number) => Buffer.alloc(20, n), hexOf = (b: Buffer) => "0x" + b.toString("hex");
    const at = async (h: string) => (await pool.query("select block_number, tx_index from tx_hashes where hash = $1", [Buffer.from(h.slice(2), "hex")])).rows[0];
    const [t1, t2] = [await at(tx(3, 1)), await at(tx(3, 2))];
    await addToken(who(4), "ERC-721", "Pass", "OPASS", null, 3);
    await pool.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, token_id, from_address, to_address) values ($1, 70, 0, $2, $3, 3, $4, $5)", [t1.block_number, t1.tx_index, who(4), who(2), who(3)]);
    await pool.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, from_address, to_address, amount) values ($1, 71, 0, $2, $3, $4, $5, 8)", [t2.block_number, t2.tx_index, who(5), who(2), who(3)]);
    try {
      const nft = { count: 1, more: false, first: { token: hexOf(who(4)), amount: null, tokenId: "3", standard: "ERC-721", decimals: null } };
      const unknown = { count: 1, more: false, first: { token: hexOf(who(5)), amount: "8", tokenId: null, standard: null, decimals: null } };
      for (const path of ["/api/txs?limit=100", "/api/blocks/3/transactions?limit=100"]) {
        const items = body(await get(path)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(items.find((x) => x.hash === tx(3, 1))!.tokenMoves, path).toEqual(nft);
        expect(items.find((x) => x.hash === tx(3, 2))!.tokenMoves, path).toEqual(unknown);
      }
      const known = (body(await get("/api/blocks/2/transactions?limit=100")).items as Record<string, any>[]).find((x) => x.hash === tx(2, 1))!; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(known.tokenMoves.first).toMatchObject({ standard: "ERC-20", decimals: 6 });
    } finally {
      await pool.query("delete from token_transfers where block_number = $1 and log_index in (70, 71)", [t1.block_number]);
      await pool.query("delete from tokens where address = $1", [who(4)]);
      await pool.query("delete from contracts where address = $1", [who(4)]);
    }
  });

  it("leaves the token moves out of the CSV, which does not write them", async () => {
    const spy = vi.spyOn(pool, "query");
    try {
      expect((await get("/api/txs?format=csv")).status).toBe(200);
      expect(spy.mock.calls.filter((c) => /token_transfers/.test(String(typeof c[0] === "string" ? c[0] : (c[0] as { text?: string }).text)))).toHaveLength(0);
      spy.mockClear();
      expect((await get("/api/txs?limit=5")).status).toBe(200);
      expect(spy.mock.calls.filter((c) => /token_transfers/.test(String(typeof c[0] === "string" ? c[0] : (c[0] as { text?: string }).text))).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives a transaction's token transfers its method and time and the token's standard", async () => {
    const who = (n: number) => Buffer.alloc(20, n);
    const [call] = (await pool.query("select t.block_number, t.tx_index, t.method_id, extract(epoch from b.timestamp)::bigint as ts from transactions t join blocks b on b.number = t.block_number where t.block_number = 2 and t.tx_index = 1")).rows;
    const [made] = (await pool.query("select t.block_number, t.tx_index, extract(epoch from b.timestamp)::bigint as ts from tx_hashes h join transactions t on t.block_number = h.block_number and t.tx_index = h.tx_index join blocks b on b.number = t.block_number where h.hash = $1", [Buffer.from(tx(3, 6).slice(2), "hex")])).rows;
    await addToken(who(0x31), "ERC-721", "Nft", "NFT", null, 3);
    await pool.query("insert into token_transfers (block_number, log_index, batch_index, tx_index, token, token_id, from_address, to_address) values ($1, 95, 0, $2, $3, 1, $4, $5)", [made.block_number, made.tx_index, who(0x31), who(4), who(5)]);
    try {
      const a = body(await get(`/api/txs/${tx(2, 1)}/token-transfers`)).items as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(a.length).toBeGreaterThan(0);
      for (const t of a) {
        expect(t.methodId).toBe(call.method_id === null ? null : "0x" + call.method_id.toString("hex"));
        expect(t.timestamp).toBe(Number(call.ts));
        expect(t.standard === null || typeof t.standard === "string").toBe(true);
      }
      // The creation has no method (its first input bytes are code), and the token in the row is an ERC-721.
      const b = (body(await get(`/api/txs/${tx(3, 6)}/token-transfers`)).items as Record<string, any>[])[0]!; // eslint-disable-line @typescript-eslint/no-explicit-any
      same(b, F.transfer);
      expect(b).toMatchObject({ methodId: null, creation: true, timestamp: Number(made.ts), standard: "ERC-721", tokenId: "1" });
      for (const t of a) expect(t.creation).toBe(false);
    } finally {
      await pool.query("delete from token_transfers where block_number = $1 and log_index = 95", [made.block_number]);
      await pool.query("delete from tokens where address = $1", [who(0x31)]);
      await pool.query("delete from contracts where address = $1", [who(0x31)]);
    }
  });
  describe("the oldest transactions first, for the list's last page", () => {
    const hashes = (a: Answer) => (body(a).items as { hash: string }[]).map((t) => t.hash);

    it("lists the oldest first with order=asc, and pages on from there with after", async () => {
      const newest = hashes(await get("/api/txs?limit=100"));
      expect(newest).toHaveLength(12);
      const oldest = await get("/api/txs?order=asc&limit=100");
      expect(oldest.status).toBe(200);
      same(body(oldest), F.txPage);
      expect(hashes(oldest)).toEqual([...newest].reverse());
      expect(body(oldest).next).toBeNull();
      for (const t of body(oldest).items) same(t, F.txItem);
      // The total is the same either way, so a client can tell the last page from the count.
      expect(body(oldest).total).toBe(body(await get("/api/txs")).total);
      const walked: string[] = [];
      let next: string | null = null;
      for (let turns = 0; turns < 20; turns++) {
        const a = await get(`/api/txs?order=asc&limit=5${next ? `&after=${next}` : ""}`);
        expect(a.status).toBe(200);
        walked.push(...hashes(a));
        next = body(a).next;
        if (!next) break;
      }
      expect(walked).toEqual([...newest].reverse());
      expect((await get("/api/txs?order=desc&limit=100")).body).toEqual((await get("/api/txs?limit=100")).body);
    });

    it("keeps the filters and the page size of the newest-first list", async () => {
      const failed = hashes(await get("/api/txs?filter=failed&limit=100"));
      expect(hashes(await get("/api/txs?order=asc&filter=failed&limit=100"))).toEqual([...failed].reverse());
      const calls = hashes(await get("/api/txs?filter=calls&limit=100"));
      expect(hashes(await get("/api/txs?order=asc&filter=calls&limit=100"))).toEqual([...calls].reverse());
      const page = body(await get("/api/txs?order=asc&limit=3"));
      expect(page.items).toHaveLength(3);
      expect(page.next).not.toBeNull();
      expect(body(await get("/api/txs?order=asc")).items).toHaveLength(12);
    });

    it("refuses an order it does not know, before with order=asc, after without it, and a key that is not one", async () => {
      for (const path of ["/api/txs?order=up", "/api/txs?order=ASC", "/api/txs?order=asc&before=3:1", "/api/txs?after=2:1", "/api/txs?order=asc&after=x", "/api/txs?order=asc&after=1", "/api/txs?format=csv&order=bogus", "/api/txs?format=csv&order=asc"]) {
        expect((await get(path)).status, path).toBe(400);
      }
      // The file is newest first, and says so by taking order=desc as it does the list.
      expect((await get("/api/txs?format=csv&order=desc")).status).toBe(200);
    });

    it("reads from the primary key in order, with no sort", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local enable_seqscan = off");
        for (const key of [[null, null], [2, 3]] as (number | null)[][]) {
          const plan = (await client.query(
            `explain select ${txSelect} from transactions t join blocks b on b.number = t.block_number
             where ($1::bigint is null or (t.block_number, t.tx_index) > ($1::bigint, $2::int)) order by t.block_number, t.tx_index limit 26`, key)).rows.map((r) => r["QUERY PLAN"]).join("\n");
          expect(plan).toMatch(/Index (Only )?Scan/);
          expect(plan).not.toMatch(/Sort Key|Seq Scan on transactions/);
        }
        await client.query("rollback");
      } finally { client.release(); }
    });
  });
});
