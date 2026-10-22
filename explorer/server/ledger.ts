import { readFileSync, statSync } from "node:fs";

/**
 * The explorer's whole view of Canton: the JSON Ledger API of the participant that holds the reader party, two calls only, both reads.
 * It asks for the reader party's transactions, filtered to the block record, and keeps nothing else the answer might carry.
 */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set(["GET /v2/state/ledger-end", "POST /v2/updates", "GET /v2/parties/participant-id"]);

/** The package is named, not pinned by id, as the demo does; Canton picks the vetted version. */
export const BLOCK_RECORD_TEMPLATE = "#canton-zk-evm:Zk.Chain:BlockRecord";
const RECORD_SUFFIX = ":Zk.Chain:BlockRecord";

export class LedgerError extends Error {}

/**
 * The bearer token of a participant that needs a login, read from the file LEDGER_TOKEN_FILE names. It is read on every call, so a file
 * that a refresh job rewrites is picked up without a restart, and only a file that its owner alone can read is used. Neither the token
 * nor any part of it goes into an error: the messages name the file and say what is wrong with it.
 */
export function readLedgerToken(file: string, setting = "LEDGER_TOKEN_FILE"): string {
  let text: string;
  try {
    if (statSync(file).mode & 0o077) throw new LedgerError(`${setting} ${file} must be readable by its owner only (chmod 600)`);
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError(`${setting} ${file} cannot be read`);
  }
  const token = text.trim();
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) throw new LedgerError(`${setting} ${file} must hold one token and nothing else`);
  return token;
}

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
  /** What the reader's update says about itself, kept for the Canton view of a block. The observers are never read. */
  synchronizerId: string;
  /** When the transaction takes effect, as Canton writes it (UTC); the record time when Canton sends none. */
  effectiveAt: string;
  contractId: string;
  /** The record's template as the update names it: package id, module and entity. */
  template: { packageId: string; module: string; entity: string };
  /** The party ids that signed the record's creation: the operator and the confirmer, and no one else. */
  signatories: string[];
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
  const [packageId, module, entity, ...rest] = text(event, "templateId", updateId, (t) => t.split(":").length === 3 && !t.startsWith("#")).split(":");
  if (rest.length > 0 || !packageId || !module || !entity) fail("a template id");
  const signatories = field(event, "signatories", updateId);
  if (!Array.isArray(signatories) || signatories.length === 0 || signatories.some((x) => typeof x !== "string" || x === "")) {
    throw new LedgerError(`the block record in update ${updateId} has signatories that are not valid`);
  }
  return {
    updateId, offset: whole(tx, "offset", updateId), recordTime, chainId: whole(a, "chainId", updateId), number: whole(a, "number", updateId),
    blockHash: hash("blockHash"), parentHash: hash("parentHash"),
    headerHex: text(a, "headerHex", updateId, HEX), txsHex: text(a, "txsHex", updateId, HEX_OR_EMPTY), proofHex: text(a, "proofHex", updateId, HEX),
    operator: text(a, "operator", updateId), confirmer: text(a, "confirmer", updateId),
    synchronizerId: text(tx, "synchronizerId", updateId),
    effectiveAt: tx.effectiveAt === undefined ? recordTime : text(tx, "effectiveAt", updateId, (s) => Number.isFinite(Date.parse(s))),
    contractId: text(event, "contractId", updateId), template: { packageId: packageId!, module: module!, entity: entity! }, signatories: signatories as string[],
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

export function createLedger(url: string, timeoutMs: number, readerParty: string | null, pageSize = 100, tokenFile: string | null = null) {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const route = `${method} ${path.split("?")[0]}`;
    if (!ALLOWED_ENDPOINTS.has(route)) throw new LedgerError(`${route} is not on the list of calls the explorer may make`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (tokenFile) headers.authorization = `Bearer ${readLedgerToken(tokenFile)}`;
    try {
      const res = await fetch(url + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
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

  /** The participant's own id, as it reports it. Offsets are local to one participant, so every stored offset says whose it is. */
  async function participantId(): Promise<string> {
    const id = obj(await call("GET", "/v2/parties/participant-id"), "a participant id").participantId;
    return typeof id === "string" && id !== "" ? id : fail("a participant id");
  }

  /**
   * The block records Canton committed after offset `after`, up to and including `upTo` (a ledger end read first), oldest first, one page of
   * the walk at a time: a caller that indexes each page before it asks for the next keeps its memory to one page, and a read that fails
   * on a later page does not take back what the earlier pages gave.
   */
  async function* recordPages(after: number, upTo: number): AsyncGenerator<BlockRecord[]> {
    if (!readerParty) throw new LedgerError("READER_PARTY is not set: the explorer reads Canton as the reader party only");
    for (let begin = after; begin < upTo; ) {
      const items = await call("POST", `/v2/updates?limit=${pageSize}`, updatesRequest(readerParty, begin, upTo));
      if (!Array.isArray(items)) return fail("an answer that is not a list");
      let last = begin;
      const page: BlockRecord[] = [];
      for (const item of items) {
        const r = recordsIn(item);
        last = Math.max(last, r.offset);
        page.push(...r.records);
      }
      // Only an empty answer ends the walk: Canton may cap `limit` below ours, or close a list early, so a short page proves nothing.
      if (items.length === 0) break;
      if (last <= begin) throw new LedgerError("Canton's updates did not move forward");
      begin = last;
      if (page.length > 0) yield page;
    }
  }

  /** The whole walk of `recordPages`, in one list (for a short range; the indexer reads page by page). */
  async function records(after: number, upTo: number): Promise<BlockRecord[]> {
    const out: BlockRecord[] = [];
    for await (const page of recordPages(after, upTo)) out.push(...page);
    return out;
  }

  return { call, ledgerEnd, records, recordPages, participantId };
}

export type Ledger = ReturnType<typeof createLedger>;
