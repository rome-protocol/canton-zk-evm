/**
 * The Etherscan-compatible `/api` and `/v2/api` (design 6.2): one door, a `module` and an `action`, answered as Etherscan answers (`{status, message, result}`, numbers
 * as decimal strings, addresses in lowercase), because the tools that are pointed at it (Foundry, Hardhat, ethers) read only that shape. HTTP is 200 for everything, as
 * Etherscan's is; a refusal is `status` "0". `apikey` is never read: the tools insist on sending one, and there are no keys (design 6.6).
 *
 * This file is the account module (balance, balancemulti, tokenbalance, txlist, txlistinternal, tokentx, tokennfttx, token1155tx, getminedblocks), the transaction module
 * (getstatus, gettxreceiptstatus), the contract module (verifysourcecode, checkverifystatus, getsourcecode, getabi, getcontractcreation, verifyproxycontract, checkproxyverification), the block module (getblockreward, getblocknobytime, getblockcountdown), the logs module (getLogs) and the door itself; the other
 * modules register their actions in `MODULES` as they land. What is final is all that is served: every row is from a final block, a balance is reth's at the newest
 * final block (never the database's copy), and a list that stage 2 writes (internal calls, token transfers) stops at the block stage 2 has reached, so it is never
 * partly written. The texts of the answers are Etherscan's where the module's documentation and its answers give one, and are held by tests with recorded answers.
 */
import type { Answer } from "../api.ts";
import type { PublicRpc } from "../public-rpc.ts";
import { ChainDbError } from "../chain-db.ts";
import { RethError, type Reth } from "../reth.ts";
import type { VerifyApi } from "../verifier/api.ts";
import { toolOf } from "../verifier/request.ts";
import { NOT_VERIFIED, sourceCodeFields } from "./etherscan-contract-rest.ts";
import { PageTooLarge, QueryTimeout, type Closest, type EtherscanRest, type InternalRow, type LogFilter, type TokenMoveRow, type TokenStandard, type TxRow, type Window } from "./etherscan-rest.ts";

/** `page × offset` may be no more than this, as Etherscan's window is. */
export const RESULT_WINDOW = 10_000;
export const MAX_BALANCES = 20;
/** `getcontractcreation` takes at most this many addresses. */
export const MAX_CREATIONS = 5;
/** Etherscan's `libraryname1` to `libraryname10`. */
const MAX_LIBRARIES = 10;

export const TEXTS = {
  module: "Error! Missing Or invalid Module name",
  action: "Error! Missing Or invalid Action name",
  address: "Error! Invalid address format",
  txhash: "Error! Invalid txhash format",
  chainid: "Missing or unsupported chainid parameter (required for v2 api), please see https://api.etherscan.io/v2/chainlist for the list of supported chainids",
  window: "Result window is too large, PageNo x Offset size must be less than or equal to 10000",
  paging: "Error! Invalid page or offset",
  sort: "Error! Invalid sort, use asc or desc",
  blocks: "Error! Invalid startblock or endblock",
  tag: "Error! Invalid tag, use latest",
  noRows: "No transactions found",
  unsupported: "not supported on Ostia",
  noFinal: "The explorer has no final block yet.",
  broken: "The explorer cannot read the chain right now.",
  tooManyAddresses: `Error! Max ${MAX_BALANCES} addresses per call`,
  tokenWho: "Error! Missing address or contractaddress",
  txlistinternal: "Error! Missing address, txhash or startblock and endblock",
  blocktype: "Error! Invalid blocktype, use blocks or uncles",
  blockno: "Error! Invalid block no",
  noBlock: "Error! Block does not exist",
  timestamp: "Error! Invalid timestamp format",
  closest: "Error! Invalid closest value, use before or after",
  noClosest: "Error! Closest block was not found",
  passed: "Error! Block number already pass",
  noRhythm: "Error! Ostia cuts blocks on demand, so there is no block time to count down by",
  topic: "Error! Invalid topic format",
  topicOp: "Error! Invalid topic operator, use and or or",
  logsWide: "Query Timeout occured. Please select a smaller result dataset",
  tooLarge: "Result too large; ask for a smaller offset",
  timeout: "Query Timeout occured. Please select a smaller result dataset",
  noRecords: "No records found",
  noData: "No data found",
  noPrice: "Error! A test coin has no price, so Ostia gives none",
  noGenesis: "Error! The explorer does not hold the genesis allocation yet",
  gasprice: "Error! Invalid gasprice",
  noFinalTx: "Error! No transaction has reached final yet, so there is no time to estimate by",
  contract: "Error! Invalid contractaddress format",
  tooManyCreations: `Error! Max ${MAX_CREATIONS} addresses per call`,
  unknownGuid: "Unknown UID",
  notRunning: "Verification is not running.",
} as const;

