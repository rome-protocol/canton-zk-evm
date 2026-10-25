import { readFileSync, statSync } from "node:fs";
import { isHexBytes } from "./hex.ts";

/**
 * The explorer's whole view of Canton: the JSON Ledger API of the participant that holds the reader party, three calls only, all reads.
 * It asks for the reader party's transactions, filtered to the block record, and keeps nothing else the answer might carry.
 * The custody read (`gatewayCustody`) is a second client with one call of its own, made only when the gateway party and a token for it are configured:
 * it is the one place the explorer reads as the gateway, for the registered tokens and the sum of the holdings, and it keeps nothing else the answer carries.
 * The gateway party must be hosted on the participant at the same URL, since the offset it reads at is that participant's.
 */
export const READER_ENDPOINTS: ReadonlySet<string> = new Set(["GET /v2/state/ledger-end", "POST /v2/updates", "GET /v2/parties/participant-id"]);
/** The custody client reads as the gateway with a token of its own, and may make this one call: each client may read only with the rights of its own party. */
export const CUSTODY_ENDPOINTS: ReadonlySet<string> = new Set(["POST /v2/state/active-contracts"]);
/** Every call either client may make (the two lists together), for the check against Canton's own OpenAPI document. */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([...READER_ENDPOINTS, ...CUSTODY_ENDPOINTS]);

/** The package is named, not pinned by id, as the demo does; Canton picks the vetted version. */
export const BLOCK_RECORD_TEMPLATE = "#canton-zk-evm:Zk.Chain:BlockRecord";
const RECORD_SUFFIX = ":Zk.Chain:BlockRecord";
export const GATEWAY_TOKEN_TEMPLATE = "#canton-zk-evm:Zk.Chain:GatewayToken";
const GATEWAY_TOKEN_SUFFIX = ":Zk.Chain:GatewayToken";
/** The token standard's Holding interface: what a holding shows as its view, whatever template the registry made it with. */
export const HOLDING_INTERFACE = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
const HOLDING_SUFFIX = ":Splice.Api.Token.HoldingV1:Holding";

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
const HEX = (s: string) => isHexBytes(s, { prefix: "none", empty: false });
/** Hex that may be empty: a block with no transactions has a txsHex of "", which Daml accepts and the record keeps. */
const HEX_OR_EMPTY = (s: string) => isHexBytes(s, { prefix: "none" });

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

/** One registered token and what the gateway holds of its instrument. The amount is in base units of 10 decimals (a Canton amount's own). No owner and no contract id is kept. */
export interface CustodyToken { evmToken: string; instrumentAdmin: string; instrumentId: string; custody: bigint; holdings: number }
export interface GatewayCustody {
  /** The ledger offset the contracts were read at. */
  offset: number;
  tokens: CustodyToken[];
}

const custodyFail = (what: string): never => { throw new LedgerError(`the gateway's custody cannot be read: ${what}`); };
const SCALE = 10;
/** A Daml Numeric(10) as the JSON API writes it, in base units. A negative amount, an exponent or more than 10 decimals is not one. */
function baseUnits(amount: unknown): bigint {
  const m = typeof amount === "string" ? /^(\d+)(?:\.(\d{1,10}))?$/.exec(amount) : null;
  if (!m) return custodyFail("a holding's amount is not a decimal of at most 10 places");
  return BigInt(m[1]!) * 10n ** BigInt(SCALE) + BigInt((m[2] ?? "").padEnd(SCALE, "0"));
}
const instrumentOf = (v: unknown, what: string): { admin: string; id: string } => {
  const i = typeof v === "object" && v !== null ? (v as Json) : null;
  if (!i || typeof i.admin !== "string" || i.admin === "" || typeof i.id !== "string" || i.id === "") return custodyFail(`${what} has no instrument`);
  return { admin: i.admin, id: i.id };
};

/**
 * The registered tokens and the gateway's holdings, from the active contracts of one party's view at one offset. `party` is the gateway: the
 * holdings count only where it is the owner (the view may show others it is a stakeholder of), locked ones included, since a lock does not move the coin.
 * A holding it cannot read, an amount that is not a decimal, a token registered twice or an instrument shared by two tokens fails the whole read:
 * a total that might be short, or counted for two tokens, is worse than none.
 */
