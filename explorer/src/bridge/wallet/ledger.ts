// What the Bridge reads for a connected wallet's account, in the shapes the account service gives for a Bridge account (canton/accounts.ts): the holdings, the allocations, the open requests and the two
// acceptances come from the wallet's own view of the ledger (its active contracts, for its party), and the token registries' answers come from the account service's public registry route, which needs
// no signature and keeps no account. Nothing here signs.
import { AccountsError, retryAfterSeconds, type AllocationView, type ChoiceContext, type FactoryAnswer, type Holding, type OpenRequest, type OpenState, type TransferFactoryAnswer } from "../canton/accounts.ts";
import type { Chain } from "../canton/commands.ts";
import { Refused } from "../moves/moves.ts";
import { timeoutSignal } from "../../timeout.ts";
import { refusalOf, WALLET_WORDS, type LedgerRequest, type WalletLink } from "./link.ts";

const HOLDING = "Splice.Api.Token.HoldingV1:Holding";
const ALLOCATION = "Splice.Api.Token.AllocationV1:Allocation";
const interfaceId = (name: string, pkg: string) => `#${pkg}:${name}`;
const HOLDING_ID = interfaceId(HOLDING, "splice-api-token-holding-v1");
const ALLOCATION_ID = interfaceId(ALLOCATION, "splice-api-token-allocation-v1");
const PAGE = 200;     // contracts in one page of a read
const PAGES = 20;     // pages a read follows before it gives up

/** The templates of the open requests and the two acceptances, and the field that names their owner. */
const TEMPLATES = {
  deposit: { id: "#canton-zk-evm:Zk.Chain:DepositRequest", owner: "depositor" },
  redeem: { id: "#canton-zk-evm:Zk.Chain:RedeemRequest", owner: "holder" },
  twin: { id: "#ostia-twin:Twin.Twin:TwinAcceptance", owner: "party" },
  withdrawal: { id: "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance", owner: "party" },
} as const;
/** The part of a template id that does not name its package: "Zk.Chain:DepositRequest". The ledger names a template by package id or by package name; the module and the entity are the same. */
const entityOf = (templateId: unknown): string => String(templateId).split(":").slice(-2).join(":");

interface Created { contractId?: string; templateId?: string; packageName?: string; createArgument?: Record<string, unknown>; interfaceViews?: { viewValue?: any }[] }

/** A refusal or a failure of the wallet's ledger call, as the library's own error kinds: a wait looks again after a rate or an outage, and the move says the rest in words. */
export function ledgerError(e: unknown): unknown {
  if (e instanceof AccountsError || e instanceof Refused) return e;
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (code === -32005) return new AccountsError("rate-limited", 429, "Too many requests just now. Wait a minute and try again.");
  if (code === -32002 || code === 4900 || code === 4901) return new AccountsError("unavailable", 503, "Your Canton wallet could not be reached. Try again in a moment.");
  if (code === 4200 || code === -32601 || code === -32004 || code === -32602) return new Refused(WALLET_WORDS.cannotRead);
  return refusalOf(e) ?? e;
}

/** The ledger as the wallet shows it to this page. */
export class WalletLedger {
  private readonly link: Pick<WalletLink, "party" | "ledgerApi">;
  private readonly chain: Chain;
  constructor(link: Pick<WalletLink, "party" | "ledgerApi">, chain: Chain) { [this.link, this.chain] = [link, chain]; }

  private only(party: string): string {
    if (party !== this.link.party) throw new Refused("This is not the account of the connected wallet.");
    return party;
  }