/** A refusal: `status` "0", `message` "NOTOK" and the reason as the result, unless a text is given for the message instead (Etherscan words some refusals that way). */
export class NotOk extends Error {
  readonly reason: string;
  readonly inMessage: boolean;
  constructor(reason: string, inMessage = false) { super(reason); this.reason = reason; this.inMessage = inMessage; }
}
/** A list that has no rows, with its module's own words: Etherscan's `logs` module says "No records found" where its account lists say "No transactions found". */
export class Empty extends Error {}
/** What a handler gives back; a list with no rows is Etherscan's "No transactions found". */
type Result = string | object[] | object | Raw;
/** A JSON-RPC answer passed through as it is: the `proxy` module has no `status` and `message`, as Etherscan's has none. */
export class Raw { readonly body: object; constructor(body: object) { this.body = body; } }
const answer = (body: unknown): Answer => ({ status: 200, body });
const okBody = (result: Result): Answer =>
  result instanceof Raw ? answer(result.body) : answer(Array.isArray(result) && result.length === 0 ? { status: "0", message: TEXTS.noRows, result: [] } : { status: "1", message: "OK", result });
const empty = (e: Empty): Answer => answer({ status: "0", message: e.message, result: [] });
const notOk = (e: NotOk): Answer => answer(e.inMessage ? { status: "0", message: e.reason, result: null } : { status: "0", message: "NOTOK", result: e.reason });

/** The request's parameters: the query's and a form body's, the query's first; one that is empty is as good as absent. Names are as Etherscan spells them. */
export class Params {
  private readonly all: URLSearchParams[];
  constructor(query: URLSearchParams, body?: string) { this.all = body ? [query, new URLSearchParams(body)] : [query]; }
  get(name: string): string | null {
    return this.raw(name)?.trim() ?? null;
  }
  /** The value as it was sent, with its white space: a source's trailing newline is part of what the compiler hashes. */
  raw(name: string): string | null {
    for (const q of this.all) {
      const v = q.get(name);
      if (v !== null && v.trim() !== "") return v;
    }
    return null;
  }
}

interface Ctx { p: Params; rest: EtherscanRest; verify: VerifyApi | undefined; reth: Pick<Reth, "balanceAt" | "tokenBalanceAt" | "tokenSupplyAt">; rpc: PublicRpc | undefined; ip: string; heads: () => Promise<{ head: number | null; cursor: number }> }
type Handler = (c: Ctx) => Promise<Result>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, WHOLE = /^[0-9]{1,15}$/;
const addressOf = (v: string | null): string => {
  if (v === null || !ADDRESS.test(v)) throw new NotOk(TEXTS.address);
  return v.toLowerCase();
};
const dec = (v: string | null | undefined): string => v ?? "";

/**
 * The window of a list: `startblock` and `endblock` (the newest block there is when it is absent or "latest"; a block newer than that is the newest), `sort`
 * (`asc` by default), and `page` and `offset` (the first page of 10,000 rows when neither is given). `cap` is the newest block the list may show.
 */
function windowOf(p: Params, cap: number | null): Window {
  const newest = cap ?? -1;
  const num = (name: string, fallback: number): number => {
    const v = p.get(name);
    if (v === null || (name === "endblock" && v === "latest")) return fallback;
    if (!WHOLE.test(v)) throw new NotOk(TEXTS.blocks);
    return Number(v);
  };
  const start = num("startblock", 0), end = Math.min(num("endblock", newest), newest);
  const sort = p.get("sort") ?? "asc";
  if (sort !== "asc" && sort !== "desc") throw new NotOk(TEXTS.sort);
  const whole = (name: string, fallback: number): number => {
    const v = p.get(name);
    if (v === null) return fallback;
    if (!WHOLE.test(v) || Number(v) < 1) throw new NotOk(TEXTS.paging);
    return Number(v);
  };
  const page = whole("page", 1), offset = whole("offset", RESULT_WINDOW);
  if (page * offset > RESULT_WINDOW) throw new NotOk(TEXTS.window, true);
  return { start, end, sort, skip: (page - 1) * offset, limit: offset };
}

const confirmationsOf = (head: number, block: number): string => String(head - block + 1);

const txItem = (t: TxRow, head: number) => ({
  blockNumber: String(t.block), timeStamp: String(t.timestamp), hash: t.hash, nonce: String(t.nonce), blockHash: t.blockHash, transactionIndex: String(t.index), from: t.from, to: t.to ?? "",
  value: t.value, gas: t.gasLimit, gasPrice: t.gasPrice, isError: t.success ? "0" : "1", txreceipt_status: t.success ? "1" : "0", input: t.input, contractAddress: t.created ?? "",
  cumulativeGasUsed: t.cumulativeGasUsed, gasUsed: t.gasUsed, confirmations: confirmationsOf(head, t.block), methodId: t.methodId ?? "0x", functionName: "",
});

const internalItem = (c: InternalRow) => {
  const creates = c.callType.startsWith("create");
  return {
    blockNumber: String(c.block), timeStamp: String(c.timestamp), hash: c.hash, from: c.from, to: creates ? "" : c.to ?? "", value: c.value, contractAddress: creates ? c.to ?? "" : "", input: "",
    type: c.callType, gas: c.gas ?? "0", gasUsed: c.gasUsed ?? "0", traceId: c.traceAddress.join("_"), isError: c.error === null ? "0" : "1", errCode: c.error ?? "",
  };
};

