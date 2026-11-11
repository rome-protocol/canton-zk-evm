import { describe, expect, it } from "vitest";
import { accountsRow, readUsage, usageOf, ACCOUNTS_DEGRADED_AT, ACCOUNTS_DOWN_AT } from "./accounts-health.ts";
import { evaluate, httpStatusOf, specOf, type RawRow } from "./health.ts";

const usage = (accounts: number, ceilings: Record<string, { used: number; limit: number }> = {}) => ({ accounts, accountCap: 1000, ceilings: { executesDay: { used: 0, limit: 2000 }, ...ceilings } });
const read = (u: ReturnType<typeof usage>, ok = true) => accountsRow({ ok, usage: u });

describe("the account service's limits as a health row", () => {
  it("warns at 60% and fails at 90%, of the worst ceiling or of the account cap", () => {
    expect([ACCOUNTS_DEGRADED_AT, ACCOUNTS_DOWN_AT]).toEqual([0.6, 0.9]);
    expect(read(usage(10)).status).toBe("ok");
    expect(read(usage(599)).status).toBe("ok");
    expect(read(usage(600)).status).toBe("degraded");
    expect(read(usage(899)).status).toBe("degraded");
    expect(read(usage(900)).status).toBe("down");
    expect(read(usage(10, { newAccountsDay: { used: 59, limit: 100 } })).status).toBe("ok");
    expect(read(usage(10, { newAccountsDay: { used: 60, limit: 100 } })).status).toBe("degraded");
    expect(read(usage(10, { trafficDay: { used: 90, limit: 100 } })).status).toBe("down");
    expect(read(usage(10, { trafficDay: { used: 100, limit: 100 } })).status).toBe("down");
  });

  it("names every ceiling that is over 60%, the fullest first, in words, and a name it does not know by itself", () => {
    const row = read(usage(700, { takeBacksDay: { used: 95, limit: 100 }, invented: { used: 7, limit: 10 }, executesDay: { used: 10, limit: 2000 } }));
    expect(row.detail).toBe("take-backs and accepts today: 95 of 100 (95%); accounts held against the participant's cap: 700 of 1000 (70%); invented: 7 of 10 (70%)");
    expect(row.value).toMatchObject({ accounts: 700, accountCap: 1000, ceilings: { accounts: { percent: 70 }, takeBacksDay: { percent: 95 }, executesDay: { percent: 1 } } });
  });

  it("is degraded when the service cannot be read, with the reason, and the reason is cut", () => {
    const row = accountsRow({ error: "x".repeat(500) });
    expect(row.status).toBe("degraded");
    expect(row.detail!.length).toBeLessThanOrEqual(300);
    expect(row.value).toBeNull();
  });

  it("reads only well-formed numbers", () => {
    expect(usageOf({ accounts: 1, accountCap: 10, ceilings: { a: { used: 1, limit: 2 } } })).toEqual({ accounts: 1, accountCap: 10, ceilings: { a: { used: 1, limit: 2 } } });
    for (const bad of [null, "x", {}, { accounts: -1, accountCap: 10, ceilings: {} }, { accounts: 1, accountCap: 0, ceilings: {} }, { accounts: 1, accountCap: 10 }, { accounts: 1, accountCap: 10, ceilings: [] },
      { accounts: 1, accountCap: 10, ceilings: { a: { used: "1", limit: 2 } } }, { accounts: 1, accountCap: 10, ceilings: { a: { used: 1, limit: 0 } } }, { accounts: 1, accountCap: 10, ceilings: { a: null } }]) {
      expect(usageOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("asks the service with a GET that follows no redirect, and refuses what is not a success or does not carry the limits", async () => {
    const seen: { url: unknown; init: RequestInit | undefined }[] = [];
    const fetcher = (answer: () => Response) => (async (url: unknown, init?: RequestInit) => { seen.push({ url, init }); return answer(); }) as unknown as typeof fetch;
    const body = { ok: true, accounts: 3, accountCap: 1000, ceilings: { executesDay: { used: 1, limit: 2 } } };
    expect(await readUsage("http://127.0.0.1:8081/healthz", fetcher(() => new Response(JSON.stringify(body))))).toEqual({ ok: true, usage: { accounts: 3, accountCap: 1000, ceilings: body.ceilings } });
    expect(seen[0]!.url).toBe("http://127.0.0.1:8081/healthz");
    expect(seen[0]!.init).toMatchObject({ redirect: "error" });
    expect(seen[0]!.init?.method).toBeUndefined();
    expect((await readUsage("http://x/healthz", fetcher(() => new Response(JSON.stringify({ ...body, ok: false }))))).ok).toBe(false);
    await expect(readUsage("http://x/healthz", fetcher(() => new Response("{}", { status: 503 })))).rejects.toThrow("HTTP 503");
    await expect(readUsage("http://x/healthz", fetcher(() => new Response("{}")))).rejects.toThrow("did not report its limits");
  });
});

describe("an advisory row in the health model", () => {
  const row = (id: string, status: string, age = 1): RawRow => ({ id, status, value: null, threshold: null, detail: `${id} says ${status}`, sinceSeconds: age, ageSeconds: age, changedAt: "2026-11-11T10:00:00.000Z", refreshedAt: "2026-11-11T10:00:00.000Z" });
  const base = ["C4", "C5", "derive_lag", "C10"].map((id) => row(id, "ok"));

  it("keeps the word down in its own entry and problems, and counts degraded in the overall word, so the instance stays in service", () => {
    expect(specOf("accounts")).toMatchObject({ role: "api", worst: "down", advisory: true });
    const e = evaluate([...base, row("accounts", "down")]);
    expect(e.checks.find((c) => c.id === "accounts")).toMatchObject({ status: "down", elsewhere: false });
    expect(e.problems).toEqual(["accounts: accounts says down"]);
    expect([e.status, e.down, httpStatusOf(e.status)]).toEqual(["degraded", false, 200]);
  });

  it("is only advisory: a row of the same kind that is not, and a real failure beside it, still turn the answer down", () => {
    expect(evaluate([...base, row("accounts", "down"), row("C1", "down")]).down).toBe(true);
    expect(evaluate([...base, row("accounts", "degraded")]).status).toBe("degraded");
    expect(evaluate([...base, row("accounts", "ok")]).status).toBe("ok");
    expect(specOf("faucet").advisory).toBeUndefined();
  });

  it("turns degraded when the instance that writes it stops, never down", () => {
    const e = evaluate([...base, row("accounts", "ok", 10_000)]);
    expect(e.checks.find((c) => c.id === "accounts")).toMatchObject({ status: "degraded", stale: true });
    expect(httpStatusOf(e.status)).toBe(200);
  });
});
