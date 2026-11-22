/**
 * The Canton side of a move to another chain: the requests that are still open. A request is a deposit the account's wallet made and the gateway has not claimed; its label, when it is a route's, says where the
 * coin is going, and its allocation says until when it can be taken (`settleBefore`). Read as the gateway party, which is an observer of both, at the ledger end the reader reports: one list of each, never cut short
 * (a list as long as the limit may have been cut, so it is refused). Nothing here writes.
 */
import { LedgerError, type Ledger } from "../ledger.ts";

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
export interface Canton {
  /** The open requests whose label is a route's (`r1:`). */
  requests(): Promise<OpenRequest[]>;
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

export function createCanton({ reader, gateway, limit = 500 }: { reader: Pick<Ledger, "ledgerEnd">; gateway: Pick<Ledger, "call"> & { party: string }; limit?: number }): Canton {
  return {
    async requests() {
      const offset = await reader.ledgerEnd();
      const read = async (what: string, identifierFilter: unknown): Promise<unknown[]> => {
        const items = await gateway.call("POST", `/v2/state/active-contracts?limit=${limit}`, {
          eventFormat: { filtersByParty: { [gateway.party]: { cumulative: [{ identifierFilter }] } }, verbose: false }, activeAtOffset: offset,
        });
        if (!Array.isArray(items)) return bad("an answer that is not a list");
        if (items.length >= limit) throw new LedgerError(`the ${what} cannot be read: Canton sent ${items.length} contracts, the limit asked, so the list may be cut short`);
        return items;
      };
      const [requests, allocations] = await Promise.all([
        read("open deposit requests", { TemplateFilter: { value: { templateId: DEPOSIT_REQUEST_TEMPLATE, includeCreatedEventBlob: false } } }),
        read("allocations", { InterfaceFilter: { value: { interfaceId: ALLOCATION_INTERFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } }),
      ]);
      return requestsFrom(requests, allocations);
    },
  };
}