const tokenItem = (standard: TokenStandard, m: TokenMoveRow, head: number) => {
  const common = {
    blockNumber: String(m.block), timeStamp: String(m.timestamp), hash: m.hash, nonce: String(m.nonce), blockHash: m.blockHash, from: m.from, contractAddress: m.token, to: m.to,
  };
  const tail = {
    transactionIndex: String(m.index), gas: m.gasLimit, gasPrice: m.gasPrice, gasUsed: m.gasUsed, cumulativeGasUsed: m.cumulativeGasUsed, input: "deprecated", confirmations: confirmationsOf(head, m.block),
  };
  const named = { tokenName: dec(m.name), tokenSymbol: dec(m.symbol) };
  if (standard === "ERC-20") return { ...common, value: dec(m.amount), ...named, tokenDecimal: m.decimals === null ? "" : String(m.decimals), ...tail };
  if (standard === "ERC-721") return { ...common, tokenID: dec(m.tokenId), ...named, tokenDecimal: "0", ...tail };
  return { ...common, tokenID: dec(m.tokenId), tokenValue: dec(m.amount), ...named, ...tail };
};

/** The newest final block, which a list's confirmations and a balance are counted from. */
async function finalHead(c: Ctx): Promise<number> {
  const { head } = await c.heads();
  if (head === null) throw new NotOk(TEXTS.noFinal);
  return head;
}

/** `tag` is the newest final block, whichever of Etherscan's names for the newest it is given by. */
function checkTag(p: Params): void {
  const tag = p.get("tag");
  if (tag !== null && !["latest", "safe", "finalized"].includes(tag)) throw new NotOk(TEXTS.tag);
}

const account: Record<string, Handler> = {
  async balance(c) {
    const a = addressOf(c.p.get("address"));
    checkTag(c.p);
    return (await c.reth.balanceAt(a, await finalHead(c))).toString();
  },
  async balancemulti(c) {
    const raw = c.p.get("address");
    const list = (raw ?? "").split(",").map((x) => x.trim());
    if (list.length > MAX_BALANCES) throw new NotOk(TEXTS.tooManyAddresses);
    const accounts = list.map((x) => addressOf(x));
    checkTag(c.p);
    const head = await finalHead(c);
    const balances = await Promise.all(accounts.map((a) => c.reth.balanceAt(a, head)));
    return accounts.map((account, i) => ({ account, balance: (balances[i] as bigint).toString() }));
  },
  async tokenbalance(c) {
    const token = c.p.get("contractaddress");
    if (token === null) throw new NotOk(TEXTS.tokenWho);
    const t = addressOf(token), a = addressOf(c.p.get("address"));
    checkTag(c.p);
    return (await c.reth.tokenBalanceAt(t, a, await finalHead(c))).toString();
  },
  async txlist(c) {
    const a = addressOf(c.p.get("address"));
    const { head } = await c.heads();
    const w = windowOf(c.p, head);
    return (await c.rest.txlist(a, w)).map((t) => txItem(t, head as number));
  },
  async txlistinternal(c) {
    const { head, cursor } = await c.heads();
    const w = windowOf(c.p, head === null ? null : Math.min(head, cursor));
    const hash = c.p.get("txhash"), address = c.p.get("address");
    let rows: InternalRow[];
    if (hash !== null) {
      if (!HASH.test(hash)) throw new NotOk(TEXTS.txhash);
      rows = (await c.rest.internalOfTx(hash.toLowerCase(), w)) ?? [];
    } else if (address !== null) {
      rows = await c.rest.internalOf(addressOf(address), w);
    } else {
      if (c.p.get("startblock") === null || c.p.get("endblock") === null) throw new NotOk(TEXTS.txlistinternal);
      rows = await c.rest.internalInBlocks(w);
    }
    return rows.map(internalItem);
  },
  async getminedblocks(c) {
    const a = addressOf(c.p.get("address"));
    const type = c.p.get("blocktype") ?? "blocks";
    if (type !== "blocks" && type !== "uncles") throw new NotOk(TEXTS.blocktype);
    const { head } = await c.heads();
    const w = windowOf(c.p, head);
    // Ostia has no uncles.
    if (type === "uncles") return [];
    return (await c.rest.mined(a, w)).map((m) => ({ blockNumber: String(m.block), timeStamp: String(m.timestamp), blockReward: m.reward }));
  },
};

/** One handler for the three token lists: they differ in the standard they list and the fields they give. */
const tokenList = (standard: TokenStandard): Handler => async (c) => {
  const a = c.p.get("address"), token = c.p.get("contractaddress");
  if (a === null && token === null) throw new NotOk(TEXTS.tokenWho);
  const who = a === null ? null : addressOf(a), of = token === null ? null : addressOf(token);
  const { head, cursor } = await c.heads();
  const w = windowOf(c.p, head === null ? null : Math.min(head, cursor));
  return (await c.rest.tokenMoves(standard, who, of, w)).map((m) => tokenItem(standard, m, head as number));
};
account.tokentx = tokenList("ERC-20");
account.tokennfttx = tokenList("ERC-721");
account.token1155tx = tokenList("ERC-1155");

const blockNo = (v: string | null): number => {
  if (v === null || !WHOLE.test(v)) throw new NotOk(TEXTS.blockno);
  return Number(v);
};
const txHashOf = (v: string | null): string => {
  if (v === null || !HASH.test(v)) throw new NotOk(TEXTS.txhash);
  return v.toLowerCase();
};

