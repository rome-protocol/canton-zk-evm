import { describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, withDatabase } from "../db/testing.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createIndexer, type DeriveShape } from "./indexer.ts";
import { CHANNEL, parseEvent, textOf } from "./notify.ts";

describe("the text of a notification", () => {
  it("round-trips the events, and ignores any other text", () => {
    for (const e of [{ kind: "final", number: 7 }, { kind: "derived", number: 0 }, { kind: "inflight" }] as const) expect(parseEvent(textOf(e))).toEqual(e);
    for (const t of [undefined, "", "final", "final:", "final:-1", "final:01", "final:1.5", "derived:x", "inflight:1", "final:99999999999999999", "FINAL:1"]) expect(parseEvent(t)).toBeNull();
  });
});

describe.skipIf(!TEST_URL)("what the indexer tells the API instances", () => {
  checkRequired();
  /** The notifications that arrive while `fn` runs, in order. */
  async function heard(url: string, fn: () => Promise<void>): Promise<string[]> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const out: string[] = [];
    c.on("notification", (m) => { if (m.channel === CHANNEL) out.push(m.payload ?? ""); });
    await c.query(`listen ${CHANNEL}`);
    try {
      await fn();
      await c.query("select 1"); // a notification sent before this answer has been received by now
    } finally {
      await c.end();
    }
    return out;
  }
  async function run(derive: DeriveShape, second: boolean): Promise<string[]> {
    let out: string[] = [];
    await withDatabase(async (pool, url) => {
      await migrate(pool);
      const chain = makeChain([{ txs: 1 }, { txs: 2 }]);
      const indexer = createIndexer({ pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive });
      await indexer.open();
      try {
        out = await heard(url, async () => {
          await indexer.runOnce();
          if (second) await indexer.deriveOnce();
        });
      } finally {
        await indexer.close();
      }
    });
    return out;
  }

  it("says a block is final and derived in one transaction when stage 2 is inline, in order", async () => {
    expect(await run("inline", false)).toEqual(["final:1", "derived:1", "final:2", "derived:2"]);
  });

  it("says a block is final when stage 1 has it, and derived later when stage 2 is behind", async () => {
    expect(await run("behind", false)).toEqual(["final:1", "final:2"]);
    expect(await run("behind", true)).toEqual(["final:1", "final:2", "derived:1", "derived:2"]);
  });
});
