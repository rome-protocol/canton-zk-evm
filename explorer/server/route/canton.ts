/**
 * The Canton side of a move to another chain: the requests that are still open. A request is a deposit the account's wallet made and the gateway has not claimed; its label, when it is a route's, says where the
 * coin is going, and its allocation says until when it can be taken (`settleBefore`). Read as the gateway party, which is an observer of both, at the ledger end the reader reports: one list of each, never cut short
 * (a list as long as the limit may have been cut, so it is refused). Nothing here writes.
 */
import { LedgerError, registeredFrom, ZK_CHAIN_TEMPLATE, GATEWAY_TOKEN_TEMPLATE, type Ledger } from "../ledger.ts";

export const DEPOSIT_REQUEST_TEMPLATE = "#canton-zk-evm:Zk.Chain:DepositRequest";
export const ALLOCATION_INTERFACE = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";
const REQUEST_SUFFIX = ":Zk.Chain:DepositRequest";
const ALLOCATION_SUFFIX = ":Splice.Api.Token.AllocationV1:Allocation";

export interface OpenRequest {
  depositId: string;
  /** The Canton account that made it. */
  party: string;
  label: string;
  /** The allocation's amount in Canton's 10 decimals, as base units, when the move was requested and its `settleBefore` (both ISO). Null where the allocation is not in the gateway's view. */
  amount: bigint | null;
  requestedAt: string | null;
  settleBefore: string | null;
}
/** What Canton can pay out to a party now: the accounts that take withdrawals, whether the legs are paused, and for each asset what the quota leaves and when some of it comes back. */
export interface Payout {
  /** The parties with a standing `WithdrawalAcceptance`. */
  acceptances: Set<string>;
  /** `pausedUntil` is in the future. */
  paused: boolean;
  pausedUntil: string | null;
  /** By the token's address on Ostia (lower case). `left` is in Canton's 10 decimals as base units; null: there is no quota. `renewsAt`: when the earliest counted withdrawal drops out, null when none is counted. */
  assets: Map<string, { left: bigint | null; renewsAt: string | null }>;
}
export interface Canton {
  /** The open requests whose label is a route's (`r1:`). */
  requests(): Promise<OpenRequest[]>;
  /** The acceptances, the pause and the quota, read at one ledger end. */
  payout(): Promise<Payout>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const bad = (what: string): never => { throw new LedgerError(`Canton sent ${what} that is not valid`); };
const created = (item: unknown): Json => obj(obj(obj(obj(item).contractEntry).JsActiveContract).createdEvent);
const LABEL = /^r1:/;

/** The route requests and the allocations behind them, from the two lists of active contracts. A request with no allocation in the view is kept, with no amount and no end. */
export function requestsFrom(requestItems: unknown[], allocationItems: unknown[]): OpenRequest[] {
  const allocations = new Map<string, { amount: bigint; requestedAt: string; settleBefore: string }>();
  for (const item of allocationItems) {
    const e = created(item);
    const view = (Array.isArray(e.interfaceViews) ? e.interfaceViews : []).map(obj).find((v) => typeof v.interfaceId === "string" && v.interfaceId.endsWith(ALLOCATION_SUFFIX));
    const spec = obj(obj(obj(view?.viewValue).allocation));
    const leg = obj(spec.transferLeg), settlement = obj(spec.settlement);
    const m = typeof leg.amount === "string" ? /^(\d+)(?:\.(\d{1,10}))?$/.exec(leg.amount) : null;
    const time = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
    if (typeof e.contractId !== "string" || !m || !time(settlement.settleBefore) || !time(settlement.requestedAt)) continue;
    allocations.set(e.contractId, { amount: BigInt(m[1]!) * 10n ** 10n + BigInt((m[2] ?? "").padEnd(10, "0")), requestedAt: settlement.requestedAt, settleBefore: settlement.settleBefore });
  }
  const out: OpenRequest[] = [];
  for (const item of requestItems) {
    const e = created(item);
    if (typeof e.templateId !== "string" || !e.templateId.endsWith(REQUEST_SUFFIX)) continue;
    const a = obj(e.createArgument);
    if (typeof a.depositId !== "string" || typeof a.depositor !== "string" || a.depositor === "" || typeof a.allocation !== "string") bad("a deposit request");
    if (typeof a.label !== "string" || !LABEL.test(a.label)) continue;
    const found = allocations.get(a.allocation as string);
    out.push({ depositId: a.depositId as string, party: a.depositor as string, label: a.label, amount: found?.amount ?? null, requestedAt: found?.requestedAt ?? null, settleBefore: found?.settleBefore ?? null });
  }
  return out;
}

const ACCEPTANCE_TEMPLATE = "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance";
const ACCEPTANCE_SUFFIX = ":Zk.Chain:WithdrawalAcceptance";
const CHAIN_SUFFIX = ":Zk.Chain:ZkChain";
const decimal = (v: unknown): bigint | null => {
  const m = typeof v === "string" ? /^(\d+)(?:\.(\d{1,10}))?$/.exec(v) : null;
  return m ? BigInt(m[1]!) * 10n ** 10n + BigInt((m[2] ?? "").padEnd(10, "0")) : null;
};
const instant = (v: unknown): number | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The payout facts of one chain from the three lists of active contracts, as `takeAgainstQuota` counts them: the quota is per Canton instrument, and the withdrawals still counted are the chain record's
 * `withdrawn` tallies that end after `nowMs`. A tally of an instrument no listed token stands for is not read. A chain record that is missing, or twice there, or a quota that does not read, fails the whole read:
 * a payout limit that might be wrong is worse than none.
 */
export function payoutFrom(acceptanceItems: unknown[], chainItems: unknown[], assetItems: unknown[], chainId: number, nowMs: number): Payout {
  const acceptances = new Set<string>();
  for (const item of acceptanceItems) {
    const e = created(item);
    if (typeof e.templateId !== "string" || !e.templateId.endsWith(ACCEPTANCE_SUFFIX)) continue;
    const a = obj(e.createArgument);
    if (Number(a.chainId) === chainId && typeof a.party === "string" && a.party !== "") acceptances.add(a.party);
  }
  const chains = chainItems.map(created).filter((e) => typeof e.templateId === "string" && e.templateId.endsWith(CHAIN_SUFFIX)).map((e) => obj(e.createArgument)).filter((a) => Number(a.chainId) === chainId);
  if (chains.length !== 1) bad(chains.length === 0 ? "no chain record" : "two chain records");
  const chain = chains[0]!;
  const until = chain.pausedUntil === null || chain.pausedUntil === undefined ? null : instant(chain.pausedUntil);
  if (chain.pausedUntil !== null && chain.pausedUntil !== undefined && until === null) bad("a pause that is not a time");
  const quota = chain.withdrawalQuota === null || chain.withdrawalQuota === undefined ? null : decimal(chain.withdrawalQuota);
  if (chain.withdrawalQuota !== null && chain.withdrawalQuota !== undefined && quota === null) bad("a quota that is not a decimal");
  const counted = chain.withdrawn === null || chain.withdrawn === undefined ? [] : Array.isArray(chain.withdrawn) ? chain.withdrawn.map(obj) : bad("withdrawals that are not a list");
  const assets = new Map<string, { left: bigint | null; renewsAt: string | null }>();
  for (const t of registeredFrom(assetItems)) {
    const key = `${t.instrumentAdmin}/${t.instrumentId}`;
    const live = counted.filter((x) => x.tallyToken === key && (instant(x.countedUntil) ?? bad("a withdrawal's end that is not a time")) > nowMs);
    const used = live.reduce((sum, x) => sum + (decimal(x.tallyAmount) ?? bad("a withdrawal that is not a decimal")), 0n);
    const renews = live.length === 0 ? null : Math.min(...live.map((x) => instant(x.countedUntil)!));
    assets.set(t.evmToken, { left: quota === null ? null : quota > used ? quota - used : 0n, renewsAt: renews === null ? null : iso(renews) });
  }
  return { acceptances, paused: until !== null && until > nowMs, pausedUntil: until !== null && until > nowMs ? iso(until) : null, assets };
}

export function createCanton({ reader, gateway, chainId = 0, limit = 500, now = Date.now }: { reader: Pick<Ledger, "ledgerEnd">; gateway: Pick<Ledger, "call"> & { party: string }; chainId?: number; limit?: number; now?: () => number }): Canton {
  const lists = (offset: number) => async (what: string, identifierFilter: unknown): Promise<unknown[]> => {
    const items = await gateway.call("POST", `/v2/state/active-contracts?limit=${limit}`, {
      eventFormat: { filtersByParty: { [gateway.party]: { cumulative: [{ identifierFilter }] } }, verbose: false }, activeAtOffset: offset,
    });
    if (!Array.isArray(items)) return bad("an answer that is not a list");
    if (items.length >= limit) throw new LedgerError(`the ${what} cannot be read: Canton sent ${items.length} contracts, the limit asked, so the list may be cut short`);
    return items;
  };
  const template = (templateId: string) => ({ TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } });
  return {
    async payout() {
      const read = lists(await reader.ledgerEnd());
      const [acceptances, chains, listed] = await Promise.all([read("withdrawal acceptances", template(ACCEPTANCE_TEMPLATE)), read("chain records", template(ZK_CHAIN_TEMPLATE)), read("registered tokens", template(GATEWAY_TOKEN_TEMPLATE))]);
      return payoutFrom(acceptances, chains, listed, chainId, now());
    },
    async requests() {
      const read = lists(await reader.ledgerEnd());
      const [requests, allocations] = await Promise.all([
        read("open deposit requests", { TemplateFilter: { value: { templateId: DEPOSIT_REQUEST_TEMPLATE, includeCreatedEventBlob: false } } }),
        read("allocations", { InterfaceFilter: { value: { interfaceId: ALLOCATION_INTERFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } }),
      ]);
      return requestsFrom(requests, allocations);
    },
  };
}