/** What the stored transaction says: it succeeded or reverted. A hash the index does not hold has not failed (Etherscan answers no error for it). Only final blocks are indexed. */
const transaction: Record<string, Handler> = {
  async getstatus(c) {
    const ok = await c.rest.txSuccess(txHashOf(c.p.get("txhash")));
    return ok === false ? { isError: "1", errDescription: "Reverted" } : { isError: "0", errDescription: "" };
  },
  async gettxreceiptstatus(c) {
    const ok = await c.rest.txSuccess(txHashOf(c.p.get("txhash")));
    return { status: ok === null ? "" : ok ? "1" : "0" };
  },
};

const block: Record<string, Handler> = {
  /** There is no block reward on Ostia, so the reward is the block's priority fees (the base fee is burnt), the miner is its fee recipient, and there are no uncles. */
  async getblockreward(c) {
    const n = blockNo(c.p.get("blockno"));
    const b = await c.rest.blockReward(n);
    if (b === null) throw new NotOk(TEXTS.noBlock);
    return { blockNumber: String(b.block), timeStamp: String(b.timestamp), blockMiner: b.miner, blockReward: b.reward, uncles: [], uncleInclusionReward: "0" };
  },
  async getblocknobytime(c) {
    const ts = c.p.get("timestamp");
    // PostgreSQL cannot make a time of year 10000 or later, so a larger number is refused here, as a wrong timestamp, and not read.
    if (ts === null || !WHOLE.test(ts) || Number(ts) > MAX_TIMESTAMP) throw new NotOk(TEXTS.timestamp);
    const closest = c.p.get("closest");
    if (closest !== "before" && closest !== "after") throw new NotOk(TEXTS.closest);
    const n = await c.rest.blockAtTime(Number(ts), closest as Closest);
    if (n === null) throw new NotOk(TEXTS.noClosest);
    return String(n);
  },
  /** A countdown needs a rhythm to count by; `on_demand` cuts a block only when a transaction waits, so it has none. */
  async getblockcountdown(c) {
    const target = blockNo(c.p.get("blockno"));
    const r = await c.rest.rhythm();
    if (r === null || r.strategy !== "fixed_rhythm" || r.intervalMs === null) throw new NotOk(TEXTS.noRhythm);
    const head = await finalHead(c);
    if (target <= head) throw new NotOk(TEXTS.passed);
    const remaining = target - head;
    return { CurrentBlock: String(head), CountdownBlock: String(target), RemainingBlock: String(remaining), EstimateTimeInSec: String((remaining * r.intervalMs) / 1000) };
  },
};

/** The most logs a `getLogs` page holds, and the widest range of blocks it will search without an address or a topic0 to narrow it by (the indexes are on those two). */
export const MAX_LOGS = 1_000;
export const MAX_LOG_RANGE = 10_000;
const hexq = (n: number | string): string => (BigInt(n) === 0n ? "0x" : "0x" + BigInt(n).toString(16));

const logs: Record<string, Handler> = {
  async getLogs(c) {
    const { head } = await c.heads();
    const p = c.p;
    const newest = head ?? -1;
    // `latest` is the newest final block at either end; a missing fromBlock is block 0 and a missing toBlock is the newest.
    const edge = (name: string, fallback: number): number => {
      const v = p.get(name);
      if (v === null) return fallback;
      if (v === "latest") return newest;
      if (!WHOLE.test(v)) throw new NotOk(TEXTS.blocks);
      return Number(v);
    };
    const from = edge("fromBlock", 0), to = Math.min(edge("toBlock", newest), newest);
    const whole = (name: string, fallback: number): number => {
      const v = p.get(name);
      if (v === null) return fallback;
      if (!WHOLE.test(v) || Number(v) < 1) throw new NotOk(TEXTS.paging);
      return Number(v);
    };
    const page = whole("page", 1), offset = Math.min(whole("offset", MAX_LOGS), MAX_LOGS);
    if (page * offset > RESULT_WINDOW) throw new NotOk(TEXTS.window, true);
    const a = p.get("address");
    const address = a === null ? null : addressOf(a);
    const topics: (string | null)[] = [0, 1, 2, 3].map((i) => {
      const t = p.get(`topic${i}`);
      if (t === null) return null;
      if (!HASH.test(t)) throw new NotOk(TEXTS.topic);
      return t.toLowerCase();
    });
    // Topics are combined left to right; the operator between two is `topicX_Y_opr`, `and` when it is not given.
    const given = topics.flatMap((t, i) => (t === null ? [] : [i]));
    const ops = given.slice(1).map((j, k) => {
      const op = (p.get(`topic${given[k]}_${j}_opr`) ?? "and").toLowerCase();
      if (op !== "and" && op !== "or") throw new NotOk(TEXTS.topicOp);
      return op;
    });
    // topic0 narrows the search only when every topic is and-ed with it.
    const narrowed = address !== null || (topics[0] !== null && ops.every((o) => o === "and"));
    if (head === null || from > to) throw new Empty(TEXTS.noRecords);
    if (!narrowed && to - from + 1 > MAX_LOG_RANGE) throw new NotOk(TEXTS.logsWide);
    const filter: LogFilter = { from, to, address, topics, ops, skip: (page - 1) * offset, limit: offset };
    const rows = await c.rest.logs(filter);
    if (rows.length === 0) throw new Empty(TEXTS.noRecords);
    return rows.map((l) => ({
      address: l.address, topics: l.topics, data: l.data, blockNumber: hexq(l.block), blockHash: l.blockHash, timeStamp: hexq(l.timestamp), gasPrice: hexq(l.gasPrice), gasUsed: hexq(l.gasUsed),
      logIndex: hexq(l.logIndex), transactionHash: l.txHash, transactionIndex: hexq(l.txIndex),
    }));
  },
};

