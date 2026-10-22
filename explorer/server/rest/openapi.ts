/**
 * `GET /api/openapi.json` (design 6.1 and 6.7): what each route is, what it takes and which fields it answers with. The fields are the allowlists of
 * fields.ts themselves, so a field cannot be added to an answer and left out here. The text of each route is written by hand below; a test holds that
 * the routes the API registers and the routes described here are the same set.
 */
import { FIELDS, REST_FIELDS as F } from "./fields.ts";
import { BUFFER_BLOCKS, PER_CLIENT, TOPICS, TXS_MAX } from "./stream.ts";
import { MAX_LIMIT, DEFAULT_LIMIT, AROUND_MAX, AROUND_DEFAULT } from "./paging.ts";
import { SORTS } from "./account-routes.ts";
import { DEFAULT_WINDOW, METRICS, STEPS, WINDOWS, WINDOW_STEPS } from "./stats-routes.ts";

type Fields = readonly string[];
interface Query { name: string; about: string; values?: readonly string[] }
interface Doc {
  summary: string;
  query?: Query[];
  /** The fields of a single object. */
  object?: Fields;
  /** A page: the fields of each item, and whether the page says if stage 2 had reached it (`derived`). */
  page?: { items: Fields; derived: boolean };
  /** For an answer that is not a list of fields. */
  note?: string;
  /** What `{param}` is. */
  param?: string;
  /** The tag of the group in a viewer. */
  tag: string;
  /** The method, when it is not GET. */
  method?: "post";
}

const limit: Query = { name: "limit", about: `How many rows: 1 to ${MAX_LIMIT}, ${DEFAULT_LIMIT} when left out.` };
const before: Query = { name: "before", about: "The `next` of the page before: this page is the rows after that key, newest first. Leave out for the first page." };
const after: Query = { name: "after", about: "The `next` of the page before: this page is the rows after that key, oldest first. Leave out for the first page." };
const raw: Query = { name: "raw", about: "1 for the rows as the chain wrote them, without what the explorer decodes from them (an immutable answer).", values: ["1"] };
const sort = (values: readonly string[]): Query => ({ name: "sort", about: `The order of the list; ${values[0]} when left out.`, values });
const blockFilter: Query = { name: "filter", about: "all blocks, only the blocks with transactions, or only the empty ones (genesis is not one); all when left out.", values: ["all", "transactions", "empty"] };
const txFilter: Query = { name: "filter", about: "all transactions, only the reverted ones (`failed`), or only the calls into contracts (`calls`, a transaction with input); all when left out.", values: ["all", "failed", "calls"] };
const txCsv: Query = { name: "format", about: "csv for the newest transactions as a file with the list's columns (up to 1000, `limit` sets fewer; no paging); left out for JSON.", values: ["csv"] };
const csv: Query = { name: "format", about: "csv for the newest blocks as a file with the list's columns (up to 1000, `limit` sets fewer; no paging); left out for JSON.", values: ["csv"] };
const around: Query = { name: "n", about: `How many updates on each side: 1 to ${AROUND_MAX}, ${AROUND_DEFAULT} when left out.` };
const paged = [limit, before], pagedAfter = [limit, after];
const DERIVED = "Stage 2 of the indexer may be behind stage 1: `derived` is false for a block it has not reached, and what it writes is then empty or null, not final.";

