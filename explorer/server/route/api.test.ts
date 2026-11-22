import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi, type Answer } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { PINS } from "../../test/synthetic-chain.ts";
import { DOCS } from "../rest/openapi.ts";
import { REST_FIELDS as F } from "../rest/fields.ts";
import { createCantonRoute, ROUTE_PATHS } from "./route.ts";

const env = { READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" };
const settingsText = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const agg = { AGGLAYER_BRIDGE: "1", AGGLAYER_SEPOLIA_RPC_URL: "https://sepolia.example.invalid/hidden-part-1234", AGGLAYER_OSTIA_BRIDGE: "0x" + "53".repeat(20), AGGLAYER_SEPOLIA_BRIDGE: "0x" + "52".repeat(20) };
const route = { OSTIA_ROUTE_OUT: "1", OSTIA_ROUTER: "0x" + "a1".repeat(20), OSTIA_BOOK: "0x" + "b2".repeat(20), OSTIA_ROUTE_NOT_TAKEN_SECONDS: "600", OSTIA_ROUTE_OWN_CLAIM_SECONDS: "300" };
const unreachable = new Proxy({}, { get: (_t, name) => () => { throw new Error(`the database was read (${String(name)})`); } }) as unknown as Pool;
const body = (a: Answer) => a.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function make(on: boolean) {
  const config = loadConfig(on ? { ...env, ...agg, ...route } : env, () => settingsText);
  const cantonRoute = on ? createCantonRoute({ settings: config.cantonRoute!, agglayer: config.agglayer!, bridge: { status: async () => ({ available: true }) as never }, reth: { block: async () => ({ number: 5 }) as never, callAt: async () => "0x" }, pool: { query: async () => ({ rows: [] }) }, canton: null }) : undefined;
  return createApi({ config, reth: {} as never, ledger: {} as never, chain: createChainDb(unreachable), ...(cantonRoute ? { cantonRoute } : {}) });
}

describe("the Canton route in the API", () => {
  it("is registered and described while the switch is on", async () => {
    const api = make(true);
    for (const p of ROUTE_PATHS) { expect(api.routes).toContain(p); expect(DOCS[p]).toBeDefined(); }
    const doc = body(await api("GET", "/api/openapi.json"));
    const props = doc.paths["/api/canton-route/moves"].get.responses["200"].content["application/json"].schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([...F.routeMoves].sort());
    expect(doc.paths["/api/canton-route/moves"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["party", "evm"]);
  });
  it("is neither listed nor described while the switch is off (the default), and still answers", async () => {
    const api = make(false);
    expect(loadConfig(env, () => settingsText).cantonRoute).toBeNull();
    for (const p of ROUTE_PATHS) expect(api.routes).not.toContain(p);
    expect(JSON.stringify(body(await api("GET", "/api/openapi.json")))).not.toMatch(/canton-route/);
    expect(await api("GET", "/api/canton-route/setup")).toMatchObject({ status: 200, body: { on: false } });
    expect(await api("GET", `/api/canton-route/moves?evm=0x${"e3".repeat(20)}`)).toMatchObject({ status: 404, body: { error: "The Canton route is off on this explorer." } });
  });
  it("answers GET only, and keeps the case of a party id in the query", async () => {
    const api = make(true);
    expect((await api("POST", "/api/canton-route/setup")).status).toBe(405);
    expect((await api("GET", "/api/canton-route/moves?party=Alice::1220AB", undefined, "2.2.2.2")).status).toBe(200);
  });
  it("is refused at start without the AggLayer bridge", () => {
    expect(() => loadConfig({ ...env, ...route }, () => settingsText)).toThrow("needs AGGLAYER_BRIDGE=1");
  });
});
