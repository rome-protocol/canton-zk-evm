import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApi, type RoutedApi } from "../api.ts";
import { createChainDb } from "../chain-db.ts";
import { loadConfig } from "../config.ts";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "../db/testing.ts";
import type { Reth } from "../reth.ts";
import { PINS } from "../../test/synthetic-chain.ts";
import { createVerifyApi, PROXY_TEXTS } from "./api.ts";
import { JobQueue } from "./jobs.ts";
import { Verifier } from "./verify.ts";
import { addContract, fakeProbe, outputFor, StubCompile } from "./verify-fixtures.ts";
import { EIP1967_IMPLEMENTATION_SLOT } from "../indexer/proxies.ts";
import { VerifierWorker } from "./worker.ts";

checkRequired();
const suite = TEST_URL ? describe : describe.skip;

const meta = (tag: number): Buffer => {
  const body = Buffer.concat([Buffer.from("a264697066735822", "hex"), Buffer.alloc(34, tag), Buffer.from("64736f6c6343", "hex"), Buffer.from("00081c", "hex")]);
  return Buffer.concat([body, Buffer.from([0, body.length])]);
};
const runtime = Buffer.concat([Buffer.from("6080604052348015600e575f80fd5b50600436106030575f3560e01c8063".padEnd(120, "5b"), "hex"), meta(1)]);
const creation = Buffer.concat([Buffer.from("608060405234801561000f575f80fd5b50610150806100305f395ff3fe", "hex"), runtime, meta(1)]);
const A = "0x" + "a1".repeat(20);
const config = loadConfig({ READER_PARTY: "reader::1220" + "11".repeat(32), PINS_FILE: "pins.txt" }, () => `programVK=${PINS.programVK}\nrootC=${PINS.rootC}\n`);
const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  address: A, codeFormat: "solidity-single-file", sourceCode: "// SPDX-License-Identifier: MIT\ncontract Box {}", contractName: "Box", compilerVersion: "v0.8.28+commit.7893614a",
  optimizationUsed: "1", runs: 200, ...over,
});

