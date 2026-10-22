/**
 * The REST routes of accounts, contracts, tokens and gateway legs, and the search (design 6.1 and 7). Every answer is built field by field from the allowlists
 * in fields.ts, every list is a keyset page, and every 200 carries the cache rule of what it holds.
 *
 * Most of what these routes list is written by stage 2, which may be behind stage 1: every page and every composite answer carries `derived`, true when the derive
 * cursor has reached the newest final block, and false while newer blocks have not been counted yet (what is listed is then true as of the cursor, not as of the head).
 * An address's balance is never the database's copy: it is read from reth at the newest final block.
 */
import type { Answer } from "../api.ts";
import { cached } from "./cache.ts";
import type { AccountRest, AddressSort, ContractSort, TokenSort } from "./account-rest.ts";
import { REST_FIELDS as F, pick } from "./fields.ts";
import { BadRequest, cursorOf, keyOf, limitOf, pageOf } from "./paging.ts";
import type { Reth } from "../reth.ts";

const ADDRESS = /^0x[0-9a-f]{40}$/, LEG_ID = /^0x[0-9a-f]{64}$/;
const ok = (body: unknown): Answer => ({ status: 200, body });
const fail = (status: number, error: string): Answer => ({ status, body: { error } });
const sortHelp = (allowed: readonly string[]) => `sort is one of ${allowed.join(", ")}.`;

export const NO_ADDRESS = "An address is 0x and 40 hex digits.";
export const NO_CONTRACT = "No contract is held at that address.";
export const NO_TOKEN = "No token is held at that address.";
export const NO_LEG = "No gateway leg has that id.";
/** What the first part of a name search may be: it is matched as text, never as a pattern, and a very short or very long one is not a name. */
const NAME = /^.{2,64}$/s;

export interface AccountRouteDeps {
  accounts: AccountRest;
  /** reth, for the balance of an address at the newest final block. */
  reth: Pick<Reth, "balanceAt">;
  /** The search as it stood before names: a block, a hash, an address or a Canton update id. Its answer for a text that is none of them is the 404. */
  search: (q: string) => Promise<Answer>;
}

