import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../server/api.ts";
import { ApiError, getStatus, search } from "./api.ts";
import { account, block, status, tokenAddress, tx } from "./test-utils.tsx";

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
    expect(await search("3")).toEqual({ found: true, path: "/block/3" });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/search?q=3");
    answer(404, { error: "Not found. Search takes a block number." });
    expect(await search("0xabc&x=1")).toEqual({ found: false, message: "Not found. Search takes a block number." });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/search?q=0xabc%26x%3D1");
    answer(502, { error: "The explorer cannot read the chain right now." });
    await expect(search("3")).rejects.toMatchObject({ status: 502 });
  });
});
