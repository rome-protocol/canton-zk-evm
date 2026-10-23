import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApi, type RoutedApi } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import type { Reth } from "../reth.ts";
import { PINS } from "../../test/synthetic-chain.ts";
import { createAccountRest } from "./account-rest.ts";
import { createChainRest } from "./chain-rest.ts";
import { createEtherscanRest } from "./etherscan-rest.ts";
import { MODULES } from "./etherscan.ts";
import { createStatsRest } from "./stats-rest.ts";
import { CACHE_CONTROL } from "./cache.ts";
import { REST_FIELDS as F, FIELDS } from "./fields.ts";
import { DOCS } from "./openapi.ts";

const settings = `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`;
const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => settings);
/** A database that is never reached: any query a route makes is an error, so a route that answers 400 has refused the request before it read anything. */
const unreachable = new Proxy({}, { get: (_t, name) => () => { throw new Error(`the database was read (${String(name)})`); } }) as unknown as Pool;
const reth = {} as unknown as Reth;
const withRpc = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt", PUBLIC_RPC: "1" }, () => settings);
const full = (cfg = config): RoutedApi => createApi({ config: cfg, reth, ledger: {} as never, chain: createChainDb(unreachable), rest: createChainRest(unreachable), accounts: createAccountRest(unreachable), etherscanRest: createEtherscanRest(unreachable), stats: createStatsRest(unreachable), live: true, verify: { submit: async () => ({ status: 202, body: { guid: "g" } }), status: async () => ({ status: 404, body: {} }) } });
const plain = (): RoutedApi => createApi({ config, reth, ledger: {} as never, chain: createChainDb(unreachable) });
const sample: Record<string, string> = {
  id: "1", hash: "0x" + "00".repeat(32), updateId: "1220" + "00".repeat(32), address: "0x" + "00".repeat(20), ticket: "t1", guid: "00000000-0000-4000-8000-000000000000",
};
const concrete = (path: string) => path.replace(/\{(\w+)\}/g, (_, n: string) => sample[n] ?? "1");
const body = async (api: RoutedApi, path: string) => (await api("GET", path)).body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("the API description", () => {
  it("describes every route the API registers, and only those", () => {
    const api = full();
    // The public RPC is a route only where it is on.
    expect([...api.routes].sort()).toEqual(Object.keys(DOCS).filter((p) => p !== "/rpc").sort());
    expect(new Set(api.routes).size).toBe(api.routes.length);
    expect([...full(withRpc).routes].sort()).toEqual(Object.keys(DOCS).sort());
    expect(api.routes).toContain("/healthz");
  });

  it("lists, without a database, only the routes that exist: no chain, account or stream routes", async () => {
    const api = plain();
    expect(api.routes).not.toContain("/api/blocks");
    expect(api.routes).not.toContain("/api/stream");
    expect(api.routes).not.toContain("/api");
    expect(api.routes).not.toContain("/v2/api");
    const doc = await body(api, "/api/openapi.json");
    expect(Object.keys(doc.paths).sort()).toEqual([...api.routes].sort());
    expect(Object.keys(doc.paths)).toContain("/api/status");
    for (const p of Object.keys(doc.paths)) expect(DOCS[p]).toBeDefined();
  });

  it("serves an OpenAPI 3.1 document with a path for each route, cached for a few seconds with a tag", async () => {
    const api = full();
    const a = await api("GET", "/api/openapi.json");
    expect(a.status).toBe(200);
    expect(a.headers?.["cache-control"]).toBe(CACHE_CONTROL.composite);
    expect(a.headers?.etag).toMatch(/^"[0-9a-f]{32}"$/);
    const doc = a.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toContain(config.chainName);
    expect(Object.keys(doc.paths).sort()).toEqual([...api.routes].sort());
    expect(Object.keys(doc.paths).every((p) => p.startsWith("/api/") || p === "/healthz" || p === "/api" || p === "/v2/api")).toBe(true);
    expect((await api("POST", "/api/openapi.json")).status).toBe(405);
  });

  it("names the fields of each answer as its allowlist does, and every path parameter", async () => {
    const doc = await body(full(), "/api/openapi.json");
    const props = (path: string) => doc.paths[path].get.responses["200"].content["application/json"].schema.properties as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(props("/api/blocks").items.items.properties).sort()).toEqual([...F.blockItem].sort());
    expect(Object.keys(props("/api/blocks")).sort()).toEqual([...F.page].sort());
    expect(Object.keys(props("/api/addresses")).sort()).toEqual([...F.derivedPage].sort());
    expect(Object.keys(props("/api/addresses").items.items.properties).sort()).toEqual([...F.addressItem].sort());
    expect(Object.keys(props("/api/tokens/{address}")).sort()).toEqual([...F.tokenDetail].sort());
    expect(Object.keys(props("/api/status")).sort()).toEqual([...FIELDS.status].sort());
    for (const [path, item] of Object.entries(doc.paths as Record<string, any>)) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!item.get) continue;
      const declared = (item.get.parameters as { name: string; in: string }[]).filter((p) => p.in === "path").map((p) => p.name);
      expect(declared, path).toEqual(named);
      expect(item.get.summary, path).toBeTruthy();
    }
    const rpc = (await body(full(withRpc), "/api/openapi.json")).paths["/rpc"];
    expect(Object.keys(rpc)).toEqual(["post"]);
    expect(Object.keys((await body(full(), "/api/openapi.json")).paths["/healthz"].get.responses["200"].content["application/json"].schema.properties).sort()).toEqual([...FIELDS.status].sort());
    expect(doc.paths["/api/stream"].get.responses["200"].content["text/event-stream"]).toBeDefined();
    expect(Object.keys(doc.paths["/api/faucet"]).sort()).toEqual(["get", "post"]);
    // Etherscan's door is described at both of its paths, for GET and POST, with the modules this part of it answers.
    for (const door of ["/api", "/v2/api"]) {
      expect(Object.keys(doc.paths[door]).sort()).toEqual(["get", "post"]);
      expect(doc.paths[door].get.tags).toEqual(["Etherscan"]);
      const names = doc.paths[door].get.parameters.map((q: { name: string }) => q.name);
      for (const n of ["module", "action", "address", "fromBlock", "topic0", "topic0_1_opr", "blockno", "txhash"]) expect(names).toContain(n);
    }
    // The API page reads the module table from `x-modules` of /api's GET; it is the table the door answers from.
    expect(doc.paths["/api"].get["x-modules"]).toEqual(Object.fromEntries(Object.entries(MODULES).map(([m, a]) => [m, Object.keys(a)])));
    expect(Object.keys(doc.paths["/api"].get["x-modules"])).toEqual(["account", "transaction", "block", "logs", "token", "stats", "proxy", "gastracker"]);
    expect(doc.paths["/api"].get["x-modules"]).toMatchObject({
      token: ["tokeninfo", "tokenholdercount", "tokenholderlist"], stats: ["ethsupply", "tokensupply", "ethprice"], gastracker: ["gasoracle", "gasestimate"],
      proxy: ["eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockTransactionCountByNumber", "eth_getTransactionByHash", "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_gasPrice", "eth_estimateGas", "eth_getUncleByBlockNumberAndIndex"],
    });
    expect(doc.paths["/v2/api"].get["x-modules"]).toBeUndefined();
    expect(doc.paths["/api"].get.parameters.find((q: { name: string }) => q.name === "action").description).toContain("getLogs");
  });

  it("documents only the query parameters its routes read: each is refused when it is wrong, before any read", async () => {
    const api = full();
    const wrong: Record<string, string> = { limit: "0", before: "!!", after: "!!", sort: "nonsense", verified: "nonsense", window: "nonsense", step: "nonsense", metric: "nonsense" };
    let checked = 0;
    for (const [path, d] of Object.entries(DOCS)) {
      if (path === "/api/stream" || path === "/api/search" || path === "/rpc" || path === "/api" || path === "/v2/api" /* answers 200 with its own NOTOK: etherscan.test.ts */ || !d.query) continue;
      for (const q of d.query) {
        if (!wrong[q.name]) continue;
        const a = await api("GET", `${concrete(path)}?${q.name}=${encodeURIComponent(wrong[q.name]!)}`);
        expect(a.status, `${path} ?${q.name}`).toBe(400);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("lists as paged exactly the routes whose pages say so", () => {
    for (const [path, d] of Object.entries(DOCS)) {
      const paging = (d.query ?? []).map((q) => q.name).filter((n) => n === "before" || n === "after");
      expect(paging.length, path).toBe(d.page ? 1 : 0);
    }
  });
  it("states the limits the server holds, from its own settings: the page size always, the public RPC's rate only where it is on", async () => {
    const off = (await body(full(), "/api/openapi.json")).info["x-limits"];
    const held = { rest: { perSecond: 20, burst: 60 }, etherscan: { perSecond: 10, perMinute: 600, maxPageBytes: 8_388_608 }, verification: { perHour: 30, maxBodyKb: 500 }, streams: { perClient: 4 } };
    expect(off).toEqual({ pageSize: 100, ...held });
    const on = (await body(full(withRpc), "/api/openapi.json")).info["x-limits"];
    expect(on).toEqual({ pageSize: 100, rpcPerMinute: withRpc.publicRpc.ratePerMinute, ...held });
    expect(withRpc.publicRpc.ratePerMinute).toBe(300);
  });
});