export function custodyFrom(items: unknown[], party: string): CustodyToken[] {
  const registered: { evmToken: string; admin: string; id: string }[] = [];
  const held: { admin: string; id: string; amount: bigint }[] = [];
  for (const item of items) {
    const entry = obj(obj(obj(item, "an active contract").contractEntry, "an active contract").JsActiveContract, "an active contract");
    const e = obj(entry.createdEvent, "an active contract"), template = typeof e.templateId === "string" ? e.templateId : "";
    if (template.endsWith(GATEWAY_TOKEN_SUFFIX)) {
      const a = obj(e.createArgument, "a registered token");
      const evm = typeof a.evmToken === "string" ? a.evmToken.replace(/^0x/, "").toLowerCase() : "";
      if (!/^[0-9a-f]{40}$/.test(evm)) custodyFail("a registered token's evmToken is not an address");
      const { admin, id } = instrumentOf(a.instrumentId, "a registered token");
      registered.push({ evmToken: "0x" + evm, admin, id });
    }
    for (const v of Array.isArray(e.interfaceViews) ? (e.interfaceViews as Json[]) : []) {
      if (typeof v.interfaceId !== "string" || !v.interfaceId.endsWith(HOLDING_SUFFIX)) continue;
      const status = (v.viewStatus as Json | undefined)?.code ?? 0;
      if (status !== 0 || typeof v.viewValue !== "object" || v.viewValue === null) custodyFail("a holding has no readable view");
      const view = v.viewValue as Json;
      if (view.owner !== party) continue;
      // The view is what the template says of itself: a holding counts only where the instrument's admin signed it, so a template of someone else's cannot claim the registry.
      const instrument = instrumentOf(view.instrumentId, "a holding");
      if (!(Array.isArray(e.signatories) ? e.signatories : []).includes(instrument.admin)) continue;
      held.push({ ...instrument, amount: baseUnits(view.amount) });
    }
  }
  const seen = new Set<string>(), instruments = new Set<string>();
  for (const r of registered) {
    if (seen.has(r.evmToken)) custodyFail(`token ${r.evmToken} is registered twice`);
    seen.add(r.evmToken);
    const key = JSON.stringify([r.admin, r.id]);
    if (instruments.has(key)) custodyFail(`instrument ${r.id} is registered twice, for two tokens`);
    instruments.add(key);
  }
  return registered.map((r): CustodyToken => {
    const mine = held.filter((h) => h.admin === r.admin && h.id === r.id);
    return { evmToken: r.evmToken, instrumentAdmin: r.admin, instrumentId: r.id, custody: mine.reduce((s, h) => s + h.amount, 0n), holdings: mine.length };
  }).sort((a, b) => (a.evmToken < b.evmToken ? -1 : 1));
}

export function createLedger(url: string, timeoutMs: number, readerParty: string | null, pageSize = 100, tokenFile: string | null = null, endpoints: ReadonlySet<string> = READER_ENDPOINTS) {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const route = `${method} ${path.split("?")[0]}`;
    if (!endpoints.has(route)) throw new LedgerError(`${route} is not on the list of calls the explorer may make`);
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

  /**
   * What the gateway holds on Canton of each registered token's instrument, read as the gateway at `offset` (the caller's choice, so that it can set the answer
   * against the EVM at the block that offset records). One request, filtered to the GatewayToken template and the Holding interface. `limit` is asked of Canton and
   * must be at or below the participant's list maximum: a list as long as the limit may have been cut, so it is refused.
   */
  async function gatewayCustody(limit: number, offset: number): Promise<GatewayCustody> {
    if (!readerParty) throw new LedgerError("the gateway party is not set: the custody read is for the gateway party only");
    const filter = (identifierFilter: unknown) => ({ identifierFilter });
    const items = await call("POST", `/v2/state/active-contracts?limit=${limit}`, {
      eventFormat: { filtersByParty: { [readerParty]: { cumulative: [
        filter({ TemplateFilter: { value: { templateId: GATEWAY_TOKEN_TEMPLATE, includeCreatedEventBlob: false } } }),
        filter({ InterfaceFilter: { value: { interfaceId: HOLDING_INTERFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } }),
      ] } }, verbose: false },
      activeAtOffset: offset,
    });
    if (!Array.isArray(items)) return fail("an answer that is not a list");
    if (items.length >= limit) throw new LedgerError(`the gateway's custody cannot be read: Canton sent ${items.length} contracts, the limit asked, so the list may be cut short (CUSTODY_LIMIT must stay at or below the participant's list maximum, and above the number of contracts)`);
    return { offset, tokens: custodyFrom(items, readerParty) };
  }

  return { call, ledgerEnd, records, recordPages, participantId, gatewayCustody };
}

export type Ledger = ReturnType<typeof createLedger>;