/** `contractaddress` of the token and stats modules: required, and an address. */
const contractOf = (v: string | null): string => {
  if (v === null || !ADDRESS.test(v)) throw new NotOk(TEXTS.contract);
  return v.toLowerCase();
};

const TOKEN_TYPE: Record<TokenStandard, string> = { "ERC-20": "ERC20", "ERC-721": "ERC721", "ERC-1155": "ERC1155" };
const NO_LINKS = ["description", "website", "email", "blog", "reddit", "slack", "facebook", "twitter", "bitcointalk", "github", "telegram", "wechat", "linkedin", "discord", "whitepaper"];

/** The token module. The indexer's token rows answer it, so a token's holders are as far on as stage 2 is; an address that is no token has no data. */
const token: Record<string, Handler> = {
  async tokeninfo(c) {
    const t = await c.rest.tokenInfo(contractOf(c.p.get("contractaddress")));
    if (t === null) throw new Empty(TEXTS.noData);
    // Etherscan's `divisor` is the token's decimals; a token's links are not known to Ostia, so they are empty, as Etherscan's are for a token it knows nothing about.
    return [{
      contractAddress: t.address, tokenName: dec(t.name), symbol: dec(t.symbol), divisor: t.decimals === null ? "" : String(t.decimals), tokenType: TOKEN_TYPE[t.standard], totalSupply: dec(t.totalSupply),
      blueCheckmark: "false", ...Object.fromEntries(NO_LINKS.map((k) => [k, ""])), tokenPriceUSD: "",
    }];
  },
  async tokenholdercount(c) {
    const t = await c.rest.tokenInfo(contractOf(c.p.get("contractaddress")));
    if (t === null) throw new Empty(TEXTS.noData);
    return String(t.holders);
  },
  async tokenholderlist(c) {
    const a = contractOf(c.p.get("contractaddress"));
    const w = windowOf(c.p, null);
    const t = await c.rest.tokenInfo(a);
    if (t === null) throw new Empty(TEXTS.noData);
    // An ERC-1155 balance is by token id, and has no single holder quantity.
    if (t.standard === "ERC-1155") throw new NotOk(TEXTS.unsupported);
    return (await c.rest.holders(a, w)).map((h) => ({ TokenHolderAddress: h.holder, TokenHolderQuantity: h.value }));
  },
};

/** The stats module's free actions. A test coin has no price, and the paid daily statistics are not served (UNSUPPORTED). */
const stats: Record<string, Handler> = {
  /** The genesis allocation minus the fees burnt in the final blocks (nothing mints coins later). */
  async ethsupply(c) {
    const head = await finalHead(c);
    const genesis = await c.rest.genesisSupply();
    if (genesis === null) throw new NotOk(TEXTS.noGenesis);
    return (BigInt(genesis) - BigInt(await c.rest.burntFees(head))).toString();
  },
  async tokensupply(c) {
    const t = contractOf(c.p.get("contractaddress"));
    return (await c.reth.tokenSupplyAt(t, await finalHead(c))).toString();
  },
  async ethprice() {
    throw new NotOk(TEXTS.noPrice);
  },
};

/** Wei as Etherscan writes a price: in gwei, with the digits it needs and no more. */
export function gwei(wei: bigint | string): string {
  const v = BigInt(wei);
  const whole = v / 1_000_000_000n, frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}
const ratio = (n: number): string => n.toFixed(15).replace(/\.?0+$/, "");

/** What Etherscan's `proxy` module gives for an argument that is missing: the node's own words, as a JSON-RPC error. */
const rpcError = (code: number, message: string): Raw => new Raw({ jsonrpc: "2.0", id: 1, error: { code, message } });
const rpcResult = (result: unknown): Raw => new Raw({ jsonrpc: "2.0", id: 1, result });
type Up = { result?: unknown; error?: unknown };
const isUp = (v: unknown): v is Up => typeof v === "object" && v !== null;

/** One call of the public RPC: its rules (final only, the tracker for a send, the limits of a client) are the proxy's. The JSON-RPC answer is given back as it is. */
async function viaRpc(c: Ctx, method: string, params: unknown[]): Promise<Up> {
  if (!c.rpc) throw new NotOk(TEXTS.unsupported);
  const a = await c.rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), c.ip);
  if (!isUp(a.body)) throw new NotOk(TEXTS.broken);
  return a.body;
}
/** The named parameters in order, or the JSON-RPC error of the first one missing. A `tag` that is left out is the newest, as Etherscan has it (ethers leaves it out of a call). */
function need(c: Ctx, names: string[]): string[] | Raw {
  const out: string[] = [];
  for (const [i, n] of names.entries()) {
    const v = c.p.get(n) ?? (n === "tag" ? "latest" : null);
    if (v === null) return rpcError(-32602, `missing value for required argument ${i}`);
    out.push(v);
  }
  return out;
}
/** The call a client describes, in Etherscan's names (`gas`) and in ethers' (`gasLimit`), with the fields that were sent and no others. */
function callObject(c: Ctx): Record<string, string> {
  const call: Record<string, string> = {};
  for (const [param, field] of [["to", "to"], ["from", "from"], ["data", "data"], ["value", "value"], ["gasPrice", "gasPrice"], ["gas", "gas"], ["gasLimit", "gas"], ["maxFeePerGas", "maxFeePerGas"], ["maxPriorityFeePerGas", "maxPriorityFeePerGas"]] as const) {
    const v = c.p.get(param);
    if (v !== null && !(field in call)) call[field] = v;
  }
  return call;
}
/** A call whose parameters are the named ones, as strings. */
const plain = (method: string, names: string[]): Handler => async (c) => {
  const a = need(c, names);
  if (a instanceof Raw) return a;
  return new Raw(await viaRpc(c, method, a));
};
/** The block the public RPC gives for a tag, whose transactions the two block actions below count and pick from. A block that is not final is null, as it is on `/rpc`. */
async function blockOf(c: Ctx, full: boolean): Promise<Raw | { block: { transactions?: unknown[] } | null }> {
  const a = need(c, ["tag"]);
  if (a instanceof Raw) return a;
  const r = await viaRpc(c, "eth_getBlockByNumber", [a[0], full]);
  if (r.error !== undefined || !("result" in r)) return new Raw(r);
  return { block: typeof r.result === "object" ? (r.result as { transactions?: unknown[] } | null) : null };
}

