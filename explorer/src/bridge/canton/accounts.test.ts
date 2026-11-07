import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AccountsClient, AccountsError, retryAfterSeconds } from "./accounts.ts";
import { base64, fromBase64, keyFromSignature } from "./key.ts";

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
  it("sends no signature to topology and allocate, and opens the account by signing the multi-hash", async () => {
    const hash = new Uint8Array(34).fill(7);
    const f = vi.fn(async (url: string) => url.endsWith("/topology") ? answer(200, { party: PARTY, exists: false, multiHash: base64(hash), blob: "blob" }) : answer(200, { party: PARTY, created: true }));
    expect(await client(f).open(key)).toBe(PARTY);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((c) => c[0])).toEqual(["/accounts/v1/topology", "/accounts/v1/allocate"]);
    expect(calls.every(([, i]) => !("X-Account-Signature" in (i.headers as object)))).toBe(true);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ publicKey: base64(key.publicKey) });
    const sent = JSON.parse(calls[1]![1].body as string);
    expect(sent.blob).toBe("blob");
    expect(Buffer.from(sent.signature, "base64")).toEqual(Buffer.from(await key.sign(hash)));
  });
  it("finds an account that exists without allocating", async () => {
    const f = vi.fn(async () => answer(200, { party: PARTY, exists: true }));
    expect(await client(f).open(key)).toBe(PARTY);
    expect(f).toHaveBeenCalledTimes(1);
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
