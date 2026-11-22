import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi, type Answer } from "../api.ts";
import { createApiHealth } from "../api-health.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { PINS } from "../../test/synthetic-chain.ts";
import { DOCS } from "../rest/openapi.ts";
import { REST_FIELDS as F } from "../rest/fields.ts";
import { specOf } from "../health.ts";
import { AGGLAYER_PATHS, createAgglayerBridge } from "./bridge.ts";
import { createAggkitReader, type AggkitReader } from "./aggkit.ts";
import type { SepoliaReader } from "./sepolia.ts";

const OSTIA = "0x53a0ce7242b616fe706b03b464e5c32ed16e0998", SEPOLIA = "0x528e26b25a34a4a5d0dbda1d57d318153d2ed582";
const env = { READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" };
const settingsText = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const on = { ...env, AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/hidden-part-1234", AGGLAYER_OSTIA_BRIDGE: OSTIA, AGGLAYER_SEPOLIA_BRIDGE: SEPOLIA };
const unreachable = new Proxy({}, { get: (_t, name) => () => { throw new Error(`the database was read (${String(name)})`); } }) as unknown as Pool;

const aggkit = { bridge: async () => undefined, l1InfoTreeIndex: async () => undefined, injectedLeaf: async () => undefined, claimProof: async () => undefined, settlements: async () => [], syncStatus: async () => null, healthy: async () => true } as unknown as AggkitReader;
const sepolia = { isClaimed: async () => false, attached: async () => true } as unknown as SepoliaReader;
const reth = { block: async () => ({ number: 5 }), callAt: async () => "0x" + "0".repeat(64) };

function make(withBridge: boolean) {
  const config = loadConfig(withBridge ? on : env, () => settingsText);
  const bridge = withBridge ? createAgglayerBridge({ settings: config.agglayer!, chainId: config.chainId, chainName: config.chainName, aggkit, sepolia, reth: reth as never }) : undefined;
  return createApi({ config, reth: reth as never, ledger: {} as never, chain: createChainDb(unreachable), ...(bridge ? { agglayer: bridge } : {}) });
}
const body = (a: Answer) => a.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("the AggLayer routes in the API", () => {
  it("are registered and described in the API description while the switch is on", async () => {
    const api = make(true);
    for (const p of AGGLAYER_PATHS) { expect(api.routes).toContain(p); expect(DOCS[p]).toBeDefined(); }
    const doc = body(await api("GET", "/api/openapi.json"));
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining([...AGGLAYER_PATHS]));
    const props = doc.paths["/api/agglayer/claim"].get.responses["200"].content["application/json"].schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([...F.agglayerClaim].sort());
    expect(doc.paths["/api/agglayer/deposit"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["network", "count"]);
  });

  it("are not in the route list or the API description while the switch is off, and still answer", async () => {
    const api = make(false);
    for (const p of AGGLAYER_PATHS) expect(api.routes).not.toContain(p);
    const doc = body(await api("GET", "/api/openapi.json"));
    expect(Object.keys(doc.paths).filter((p) => p.includes("agglayer"))).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/agglayer/i);
    expect(await api("GET", "/api/agglayer/setup")).toMatchObject({ status: 200, body: { on: false } });
  });

  it("answer {on: false} for the setup and 404 for the others while the switch is off (the default)", async () => {
    const api = make(false);
    expect(loadConfig(env, () => settingsText).agglayer).toBeNull();
    expect(await api("GET", "/api/agglayer/setup")).toMatchObject({ status: 200, body: { on: false } });
    expect(await api("GET", "/api/agglayer/deposit?network=0&count=1")).toMatchObject({ status: 404, body: { error: "The AggLayer bridge is off on this explorer." } });
    expect(await api("GET", "/api/agglayer/claim?network=0&count=1")).toMatchObject({ status: 404 });
    expect((await api("GET", "/api/agglayer/other")).status).toBe(404);
  });

  it("answer from the bridge while it is on, GET only, and carry nothing that is private", async () => {
    const api = make(true);
    const a = await api("GET", "/api/agglayer/setup", undefined, "1.1.1.1");
    expect(a.status).toBe(200);
    expect(body(a)).toMatchObject({ on: true, chain: { networkId: 75 } });
    expect(JSON.stringify(a.body)).not.toMatch(/hidden-part-1234|sepolia\.example|127\.0\.0\.1/);
    expect((await api("POST", "/api/agglayer/setup")).status).toBe(405);
    expect(body(await api("GET", "/api/agglayer/deposit?network=0&count=1", undefined, "1.1.1.1"))).toMatchObject({ stage: "unknown", leaf: null });
    expect((await api("GET", "/api/agglayer/deposit?network=7&count=1", undefined, "1.1.1.1")).status).toBe(400);
  });
});

describe("a bridge service answer that breaks mid-body", () => {
  it("is a 503 in words on the deposit and claim routes, never a 500", async () => {
    const broken = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); c.error(new TypeError("terminated")); } }), { status: 200 })) as unknown as typeof fetch;
    const config = loadConfig(on, () => settingsText);
    const bridge = createAgglayerBridge({ settings: config.agglayer!, chainId: config.chainId, chainName: config.chainName, aggkit: createAggkitReader({ baseUrl: "http://127.0.0.1:5578", fetch: broken }), sepolia, reth: reth as never });
    const api = createApi({ config, reth: reth as never, ledger: {} as never, chain: createChainDb(unreachable), agglayer: bridge });
    for (const p of ["deposit", "claim"]) expect(await api("GET", `/api/agglayer/${p}?network=0&count=1`, undefined, "1.1.1.1")).toMatchObject({ status: 503, body: { error: "The bridge cannot be read right now." } });
  });
});