const proxy: Record<string, Handler> = {
  eth_blockNumber: plain("eth_blockNumber", []),
  async eth_getBlockByNumber(c) {
    const a = need(c, ["tag", "boolean"]);
    if (a instanceof Raw) return a;
    if (a[1] !== "true" && a[1] !== "false") return rpcError(-32602, "invalid argument 1: boolean must be true or false");
    return new Raw(await viaRpc(c, "eth_getBlockByNumber", [a[0], a[1] === "true"]));
  },
  /** The count is the length of the block's list, so it follows the final-only rule of the block. */
  async eth_getBlockTransactionCountByNumber(c) {
    const b = await blockOf(c, false);
    if (b instanceof Raw) return b;
    return rpcResult(b.block === null ? null : "0x" + (b.block.transactions?.length ?? 0).toString(16));
  },
  eth_getTransactionByHash: plain("eth_getTransactionByHash", ["txhash"]),
  async eth_getTransactionByBlockNumberAndIndex(c) {
    const index = c.p.get("index");
    if (index === null) return rpcError(-32602, "missing value for required argument 1");
    if (!/^0x[0-9a-f]+$/i.test(index)) return rpcError(-32602, "invalid argument 1: hex string without 0x prefix");
    const b = await blockOf(c, true);
    if (b instanceof Raw) return b;
    const at = BigInt(index);
    return rpcResult(b.block?.transactions?.[at > 0xffffffffn ? -1 : Number(at)] ?? null);
  },
  eth_getTransactionCount: plain("eth_getTransactionCount", ["address", "tag"]),
  eth_sendRawTransaction: plain("eth_sendRawTransaction", ["hex"]),
  eth_getTransactionReceipt: plain("eth_getTransactionReceipt", ["txhash"]),
  async eth_call(c) {
    const a = need(c, ["to", "data", "tag"]);
    if (a instanceof Raw) return a;
    return new Raw(await viaRpc(c, "eth_call", [callObject(c), a[2]]));
  },
  eth_getCode: plain("eth_getCode", ["address", "tag"]),
  eth_getStorageAt: plain("eth_getStorageAt", ["address", "position", "tag"]),
  eth_gasPrice: plain("eth_gasPrice", []),
  /** The call as the node gets it: the fields that were sent, and no block, so the public RPC reads it at the final block. */
  async eth_estimateGas(c) {
    return new Raw(await viaRpc(c, "eth_estimateGas", [callObject(c)]));
  },
  /** There are no uncles on Ostia. */
  async eth_getUncleByBlockNumberAndIndex() { return rpcResult(null); },
};

const gastracker: Record<string, Handler> = {
  /** Three prices over the base fee of the newest final block: it plus the 25th, the 50th and the 75th percentile of the priority fees paid in the last 20 blocks. */
  async gasoracle(c) {
    const f = await c.rest.feeSample();
    if (f === null) throw new NotOk(TEXTS.noFinal);
    const base = BigInt(f.baseFee), tips = f.tips ?? ["0", "0", "0"];
    return {
      LastBlock: String(f.block), SafeGasPrice: gwei(base + BigInt(tips[0])), ProposeGasPrice: gwei(base + BigInt(tips[1])), FastGasPrice: gwei(base + BigInt(tips[2])),
      suggestBaseFee: gwei(base), gasUsedRatio: f.usedRatios.map(ratio).join(","),
    };
  },
  /** The median time to final, in whole seconds, whatever the price offered: a block is cut for a waiting transaction, and every transaction waits for the proof. */
  async gasestimate(c) {
    const price = c.p.get("gasprice");
    if (price !== null && !/^[0-9]{1,78}$/.test(price)) throw new NotOk(TEXTS.gasprice);
    const seconds = await c.rest.medianSecondsToFinal();
    if (seconds === null) throw new NotOk(TEXTS.noFinalTx);
    return String(Math.max(1, Math.ceil(seconds)));
  },
};

