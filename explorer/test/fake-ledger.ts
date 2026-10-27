import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Json = Record<string, unknown>;

export interface FakeRequest { method: string; path: string; query: URLSearchParams; body: Json | null; authorization: string | null }

export interface FakeLedger {
  url: string;
  /** Every request the fake received, in order. */
  requests: FakeRequest[];
  close(): Promise<void>;
}

export const FAKE_READER = "reader::1220" + "ab".repeat(32);
export const FAKE_OPERATOR = "operator::1220" + "cd".repeat(32);
export const FAKE_CONFIRMER = "confirmer::1220" + "ef".repeat(32);
export const RECORD_ID = "abc123def456:Zk.Chain:BlockRecord";
export const FAKE_PARTICIPANT = "PAR::participant::1220" + "aa".repeat(32);

/** The fields of a BlockRecord as the JSON Ledger API shows them (an Int64 is a string, a hash is hex without 0x). */
export function recordFields(over: Json = {}): Json {
  return {
    operator: FAKE_OPERATOR, confirmer: FAKE_CONFIRMER, builder: "builder::1220" + "11".repeat(32), reader: FAKE_READER, chainId: "770101",
    number: "3", blockHash: "35".repeat(32), parentHash: "0b".repeat(32), headerHex: "f9".repeat(40), txsHex: "02".repeat(20), proofHex: "ee".repeat(1344), ...over,
  };
}

export function createdEvent(offset: number, args: Json = recordFields(), templateId = RECORD_ID): Json {
  return {
    CreatedEvent: {
      offset, nodeId: 0, contractId: "00" + offset.toString(16).padStart(8, "0"), templateId, createdAt: "2026-10-04T01:37:15.412Z", packageName: "canton-zk-evm",
      representativePackageId: "abc123def456", acsDelta: true, createArgument: args, witnessParties: [FAKE_READER], signatories: [FAKE_OPERATOR, FAKE_CONFIRMER],
    },
  };
}

/** One Canton transaction, as an item of the /v2/updates answer. */
export function transaction(offset: number, updateId: string, events: Json[], recordTime = "2026-10-04T01:37:15.412Z"): Json {
  return { update: { Transaction: { value: { updateId, effectiveAt: recordTime, offset, synchronizerId: "sync::1220" + "99".repeat(32), recordTime, events } } } };
}

export const FAKE_GATEWAY = "gateway::1220" + "a1".repeat(32);
export const FAKE_REGISTRY = "registry::1220" + "b2".repeat(32);
export const GATEWAY_TOKEN_ID = "abc123def456:Zk.Chain:GatewayToken";
export const HOLDING_INTERFACE_ID = "f00dbabe0001:Splice.Api.Token.HoldingV1:Holding";

/** A GatewayToken as an active contract (the template's create argument, as the JSON Ledger API shows it). */
export function gatewayToken(evmToken: string, admin = FAKE_REGISTRY, id = "TKB", over: Json = {}): ActiveContract {
  return {
    contractId: "00" + evmToken.slice(-8), templateId: GATEWAY_TOKEN_ID,
    createArgument: { operator: FAKE_OPERATOR, confirmer: FAKE_CONFIRMER, gateway: FAKE_GATEWAY, builder: "builder::1220" + "11".repeat(32), chainId: "770101", evmToken, instrumentId: { admin, id }, factory: "00ff", ...over },
  };
}

/** A token standard Holding as an active contract: it has an interface view and no template the gateway asked for. */
export function holding(n: number, owner: string, amount: string, admin = FAKE_REGISTRY, id = "TKB", lock: unknown = null, view: Json | null | "unreadable" = null, signatories: string[] = [admin, owner]): ActiveContract {
  const value = view ?? { owner, instrumentId: { admin, id }, amount, lock, meta: { values: {} } };
  return {
    contractId: "00" + n.toString(16).padStart(8, "0"), templateId: "999999:Some.Token:Holding", signatories,
    interfaceViews: [view === "unreadable" ? { interfaceId: HOLDING_INTERFACE_ID, viewStatus: { code: 3, message: "no view" } } : { interfaceId: HOLDING_INTERFACE_ID, viewStatus: { code: 0, message: "" }, viewValue: value }],
  };
}

