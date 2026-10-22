/**
 * The REST routes of the chain (design 6.1): blocks, transactions and Canton updates. Every answer is built field by field from the allowlists in fields.ts,
 * every list is a keyset page, and every 200 carries the cache rule of what it holds. Stage 2 fields are "not derived yet" (`derived: false`, nulls or an empty
 * page) while the derive cursor is below the block.
 */
import type { Answer } from "../api.ts";
import { cached } from "./cache.ts";
import type { ChainRest } from "./chain-rest.ts";
import { traceKey } from "./chain-rest.ts";
import { REST_FIELDS as F, pick } from "./fields.ts";
import { BadRequest, cursorOf, isTrace, keyOf, limitOf, pageOf } from "./paging.ts";
import { router } from "./router.ts";
import { traceOf, type CallFrame } from "./trace.ts";
import { RethTooBig, type Reth } from "../reth.ts";

const HASH = /^0x[0-9a-f]{64}$/, UPDATE = /^1220[0-9a-f]{64}$/;
const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, error: string): Answer => ({ status, body: { error } });
export const NOT_FOUND_HERE = "Nothing is held for that. Only blocks that are final on Canton are listed here.";

export interface ChainRouteDeps {
  rest: ChainRest;
  reth: Pick<Reth, "rpc">;
  /** The pages' own block and transaction answers (the routes that exist already), which these routes add to. */
  block: (id: string) => Promise<Answer>;
  transaction: (hash: string) => Promise<Answer>;
}