export const DOCS: Record<string, Doc> = {
  "/api/blocks": { tag: "Blocks", summary: "The newest final blocks, with the proof time and the time to final where the producer's journal has them.", query: [...paged, blockFilter, csv], page: { items: F.blockItem, derived: false } },
  "/api/blocks/{id}": { tag: "Blocks", summary: "One block, by number or 0x hash.", param: "The block's number or its 0x hash.", object: F.blockDetail },
  "/api/blocks/{id}/transactions": { tag: "Blocks", summary: "The transactions of a block, in order.", param: "The block's number or its 0x hash.", query: pagedAfter, page: { items: F.txItem, derived: false } },
  "/api/blocks/{id}/legs": { tag: "Blocks", summary: "The gateway legs a block recorded, in order.", param: "The block's number or its 0x hash.", query: pagedAfter, page: { items: F.leg, derived: false } },
  "/api/blocks/{id}/record": { tag: "Blocks", summary: "The Canton record of a block: header, transactions and proof, as hex.", param: "The block's number or its 0x hash.", object: F.record },
  "/api/txs": { tag: "Transactions", summary: "The newest final transactions.", query: [...paged, txFilter, txCsv], page: { items: F.txItem, derived: false } },
  "/api/txs/{hash}": { tag: "Transactions", summary: "One transaction. Its stage 2 fields are null until its block is derived. `raw=1` is the receipt of a final transaction as reth gave it, which never changes.", param: "The transaction's 0x hash.", query: [raw], object: F.txDetail },
  "/api/txs/{hash}/logs": { tag: "Transactions", summary: "The logs of a transaction, with the events that can be decoded.", param: "The transaction's 0x hash.", query: [...pagedAfter, raw], page: { items: F.log, derived: false } },
  "/api/txs/{hash}/internal": { tag: "Transactions", summary: `The internal calls that moved value. ${DERIVED}`, param: "The transaction's 0x hash.", query: [...pagedAfter, raw], page: { items: F.internal, derived: true } },
  "/api/txs/{hash}/token-transfers": { tag: "Transactions", summary: `The token transfers of a transaction. ${DERIVED}`, param: "The transaction's 0x hash.", query: [...pagedAfter, raw], page: { items: F.transfer, derived: true } },
  "/api/txs/{hash}/trace": { tag: "Transactions", summary: "The call tree of a transaction, as reth traced it. A frame's input is cut at 1,024 bytes (its whole size is `inputSize`); `raw=1` serves it whole. It never changes for a final transaction.", param: "The transaction's 0x hash.", query: [raw], object: F.trace },
  "/api/canton/updates": { tag: "Canton", summary: "The newest Canton updates that carry a block.", query: paged, page: { items: F.updateItem, derived: false } },
  "/api/canton/updates/{updateId}": { tag: "Canton", summary: "One Canton update.", param: "The update id (1220 and 64 hex digits).", object: F.updateDetail },
  "/api/canton/updates/{updateId}/around": { tag: "Canton", summary: "The Canton updates around one, newest first: up to n newer, the update itself and up to n older, by the list's own key (record time, update id). `submittedTemplate`, `submittedChoice` and `txCount` are the producer log's and the block's; null where the log or the block does not hold them.", param: "The update id (1220 and 64 hex digits).", query: [around], note: "An object with `items`, each with the fields in the item list of this route.", object: F.updateAround },
  "/api/addresses": { tag: "Accounts", summary: `Addresses by balance or by transactions. The balance is the database's copy, as of its \`balanceBlock\`. ${DERIVED}`, query: [sort(SORTS.addresses), ...paged], page: { items: F.addressItem, derived: true } },
  "/api/addresses/{address}": { tag: "Accounts", summary: "One address. Its balance is reth's at the newest final block; the counters are the database's. A token's address says so.", param: "A 0x address.", object: F.addressDetail },
  "/api/addresses/{address}/txs": { tag: "Accounts", summary: "The transactions that an address sent, received or created.", param: "A 0x address.", query: paged, page: { items: F.txItem, derived: false } },
  "/api/addresses/{address}/internal": { tag: "Accounts", summary: `The internal calls that moved value to or from an address. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.addressInternal, derived: true } },
  "/api/addresses/{address}/token-transfers": { tag: "Accounts", summary: `The token transfers to or from an address. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.tokenTransferItem, derived: true } },
  "/api/addresses/{address}/tokens": { tag: "Accounts", summary: `What an address holds, token by token. ${DERIVED}`, param: "A 0x address.", query: pagedAfter, page: { items: F.holding, derived: true } },
  "/api/addresses/{address}/coin-history": { tag: "Accounts", summary: `An address's balance at the blocks where it changed. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.coinPoint, derived: true } },
  "/api/contracts": { tag: "Contracts", summary: `Contracts. ${DERIVED}`, query: [sort(SORTS.contracts), { name: "verified", about: "true for the contracts whose source is verified, false for the others.", values: ["true", "false"] }, ...paged], page: { items: F.contractItem, derived: true } },
  "/api/contracts/{address}": { tag: "Contracts", summary: "One contract, with its code, proxy and verification.", param: "A 0x address.", object: F.contractDetail },
  "/api/contracts/{address}/source": { tag: "Contracts", summary: "The verified source files and ABI of a contract. Every field after `verified` is empty while nothing is verified.", param: "A 0x address.", object: F.source },
  "/api/tokens": { tag: "Tokens", summary: `Tokens. ${DERIVED}`, query: [sort(SORTS.tokens), ...paged], page: { items: F.tokenItem, derived: true } },
  "/api/tokens/{address}": { tag: "Tokens", summary: "One token, with its numbers.", param: "A 0x address.", object: F.tokenDetail },
  "/api/tokens/{address}/holders": { tag: "Tokens", summary: `The holders of a token. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.holder, derived: true } },
  "/api/tokens/{address}/transfers": { tag: "Tokens", summary: `The transfers of a token. ${DERIVED}`, param: "A 0x address.", query: paged, page: { items: F.tokenTransferItem, derived: true } },
  "/api/legs": { tag: "Gateway", summary: "The gateway's legs, newest first.", query: paged, page: { items: F.legItem, derived: false } },
  "/api/legs/{id}": { tag: "Gateway", summary: "One gateway leg, by its id.", param: "The leg's 0x id.", object: F.legItem },
  "/api/search": { tag: "Search", summary: "Where a text leads: a block number or hash, a transaction hash, an address, a Canton update id, or the start of a token's or a verified contract's name.", query: [{ name: "q", about: "The text to look for." }], object: F.search },
  "/api/stats/summary": {
    tag: "Stats", summary: "The numbers of the stats page over a window, and what is live now. A window is the last whole buckets of the rows it is read from (1h and 6h: minutes; 24h and 7d: hours; 30d: days), the open one included; `from` and `to` are the buckets read. Times are seconds, read from buckets 5% apart: a percentile is at most 5% above the truth. A time or a rate with nothing behind it is null. Runs marked as tests are counted in `test` and left out of everything else. `asOf` is when the rollups last ran.",
    query: [{ name: "window", about: `The window: ${Object.keys(WINDOWS).join(", ")}; ${DEFAULT_WINDOW} when left out.`, values: Object.keys(WINDOWS) }], object: F.statsSummary,
  },
  "/api/stats/series": {
    tag: "Stats", summary: `One metric over a window, one point for each step: \`points\` is a list of \`at\` (the start of the step) and \`value\`. A step with no row is 0 for a count and null for a time or a rate. The windows can be drawn in these steps (the first is the default): ${Object.entries(WINDOW_STEPS).map(([w, s]) => `${w}: ${s.join(", ")}`).join("; ")}. \`busy_ratio\` is drawn in 10m, 1h or 1d, and the daily address and contract counts in 1d.`,
    query: [
      { name: "metric", about: `What to draw: ${Object.keys(METRICS).join(", ")}.`, values: Object.keys(METRICS) },
      { name: "window", about: `The window: ${Object.keys(WINDOWS).join(", ")}; ${DEFAULT_WINDOW} when left out.`, values: Object.keys(WINDOWS) },
      { name: "step", about: "The width of a point: 1m, 10m, 1h or 1d, as the window allows.", values: Object.keys(STEPS) },
    ], object: F.statsSeries,
  },
  "/api/status": { tag: "Status", summary: "What the chain and the explorer are doing now.", object: FIELDS.status },
  "/api/block/{id}": { tag: "Pages", summary: "A block as its page shows it: a final block, or one still on its way.", param: "The block's number or its 0x hash.", object: FIELDS.block },
  "/api/tx/{hash}": { tag: "Pages", summary: "A transaction as its page shows it, with where it is in its life.", param: "The transaction's 0x hash.", object: FIELDS.tx },
  "/api/address/{address}": { tag: "Pages", summary: "An address as its page shows it.", param: "A 0x address.", object: FIELDS.address },
  "/api/in-flight": { tag: "Status", summary: "The attempts that are not final yet. Nothing here is a fact of the chain until its block is final.", object: FIELDS.inFlight },
  "/api/faucet": { tag: "Faucet", summary: "GET: what the faucet shows about itself. POST {\"address\": \"0x...\"}: asks for coin, and answers with a ticket.", object: FIELDS.faucetInfo },
  "/api/faucet/ticket/{ticket}": { tag: "Faucet", summary: "Where a faucet request is.", param: "The ticket a request was answered with.", object: FIELDS.faucetTicket },
  "/api/verify": { tag: "Verification", method: "post", summary: "Sends a contract's Solidity source for verification: single file or standard JSON input, with the compiler version, the settings, the constructor arguments and the libraries. Answers 202 with a GUID to ask about.", note: "Queued: the GUID." },
  "/api/verify/{guid}": { tag: "Verification", summary: "Where a verification is: pending, running, or its result (Pass, Fail or Already Verified, with the reason).", param: "The GUID a submission was answered with.", object: FIELDS.verifyJob },
  "/healthz": { tag: "Status", summary: "The same answer as /api/status, for a load balancer: 503 when the explorer is not serving.", object: FIELDS.status },
  "/rpc": { tag: "RPC", method: "post", summary: "The public JSON-RPC: what a wallet or a script sees of the chain, final blocks only. A body is one call or a batch (at most 20 calls, 256 KiB).", note: "JSON-RPC 2.0" },
  "/api/openapi.json": { tag: "Status", summary: "This description.", note: "An OpenAPI 3.1 document." },
  "/api/stream": {
    tag: "Live", summary: `A server-sent event stream. Events: \`block\` and \`txs\` (the first ${TXS_MAX} hashes of a new final block's transactions), whose id is the block number, \`derived\` (stage 2 has reached a block), \`inflight\` (an attempt changed step) and \`stats\` (every 5 s). A comment line every 15 s keeps proxies from closing it. A client that reconnects with the \`Last-Event-ID\` header gets the blocks it missed, up to ${BUFFER_BLOCKS}. ${PER_CLIENT} streams a client; a fifth is answered with 429.`,
    query: [{ name: "topics", about: `A comma-separated list of ${TOPICS.join(", ")}; all of them when left out.`, values: TOPICS }], note: "text/event-stream",
  },
};

