import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

export interface FakeRequest { method: string; path: string; query: URLSearchParams; body: Json | null }

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

export const checkpoint = (offset: number): Json => ({ update: { OffsetCheckpoint: { value: { offset, synchronizerTimes: [] } } } });

const offsetOf = (item: Json): number => {
  const [body] = Object.values((item.update ?? {}) as Json);
  return ((body as Json).value as Json).offset as number;
};

/**
 * A small stand-in for the JSON Ledger API: the ledger end and the updates after an offset. Like the real endpoint it needs an
 * upper bound (`endInclusive`) to finish, and it honours `limit` (and a lower `cap`, as Canton's own list maximum). The fake answers any other path with 404, as a missing endpoint.
 */
export async function startFakeLedger(items: Json[], opts: { httpStatus?: number; ledgerEnd?: number; cap?: number } = {}): Promise<FakeLedger> {
  const requests: FakeRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://fake");
      const body = raw ? (JSON.parse(raw) as Json) : null;
      requests.push({ method: req.method ?? "", path: u.pathname, query: u.searchParams, body });
      const send = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (opts.httpStatus) return send(opts.httpStatus, { code: "FAILED" });
      if (req.method === "GET" && u.pathname === "/v2/state/ledger-end") {
        return send(200, { offset: opts.ledgerEnd ?? items.reduce((m, i) => Math.max(m, offsetOf(i)), 0) });
      }
      if (req.method === "POST" && u.pathname === "/v2/updates") {
        const begin = body?.beginExclusive, end = body?.endInclusive;
        if (typeof begin !== "number" || typeof end !== "number" || !body?.updateFormat) return send(400, { code: "INVALID_ARGUMENT" });
        const limit = Math.min(Number(u.searchParams.get("limit") ?? Infinity), opts.cap ?? Infinity);
        return send(200, items.filter((i) => offsetOf(i) > begin && offsetOf(i) <= end).slice(0, limit));
      }
      send(404, { code: "NOT_FOUND" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((ok) => server.close(() => ok())) };
}
