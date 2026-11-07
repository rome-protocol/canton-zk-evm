import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AccountsClient, AccountsError, retryAfterSeconds } from "./accounts.ts";
import { base64, fromBase64, hex, keyFromSignature, type CantonKey } from "./key.ts";
import { fingerprintOf, OnboardingNotChecked, partyOf, topologyMultiHash } from "./topology.ts";

// Real answers of the pinned Canton, printed by apps/accounts/tests/integration.py (fixtures.json): the topology of one key, and what the account service said of the account's allocations and open requests.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as Record<string, any>[];
const fixture = (name: string) => fixtures.find((f) => f.name === name)!;
const topology = fixture("topology");
const realKey = { publicKey: fromBase64(topology.publicKey) } as CantonKey;   // the key of the real topology: open() only reads its public half

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
  it("computes the party and the multi-hash itself: the real vectors of the pinned Canton", async () => {
    expect(await partyOf(realKey.publicKey)).toBe(topology.party);   // bridge:: and the fingerprint: 1220 and the SHA-256 (purpose 12) of the 32 raw bytes
    expect(await fingerprintOf(realKey.publicKey)).toBe(topology.party.slice("bridge::".length));
    expect(hex(await topologyMultiHash(topology.topologyTransactions))).toBe(hex(fromBase64(topology.multiHash)));   // the participant's multi-hash of its transactions
    expect(fromBase64(topology.multiHash).length).toBe(34);
    expect(await partyOf(key.publicKey)).not.toBe(topology.party);
  });
  it("sends no signature to topology, and asks the wallet again before a first account", async () => {
    const f = vi.fn(async () => answer(200, { party: topology.party, exists: false, multiHash: topology.multiHash, topologyTransactions: topology.topologyTransactions, blob: "blob" }));
    const confirm = vi.fn(async () => {});
    // The real topology is the participant's, and the page cannot yet read it: it signs nothing and allocates nothing.
    await expect(client(f).open(realKey, confirm)).rejects.toThrow(OnboardingNotChecked);
    await expect(client(f).open(realKey)).rejects.toThrow(/cannot yet read/);
    expect(confirm).toHaveBeenCalledTimes(1);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.every(([url, i]) => url === "/accounts/v1/topology" && !("X-Account-Signature" in (i.headers as object)))).toBe(true);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ publicKey: topology.publicKey });
    // A wallet that does not sign the same way twice stops the account where it is asked again.
    await expect(client(f).open(realKey, async () => { throw new Error("this wallet does not sign the same way twice"); })).rejects.toThrow("same way twice");
  });
  it("signs no multi-hash the service names: a prepared transaction's hash (the reviewer's attack), or the hash of other transactions", async () => {
    const mine = await partyOf(key.publicKey);
    const archived = fixture("exercise-archive");
    let allocated = 0;
    const attack = (multiHash: string, transactions: string[]) => vi.fn(async (url: string) => {
      if (url.endsWith("/topology")) return answer(200, { party: mine, exists: false, multiHash, topologyTransactions: transactions, blob: "blob" });
      allocated++;
      return answer(200, { party: mine, created: true });
    });
    const confirm = vi.fn(async () => {});
    // 32 bytes: the hash that executes a transaction. Not a multi-hash of the transactions it came with.
    await expect(client(attack(archived.preparedTransactionHash, topology.topologyTransactions)).open(key, confirm)).rejects.toThrow(/not the hash of the transactions/);
    // 34 bytes of the attacker's choosing
    await expect(client(attack(base64(new Uint8Array([0x12, 0x20, ...new Uint8Array(32).fill(9)])), topology.topologyTransactions)).open(key, confirm)).rejects.toThrow(/not the hash of the transactions/);
    // a multi-hash that is not even base64, and no transactions at all
    await expect(client(attack("not base64!", topology.topologyTransactions)).open(key, confirm)).rejects.toThrow(OnboardingNotChecked);
    await expect(client(attack(topology.multiHash, [])).open(key, confirm)).rejects.toThrow(AccountsError);
    expect([allocated, confirm.mock.calls.length]).toEqual([0, 0]);   // nothing was signed or sent, and the wallet was not asked again
  });
  it("takes the party from the key, never from the service", async () => {
    const mine = await partyOf(key.publicKey);
    const other = "bridge::1220" + "ee".repeat(32);
    for (const exists of [true, false]) {
      const f = vi.fn(async () => answer(200, { party: other, exists, multiHash: "AA==", topologyTransactions: ["AA=="], blob: "blob" }));
      await expect(client(f).open(key)).rejects.toThrow(/names bridge::1220e+/);
      expect(f).toHaveBeenCalledTimes(1);
    }
    expect(await client(vi.fn(async () => answer(200, { party: mine, exists: true }))).open(key)).toBe(mine);
  });
  it("finds an account that exists without allocating or asking the wallet", async () => {
    const mine = await partyOf(key.publicKey);
    const f = vi.fn(async () => answer(200, { party: mine, exists: true }));
    const confirm = vi.fn(async () => {});
    expect(await client(f).open(key, confirm)).toBe(mine);
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
    const kinds: [number, string][] = [[400, "bad-request"], [401, "unauthorized"], [403, "forbidden"], [404, "not-found"], [409, "conflict"], [422, "refused"], [429, "rate-limited"], [502, "unavailable"], [503, "unavailable"], [500, "server"]];
    for (const [status, kind] of kinds) {
      const error = await client(vi.fn(async () => answer(status, { error: "no", code: "C", detail: "d" }, { "Retry-After": "12" }))).holdings(key, PARTY).catch((e) => e);
      expect(error).toBeInstanceOf(AccountsError);
      expect(error).toMatchObject({ kind, status, message: "no", retryAfter: 12, code: "C", detail: "d" });
    }
    expect(await client(vi.fn(async () => { throw new TypeError("offline"); })).holdings(key, PARTY).catch((e) => e)).toMatchObject({ kind: "network", message: "offline" });
  });
  it("reads Retry-After as seconds or as a date", () => {
    expect(retryAfterSeconds("30")).toBe(30);
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30);
    expect(retryAfterSeconds(null)).toBeUndefined();
    expect(retryAfterSeconds("soon")).toBeUndefined();
  });
});
