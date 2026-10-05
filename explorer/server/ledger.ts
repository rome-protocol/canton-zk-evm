/**
 * The explorer's whole view of Canton: the JSON Ledger API of the participant that holds the reader party, two calls only, both reads.
 * It asks for the reader party's transactions, filtered to the block record, and keeps nothing else the answer might carry.
 */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set(["GET /v2/state/ledger-end", "POST /v2/updates"]);

/** The package is named, not pinned by id, as the demo does; Canton picks the vetted version. */
export const BLOCK_RECORD_TEMPLATE = "#canton-zk-evm:Zk.Chain:BlockRecord";
const RECORD_SUFFIX = ":Zk.Chain:BlockRecord";

export class LedgerError extends Error {}

/** One block's record on Canton. Hashes are 0x and lowercase; the header, transactions and proof are lowercase hex, exactly as the record holds them. */
export interface BlockRecord {
  updateId: string;
  offset: number;
  /** When Canton recorded the transaction, as Canton writes it (UTC). */
  recordTime: string;
  chainId: number;
  number: number;
  blockHash: string;
  parentHash: string;
  headerHex: string;
  txsHex: string;
  proofHex: string;
  /** The two signers of the record: the chain's root of trust. The builder's and the reader's party ids are read and dropped. */
  operator: string;
  confirmer: string;
}

type Json = Record<string, unknown>;

const obj = (v: unknown, what: string): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : fail(what));
const fail = (what: string): never => { throw new LedgerError(`Canton sent ${what} that is not valid`); };

function field(args: Json, name: string, update: string): unknown {
  const v = args[name];
  if (v === undefined || v === null) throw new LedgerError(`the block record in update ${update} has no ${name}`);
  return v;
}
function text(args: Json, name: string, update: string, ok: (s: string) => boolean = (s) => s !== ""): string {
  const v = field(args, name, update);
  if (typeof v !== "string" || !ok(v)) throw new LedgerError(`the block record in update ${update} has a ${name} that is not valid`);
  return v;
}
/** A Daml Int comes as a string in the JSON API. */
function whole(args: Json, name: string, update: string): number {
  const v = field(args, name, update);
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new LedgerError(`the block record in update ${update} has a ${name} that is not a whole number`);
  return n;
}
const HASH = (s: string) => /^(0x)?[0-9a-f]{64}$/.test(s);
const HEX = (s: string) => /^([0-9a-f]{2})+$/.test(s);
/** Hex that may be empty: a block with no transactions has a txsHex of "", which Daml accepts and the record keeps. */
const HEX_OR_EMPTY = (s: string) => /^([0-9a-f]{2})*$/.test(s);

function record(tx: Json, event: Json): BlockRecord {
  const updateId = text(tx, "updateId", "?"), recordTime = text(tx, "recordTime", updateId, (s) => Number.isFinite(Date.parse(s)));
  const a = obj(event.createArgument, "a createArgument");
  const hash = (name: string) => "0x" + text(a, name, updateId, HASH).replace(/^0x/, "");
  text(a, "builder", updateId); text(a, "reader", updateId);
  return {
    updateId, offset: whole(tx, "offset", updateId), recordTime, chainId: whole(a, "chainId", updateId), number: whole(a, "number", updateId),
    blockHash: hash("blockHash"), parentHash: hash("parentHash"),
    headerHex: text(a, "headerHex", updateId, HEX), txsHex: text(a, "txsHex", updateId, HEX_OR_EMPTY), proofHex: text(a, "proofHex", updateId, HEX),
    operator: text(a, "operator", updateId), confirmer: text(a, "confirmer", updateId),
  };
}

/** The block records an update created. An update of another kind (a checkpoint) has none; other contracts and archived events are not read. */
function recordsIn(item: unknown): { offset: number; records: BlockRecord[] } {
  const [kind, body] = Object.entries(obj(obj(item, "an update").update, "an update"))[0] ?? fail("an empty update");
  const value = obj(obj(body, "an update").value, "an update");
  const offset = value.offset;
  if (typeof offset !== "number") fail("an update with no offset");
  if (kind !== "Transaction") return { offset: offset as number, records: [] };
  const events = Array.isArray(value.events) ? value.events : fail("a transaction with no events");
  const records = (events as unknown[]).flatMap((e) => {
    const created = obj(e, "an event").CreatedEvent;
    if (created === undefined) return [];
    const c = obj(created, "an event");
    return typeof c.templateId === "string" && c.templateId.endsWith(RECORD_SUFFIX) ? [record(value, c)] : [];
  });
  return { offset: offset as number, records };
}

export function createLedger(url: string, timeoutMs: number, readerParty: string | null, pageSize = 100) {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const route = `${method} ${path.split("?")[0]}`;
    if (!ALLOWED_ENDPOINTS.has(route)) throw new LedgerError(`${route} is not on the list of calls the explorer may make`);
    try {
      const res = await fetch(url + path, {
        method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      throw new LedgerError(`${route}: cannot read Canton (${(e as Error).message})`);
    }
  }

  /** The ledger's newest offset; 0 for a ledger with nothing in it. */
  async function ledgerEnd(): Promise<number> {
    const offset = obj(await call("GET", "/v2/state/ledger-end"), "a ledger end").offset;
    return offset === undefined ? 0 : typeof offset === "number" ? offset : fail("a ledger end");
  }

  const updatesRequest = (party: string, begin: number, end: number) => ({
    beginExclusive: begin, endInclusive: end,
    updateFormat: { includeTransactions: {
      eventFormat: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: BLOCK_RECORD_TEMPLATE, includeCreatedEventBlob: false } } } }] } }, verbose: false },
      transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
    } },
  });

  /** The block records Canton committed after offset `after`, up to and including `upTo` (a ledger end read first), oldest first. */
  async function records(after: number, upTo: number): Promise<BlockRecord[]> {
    if (!readerParty) throw new LedgerError("READER_PARTY is not set: the explorer reads Canton as the reader party only");
    const out: BlockRecord[] = [];
    for (let begin = after; begin < upTo; ) {
      const items = await call("POST", `/v2/updates?limit=${pageSize}`, updatesRequest(readerParty, begin, upTo));
      if (!Array.isArray(items)) return fail("an answer that is not a list");
      let last = begin;
      for (const item of items) {
        const r = recordsIn(item);
        last = Math.max(last, r.offset);
        out.push(...r.records);
      }
      // Only an empty answer ends the walk: Canton may cap `limit` below ours, or close a list early, so a short page proves nothing.
      if (items.length === 0) break;
      if (last <= begin) throw new LedgerError("Canton's updates did not move forward");
      begin = last;
    }
    return out;
  }

  return { call, ledgerEnd, records };
}

export type Ledger = ReturnType<typeof createLedger>;
