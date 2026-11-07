import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AccountsClient, AccountsError, acceptChoice, factoryChoice, retryAfterSeconds } from "./accounts.ts";
import { base64, fromBase64, keyFromSignature } from "./key.ts";
import { partyOf } from "./topology.ts";

// A real answer of the pinned Canton, printed by apps/accounts/tests/integration.py (fixtures.json): what the account service said of the account's allocations and open requests.
// (The topology answers, and opening an account from them, are in topology.test.ts.)
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as Record<string, any>[];
const fixture = (name: string) => fixtures.find((f) => f.name === name)!;
const PARTICIPANT = "operator::1220" + "cd".repeat(32);

const key = await keyFromSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1b");
const PARTY = "bridge::1220" + "ab".repeat(32);
const NOW = 1_800_000_000_000;

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const verifies = async (header: string, method: string, path: string, body: string) => {
  const [seconds, signature] = [header.slice(0, header.indexOf(".")), header.slice(header.indexOf(".") + 1)];
  const message = `accounts-v1\n${method}\n${path}\n${createHash("sha256").update(body).digest("hex")}\n${seconds}`;
  const pub = await crypto.subtle.importKey("raw", key.publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, pub, fromBase64(signature) as BufferSource, new TextEncoder().encode(message));
};
const client = (f: ReturnType<typeof vi.fn>) => new AccountsClient("", f as unknown as typeof fetch, () => NOW);