/** The route for a request, or undefined when it is none of these. `parts` is the path split into lowercase segments, `/api` first. */
export function accountRoutes({ accounts, reth, search }: AccountRouteDeps) {
  /** A page of rows in the fields of an allowlist. `derived` is the pages' own word on stage 2, and is always given: these lists are all derived. */
  const page = <T extends object, K extends keyof T>(rows: T[], limit: number, key: (r: T) => string, fields: readonly K[], derived: boolean) => {
    const p = pageOf(rows, limit, key);
    return pick({ derived, items: p.items.map((r) => pick(r, fields)), next: p.next }, F.derivedPage);
  };
  const isDerived = async (): Promise<boolean> => {
    const { head, cursor } = await accounts.derivedThrough();
    return head === null || cursor >= head;
  };
  const addressOf = (a: string): string => {
    if (!ADDRESS.test(a)) throw new BadRequest(NO_ADDRESS);
    return a;
  };
  const verifiedOf = (raw: string | null): boolean | null => {
    if (raw === null || raw === "") return null;
    if (raw !== "true" && raw !== "false") throw new BadRequest("verified is true or false.");
    return raw === "true";
  };
  const SORTS = { addresses: ["balance", "txs"], contracts: ["interactions", "newest", "oldest"], tokens: ["holders", "transfers", "newest"] } as const;
  const sort = <T extends string>(q: URLSearchParams, allowed: readonly T[]): T => {
    const raw = q.get("sort");
    if (raw !== null && !(allowed as readonly string[]).includes(raw)) throw new BadRequest(sortHelp(allowed));
    return (raw ?? allowed[0]) as T;
  };

  async function addressList(q: URLSearchParams): Promise<Answer> {
    const by = sort<AddressSort>(q, SORTS.addresses), limit = limitOf(q.get("limit"));
    const before = cursorOf(q.get("before"), by === "balance" ? ["text", "text"] : ["int", "text"]);
    const rows = await accounts.addresses(by, before, limit);
    return cached(ok(page(rows, limit, (a) => keyOf(by === "balance" ? (a.balance as string) : a.txCount, a.address), F.addressItem, await isDerived())), "list");
  }

  async function oneAddress(a: string): Promise<Answer> {
    addressOf(a);
    const { head } = await accounts.derivedThrough();
    // The balance a tool acts on is reth's at the newest final block, never the database's copy; with no final block yet there is nothing to read it at.
    const [held, balance] = await Promise.all([accounts.address(a), head === null ? Promise.resolve(null) : reth.balanceAt(a, head)]);
    const body = {
      address: a, kind: "account", sentCount: 0, receivedCount: 0, internalCount: 0, tokenTransferCount: 0, firstSeenBlock: null, lastActiveBlock: null, token: null, createdBy: null, ...held,
      balance: balance === null ? null : balance.toString(), balanceBlock: head, derived: await isDerived(),
    };
    return cached(ok(pick(body, F.addressDetail)), "composite");
  }

  async function addressTxs(a: string, q: URLSearchParams): Promise<Answer> {
    addressOf(a);
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "int"]);
    const rows = await accounts.addressTxs(a, before, limit);
    const p = pageOf(rows, limit, (t) => keyOf(t.block, t.index));
    return cached(ok(pick({ items: p.items.map((t) => pick(t, F.txItem)), next: p.next }, F.page)), "list");
  }

  async function addressInternal(a: string, q: URLSearchParams): Promise<Answer> {
    addressOf(a);
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "int", "trace"]);
    const rows = await accounts.addressInternal(a, before, limit);
    return cached(ok(page(rows, limit, (c) => keyOf(c.block, c.txIndex, "t" + c.traceAddress.join("-")), F.addressInternal, await isDerived())), "list");
  }

  async function addressTransfers(a: string, q: URLSearchParams): Promise<Answer> {
    addressOf(a);
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "int", "int"]);
    const rows = await accounts.addressTransfers(a, before, limit);
    return cached(ok(page(rows, limit, (t) => keyOf(t.block, t.logIndex, t.batchIndex), F.tokenTransferItem, await isDerived())), "list");
  }

  async function addressTokens(a: string, q: URLSearchParams): Promise<Answer> {
    addressOf(a);
    const limit = limitOf(q.get("limit")), after = cursorOf(q.get("after"), ["text", "text"]);
    const rows = await accounts.holdings(a, after, limit);
    return cached(ok(page(rows, limit, (h) => keyOf(h.token, h.tokenId), F.holding, await isDerived())), "composite");
  }

  async function coinHistory(a: string, q: URLSearchParams): Promise<Answer> {
    addressOf(a);
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int"]);
    const rows = await accounts.coinHistory(a, (before?.[0] as number | undefined) ?? null, limit);
    return cached(ok(page(rows, limit, (c) => keyOf(c.block), F.coinPoint, await isDerived())), "list");
  }

  async function contractList(q: URLSearchParams): Promise<Answer> {
    const by = sort<ContractSort>(q, SORTS.contracts), limit = limitOf(q.get("limit")), verified = verifiedOf(q.get("verified"));
    const before = cursorOf(q.get("before"), by === "interactions" ? ["int", "text"] : ["int", "int", "text"]);
    const rows = await accounts.contracts(by, verified, before, limit);
    const key = (c: (typeof rows)[number]) => (by === "interactions" ? keyOf(c.interactionCount, c.address) : keyOf(c.creationBlock ?? 0, c.creationTxIndex ?? 0, c.address));
    return cached(ok(page(rows, limit, key, F.contractItem, await isDerived())), "list");
  }

  async function oneContract(a: string): Promise<Answer> {
    addressOf(a);
    const c = await accounts.contract(a);
    if (!c) return fail(404, NO_CONTRACT);
    return cached(ok(pick({ ...c, proxy: c.proxy && pick(c.proxy, F.proxy), verification: c.verification && pick(c.verification, F.verification), derived: await isDerived() }, F.contractDetail)), "composite");
  }

  async function contractSource(a: string): Promise<Answer> {
    addressOf(a);
    const { held, source } = await accounts.source(a);
    if (!held) return fail(404, NO_CONTRACT);
    const empty = { address: a, verified: false, matchType: null, language: null, compilerVersion: null, codeFormat: null, contractPath: null, contractName: null, optimizerEnabled: null, optimizerRuns: null, evmVersion: null, license: null, settings: null, files: [], abi: null, constructorArgs: null, libraries: null, verifiedAt: null };
    const body = source ? { ...source, address: a, verified: true, files: source.files.map((f) => pick(f, F.sourceFile)) } : empty;
    return cached(ok(pick(body, F.source)), "composite");
  }

  async function tokenList(q: URLSearchParams): Promise<Answer> {
    const by = sort<TokenSort>(q, SORTS.tokens), limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "text"]);
    const rows = await accounts.tokens(by, before, limit);
    const key = (t: (typeof rows)[number]) => keyOf(by === "holders" ? t.holderCount : by === "transfers" ? t.transferCount : t.firstTransferBlock, t.address);
    return cached(ok(page(rows, limit, key, F.tokenItem, await isDerived())), "list");
  }

  async function oneToken(a: string): Promise<Answer> {
    addressOf(a);
    const t = await accounts.token(a);
    if (!t) return fail(404, NO_TOKEN);
    return cached(ok(pick({ ...t, derived: await isDerived() }, F.tokenDetail)), "composite");
  }

  async function tokenHolders(a: string, q: URLSearchParams): Promise<Answer> {
    addressOf(a);
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["text", "text", "text"]);
    if (!(await accounts.token(a))) return fail(404, NO_TOKEN);
    const rows = await accounts.holders(a, before, limit);
    return cached(ok(page(rows, limit, (h) => keyOf(h.value, h.holder, h.tokenId), F.holder, await isDerived())), "list");
  }

  async function tokenTransfers(a: string, q: URLSearchParams): Promise<Answer> {
    addressOf(a);
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "int", "int"]);
    if (!(await accounts.token(a))) return fail(404, NO_TOKEN);
    const rows = await accounts.tokenTransfers(a, before, limit);
    return cached(ok(page(rows, limit, (t) => keyOf(t.block, t.logIndex, t.batchIndex), F.tokenTransferItem, await isDerived())), "list");
  }

  // The legs are stage 1 facts: they are complete as soon as their block is final.
  async function legList(q: URLSearchParams): Promise<Answer> {
    const limit = limitOf(q.get("limit")), before = cursorOf(q.get("before"), ["int", "int"]);
    const p = pageOf(await accounts.legs(before, limit), limit, (l) => keyOf(l.block, l.legIndex));
    return cached(ok(pick({ items: p.items.map((l) => pick(l, F.legItem)), next: p.next }, F.page)), "list");
  }

  async function oneLeg(id: string): Promise<Answer> {
    if (!LEG_ID.test(id)) throw new BadRequest("A leg is named by its id, 0x and 64 hex digits.");
    const l = await accounts.leg(id);
    return l ? cached(ok(pick(l, F.legItem)), "composite") : fail(404, NO_LEG);
  }

  /** What was typed, as a place to open. A block, a hash, an address or a Canton update id go the way they always did; the start of a token's or a verified contract's name lists its matches. */
  async function find(q: string): Promise<Answer> {
    const text = q.trim().toLowerCase();
    const found = await search(text);
    if (found.status === 200) return cached(ok(pick({ path: (found.body as { path: string }).path, matches: [] }, F.search)), "list");
    if (!NAME.test(text)) return found;
    const matches = await accounts.byName(text, 10);
    if (matches.length === 0) return found;
    const items = matches.map((m) => pick({ ...m, path: m.kind === "token" ? `/token/${m.address}` : `/address/${m.address}` }, F.searchMatch));
    return cached(ok(pick({ path: items[0]!.path, matches: items }, F.search)), "list");
  }

  return (parts: string[], q: URLSearchParams): (() => Promise<Answer>) | undefined => {
    const [, name, a, b] = parts;
    const n = parts.length;
    if (name === "addresses") {
      if (n === 2) return () => addressList(q);
      if (n === 3) return () => oneAddress(a!);
      if (n === 4 && b === "txs") return () => addressTxs(a!, q);
      if (n === 4 && b === "internal") return () => addressInternal(a!, q);
      if (n === 4 && b === "token-transfers") return () => addressTransfers(a!, q);
      if (n === 4 && b === "tokens") return () => addressTokens(a!, q);
      if (n === 4 && b === "coin-history") return () => coinHistory(a!, q);
    }
    if (name === "contracts") {
      if (n === 2) return () => contractList(q);
      if (n === 3) return () => oneContract(a!);
      if (n === 4 && b === "source") return () => contractSource(a!);
    }
    if (name === "tokens") {
      if (n === 2) return () => tokenList(q);
      if (n === 3) return () => oneToken(a!);
      if (n === 4 && b === "holders") return () => tokenHolders(a!, q);
      if (n === 4 && b === "transfers") return () => tokenTransfers(a!, q);
    }
    if (name === "legs") {
      if (n === 2) return () => legList(q);
      if (n === 3) return () => oneLeg(a!);
    }
    if (name === "search" && n === 2) return () => find(q.get("q") ?? "");
    return undefined;
  };
}