describe("the AggLayer health row", () => {
  it("has a spec: an API row, degraded at worst, so it never takes the explorer out of service", () => {
    expect(specOf("agglayer")).toMatchObject({ role: "api", worst: "degraded", intervalSeconds: 5 });
  });

  function health(agglayer?: { healthRow: () => Promise<{ id: string; status: "ok" | "degraded" | "down"; detail?: string | null }> }) {
    const queries: { sql: string; values?: unknown[] }[] = [];
    const pool = { query: async (sql: string, values?: unknown[]) => { queries.push({ sql, values }); return { rows: [] }; } } as unknown as Pool;
    const h = createApiHealth({ pool, instance: "a", reth: { block: async () => ({ number: 1 }) as never }, ledger: { ledgerEnd: async () => 1 }, ...(agglayer ? { agglayer } : {}) });
    return { queries, h };
  }

  it("is written beside the instance's own rows when the bridge is on", async () => {
    const { queries, h } = health({ healthRow: async () => ({ id: "agglayer", status: "degraded", detail: "x" }) });
    await h.refresh();
    const upsert = queries.find((q) => q.sql.includes("insert into health_checks"))!;
    expect(upsert.values![0]).toEqual(["api/a/reth", "api/a/canton", "agglayer"]);
    expect(upsert.values![1]).toEqual(["ok", "ok", "degraded"]);
    expect(queries.some((q) => q.sql.includes("check_id = 'agglayer'"))).toBe(false);
  });

  it("is removed when the bridge is off, so a row from an earlier run does not go stale for ever", async () => {
    const { queries, h } = health();
    await h.refresh();
    expect(queries.some((q) => q.sql.includes("delete from health_checks where check_id = 'agglayer'"))).toBe(true);
    expect(queries.find((q) => q.sql.includes("insert into health_checks"))!.values![0]).toEqual(["api/a/reth", "api/a/canton"]);
  });

  it("is a degraded row, not a failure of the instance, when its own read does not come back", async () => {
    const { queries, h } = health({ healthRow: async () => { throw new Error("boom http://127.0.0.1:5578"); } });
    await h.refresh();
    const upsert = queries.find((q) => q.sql.includes("insert into health_checks"))!;
    expect(upsert.values![1]).toEqual(["ok", "ok", "degraded"]);
  });
});
