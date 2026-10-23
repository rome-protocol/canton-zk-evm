import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "./db/testing.ts";
import { createFaucet, type Faucet, type FaucetOptions } from "./faucet.ts";
import { clientHasher, databaseFaucetStore, fileFaucetStore } from "./faucet-store.ts";

checkRequired();

const COIN = 10n ** 18n;
const KEY = generatePrivateKey();
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const DAY = 86400;
const T0 = Date.UTC(2026, 9, 23, 12, 30, 15);

let db: TestDatabase | undefined;
let clock: { now: number };
let calls: string[];
const captcha = { secret: "s", verifyUrl: "https://check.example/verify", scriptUrl: "https://check.example/api.js", siteKey: "k", widgetClass: "c" };

beforeEach(async () => {
  if (TEST_URL) db = await makeDatabase(true);
  clock = { now: T0 };
  calls = [];
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await db?.drop(); db = undefined; });

/** A reth that answers what the faucet reads, with a balance as of the block asked for. */
function reth(over: Record<string, unknown> = {}): FaucetOptions["reth"] {
  return {
    balance: async () => 10n ** 24n, nonce: async () => 0, gasPrice: async () => 1n, priorityFee: async () => 1n,
    sendRaw: async () => "0x" + "11".repeat(32), transaction: async () => null, ...over,
  } as unknown as FaucetOptions["reth"];
}
const verifier = (success: boolean): typeof fetch => (async (url: unknown) => { calls.push(String(url)); return new Response(JSON.stringify({ success })); }) as typeof fetch;

async function faucet(over: Partial<FaucetOptions> = {}, shared: TestDatabase | null | undefined = db): Promise<Faucet> {
  const f = createFaucet({
    key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: DAY, perIpSeconds: 600, maxPerHour: 100000, batch: 100, queueMax: 5000, stateFile: null, captcha: null,
    reth: reth(), now: () => clock.now,
    ...(shared ? { store: databaseFaucetStore(shared.pool, COIN, () => clock.now), clientKeyHash: clientHasher(Buffer.alloc(32, 7)) } : {}),
    ...over,
  });
  await f.ready();
  return f;
}
const counted = async (): Promise<Record<string, number>> => {
  const { rows } = await db!.pool.query<{ reason: string; n: number }>("select reason, sum(n)::int as n from faucet_refusals group by reason order by reason");
  return Object.fromEntries(rows.map((r) => [r.reason, r.n]));
};

describe.skipIf(!TEST_URL)("the faucet counts what it turns away", () => {
  it("counts a second request from the same address once, as 'address'", async () => {
    const f = await faucet();
    expect((await f.request(addr(1), { ip: "1.1.1.1" })).status).toBe(202);
    expect(await counted()).toEqual({});
    expect(await f.request(addr(1), { ip: "2.2.2.2" })).toMatchObject({ status: 429, body: { reason: "address" } });
    expect(await counted()).toEqual({ address: 1 });
  });

  it("counts a second request from the same network address once, as 'ip'", async () => {
    const f = await faucet();
    await f.request(addr(1), { ip: "1.1.1.1" });
    expect(await f.request(addr(2), { ip: "1.1.1.1" })).toMatchObject({ status: 429, body: { reason: "ip" } });
    expect(await counted()).toEqual({ ip: 1 });
  });

  it("counts a request over the hourly cap once, as 'hour'", async () => {
    const f = await faucet({ maxPerHour: 1 });
    await f.request(addr(1), { ip: "1.1.1.1" });
    expect(await f.request(addr(2), { ip: "2.2.2.2" })).toMatchObject({ status: 429, body: { reason: "hour" } });
    expect(await counted()).toEqual({ hour: 1 });
  });

  it("counts a failed human check once, as 'captcha': a missing token, and a token that does not pass", async () => {
    const f = await faucet({ captcha, fetch: verifier(false) });
    expect(await f.request(addr(1), { ip: "1.1.1.1" })).toMatchObject({ status: 403, body: { reason: "captcha" } });
    expect(await counted()).toEqual({ captcha: 1 });
    expect(await f.request(addr(1), { ip: "1.1.1.1", captcha: "tok" })).toMatchObject({ status: 403, body: { reason: "captcha" } });
    expect(await counted()).toEqual({ captcha: 2 });
  });

  it("counts a request that the database turns away because another instance took the address, once", async () => {
    const a = await faucet(), b = await faucet();
    expect((await a.request(addr(1), { ip: "1.1.1.1" })).status).toBe(202);
    // b's memory does not know the request: only the database's check sees it
    expect(await b.request(addr(1), { ip: "2.2.2.2" })).toMatchObject({ status: 429, body: { reason: "address" } });
    expect(await counted()).toEqual({ address: 1 });
  });

  it("counts nothing for a request that is accepted, a bad address, a full line or an empty faucet", async () => {
    const f = await faucet({ queueMax: 1 });
    expect((await f.request("nope")).status).toBe(400);
    expect((await f.request(addr(1), { ip: "1.1.1.1" })).status).toBe(202);
    expect(await f.request(addr(2), { ip: "2.2.2.2" })).toMatchObject({ status: 503, body: { reason: "queue" } });
    const empty = await faucet({ reth: reth({ balance: async () => 0n }) });
    expect(await empty.request(addr(3), { ip: "3.3.3.3" })).toMatchObject({ status: 503, body: { reason: "empty" } });
    expect(await counted()).toEqual({});
  });

  it("adds refusals of one minute into one row, and keeps minutes apart", async () => {
    const f = await faucet();
    await f.request(addr(1), { ip: "1.1.1.1" });
    for (let i = 0; i < 3; i++) await f.request(addr(1), { ip: `9.9.9.${i}` });
    clock.now += 61_000;
    await f.request(addr(1), { ip: "8.8.8.8" });
    const { rows } = await db!.pool.query<{ minute: Date; n: number }>("select minute, n from faucet_refusals where reason = 'address' order by minute");
    expect(rows.map((r) => [r.minute.toISOString(), r.n])).toEqual([["2026-10-23T12:30:00.000Z", 3], ["2026-10-23T12:31:00.000Z", 1]]);
  });

  it("stores no address and no client with a refusal: the table has a minute, a reason and a count, and nothing else", async () => {
    const f = await faucet();
    await f.request(addr(0xabc123), { ip: "203.0.113.77" });
    await f.request(addr(0xabc123), { ip: "203.0.113.77" });
    await f.request(addr(0xdef456), { ip: "203.0.113.77" });
    const cols = await db!.pool.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'faucet_refusals' order by column_name");
    expect(cols.rows.map((c) => c.column_name)).toEqual(["minute", "n", "reason"]);
    const dump = JSON.stringify((await db!.pool.query("select * from faucet_refusals")).rows);
    expect(dump).not.toMatch(/abc123|def456|203\.0\.113|203|0x/);
    expect(await counted()).toEqual({ address: 1, ip: 1 });
  });

  it("still answers when the count cannot be written", async () => {
    const f = await faucet();
    await f.request(addr(1), { ip: "1.1.1.1" });
    await db!.pool.query("drop table faucet_refusals");
    expect(await f.request(addr(1), { ip: "2.2.2.2" })).toMatchObject({ status: 429, body: { reason: "address" } });
  });

  it("purges counts older than 90 days with the requests", async () => {
    const store = databaseFaucetStore(db!.pool, COIN, () => clock.now);
    await db!.pool.query("insert into faucet_refusals (minute, reason, n) values ($1, 'ip', 4), ($2, 'ip', 5)", [new Date(T0 - 91 * 86400_000), new Date(T0 - 89 * 86400_000)]);
    await store.purge!(T0);
    const { rows } = await db!.pool.query<{ n: number }>("select n from faucet_refusals");
    expect(rows.map((r) => r.n)).toEqual([5]);
  });
});