suite("the verification routes", () => {
  let db: TestDatabase;
  let api: RoutedApi;
  const stub = new StubCompile();
  const queue = (limits = {}) => new JobQueue(db.pool, limits);
  const make = (limits = {}) => createApi({
    config, reth: {} as unknown as Reth, ledger: {} as never, chain: createChainDb(db.pool),
    verify: createVerifyApi({ pool: db.pool, queue: queue(limits), clientHash: (c) => c.padEnd(64, "0").replace(/[^0-9a-f]/g, "0").slice(0, 64), probe: fakeProbe().probe }),
  });
  const running = () => db.pool.query(
    "insert into health_checks (check_id, status, value, changed_at, checked_at) values ('verifier/compilers', 'ok', '{}'::jsonb, now(), now()) on conflict (check_id) do update set checked_at = now()");
  beforeAll(async () => { db = await makeDatabase(true); });
  afterAll(async () => { await db.drop(); });
  beforeEach(async () => {
    await db.pool.query("truncate verification_jobs, verified_sources, contracts, bytecodes, health_checks cascade");
    stub.calls = 0; stub.fail = null;
    stub.output = outputFor("Box.sol", "Box", { creation: creation.toString("hex"), runtime: runtime.toString("hex") });
    await addContract(db.pool, A, runtime, creation);
    api = make();
  });

  it("takes a submission, answers with a GUID, and tells the result once the role has run it", async () => {
    await running();
    const sent = await api("POST", "/api/verify", body(), "203.0.113.5");
    expect(sent.status).toBe(202);
    expect(Object.keys(sent.body as object)).toEqual(["guid"]);
    const guid = (sent.body as { guid: string }).guid;
    const waiting = await api("GET", `/api/verify/${guid}`);
    expect(waiting).toMatchObject({ status: 200, body: { guid, status: "pending", result: "Pending in queue" } });
    expect(waiting.headers?.["cache-control"]).toBeUndefined();
    const w = new VerifierWorker(db.pool, queue(), new Verifier(db.pool, stub), { cacheUsable: async () => null, log: () => undefined });
    expect(await w.step()).toBe("ended");
    const done = await api("GET", `/api/verify/${guid}`);
    expect(done.status).toBe(200);
    expect(Object.keys(done.body as object).sort()).toEqual(["guid", "result", "status"]);
    expect(done.body).toMatchObject({ status: "pass" });
    // the same contract again is answered as already verified
    const again = (await api("POST", "/api/verify", body(), "203.0.113.5")).body as { guid: string };
    await w.step();
    expect((await api("GET", `/api/verify/${again.guid}`)).body).toMatchObject({ status: "already" });
  });

  it("answers 503 while no verifier role has run lately, and when its row is a minute old", async () => {
    expect((await api("POST", "/api/verify", body())).status).toBe(503);
    await running();
    await db.pool.query("update health_checks set checked_at = now() - interval '61 seconds' where check_id = 'verifier/compilers'");
    const off = await api("POST", "/api/verify", body());
    expect(off).toMatchObject({ status: 503, body: { error: "Verification is not running." } });
    expect((await db.pool.query("select 1 from verification_jobs")).rowCount).toBe(0);
  });

  it("records that a submission came through /api/verify, and the tool it names: none when it names none, 'unknown' for one that is not forge, hardhat or remix", async () => {
    await running();
    const seen = async () => (await db.pool.query("select method, tool from verification_jobs order by created_at")).rows;
    for (const [tool, want] of [[undefined, null], ["forge", "forge"], ["Foundry", "forge"], ["hardhat", "hardhat"], ["Remix IDE", "remix"], ["my-script", "unknown"]] as const) {
      await db.pool.query("truncate verification_jobs");
      expect((await api("POST", "/api/verify", body(tool === undefined ? {} : { tool }), "203.0.113.5")).status).toBe(202);
      expect(await seen(), String(tool)).toEqual([{ method: "api", tool: want }]);
    }
    await db.pool.query("truncate verification_jobs");
    expect((await api("POST", "/api/verify", body({ tool: 5 }))).status).toBe(400);
    expect((await db.pool.query("select 1 from verification_jobs")).rowCount).toBe(0);
  });

  it("refuses a body that is not what it needs, before the queue is touched", async () => {
    await running();
    for (const text of ["", "nope", "[]", body({ sourceCode: "" }), body({ address: 5 }), body({ libraries: "x" })]) {
      expect((await api("POST", "/api/verify", text)).status, text.slice(0, 30)).toBe(400);
    }
    expect((await api("POST", "/api/verify", body({ address: "0x12" }))).status).toBe(400);
    expect((await api("GET", "/api/verify")).status).toBe(405);
    expect((await db.pool.query("select 1 from verification_jobs")).rowCount).toBe(0);
  });

  it("refuses a source that is too large with 413, and a client over its hourly limit or a full queue", async () => {
    await running();
    const big = await api("POST", "/api/verify", body({ sourceCode: "x".repeat(500 * 1024 + 1) }));
    expect(big.status).toBe(413);
    expect((await db.pool.query("select 1 from verification_jobs")).rowCount).toBe(0);
    const limited = make({ perClientPerHour: 2, maxWaiting: 3 });
    expect((await limited("POST", "/api/verify", body(), "198.51.100.1")).status).toBe(202);
    expect((await limited("POST", "/api/verify", body(), "198.51.100.1")).status).toBe(202);
    expect((await limited("POST", "/api/verify", body(), "198.51.100.1")).status).toBe(429);
    expect((await limited("POST", "/api/verify", body(), "198.51.100.2")).status).toBe(202);
    expect((await limited("POST", "/api/verify", body(), "198.51.100.3")).status).toBe(503);
  });

  it("stores the client only as a hash of its address", async () => {
    await running();
    await api("POST", "/api/verify", body(), "203.0.113.77");
    const row = (await db.pool.query("select * from verification_jobs")).rows[0] as Record<string, unknown>;
    expect(JSON.stringify(row, (_k, v) => (typeof v === "object" && v !== null && (v as { type?: string }).type === "Buffer" ? Buffer.from((v as { data: number[] }).data).toString("hex") : v))).not.toContain("203.0.113.77");
  });

  it("answers 404 for an unknown or malformed GUID, and has no route at all without the dependency", async () => {
    expect((await api("GET", "/api/verify/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await api("GET", "/api/verify/not-a-guid")).status).toBe(404);
    const plain = createApi({ config, reth: {} as unknown as Reth, ledger: {} as never, chain: createChainDb(db.pool) });
    expect(plain.routes).not.toContain("/api/verify");
    expect((await plain("GET", "/api/verify/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await plain("POST", "/api/verify", body())).status).toBe(404);
  });

  it("verifies a proxy at once from the slots it reads at the head, records the time, and answers its GUID only to the proxy check", async () => {
    const fp = fakeProbe();
    const verify = createVerifyApi({ pool: db.pool, queue: queue({ perClientPerHour: 3 }), clientHash: (c) => c.padEnd(64, "0").replace(/[^0-9a-f]/g, "0").slice(0, 64), probe: fp.probe });
    const P = "0x" + "b2".repeat(20), IMPL = "0x" + "c3".repeat(20);
    await addContract(db.pool, P, runtime, creation);
    const answerOf = async (a: { status: number; body: unknown }) => (await verify.proxyStatus((a.body as { guid: string }).guid)).body as { status: string; result: string };
    // Not a proxy yet: the implementation was not detected.
    expect(await answerOf(await verify.proxy(P, null, "1.2.3.4", 9))).toMatchObject({ status: "fail", result: PROXY_TEXTS.none });
    fp.setSlot(P, EIP1967_IMPLEMENTATION_SLOT, IMPL);
    // The wrong expectation is refused, and nothing is recorded.
    expect(await answerOf(await verify.proxy(P, "0x" + "d4".repeat(20), "1.2.3.4", 9))).toMatchObject({ status: "fail", result: PROXY_TEXTS.mismatch(IMPL, "0x" + "d4".repeat(20)) });
    expect((await db.pool.query("select verified_at from proxies")).rows[0].verified_at).toBeNull();
    const ok = await verify.proxy(P, IMPL.toUpperCase().replace("0X", "0x"), "1.2.3.4", 9);
    expect(ok.status).toBe(202);
    expect(await answerOf(ok)).toEqual({ guid: (ok.body as { guid: string }).guid, status: "pass", result: PROXY_TEXTS.done(P, IMPL) });
    expect((await db.pool.query("select verified_at, checked_block from proxies")).rows[0]).toMatchObject({ verified_at: expect.any(Date), checked_block: "9" });
    expect(new Set(fp.heads)).toEqual(new Set([9]));
    // A source's GUID is not a proxy's, nor the other way round; a contract the index does not hold is 404; the hourly limit counts the three above.
    expect((await verify.status((ok.body as { guid: string }).guid)).status).toBe(404);
    expect((await verify.proxy("0x" + "e5".repeat(20), null, "1.2.3.4", 9)).status).toBe(404);
    expect((await verify.proxy(P, null, "1.2.3.4", 9)).status).toBe(429);
  });
});