/** What a refusal of the verifier's (its HTTP status and its words) is to Etherscan's door: the words, as a NOTOK. */
const refused = (a: { status: number; body: unknown }): NotOk => new NotOk((a.body as { error?: string }).error ?? TEXTS.broken);
const guidOf = (a: { body: unknown }): string => (a.body as { guid: string }).guid;
const verifier = (c: Ctx): VerifyApi => {
  if (!c.verify) throw new NotOk(TEXTS.notRunning);
  return c.verify;
};
/** The job's answer, as Etherscan gives `checkverifystatus` and `checkproxyverification`: status 1 for a pass, 0 for the rest (the text says which), the job's text as the result. */
const jobAnswer = (a: { status: number; body: unknown }): Result => {
  if (a.status !== 200) throw new NotOk(TEXTS.unknownGuid);
  const j = a.body as { status: string; result: string };
  if (j.status === "pass") return j.result;
  throw new NotOk(j.result);
};

/** Etherscan's `verifysourcecode` fields, as the verifier takes them. Etherscan spells the constructor field `constructorArguements`; the right spelling is accepted too. */
function verifyRequest(c: Ctx) {
  const address = addressOf(c.p.get("contractaddress"));
  const need = (name: string): string => {
    const v = c.p.raw(name);
    if (v === null) throw new NotOk(`Missing or invalid ${name}`);
    return v;
  };
  const sourceCode = need("sourceCode"), contractName = need("contractname").trim(), compilerVersion = need("compilerversion").trim();
  const codeFormat = c.p.get("codeformat") ?? "solidity-single-file";
  if (codeFormat !== "solidity-single-file" && codeFormat !== "solidity-standard-json-input") throw new NotOk(TEXTS.unsupported);
  const args = c.p.get("constructorArguements") ?? c.p.get("constructorArguments") ?? "";
  if (!/^(0x)?([0-9a-fA-F]{2})*$/.test(args)) throw new NotOk("Missing or invalid constructorArguements");
  const libraries: { name: string; address: string }[] = [];
  for (let i = 1; i <= MAX_LIBRARIES; i++) {
    const name = c.p.get(`libraryname${i}`), at = c.p.get(`libraryaddress${i}`);
    if (name === null && at === null) continue;
    if (name === null || at === null || !ADDRESS.test(at)) throw new NotOk(`Missing or invalid libraryaddress${i}`);
    libraries.push({ name, address: at });
  }
  return {
    address, codeFormat, sourceCode, contractName, compilerVersion, optimizationUsed: c.p.get("optimizationUsed") ?? undefined, runs: c.p.get("runs") ?? undefined,
    evmVersion: c.p.get("evmversion") ?? undefined, licenseType: licenseOf(c.p.get("licenseType")), constructorArguments: args === "" ? undefined : args, libraries: libraries.length > 0 ? libraries : undefined,
  };
}

/** Etherscan's licenseType codes 1 to 14, as the SPDX names the pages show. */
export const LICENSES: Record<string, string> = {
  "1": "UNLICENSED", "2": "Unlicense", "3": "MIT", "4": "GPL-2.0", "5": "GPL-3.0", "6": "LGPL-2.1", "7": "LGPL-3.0",
  "8": "BSD-2-Clause", "9": "BSD-3-Clause", "10": "MPL-2.0", "11": "OSL-3.0", "12": "Apache-2.0", "13": "AGPL-3.0", "14": "BUSL-1.1",
};
/** The license a `licenseType` code names; anything else is left out, and the verifier takes the source's own SPDX line. */
const licenseOf = (v: string | null): string | undefined => (v === null ? undefined : LICENSES[v.trim()]);

/**
 * The contract module. A verification is the verifier's: `verifysourcecode` queues the job and answers its GUID, and the answers about it are the job's texts. What is read
 * is read from the indexer's rows (the verified source, the proxies table, the contracts' creations), final blocks only. A proxy check reads the proxy's slots at the final head, writes `proxies` and answers at once.
 */
const contract: Record<string, Handler> = {
  async verifysourcecode(c) {
    const v = verifier(c);
    const req = verifyRequest(c);
    const found = await c.rest.contractSource(req.address);
    // A contract the index does not hold yet (its block is not final) is what Etherscan says for an address it does not know; the tools take it as "try again later".
    if (!found.held) throw new NotOk(`Unable to locate ContractCode at ${req.address}`);
    if (found.verified?.matchType === "full") throw new NotOk("Contract source code already verified");
    const a = await v.enqueue(req, c.ip, { method: "etherscan", tool: toolOf(c.p.get("tool")) });
    if (a.status !== 202) throw refused(a);
    return guidOf(a);
  },
  async checkverifystatus(c) {
    return jobAnswer(await verifier(c).status(c.p.get("guid") ?? ""));
  },
  async getsourcecode(c) {
    return [sourceCodeFields(await c.rest.contractSource(addressOf(c.p.get("address"))))];
  },
  async getabi(c) {
    const s = await c.rest.contractSource(addressOf(c.p.get("address")));
    if (s.verified === null) throw new NotOk(NOT_VERIFIED);
    return JSON.stringify(s.verified.abi);
  },
  /**
   * A contract in the genesis allocation was made by no transaction. Etherscan's answer for such a contract (on the chains that have them) names the creator `GENESIS` and the
   * transaction `GENESIS_` and the address, with block 0; the design said "empty", but a tool that reads the creator as an address is as lost with an empty text as with this one,
   * and this one is Etherscan's. A contract made by a factory has the factory in `contractFactory` and the sender of the transaction as its creator.
   */
  async getcontractcreation(c) {
    const list = (c.p.get("contractaddresses") ?? "").split(",").map((a) => a.trim()).filter((a) => a !== "");
    if (list.length === 0) throw new NotOk(TEXTS.address);
    if (list.length > MAX_CREATIONS) throw new NotOk(TEXTS.tooManyCreations);
    const rows = await c.rest.contractCreations(list.map((a) => addressOf(a)));
    if (rows.length === 0) throw new Empty(TEXTS.noData);
    return rows.map((r) => ({
      contractAddress: r.address, contractCreator: r.genesis ? "GENESIS" : (r.creator ?? ""), txHash: r.genesis ? `GENESIS_${r.address.slice(2)}` : (r.txHash ?? ""), blockNumber: String(r.block ?? 0),
      timestamp: String(r.timestamp ?? 0), contractFactory: r.factory ?? "", creationBytecode: r.creationCode ?? "",
    }));
  },
  async verifyproxycontract(c) {
    const v = verifier(c);
    const address = addressOf(c.p.get("address"));
    const expected = c.p.get("expectedimplementation");
    if (expected !== null) addressOf(expected);
    // The slots are read at the final head, whatever the indexer's last upgrade log said.
    const a = await v.proxy(address, expected, c.ip, await finalHead(c));
    if (a.status !== 202) throw refused(a);
    return guidOf(a);
  },
  async checkproxyverification(c) {
    return jobAnswer(await verifier(c).proxyStatus(c.p.get("guid") ?? ""));
  },
};