describe("a faucet with a file for its state", () => {
  it("turns requests away as before, with no counter to write", async () => {
    const f = await faucet({ store: fileFaucetStore("/nonexistent-dir-for-test/none.json"), stateFile: null }, null);
    await f.request(addr(1), { ip: "1.1.1.1" });
    expect(await f.request(addr(1), { ip: "2.2.2.2" })).toMatchObject({ status: 429, body: { reason: "address" } });
  });
});

describe("what the faucet says about itself", () => {
  it("gives the batch size from its own setting", async () => {
    const f = await faucet({ batch: 37 }, null);
    expect(await f.info()).toMatchObject({ batch: 37 });
  });

  it("reads the balance at a block and says which block", async () => {
    const asked: unknown[][] = [];
    const f = await faucet({ reth: reth({ blockNumber: async () => 812, balanceAt: async (...a: unknown[]) => { asked.push(a); return 5n * COIN; } }) }, null);
    expect(await f.info()).toMatchObject({ balance: (5n * COIN).toString(), balanceBlock: 812 });
    expect(asked).toEqual([[expect.stringMatching(/^0x[0-9a-f]{40}$/), 812]]);
  });

  it("says no block, and still the balance, when reth cannot name one", async () => {
    const f = await faucet({ reth: reth({ blockNumber: async () => { throw new Error("down"); } }) }, null);
    expect(await f.info()).toMatchObject({ balance: (10n ** 24n).toString(), balanceBlock: null });
  });

  it("says no balance and no block when the balance cannot be read", async () => {
    const f = await faucet({ reth: reth({ balance: async () => { throw new Error("down"); }, blockNumber: async () => { throw new Error("down"); } }) }, null);
    expect(await f.info()).toMatchObject({ balance: null, balanceBlock: null });
  });

  it("says nothing of today's payouts when the store cannot count them (a file)", async () => {
    const f = await faucet({}, null);
    expect((await f.info()).sentToday).toBeNull();
  });
});

describe.skipIf(!TEST_URL)("payouts made today", () => {
  async function paid(f: Faucet, to: number, at: number, status: "sent" | "final" | "failed" | "queued") {
    const store = databaseFaucetStore(db!.pool, COIN, () => at);
    await store.save([{ id: to.toString(16).padStart(24, "0"), to: addr(to), ip: null, at, status, hash: null, block: null, reason: null, tries: 0 }], () => ({ addresses: [], ips: [], hourly: [] }));
    return f;
  }
  it("counts the payouts sent since the start of the UTC day, and no others", async () => {
    const f = await faucet();
    const dayStart = Date.UTC(2026, 9, 23);
    await paid(f, 1, dayStart + 1000, "sent");
    await paid(f, 2, dayStart + 2000, "final");
    await paid(f, 3, dayStart - 1000, "final"); // yesterday, 23:59:59
    await paid(f, 4, dayStart + 3000, "queued"); // not sent yet
    expect((await f.info()).sentToday).toBe(2);
    clock.now = dayStart + 86400_000 + 5; // a new day
    expect((await f.info()).sentToday).toBe(0);
  });
});
