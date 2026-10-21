import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { startFakeReth } from "../../test/fake-reth.ts";
import { FAKE_PARTICIPANT, FAKE_READER } from "../../test/fake-ledger.ts";

function run(env: Record<string, string>, stopAfterMs: number | null, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const p = spawn("node", ["server/indexer/cli.ts", ...args], { env: { PATH: process.env.PATH ?? "", ...env }, cwd: new URL("../..", import.meta.url).pathname });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => done({ code, out }));
    if (stopAfterMs !== null) setTimeout(() => p.kill("SIGTERM"), stopAfterMs);
  });
}

describe("the indexer's command", () => {
  it("refuses to start without the gateway's address, and says so", async () => {
    const r = await run({ READER_PARTY: FAKE_READER }, null);
    expect(r.code).toBe(1);
    expect(r.out).toContain("GATEWAY_ADDRESS");
  });

  it("refuses reset without --yes, and reader-moved without a participant, before it touches a database", async () => {
    const reset = await run({ EXPLORER_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" }, null, ["reset"]);
    expect(reset.code).toBe(1);
    expect(reset.out).toContain("--yes");
    const moved = await run({ EXPLORER_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" }, null, ["reader-moved"]);
    expect(moved.code).toBe(1);
    expect(moved.out).toContain("participant id");
  });

  it("refuses clear-check without a check, and for any check but C10, before it touches a database", async () => {
    const env = { EXPLORER_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" };
    const none = await run(env, null, ["clear-check"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("clear-check C10");
    const other = await run(env, null, ["clear-check", "C4"]);
    expect(other.code).toBe(1);
    expect(other.out).toContain("only C10");
  });

  describe.skipIf(!TEST_URL)("against the database", () => {
    checkRequired();
    it("reset --yes empties the tables and reader-moved records a move, through the command", async () => {
      await withDatabase(async (pool, dbUrl) => {
        await migrate(pool);
        await pool.query("insert into meta (key, value) values ('chain_id', '1'), ('partition_width', '1000000')");
        await pool.query("insert into canton_participants (participant_id, first_offset, moved_in_at) values ('PAR::old', 0, now())");
        await pool.query("insert into cursors (stream, position, detail, updated_at) values ('reader_updates', 40, '{\"participant\":\"PAR::old\",\"block\":4}', now())");
        const moved = await run({ EXPLORER_DATABASE_URL: dbUrl }, null, ["reader-moved", "PAR::new"]);
        expect(moved.code).toBe(0);
        expect(moved.out).toContain("PAR::new");
        expect((await pool.query("select participant_id from canton_participants order by id")).rows.map((r) => r.participant_id)).toEqual(["PAR::old", "PAR::new"]);
        const reset = await run({ EXPLORER_DATABASE_URL: dbUrl }, null, ["reset", "--yes"]);
        expect(reset.code).toBe(0);
        expect((await pool.query("select key from meta")).rows.map((r) => r.key)).toEqual(["partition_width"]);
        expect((await pool.query("select count(*) as n from canton_participants")).rows[0].n).toBe("0");
        await pool.query("insert into health_checks (check_id, status, value, changed_at, checked_at) values ('C10', 'degraded', '{\"block\":7}', now(), now())");
        const cleared = await run({ EXPLORER_DATABASE_URL: dbUrl }, null, ["clear-check", "C10"]);
        expect(cleared.code).toBe(0);
        expect((await pool.query("select status, value from health_checks where check_id = 'C10'")).rows[0]).toMatchObject({ status: "ok", value: { clearedBlock: 7 } });
      });
    }, 20_000);

    it("runs on an empty chain, writes the pins to meta, and stops cleanly when told to", async () => {
      const zero = "0x" + "00".repeat(32);
      const reth = await startFakeReth({
        eth_getBlockByNumber: () => ({ number: "0x0", hash: "0x" + "00".repeat(31) + "01", parentHash: zero, timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x7",
          miner: "0x" + "00".repeat(20), stateRoot: zero, transactionsRoot: zero, receiptsRoot: zero, extraData: "0x", transactions: [] }),
      });
      const ledger = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url?.includes("participant-id") ? { participantId: FAKE_PARTICIPANT } : { offset: 0 }));
      });
      await new Promise<void>((ok) => ledger.listen(0, "127.0.0.1", ok));
      try {
        await withDatabase(async (pool, dbUrl) => {
          await migrate(pool);
          const r = await run({
            READER_PARTY: FAKE_READER, RETH_RPC_URL: reth.url, LEDGER_URL: `http://127.0.0.1:${(ledger.address() as AddressInfo).port}`, EXPLORER_DATABASE_URL: dbUrl,
            GATEWAY_ADDRESS: "0x" + "9a".repeat(20), INDEX_DERIVE: "behind", INDEX_POLL_MS: "50",
          }, 2500);
          expect(r.out).toContain("indexer: running, stage 2 behind");
          expect(r.code).toBe(0);
          const meta = await pool.query("select key from meta where key in ('chain_id', 'genesis_hash', 'program_vk', 'root_c', 'gateway_address') order by key");
          expect(meta.rows.map((x) => x.key)).toEqual(["chain_id", "gateway_address", "genesis_hash", "program_vk", "root_c"]);
        });
      } finally {
        await reth.close();
        await new Promise<void>((ok) => ledger.close(() => ok()));
      }
    }, 20_000);
  });
});
