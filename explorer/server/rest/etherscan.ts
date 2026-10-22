/**
 * The Etherscan-compatible `/api` and `/v2/api` (design 6.2): one door, a `module` and an `action`, answered as Etherscan answers (`{status, message, result}`, numbers
 * as decimal strings, addresses in lowercase), because the tools that are pointed at it (Foundry, Hardhat, ethers) read only that shape. HTTP is 200 for everything, as
 * Etherscan's is; a refusal is `status` "0". `apikey` is never read: the tools insist on sending one, and there are no keys (design 6.6).
 *
 * This file is the account module (balance, balancemulti, txlist, txlistinternal, tokentx, tokennfttx, token1155tx, getminedblocks) and the door itself; the other
 * modules register their actions in `MODULES` as they land. What is final is all that is served: every row is from a final block, a balance is reth's at the newest
 * final block (never the database's copy), and a list that stage 2 writes (internal calls, token transfers) stops at the block stage 2 has reached, so it is never
 * partly written. The texts of the answers are Etherscan's where the module's documentation and its answers give one, and are held by tests with recorded answers.
 */
import type { Answer } from "../api.ts";
import { ChainDbError } from "../chain-db.ts";
import { RethError, type Reth } from "../reth.ts";
import type { EtherscanRest, InternalRow, TokenMoveRow, TokenStandard, TxRow, Window } from "./etherscan-rest.ts";

/** `page × offset` may be no more than this, as Etherscan's window is. */
export const RESULT_WINDOW = 10_000;
export const MAX_BALANCES = 20;

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
} as const;

/** A refusal: `status` "0", `message` "NOTOK" and the reason as the result, unless a text is given for the message instead (Etherscan words some refusals that way). */
export class NotOk extends Error {
  readonly reason: string;
  readonly inMessage: boolean;
  constructor(reason: string, inMessage = false) { super(reason); this.reason = reason; this.inMessage = inMessage; }
}
/** What a handler gives back; a list with no rows is Etherscan's "No transactions found". */
type Result = string | object[] | object;
const answer = (body: unknown): Answer => ({ status: 200, body });
const okBody = (result: Result): Answer =>
  answer(Array.isArray(result) && result.length === 0 ? { status: "0", message: TEXTS.noRows, result: [] } : { status: "1", message: "OK", result });
const notOk = (e: NotOk): Answer => answer(e.inMessage ? { status: "0", message: e.reason, result: null } : { status: "0", message: "NOTOK", result: e.reason });

/** The request's parameters: the query's and a form body's, the query's first; one that is empty is as good as absent. Names are as Etherscan spells them. */
export class Params {
  private readonly all: URLSearchParams[];
  constructor(query: URLSearchParams, body?: string) { this.all = body ? [query, new URLSearchParams(body)] : [query]; }
  get(name: string): string | null {
    for (const q of this.all) {
      const v = q.get(name);
      if (v !== null && v.trim() !== "") return v.trim();
    }
    return null;
  }
}

interface Ctx { p: Params; rest: EtherscanRest; reth: Pick<Reth, "balanceAt">; heads: () => Promise<{ head: number | null; cursor: number }> }
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

/** The actions of Etherscan's modules that Ostia answers; a later part of the API adds its modules here. */
export const MODULES: Record<string, Record<string, Handler>> = { account };
/** What Etherscan has in the modules above and Ostia does not (its paid or other-chain actions). */
const UNSUPPORTED: Record<string, readonly string[]> = {
  account: ["balancehistory", "addresstokenbalance", "addresstokennftbalance", "addresstokennftinventory", "fundedby", "txnbridge"],
};

export interface EtherscanDeps { rest: EtherscanRest; reth: Pick<Reth, "balanceAt">; chainId: number }

/** The door: a request's parameters in, Etherscan's answer out. */
export function etherscan({ rest, reth, chainId }: EtherscanDeps) {
  return async (query: URLSearchParams, body?: string): Promise<Answer> => {
    const p = new Params(query, body);
    let heads: ReturnType<EtherscanRest["heads"]> | undefined;
    const ctx: Ctx = { p, rest, reth, heads: () => (heads ??= rest.heads()) };
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
      if (!(e instanceof RethError || e instanceof ChainDbError)) throw e;
      console.error(`etherscan api: ${e.message}`);
      return notOk(new NotOk(TEXTS.broken));
    }
  };
}
