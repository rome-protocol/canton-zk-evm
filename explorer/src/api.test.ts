import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../server/api.ts";
import { REST_FIELDS } from "../server/rest/fields.ts";
import {
  ApiError, addressTransfersCsvPath, blocksCsvPath, getAddressContracts, getAddressTransfers, getAllTokenTransfers, getBlocks, getInFlight, getStatsSeries, getStatsSummary, getStatus, getTokenList, getTokenListOldest, getTokenTransfers,
  getTxPage, getTxPageOldest, getTxs, search, tokenTransfersCsvPath, txsCsvPath,
} from "./api.ts";
import { account, block, blockItem, holding, inFlight, status, tokenAddress, tokenItem, tokenTransfer, tx, txItem } from "./test-utils.tsx";

afterEach(() => vi.unstubAllGlobals());

const answer = (code: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: code })));

describe("the API client", () => {
  it("holds the status fixture to the fields the server serves, so the pages are tested on what they will get", () => {
    expect(Object.keys(status()).sort()).toEqual([...FIELDS.status].sort());
    expect(Object.keys(status().latest[0]!).sort()).toEqual([...FIELDS.latest].sort());
    expect(Object.keys(status().final!).sort()).toEqual([...FIELDS.final].sort());
    expect(Object.keys(status().proving!).sort()).toEqual([...FIELDS.proving].sort());
  });

  it("holds the block, transaction and address fixtures to the fields the server serves too", () => {
    const keys = (o: object) => Object.keys(o).sort();
    const same = (o: object, fields: readonly string[]) => expect(keys(o)).toEqual([...fields].sort());
    const b = block();
    same(b, FIELDS.block);
    same(b.canton!, FIELDS.canton);
    same(b.canton!.proof!, FIELDS.proof);
    for (const f of Object.values(b.canton!.proof!)) same(f, FIELDS.fact);
    same(b.transactions[0]!, FIELDS.blockTx);
    same(b.transactions[0]!.transfer!, FIELDS.transfer);
    const t = tx();
    same(t, FIELDS.tx);
    same(t.block!, FIELDS.txBlock);
    same(t.logs[0]!, FIELDS.log);
    same(t.transfer!, FIELDS.transfer);
    same(account(), FIELDS.address);
    same(tokenAddress().token!, FIELDS.token);
    same(tokenAddress().createdBy!, FIELDS.createdBy);
  });

  it("reads the status, asking for the one path and nothing else", async () => {
    answer(200, status());
    expect(await getStatus()).toEqual(status());
    expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toEqual(["/api/status"]);
  });

  it("reads a 503 status as a status: the page shows that state", async () => {
    answer(503, status({ ok: false, problems: ["block 3: the hashes differ"] }));
    expect(await getStatus()).toMatchObject({ ok: false, problems: ["block 3: the hashes differ"] });
  });

  it("raises the server's plain message on a 502, and its own when the server cannot be reached or answers nonsense", async () => {
    answer(502, { error: "The explorer cannot read the chain right now." });
    await expect(getStatus()).rejects.toMatchObject({ status: 502, message: "The explorer cannot read the chain right now." });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("failed"); }));
    await expect(getStatus()).rejects.toBeInstanceOf(ApiError);
    answer(503, { surprise: true });
    await expect(getStatus()).rejects.toMatchObject({ message: "The explorer cannot read the chain right now." });
  });

  it("searches: the page to open, or the server's own message when nothing is found", async () => {
    answer(200, { path: "/block/3" });
    expect(await search("3")).toEqual({ found: true, path: "/block/3", matches: [] });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/search?q=3");
    answer(404, { error: "Not found. Search takes a block number." });
    expect(await search("0xabc&x=1")).toEqual({ found: false, message: "Not found. Search takes a block number." });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/search?q=0xabc%26x%3D1");
    answer(502, { error: "The explorer cannot read the chain right now." });
    await expect(search("3")).rejects.toMatchObject({ status: 502 });
  });

  it("holds the list and in-flight fixtures to the fields the server serves", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(blockItem(1))).toEqual([...REST_FIELDS.blockItem].sort());
    expect(keys(txItem(1))).toEqual([...REST_FIELDS.txItem].sort());
    expect(keys(tokenItem(1))).toEqual([...REST_FIELDS.tokenItem].sort());
    expect(keys(tokenTransfer(1))).toEqual([...REST_FIELDS.tokenTransferItem].sort());
    expect(keys(holding())).toEqual([...REST_FIELDS.holding].sort());
    const f = inFlight();
    expect(keys(f)).toEqual([...FIELDS.inFlight].sort());
    expect(keys(f.attempts[0]!)).toEqual([...FIELDS.inFlightAttempt].sort());
  });

  it("reads the newest blocks and transactions with the limit it was given, and the in-flight attempts", async () => {
    answer(200, { items: [blockItem(2)], next: null });
    expect((await getBlocks(10)).items[0]!.number).toBe(2);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/blocks?limit=10");
    answer(200, { items: [txItem(2)], next: "x" });
    expect((await getTxs(10)).next).toBe("x");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/txs?limit=10");
    answer(200, inFlight());
    expect((await getInFlight()).attempts).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/in-flight");
  });

  it("asks the stats routes for a window, a metric and, when given, a step", async () => {
    answer(200, { window: "7d" });
    expect((await getStatsSummary("7d")).window).toBe("7d");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/stats/summary?window=7d");
    answer(200, { metric: "tps", points: [] });
    await getStatsSeries("tps", "24h");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/stats/series?metric=tps&window=24h");
    await getStatsSeries("busy_ratio", "6h", "10m");
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe("/api/stats/series?metric=busy_ratio&window=6h&step=10m");
  });

  it("keeps the matches of a name search", async () => {
    const m = { kind: "token", name: "Test USD", symbol: "tUSD", address: "0x" + "ab".repeat(20), path: "/token/0x" + "ab".repeat(20) };
    answer(200, { path: m.path, matches: [m] });
    expect(await search("tusd")).toEqual({ found: true, path: m.path, matches: [m] });
  });

  it("builds the URLs of the token and last-page routes, and of the CSV files", async () => {
    const urls = () => vi.mocked(fetch).mock.calls.map((c) => c[0]);
    const A = "0x" + "a1".repeat(20), T = "0x" + "cb".repeat(20), K = "1:2:3";
    answer(200, { items: [], next: null });
    await getTxPage(null, 10);
    await getTxPage("5:1", 10, "failed");
    await getTxPageOldest(null, 10);
    await getTxPageOldest("5:1", 10, "calls");
    expect(urls()).toEqual(["/api/txs?limit=10", "/api/txs?limit=10&before=5%3A1&filter=failed", "/api/txs?order=asc&limit=10", "/api/txs?order=asc&limit=10&after=5%3A1&filter=calls"]);
    answer(200, { items: [], next: null });
    await getAllTokenTransfers(null, 10);
    await getAllTokenTransfers(K, 10, "ERC-721");
    expect(urls()).toEqual(["/api/token-transfers?limit=10", "/api/token-transfers?limit=10&before=1%3A2%3A3&standard=ERC-721"]);
    answer(200, { items: [], next: null });
    await getAddressTransfers(A, null, 10);
    await getAddressTransfers(A, K, 10, { token: T, standard: "ERC-20" });
    await getTokenTransfers(T, null, 10);
    await getAddressTransfers(A, null, 10, { standard: "nft" });
    // A value from a page's own URL is encoded, so that it cannot add parameters to the call.
    await getAddressTransfers(A, null, 10, { token: "x&standard=ERC-20" });
    expect(urls()).toEqual([`/api/addresses/${A}/token-transfers?limit=10`, `/api/addresses/${A}/token-transfers?limit=10&before=1%3A2%3A3&token=${T}&standard=ERC-20`, `/api/tokens/${T}/transfers?limit=10`,
      `/api/addresses/${A}/token-transfers?limit=10&standard=nft`, `/api/addresses/${A}/token-transfers?limit=10&token=x%26standard%3DERC-20`]);
    answer(200, { items: [], next: null });
    await getAddressContracts(A, null, 10);
    await getAddressContracts(A, K, 10);
    expect(urls()).toEqual([`/api/addresses/${A}/contracts?limit=10`, `/api/addresses/${A}/contracts?limit=10&before=1%3A2%3A3`]);
    answer(200, { items: [], next: null, total: 0, counts: {}, gatewayCount: 0 });
    await getTokenList("holders", null, 10);
    await getTokenList("newest", "7:0xab", 10, "ERC-1155");
    await getTokenList("transfers", null, 10, undefined, true);
    await getTokenListOldest("holders", null, 10);
    await getTokenListOldest("newest", "7:0xab", 10, "ERC-20", true);
    expect(urls()).toEqual([
      "/api/tokens?sort=holders&limit=10", "/api/tokens?sort=newest&limit=10&before=7%3A0xab&standard=ERC-1155", "/api/tokens?sort=transfers&limit=10&gateway=true",
      "/api/tokens?sort=holders&order=asc&limit=10", "/api/tokens?sort=newest&order=asc&limit=10&after=7%3A0xab&standard=ERC-20&gateway=true",
    ]);
    expect(txsCsvPath("failed")).toBe("/api/txs?format=csv&filter=failed");
    expect(blocksCsvPath("transactions")).toBe("/api/blocks?format=csv&filter=transactions");
    expect(addressTransfersCsvPath(A)).toBe(`/api/addresses/${A}/token-transfers?format=csv`);
    expect(addressTransfersCsvPath(A, { token: T, standard: "ERC-721" })).toBe(`/api/addresses/${A}/token-transfers?format=csv&token=${T}&standard=ERC-721`);
    expect(tokenTransfersCsvPath(T)).toBe(`/api/tokens/${T}/transfers?format=csv`);
  });
});