/** The last second of year 9999. */
const MAX_TIMESTAMP = 253_402_300_799;

/** The actions of Etherscan's modules that Ostia answers; a later part of the API adds its modules here. */
export const MODULES: Record<string, Record<string, Handler>> = { account, contract, transaction, block, logs, token, stats, proxy, gastracker };
/** What Etherscan has in the modules above and Ostia does not (its paid or other-chain actions). */
const UNSUPPORTED: Record<string, readonly string[]> = {
  account: ["balancehistory", "addresstokenbalance", "addresstokennftbalance", "addresstokennftinventory", "fundedby", "txnbridge"],
  token: ["toptokenholders", "tokensupplyhistory", "tokenbalancehistory", "tokenholderlisthistory"],
  stats: [
    "ethsupply2", "ethdailyprice", "chainsize", "nodecount", "dailyblkcount", "dailyblockrewards", "dailyavgblocktime", "dailyuncleblkcount", "dailyavgblocksize", "dailytxnfee", "dailynewaddress",
    "dailynetutilization", "dailyavghashrate", "dailytx", "dailyavggasprice", "dailygasused", "dailyavggaslimit", "dailynetdifficulty", "tokencsupply", "tokensupplyhistory",
  ],
  gastracker: ["dailyavggaslimit", "dailygasused", "dailyavggasprice"],
};

export interface EtherscanDeps {
  rest: EtherscanRest; reth: Pick<Reth, "balanceAt" | "tokenBalanceAt" | "tokenSupplyAt">; chainId: number;
  /** The public RPC, which the `proxy` module asks, so that it keeps the rules of `/rpc`. Without it the module answers "not supported on Ostia". */
  rpc?: PublicRpc;
  /** The verifier's API, which the contract module queues verifications with. Without it a verification answers "Verification is not running."; the reads of the module need no verifier. */
  verify?: VerifyApi;
}

/** The door: a request's parameters in, Etherscan's answer out. */
export function etherscan({ rest, reth, chainId, rpc, verify }: EtherscanDeps) {
  return async (query: URLSearchParams, body?: string, ip = "unknown"): Promise<Answer> => {
    const p = new Params(query, body);
    let heads: ReturnType<EtherscanRest["heads"]> | undefined;
    const ctx: Ctx = { p, rest, verify, reth, rpc, ip, heads: () => (heads ??= rest.heads()) };
    try {
      const id = p.get("chainid");
      if (id !== null && id !== String(chainId)) throw new NotOk(TEXTS.chainid);
      const module = (p.get("module") ?? "").toLowerCase(), action = p.get("action") ?? "";
      const known = Object.hasOwn(MODULES, module) ? MODULES[module] : undefined;
      if (!known && !Object.hasOwn(UNSUPPORTED, module)) throw new NotOk(TEXTS.module);
      const wanted = Object.keys(known ?? {}).find((n) => n.toLowerCase() === action.toLowerCase());
      if (!known || wanted === undefined) {
        if ((UNSUPPORTED[module] ?? []).includes(action.toLowerCase())) throw new NotOk(TEXTS.unsupported);
        throw new NotOk(TEXTS.action);
      }
      return okBody(await (known[wanted] as Handler)(ctx));
    } catch (e) {
      if (e instanceof NotOk) return notOk(e);
      if (e instanceof Empty) return empty(e);
      if (e instanceof PageTooLarge) return notOk(new NotOk(TEXTS.tooLarge));
      if (e instanceof QueryTimeout) { console.error(`etherscan api: ${e.message}`); return notOk(new NotOk(TEXTS.timeout)); }
      if (!(e instanceof RethError || e instanceof ChainDbError)) throw e;
      console.error(`etherscan api: ${e.message}`);
      return notOk(new NotOk(TEXTS.broken));
    }
  };
}