const object = (fields: Fields, extra: Record<string, unknown> = {}) => ({
  type: "object", additionalProperties: false, properties: Object.fromEntries(fields.map((f) => [f, {}])), required: [...fields], ...extra,
});
const ERROR = { $ref: "#/components/schemas/Error" };
const fail = (description: string) => ({ description, content: { "application/json": { schema: ERROR } } });

function schemaOf(d: Doc): unknown {
  if (d.page) {
    const props: Record<string, unknown> = { items: { type: "array", items: object(d.page.items) }, next: { type: ["string", "null"], description: "The key to pass as the next page's cursor; null on the last page." } };
    if (d.page.derived) props.derived = { type: "boolean", description: "True when stage 2 has reached the newest final block." };
    return { type: "object", additionalProperties: false, properties: props, required: Object.keys(props) };
  }
  return d.object ? object(d.object) : {};
}

/** The document for the paths that are registered, in the order given. A path with no description is left out, and the test of the API fails for it. */
export function buildOpenApi(paths: readonly string[], info: { title: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const d = DOCS[path];
    if (!d) continue;
    const parameters = [
      ...(d.param ? [{ name: /\{(\w+)\}/.exec(path)![1], in: "path", required: true, description: d.param, schema: { type: "string" } }] : []),
      ...(d.query ?? []).map((q) => ({ name: q.name, in: "query", required: false, description: q.about, schema: { type: "string", ...(q.values ? { enum: [...q.values] } : {}) } })),
    ];
    if (path === "/api/verify") {
      out[path] = { post: { tags: [d.tag], summary: d.summary, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["address", "codeFormat", "sourceCode", "contractName", "compilerVersion"] } } } },
        responses: { 202: { description: d.note ?? "Queued.", content: { "application/json": { schema: object(FIELDS.verifyQueued) } } }, 400: fail("The request is wrong; the message says how."), 413: fail("The source is too big."), 429: fail("The limits are reached."), 503: fail("Verification is not running, or the queue is full.") } } };
      continue;
    }
    if (d.method === "post") {
      out[path] = { post: { tags: [d.tag], summary: d.summary, requestBody: { required: true, content: { "application/json": { schema: { type: ["object", "array"] } } } },
        responses: { 200: { description: d.note ?? "The answer.", content: { "application/json": { schema: {} } } }, 413: fail("The body is too big."), 429: fail("Too many requests; Retry-After says when to try again.") } } };
      continue;
    }
    const type = path === "/api/stream" ? "text/event-stream" : "application/json";
    const get: Record<string, unknown> = {
      tags: [d.tag], summary: d.summary, parameters,
      responses: {
        200: { description: d.note ?? "The answer.", content: { [type]: { schema: schemaOf(d) } } },
        ...(parameters.length ? { 400: fail("The request is wrong; the message says how.") } : {}),
        ...(d.param ? { 404: fail("Nothing is held for that.") } : {}),
        429: fail("Too many requests; Retry-After says when to try again."),
        502: fail("The explorer cannot read the chain right now."),
      },
    };
    out[path] = path === "/api/faucet" ? { get, post: { tags: [d.tag], summary: "Asks the faucet for coin.", requestBody: { required: true, content: { "application/json": { schema: object(["address"]) } } }, responses: { 200: { description: "Queued.", content: { "application/json": { schema: object(FIELDS.faucetQueued) } } }, 400: fail("The request is wrong."), 429: fail("The limits are reached.") } } } : { get };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: info.title, version: "1",
      description: "Read-only. Every list is a keyset page (`next` is the cursor for the following page). Amounts are decimal strings. Times are ISO 8601 UTC.",
    },
    paths: out,
    components: { schemas: { Error: object(["error"]) } },
  };
}