export const FAKE_VENUE = "venue::1220" + "c3".repeat(32);
export const FAKE_SELLER = "seller::1220" + "d4".repeat(32);

/** A created event of a Daml 0.4.0 contract the gateway party sees, as the JSON Ledger API shows it in an update. */
const gatewayEvent = (offset: number, entity: string, contractId: string, args: Json, signatories: string[]): Json => ({
  CreatedEvent: {
    offset, nodeId: 0, contractId, templateId: `abc123def456:Zk.Chain:${entity}`, createdAt: "2026-10-04T01:37:15.412Z", packageName: "canton-zk-evm", representativePackageId: "abc123def456",
    acsDelta: true, createArgument: args, witnessParties: [FAKE_GATEWAY], signatories,
  },
});
const base = { operator: FAKE_OPERATOR, confirmer: FAKE_CONFIRMER, gateway: FAKE_GATEWAY, builder: "builder::1220" + "11".repeat(32), chainId: "770101" };

/** A GatewayToken as an update creates it. */
export const gatewayTokenEvent = (offset: number, contractId: string, evmToken: string, admin = FAKE_REGISTRY, id = "TKB"): Json =>
  gatewayEvent(offset, "GatewayToken", contractId, { ...base, evmToken, instrumentId: { admin, id }, factory: "00ff" }, [FAKE_OPERATOR, FAKE_CONFIRMER, FAKE_GATEWAY]);

/** A VenueTrade, which names the venue and the seller as it does on Canton (the explorer must not keep either). `amount` is the ERC-20 amount as the contract writes it, 64 hex digits. */
export const venueTradeEvent = (offset: number, contractId: string, f: { payId: string; claimId: string; token: string; payee: string; recipient: string; amount: bigint; gatewayToken: string }, over: Json = {}): Json =>
  gatewayEvent(offset, "VenueTrade", contractId, {
    ...base, venue: FAKE_VENUE, sender: FAKE_SELLER, label: "order-1", payId: f.payId, token: f.token, payee: f.payee, amount: f.amount.toString(16).padStart(64, "0"), allocation: "00a110", allocationDisclosed: null,
    gatewayToken: f.gatewayToken, claimId: f.claimId, recipient: f.recipient, ...over,
  }, [FAKE_VENUE, FAKE_SELLER]);

/** A FundedClaim, with its amount as a Daml Decimal. */
export const fundedClaimEvent = (offset: number, contractId: string, f: { claimId: string; recipient: string; amount: string; gatewayToken: string }, over: Json = {}): Json =>
  gatewayEvent(offset, "FundedClaim", contractId, { ...base, claimId: f.claimId, recipient: f.recipient, gatewayToken: f.gatewayToken, amount: f.amount, ...over }, [FAKE_OPERATOR, FAKE_CONFIRMER, FAKE_GATEWAY]);

export interface ActiveContract { contractId: string; templateId: string; createArgument?: Json; interfaceViews?: Json[]; signatories?: string[] }

/** What the fake's active-contracts endpoint answers, as the JSON Ledger API shapes a JsActiveContract. */
function activeEntry(c: ActiveContract, withView: boolean): Json {
  return { contractEntry: { JsActiveContract: { createdEvent: {
    offset: 5, nodeId: 0, contractId: c.contractId, templateId: c.templateId, createdAt: "2026-10-04T01:37:15.412Z", packageName: "canton-zk-evm",
    // the document names createArgument as always present, so a contract picked by its interface alone carries an empty one
    createArgument: c.createArgument ?? {}, ...(withView && c.interfaceViews ? { interfaceViews: c.interfaceViews } : {}),
    witnessParties: [FAKE_GATEWAY], signatories: c.signatories ?? [FAKE_GATEWAY], acsDelta: true, representativePackageId: "abc123def456",
  }, synchronizerId: "sync::1220" + "99".repeat(32), reassignmentCounter: 0 } } };
}