/** The routes of the chain: a router for a request's path, with the list of the paths it serves. */
export function chainRoutes({ rest, reth, block, transaction }: ChainRouteDeps) {
  const page = <T extends object, K extends keyof T>(rows: T[], limit: number, key: (r: T) => string, fields: readonly K[], derived?: boolean) => {
    const p = pageOf(rows, limit, key);
    const items = p.items.map((r) => pick(r, fields));
    return derived === undefined ? pick({ items, next: p.next }, F.page) : pick({ derived, items, next: p.next }, F.derivedPage);
  };
  const blockKey = (id: string): number | string => {
    if (HASH.test(id)) return id;
    if (/^\d+$/.test(id) && Number.isSafeInteger(Number(id))) return Number(id);
    throw new BadRequest("A block is named by its number or its 0x hash.");
  };
  async function finalBlock(id: string): Promise<number | undefined> {
    return rest.numberOf(blockKey(id));
  }
  async function finalTx(hash: string) {
    if (!HASH.test(hash)) throw new BadRequest("A transaction is named by its 0x hash.");
    const at = await rest.placeOf(hash);
    return at && { at, derived: at.block <= (await rest.deriveCursor()) };
  }
  /** `after` of an ascending list inside one block or transaction. */
  const afterOf = (q: URLSearchParams, shape: Parameters<typeof cursorOf>[1]) => cursorOf(q.get("after"), shape);

  const FILTERS = ["all", "transactions", "empty"] as const;
  /** The most blocks one CSV holds. */
  const CSV_MAX = 1000;
  const csvCell = (v: string | number | null) => (v === null ? "" : String(v));

  async function blocks(q: URLSearchParams): Promise<Answer> {
    const f = q.get("filter") ?? "all", format = q.get("format");
    if (!(FILTERS as readonly string[]).includes(f)) throw new BadRequest(`filter is one of ${FILTERS.join(", ")}.`);
    if (format !== null && format !== "csv") throw new BadRequest("format is csv, or left out for JSON.");
    const filter = f as (typeof FILTERS)[number];
    if (format === "csv") return blocksCsv(q, filter);
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int"]);
    const rows = await rest.blocks((before?.[0] as number | undefined) ?? null, limit, filter);
    return cached(ok(page(rows, limit, (b) => keyOf(b.number), F.blockItem)), "list");
  }

  /** The newest blocks as a file, with the columns of the list: a bounded export, not a way to walk the chain. */
  async function blocksCsv(q: URLSearchParams, filter: (typeof FILTERS)[number]): Promise<Answer> {
    const raw = q.get("limit"), limit = raw === null ? CSV_MAX : Math.min(CSV_MAX, Math.max(limitOf(raw), Number(raw)));
    const rows = (await rest.blocks(null, limit, filter)).slice(0, limit);
    const lines = ["block,time,transactions,gas_used,gas_limit,proof_seconds,seconds_to_final,canton_update_id,stage"];
    for (const b of rows) {
      lines.push([b.number, new Date(b.timestamp * 1000).toISOString(), b.txCount, b.gasUsed, b.gasLimit, b.proofSeconds === null ? null : b.proofSeconds.toFixed(3), b.finalSeconds === null ? null : b.finalSeconds.toFixed(3), b.updateId, b.number === 0 ? "genesis" : "final"].map(csvCell).join(","));
    }
    const answer = ok(lines.join("\r\n") + "\r\n");
    return cached({ ...answer, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="blocks.csv"' } }, "list");
  }

  async function oneBlock(id: string): Promise<Answer> {
    const a = await block(id);
    if (a.status !== 200) return a;
    const body = a.body as { status: string; number: number; canton: Record<string, unknown> | null };
    const final = body.status === "final";
    const extras = final ? await rest.blockExtras(body.number) : undefined;
    const derived = final && body.number <= (await rest.deriveCursor());
    // The record's hex is kept apart (/record): a block's page is small.
    const canton = body.canton && pick(body.canton, F.cantonSummary);
    return cached(ok(pick({ ...body, canton, legsCount: extras?.legsCount ?? null, derived, lifecycle: extras?.lifecycle ? pick(extras.lifecycle, F.blockLifecycle) : null } as Record<string, unknown>, F.blockDetail)), "composite");
  }

  async function blockTxs(id: string, q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), after = afterOf(q, ["int4"]), n = await finalBlock(id);
    if (n === undefined) return fail(404, NOT_FOUND_HERE);
    return cached(ok(page(await rest.blockTxs(n, (after?.[0] as number | undefined) ?? null, limit), limit, (t) => keyOf(t.index), F.txItem)), "composite");
  }

  async function blockLegs(id: string, q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), after = afterOf(q, ["int4"]), n = await finalBlock(id);
    if (n === undefined) return fail(404, NOT_FOUND_HERE);
    return cached(ok(page(await rest.blockLegs(n, (after?.[0] as number | undefined) ?? null, limit), limit, (l) => keyOf(l.legIndex), F.leg)), "composite");
  }

  /** The record is a chain fact that never changes: header, transactions and proof, as hex. */
  async function record(id: string): Promise<Answer> {
    const n = await finalBlock(id), r = n === undefined ? undefined : await rest.record(n);
    if (!r) return fail(404, NOT_FOUND_HERE);
    return cached(ok(pick({ number: r.number, hash: r.hash, contractId: r.contractId, header: r.headerHex, txs: r.txsHex, proof: r.proofHex }, F.record)), "immutable");
  }

  async function txs(q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "int4"]);
    return cached(ok(page(await rest.txs(before, limit), limit, (t) => keyOf(t.block, t.index), F.txItem)), "list");
  }

  async function oneTx(hash: string, q: URLSearchParams): Promise<Answer> {
    if (q.get("raw") === "1") return rawReceipt(hash);
    const a = await transaction(hash);
    if (a.status !== 200) return a;
    const body = a.body as { status: string };
    const here = body.status === "final" ? await finalTx(hash) : undefined;
    const derived = !!here?.derived;
    // Stage 2 keeps a row only for a transaction that made calls or reverted: past the derive cursor, no row means no calls and no revert reason.
    const trace = derived && here ? await rest.traceOf(here.at) : undefined;
    return cached(ok(pick({ ...body, derived, callCount: derived ? trace?.callCount ?? 0 : null, revertReason: trace?.revertReason ?? null } as Record<string, unknown>, F.txDetail)), "composite");
  }

  /** The receipt of a final transaction as reth gave it: a chain fact that never changes. */
  async function rawReceipt(hash: string): Promise<Answer> {
    if (!(await finalTx(hash))) return fail(404, NOT_FOUND_HERE);
    const receipt = await reth.rpc("eth_getTransactionReceipt", [hash]);
    if (receipt === null || typeof receipt !== "object") return fail(404, "reth holds no receipt of that transaction.");
    return cached(ok(receipt), "immutable");
  }

  async function logs(hash: string, q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), after = afterOf(q, ["int4"]), raw = q.get("raw") === "1", here = await finalTx(hash);
    if (!here) return fail(404, NOT_FOUND_HERE);
    const rows = await rest.txLogs(here.at, (after?.[0] as number | undefined) ?? null, limit);
    // Logs are decoded once a contract is verified; until then `decoded` is null. The raw form has no such field, and a final transaction's raw logs never change.
    const withDecoded = rows.map((l) => ({ ...l, decoded: null }));
    return cached(ok(page(withDecoded, limit, (l) => keyOf(l.logIndex), raw ? F.rawLog : F.log)), raw ? "immutable" : "composite");
  }

  async function internal(hash: string, q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), raw = q.get("raw") === "1", after = q.get("after");
    if (after !== null && !isTrace(after)) throw new BadRequest('after is "t" and a trace address, such as t0-1.');
    const here = await finalTx(hash);
    if (!here) return fail(404, NOT_FOUND_HERE);
    if (!here.derived) return cached(ok(pick({ derived: false, items: [], next: null }, F.derivedPage)), "composite");
    const rows = await rest.txInternal(here.at, after, limit);
    return cached(ok(page(rows, limit, (c) => traceKey(c.traceAddress), F.internal, true)), raw ? "immutable" : "composite");
  }

  async function transfers(hash: string, q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), raw = q.get("raw") === "1", after = afterOf(q, ["int4", "int4"]), here = await finalTx(hash);
    if (!here) return fail(404, NOT_FOUND_HERE);
    if (!here.derived) return cached(ok(pick({ derived: false, items: [], next: null }, F.derivedPage)), "composite");
    const rows = await rest.txTransfers(here.at, after, limit);
    return cached(ok(page(rows, limit, (t) => keyOf(t.logIndex, t.batchIndex), F.transfer, true)), raw ? "immutable" : "composite");
  }

  /** The full call tree, asked of reth for a transaction of a final block. */
  /** Frame inputs are served up to this many bytes (the selector and the first arguments); `inputSize` is the whole size, and `?raw=1` serves them whole. */
  const INPUT_MAX_BYTES = 1024;
  const cut = (input: string): string => (input.length > 2 + 2 * INPUT_MAX_BYTES ? input.slice(0, 2 + 2 * INPUT_MAX_BYTES) : input);

  async function trace(hash: string, q: URLSearchParams): Promise<Answer> {
    const raw = q.get("raw") === "1", here = await finalTx(hash);
    if (!here) return fail(404, NOT_FOUND_HERE);
    let t;
    try {
      t = await traceOf(reth, hash);
    } catch (e) {
      if (e instanceof RethTooBig) return fail(502, "the trace is too big to serve");
      throw e;
    }
    if (!t) return fail(404, "reth holds no trace of that transaction.");
    const frames = t.frames.map((f: CallFrame) => pick({ ...f, input: raw ? f.input : cut(f.input), inputSize: (f.input.length - 2) / 2 }, F.frame));
    // The trace of a transaction in a final block is a chain fact that never changes.
    return cached(ok(pick({ frames, truncated: t.truncated }, F.trace)), "immutable");
  }

  async function updates(q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "text"]);
    return cached(ok(page(await rest.updates(before, limit), limit, (u) => keyOf(u.micros, u.updateId), F.updateItem)), "list");
  }

  async function oneUpdate(id: string): Promise<Answer> {
    if (!UPDATE.test(id)) return fail(400, "A Canton update is named by its id, 1220 and 64 hex digits.");
    const u = await rest.update(id);
    if (!u) return fail(404, NOT_FOUND_HERE);
    return cached(ok(pick({ ...u, template: pick(u.template, F.updateTemplate), signatories: u.signatories.map((s) => pick(s, F.signatory)), producerRecord: u.producerRecord && pick(u.producerRecord, F.producerRecord) }, F.updateDetail)), "composite");
  }

  return router([
    ["/api/blocks", (_, q) => blocks(q)],
    ["/api/blocks/{id}", (id) => oneBlock(id)],
    ["/api/blocks/{id}/transactions", (id, q) => blockTxs(id, q)],
    ["/api/blocks/{id}/legs", (id, q) => blockLegs(id, q)],
    ["/api/blocks/{id}/record", (id) => record(id)],
    ["/api/txs", (_, q) => txs(q)],
    ["/api/txs/{hash}", (hash, q) => oneTx(hash, q)],
    ["/api/txs/{hash}/logs", (hash, q) => logs(hash, q)],
    ["/api/txs/{hash}/internal", (hash, q) => internal(hash, q)],
    ["/api/txs/{hash}/token-transfers", (hash, q) => transfers(hash, q)],
    ["/api/txs/{hash}/trace", (hash, q) => trace(hash, q)],
    ["/api/canton/updates", (_, q) => updates(q)],
    ["/api/canton/updates/{updateId}", (id) => oneUpdate(id)],
  ]);
}