  /** The created events of the party's active contracts that match the filter, all pages of one snapshot. */
  private async active(party: string, filters: object[], what: string): Promise<Created[]> {
    let request: Record<string, unknown> = { eventFormat: { filtersByParty: { [party]: { cumulative: filters.map((identifierFilter) => ({ identifierFilter })) } }, verbose: false }, maxPageSize: PAGE };
    const out: Created[] = [];
    for (let i = 0; i < PAGES; i++) {
      let page: { activeContracts?: { contractEntry?: { JsActiveContract?: { createdEvent?: Created } } }[]; nextPageToken?: string; activeAtOffset?: unknown };
      try { page = (await this.link.ledgerApi({ requestMethod: "post", resource: "/v2/state/active-contracts-page", body: request } satisfies LedgerRequest)) as typeof page; } catch (e) { throw ledgerError(e); }
      for (const entry of page?.activeContracts ?? []) { const created = entry?.contractEntry?.JsActiveContract?.createdEvent; if (created) out.push(created); }
      if (!page?.nextPageToken) return out;
      request = { ...request, activeAtOffset: page.activeAtOffset, pageToken: page.nextPageToken };
    }
    throw new Refused(`Your account has more ${what} than this page lists.`);
  }

  private views(party: string, interfaceIdText: string, what: string) {
    return this.active(party, [{ InterfaceFilter: { value: { interfaceId: interfaceIdText, includeInterfaceView: true, includeCreatedEventBlob: false } } }], what)
      .then((found) => found.flatMap((e) => (e.interfaceViews ?? []).map((v) => ({ contractId: String(e.contractId), view: v.viewValue }))));
  }

  /** The party's own holdings (the holding's view says its owner): a holding the party only sees is not its own. */
  async holdings(_key: unknown, party: string): Promise<Holding[]> {
    return (await this.views(this.only(party), HOLDING_ID, "holdings"))
      .filter(({ view }) => view && typeof view === "object" && view.owner === party)
      .map(({ contractId, view }) => ({ contractId, instrumentId: view.instrumentId, amount: view.amount, locked: Boolean(view.lock) }));
  }

  /** The party's own allocations (the party is the sender of the leg). */
  async allocations(_key: unknown, party: string): Promise<AllocationView[]> {
    return (await this.views(this.only(party), ALLOCATION_ID, "allocations"))
      .filter(({ view }) => view && typeof view === "object" && view.allocation?.transferLeg?.sender === party)
      .map(({ contractId, view }) => ({ contractId, allocation: view.allocation, holdingCids: view.holdingCids ?? [] }));
  }

  /** The party's open deposit and redeem requests and its two standing acceptances, from one read. A contract that names another chain's parties is not this chain's. */
  async openRequests(_key: unknown, party: string): Promise<OpenState> {
    this.only(party);
    const c = this.chain;
    const found = await this.active(party, Object.values(TEMPLATES).map((t) => ({ TemplateFilter: { value: { templateId: t.id, includeCreatedEventBlob: false } } })), "open requests");
    const ofChain = (a: Record<string, unknown>) => a.operator === c.operator && a.confirmer === c.confirmer && a.gateway === c.gateway && a.builder === c.builder && String(a.chainId) === String(c.chainId);
    const pick = (t: keyof typeof TEMPLATES): OpenRequest[] => {
      const want = TEMPLATES[t];
      return found
        .filter((e) => entityOf(e.templateId) === entityOf(want.id) && e.createArgument?.[want.owner] === party && (t === "twin" ? e.createArgument?.admin === c.gateway : ofChain(e.createArgument ?? {})))
        .map((e) => ({ contractId: String(e.contractId), arguments: e.createArgument ?? {} }));
    };
    return { depositRequests: pick("deposit"), redeemRequests: pick("redeem"), twinAcceptance: pick("twin")[0] ?? null, withdrawalAcceptance: pick("withdrawal")[0] ?? null };
  }
}

const KINDS: Record<number, AccountsError["kind"]> = { 400: "bad-request", 404: "not-found", 429: "rate-limited", 502: "unavailable", 503: "unavailable" };
const WORDS: Record<string, string> = {
  "bad-request": "The bridge could not read this request. Try again.",
  "not-found": "The bridge does not have this. Try again.",
  "rate-limited": "Too many requests just now. Wait a minute and try again.",
  unavailable: "The bridge is busy or restarting. Try again in a moment.",
  network: "The bridge could not be reached. Check your connection and try again.",
};

