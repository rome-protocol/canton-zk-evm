import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { startFakeReth } from "../../test/fake-reth.ts";
import { FAKE_PARTICIPANT, FAKE_READER } from "../../test/fake-ledger.ts";

function run(env: Record<string, string>, stopAfterMs: number | null): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const p = spawn("node", ["server/indexer/cli.ts"], { env: { PATH: process.env.PATH ?? "", ...env }, cwd: new URL("../..", import.meta.url).pathname });
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

  describe.skipIf(!TEST_URL)("against the database", () => {
    checkRequired();
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