describe("the account service client", () => {
  it("signs an account-scoped request over accounts-v1, the method, the path, the body's sha256 and the seconds", async () => {
    const f = vi.fn(async () => answer(200, { party: PARTY, holdings: [] }));
    await client(f).holdings(key, PARTY);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/accounts/v1/holdings/${PARTY}`);   // the party is not escaped: the service checks the path as sent
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const header = (init.headers as Record<string, string>)["X-Account-Signature"]!;
    expect(header.startsWith(`${NOW / 1000}.`)).toBe(true);
    expect(await verifies(header, "GET", `/accounts/v1/holdings/${PARTY}`, "")).toBe(true);

    const g = vi.fn(async () => answer(200, { party: PARTY, preparedTransaction: "AA==", preparedTransactionHash: "AA==", hashingSchemeVersion: "V2" }));
    const command = { CreateCommand: { templateId: "#p:M:E", createArguments: { a: 1 } } };
    await client(g).prepare(key, PARTY, [command]);
    const [, post] = g.mock.calls[0] as unknown as [string, RequestInit];
    expect(await verifies((post.headers as Record<string, string>)["X-Account-Signature"]!, "POST", "/accounts/v1/prepare", post.body as string)).toBe(true);   // the body as sent
    expect(JSON.parse(post.body as string)).toEqual({ party: PARTY, commands: [command], disclosedContracts: [] });
  });
  it("takes an earlier second for a request that repeats one, as the service takes each signature once", async () => {
    const c = client(vi.fn(async () => answer(200, { holdings: [] })));
    const a = await c.accountSignature(key, "GET", "/x", "");
    const b = await c.accountSignature(key, "GET", "/x", "");
    expect([a.split(".")[0], b.split(".")[0]]).toEqual([`${NOW / 1000}`, `${NOW / 1000 - 1}`]);
  });
  it("takes the party from the key, never from the service", async () => {
    const mine = await partyOf(key.publicKey);
    const other = "bridge::1220" + "ee".repeat(32);
    for (const exists of [true, false]) {
      const f = vi.fn(async () => answer(200, { party: other, exists, multiHash: "AA==", topologyTransactions: ["AA=="], blob: "blob" }));
      await expect(client(f).open(key, PARTICIPANT)).rejects.toThrow(/names bridge::1220e+/);
      expect(f).toHaveBeenCalledTimes(1);
    }
    expect(await client(vi.fn(async () => answer(200, { party: mine, exists: true }))).open(key, PARTICIPANT)).toBe(mine);
  });
  it("finds an account that exists without allocating or asking the wallet", async () => {
    const mine = await partyOf(key.publicKey);
    const f = vi.fn(async () => answer(200, { party: mine, exists: true }));
    const confirm = vi.fn(async () => {});
    expect(await client(f).open(key, PARTICIPANT, confirm)).toBe(mine);
    expect(f).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("reads the allocations and the open requests of the account by contract id, each request signed", async () => {
    const answers = fixture("answers");
    const f = vi.fn(async (url: string) => answer(200, url.includes("/allocations/") ? answers.allocations : answers.open));
    const c = client(f);
    const [allocation] = await c.allocations(key, answers.party);
    expect(allocation).toMatchObject({ contractId: answers.allocations.allocations[0].contractId, allocation: { transferLeg: { sender: answers.party } } });
    const open = await c.openRequests(key, answers.party);
    expect(open.depositRequests[0]!.arguments.allocation).toBe(allocation!.contractId);
    expect(open.redeemRequests[0]!.contractId).toBeTruthy();
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((x) => x[0])).toEqual([`/accounts/v1/allocations/${answers.party}`, `/accounts/v1/open/${answers.party}`]);
    for (const [url, init] of calls) expect(await verifies((init.headers as Record<string, string>)["X-Account-Signature"]!, "GET", url, "")).toBe(true);
  });
  it("types each refusal, and carries Retry-After and the participant's answer", async () => {
    const kinds: [number, string][] = [[400, "bad-request"], [401, "unauthorized"], [403, "forbidden"], [404, "not-found"], [422, "refused"], [429, "rate-limited"], [502, "unavailable"], [503, "unavailable"], [500, "server"]];
    for (const [status, kind] of kinds) {
      const error = await client(vi.fn(async () => answer(status, { error: "no", code: "C", detail: "d" }, { "Retry-After": "12" }))).holdings(key, PARTY).catch((e) => e);
      expect(error).toBeInstanceOf(AccountsError);
      expect(error).toMatchObject({ kind, status, message: "no", retryAfter: 12, code: "C", detail: "d" });
    }
    const conflict = await client(vi.fn(async () => answer(409, { error: "already_accepted", message: "the account has this acceptance open" }))).holdings(key, PARTY).catch((e) => e);   // a 409's `error` is the stable code
    expect(conflict).toMatchObject({ kind: "conflict", status: 409, code: "already_accepted", message: "the account has this acceptance open" });
    expect(await client(vi.fn(async () => { throw new TypeError("offline"); })).holdings(key, PARTY).catch((e) => e)).toMatchObject({ kind: "network", message: "offline" });
  });
  it("asks the registry through the service, each request signed, with the account named in the body", async () => {
    const f = vi.fn(async () => answer(200, { factoryId: "f1", choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [] } }));
    const c = client(f);
    await c.allocationFactory(key, "DSO::1220aa", PARTY, { expectedAdmin: "DSO::1220aa" });
    await c.acceptContext(key, "DSO::1220aa", "00cd", PARTY);
    await c.faucet(key, PARTY);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((x) => x[0])).toEqual(["/accounts/v1/registry/DSO::1220aa/allocation-factory", "/accounts/v1/registry/DSO::1220aa/transfer-instruction/00cd/accept-context", "/accounts/v1/faucet"]);
    expect(calls.map((x) => JSON.parse(x[1].body as string))).toEqual([{ choiceArguments: { expectedAdmin: "DSO::1220aa" }, excludeDebugFields: true, party: PARTY }, { party: PARTY }, { party: PARTY }]);
    for (const [url, init] of calls) expect(await verifies((init.headers as Record<string, string>)["X-Account-Signature"]!, "POST", url, init.body as string)).toBe(true);
  });
  it("reads the accept context from the top level of the registry's answer, as the token standard's ChoiceContext", () => {
    const disclosed = { templateId: "t", contractId: "c", createdEventBlob: "b", synchronizerId: "s" };
    expect(acceptChoice({ choiceContextData: { values: { a: 1 } }, disclosedContracts: [disclosed] })).toEqual({ context: { values: { a: 1 } }, disclosedContracts: [disclosed] });
    expect(acceptChoice({ choiceContextData: { values: {} } })).toEqual({ context: { values: {} }, disclosedContracts: [] });
  });
  it("refuses an accept context that has no top-level choiceContextData, even when one is nested", () => {
    const bare = { values: { a: 1 } };
    for (const bad of [{}, { choiceContext: { choiceContextData: bare } }, bare, { choiceContextData: "x" }, { choiceContextData: null }, null, undefined, { choiceContextData: {}, disclosedContracts: "x" }]) {
      expect(() => acceptChoice(bad)).toThrow(/choiceContextData|disclosedContracts/);
    }
    expect(() => acceptChoice({})).toThrowError(expect.objectContaining({ code: "no_choice_context" }));
  });
  it("reads the allocation factory's context from its choiceContext, and refuses a factory answer without choiceContextData", () => {
    expect(factoryChoice({ choiceContext: { choiceContextData: { values: { a: 1 } }, disclosedContracts: [] } })).toEqual({ context: { values: { a: 1 } }, disclosedContracts: [] });
    expect(() => factoryChoice({ choiceContext: { values: {} } })).toThrow(/choiceContextData/);
    expect(() => factoryChoice({})).toThrow(/choiceContextData/);
  });
  it("reads Retry-After as seconds or as a date", () => {
    expect(retryAfterSeconds("30")).toBe(30);
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30);
    expect(retryAfterSeconds(null)).toBeUndefined();
    expect(retryAfterSeconds("soon")).toBeUndefined();
  });
});