/** The shapes the relay accepts: a party id with no `/` or other path character, and a contract id (`00` and hex). */
const ADMIN = /^[^:\s/?#%\\]+::1220[0-9a-f]{64}$/;
const CONTRACT = /^00[0-9a-f]{20,252}$/;

/**
 * The token registries' answers for an account the account service does not know: the allocation factory, the transfer factory of a twin, and the context for taking an allocation back. The route is
 * `/accounts/v1/public-registry/<admin>/<what>`: the same paths as the signed relay, with no signature and no `party` (the request body is the registry's own request, sent on unchanged). It
 * answers 404 for an unknown registry, 400 for a body that is too long, and 429 when this client's rate is used up.
 */
export class PublicRegistry {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(base = "", fetcher: typeof fetch = (...a) => fetch(...a)) { [this.base, this.fetcher] = [base, fetcher]; }

  private async post(path: string, body: object): Promise<any> {
    let r: Response;
    try { r = await this.fetcher(this.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: timeoutSignal() }); }
    catch { throw new AccountsError("network", 0, WORDS.network!); }
    const answer = await r.json().catch(() => ({}));
    if (r.ok) return answer;
    const kind = KINDS[r.status] ?? (r.status >= 500 ? "unavailable" : "server");
    throw new AccountsError(kind, r.status, WORDS[kind] ?? "Something went wrong. Nothing was lost. Try again in a moment.", retryAfterSeconds(r.headers.get("Retry-After")), undefined, undefined, typeof answer?.registryStatus === "number" ? answer.registryStatus : undefined);
  }

  /** The path of one registry call. The registry's party and a contract id come from outside (the wallet's own answers), so each is checked against the shape the relay accepts before it goes into a path. */
  private path(admin: string, what: string, contract?: string): string {
    if (!ADMIN.test(admin) || (contract !== undefined && !CONTRACT.test(contract))) throw new AccountsError("bad-request", 400, WORDS["bad-request"]!);
    return `/accounts/v1/public-registry/${admin}/${what.replace("<cid>", contract ?? "")}`;
  }

  async allocationFactory(admin: string, choiceArguments: object): Promise<FactoryAnswer> {
    return this.post(this.path(admin, "allocation-factory"), { choiceArguments, excludeDebugFields: true });
  }
  async transferFactory(admin: string, choiceArguments: object): Promise<TransferFactoryAnswer> {
    return this.post(this.path(admin, "transfer-factory"), { choiceArguments, excludeDebugFields: true });
  }
  async allocationWithdrawContext(admin: string, allocation: string): Promise<ChoiceContext> {
    return this.post(this.path(admin, "allocation/<cid>/withdraw-context", allocation), { meta: {}, excludeDebugFields: true });
  }
}

/** The reads of the move library for a connected wallet, with the signature of `AccountsClient`'s (the first argument, an account's key, is not used: the wallet holds the key). */
export class WalletClient {
  private readonly ledger: WalletLedger;
  private readonly registry: PublicRegistry;
  constructor(ledger: WalletLedger, registry: PublicRegistry) { [this.ledger, this.registry] = [ledger, registry]; }
  holdings(key: unknown, party: string) { return this.ledger.holdings(key, party); }
  allocations(key: unknown, party: string) { return this.ledger.allocations(key, party); }
  openRequests(key: unknown, party: string) { return this.ledger.openRequests(key, party); }
  allocationFactory(_key: unknown, admin: string, _party: string, choiceArguments: object) { return this.registry.allocationFactory(admin, choiceArguments); }
  transferFactory(_key: unknown, admin: string, _party: string, choiceArguments: object) { return this.registry.transferFactory(admin, choiceArguments); }
  allocationWithdrawContext(_key: unknown, admin: string, allocation: string, _party: string) { return this.registry.allocationWithdrawContext(admin, allocation); }
}
