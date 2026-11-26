import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkRequired, makeDatabase, TEST_URL, type TestDatabase } from "./db/testing.ts";
import { ensurePartitions } from "./db/partitions.ts";
import { createFaucet, type Faucet, type FaucetOptions } from "./faucet.ts";
import { clientHasher, databaseFaucetStore } from "./faucet-store.ts";

checkRequired();

const COIN = 10n ** 18n;
const KEY = generatePrivateKey();
const FAUCET = privateKeyToAccount(KEY).address.toLowerCase();
const OTHER = "0x" + "77".repeat(20);
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const DAY = 86400;
const T0 = Date.UTC(2026, 10, 26, 6, 0, 0);

let db: TestDatabase | undefined;
let clock: { now: number };

beforeEach(async () => {
  if (TEST_URL) {
    db = await makeDatabase(true);
    await ensurePartitions(db.pool, { head: 0 });
  }
  clock = { now: T0 };
  for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await db?.drop(); db = undefined; });

function reth(): FaucetOptions["reth"] {
  return {
    balance: async () => 10n ** 24n, nonce: async () => 0, gasPrice: async () => 1n, priorityFee: async () => 1n,
    sendRaw: async () => "0x" + "11".repeat(32), transaction: async () => null,
  } as unknown as FaucetOptions["reth"];
}

async function faucet(over: Partial<FaucetOptions> = {}): Promise<Faucet> {
  const f = createFaucet({
    key: KEY, chainId: 770101, amountWei: COIN, perAddressSeconds: 7 * DAY, perIpSeconds: 600, maxPerHour: 100000, batch: 100, queueMax: 5000, stateFile: null, captcha: null,
    reth: reth(), now: () => clock.now, store: databaseFaucetStore(db!.pool, COIN, () => clock.now), clientKeyHash: clientHasher(Buffer.alloc(32, 7)),
    oncePerAddress: true, swapUrl: "https://swap.example/", ...over,
  });
  await f.ready();
  return f;
}

let n = 0;
/** A transaction the indexer wrote: `from` sent `value` to `to`, and it ended with `status` (1 success, 0 failure). */
async function transfer(from: string, to: string, value: bigint, status = 1): Promise<void> {
  n++;
  await db!.pool.query(
    `insert into transactions (block_number, tx_index, hash, type, from_address, to_address, nonce, value, gas_limit, effective_gas_price, gas_used, cumulative_gas_used, status, input, log_count)
     values ($1, 0, $2, 2, $3, $4, 0, $5, 21000, 1, 21000, 21000, $6, ''::bytea, 0)`,
    [n, Buffer.from(n.toString(16).padStart(64, "0"), "hex"), Buffer.from(from.slice(2), "hex"), Buffer.from(to.slice(2), "hex"), value.toString(), status],
  );
}

describe.skipIf(!TEST_URL)("one drip per address, ever, in the database", () => {
  it("refuses an address whose only record is a transfer to it from the faucet's wallet: its request row was purged, or the drip came before the database", async () => {
    await transfer(FAUCET, addr(1), COIN);
    const f = await faucet();
    expect(await f.request(addr(1), { ip: "1.1.1.1" })).toMatchObject({ status: 429, body: { reason: "once", swapUrl: "https://swap.example/" } });
    expect(f.queued()).toBe(0);
  });

  it("counts that refusal as once, which the refusal table accepts", async () => {
    await transfer(FAUCET, addr(1), COIN);
    const f = await faucet();
    await f.request(addr(1), { ip: "1.1.1.1" });
    await f.flush();
    const { rows } = await db!.pool.query<{ reason: string; n: number }>("select reason, n from faucet_refusals");
    expect(rows).toEqual([{ reason: "once", n: 1 }]);
  });

  it("does not count an address that got tROME another way: from someone else, as nothing, or in a transfer that failed", async () => {
    await transfer(OTHER, addr(1), COIN);
    await transfer(FAUCET, addr(2), 0n);
    await transfer(FAUCET, addr(3), COIN, 0);
    const f = await faucet();
    for (const [i, a] of [addr(1), addr(2), addr(3), addr(4)].entries()) expect((await f.request(a, { ip: `1.1.1.${i + 1}` })).status).toBe(202);
  });

  it("does not look at transfers when the setting is off", async () => {
    await transfer(FAUCET, addr(1), COIN);
    const f = await faucet({ oncePerAddress: false });
    expect((await f.request(addr(1), { ip: "1.1.1.1" })).status).toBe(202);
  });

  it("refuses an address whose request row is in the table, whatever its age, when another instance made it", async () => {
    const a = await faucet();
    expect((await a.request(addr(1), { ip: "1.1.1.1" })).status).toBe(202);
    clock.now += 30 * DAY * 1000;
    const b = await faucet(); // a fresh memory: only the database knows
    expect(await b.request(addr(1), { ip: "2.2.2.2" })).toMatchObject({ status: 429, body: { reason: "once" } });
  });

  it("keeps the old window when the setting is off: an address asks again after it", async () => {
    const a = await faucet({ oncePerAddress: false });
    expect((await a.request(addr(1), { ip: "1.1.1.1" })).status).toBe(202);
    clock.now += 8 * DAY * 1000;
    const b = await faucet({ oncePerAddress: false });
    expect((await b.request(addr(1), { ip: "2.2.2.2" })).status).toBe(202);
  });

  it("does not let a request that came to nothing use up the address", async () => {
    await db!.pool.query(
      `insert into faucet_requests (ticket, address, client_key, amount, state, counts, requested_at, updated_at) values ($1, $2, ''::bytea, $3, 'failed', false, $4, now())`,
      ["00000000-0000-0000-0000-000000000001", Buffer.from(addr(1).slice(2), "hex"), COIN.toString(), new Date(T0 - DAY * 1000)],
    );
    expect((await (await faucet()).request(addr(1), { ip: "1.1.1.1" })).status).toBe(202);
  });
});