export const checkpoint = (offset: number): Json => ({ update: { OffsetCheckpoint: { value: { offset, synchronizerTimes: [] } } } });

const offsetOf = (item: Json): number => {
  const [body] = Object.values((item.update ?? {}) as Json);
  return ((body as Json).value as Json).offset as number;
};

/**
 * A small stand-in for the JSON Ledger API: the ledger end and the updates after an offset. Like the real endpoint it needs an
 * upper bound (`endInclusive`) to finish, and it honours `limit` (and a lower `cap`, as Canton's own list maximum). The fake answers any other path with 404, as a missing endpoint.
 */
export async function startFakeLedger(items: Json[], opts: { httpStatus?: number; ledgerEnd?: number; cap?: number; active?: ActiveContract[] } = {}): Promise<FakeLedger> {
  const requests: FakeRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://fake");
      const body = raw ? (JSON.parse(raw) as Json) : null;
      requests.push({ method: req.method ?? "", path: u.pathname, query: u.searchParams, body, authorization: req.headers.authorization ?? null });
      const send = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (opts.httpStatus) return send(opts.httpStatus, { code: "FAILED" });
      if (req.method === "GET" && u.pathname === "/v2/state/ledger-end") {
        return send(200, { offset: opts.ledgerEnd ?? items.reduce((m, i) => Math.max(m, offsetOf(i)), 0) });
      }
      if (req.method === "GET" && u.pathname === "/v2/parties/participant-id") return send(200, { participantId: FAKE_PARTICIPANT });
      if (req.method === "POST" && u.pathname === "/v2/updates") {
        const begin = body?.beginExclusive, end = body?.endInclusive;
        if (typeof begin !== "number" || typeof end !== "number" || !body?.updateFormat) return send(400, { code: "INVALID_ARGUMENT" });
        const limit = Math.min(Number(u.searchParams.get("limit") ?? Infinity), opts.cap ?? Infinity);
        return send(200, items.filter((i) => offsetOf(i) > begin && offsetOf(i) <= end).slice(0, limit));
      }
      if (req.method === "POST" && u.pathname === "/v2/state/active-contracts") {
        // Like Canton's: a number to read at, the parties to read as, and filters that pick the contracts (a template by its entity, an interface by its views).
        const format = (body?.eventFormat ?? {}) as Json, byParty = (format.filtersByParty ?? {}) as Record<string, { cumulative?: { identifierFilter: Json }[] }>;
        if (typeof body?.activeAtOffset !== "number" || Object.keys(byParty).length === 0) return send(400, { code: "INVALID_ARGUMENT" });
        const filters = Object.values(byParty).flatMap((f) => (f.cumulative ?? []).map((x) => x.identifierFilter));
        const template = (f: Json) => (f.TemplateFilter as { value: { templateId: string } } | undefined)?.value.templateId.split(":").slice(-2).join(":");
        const iface = (f: Json) => (f.InterfaceFilter as { value: { interfaceId: string; includeInterfaceView: boolean } } | undefined)?.value;
        const found: Json[] = [];
        for (const c of opts.active ?? []) {
          const byTemplate = filters.some((f) => template(f) !== undefined && c.templateId.endsWith(":" + template(f)));
          const views = filters.map(iface).filter((v) => v !== undefined && (c.interfaceViews ?? []).some((i) => (i.interfaceId as string).endsWith(":" + v.interfaceId.split(":").slice(-2).join(":"))));
          if (byTemplate || views.length > 0) found.push(activeEntry(c, views.some((v) => v!.includeInterfaceView)));
        }
        // As for the updates: `limit` is honoured, and a lower `cap` is Canton's own list maximum, which cuts the list short without saying so.
        const limit = Math.min(Number(u.searchParams.get("limit") ?? Infinity), opts.cap ?? Infinity);
        return send(200, found.slice(0, limit));
      }
      send(404, { code: "NOT_FOUND" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((ok) => server.close(() => ok())) };
}
