import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { TEST_URL, checkRequired, makeDatabase, type TestDatabase } from "../db/testing.ts";
import { createIndexer } from "../indexer/indexer.ts";
import { CHANNEL } from "../indexer/notify.ts";
import { CHAIN_ID, GATEWAY, PINS, makeChain } from "../../test/synthetic-chain.ts";
import { createStreamHub, type Sink, type Topic } from "./stream.ts";
import { createStreamSource, type StreamSource } from "./stream-source.ts";

const all = new Set<Topic>(["blocks", "txs", "inflight", "stats"]);
function client(): Sink & { text: string } {
  const s = { text: "", write(c: string) { s.text += c; }, backlog: () => 0, end() { /* nothing */ } };
  return s;
}
const parse = (text: string) => text.split("\n\n").filter((f) => f && !f.startsWith(":")).map((f) => {
  const l = Object.fromEntries(f.split("\n").map((x) => [x.slice(0, x.indexOf(": ")), x.slice(x.indexOf(": ") + 2)]));
  return { id: l.id ?? null, event: l.event!, data: JSON.parse(l.data!) };
});
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!TEST_URL)("the live stream's source", () => {
  checkRequired();
  let db: TestDatabase | undefined, source: StreamSource | undefined;
  afterEach(async () => { await source?.stop(); await db?.drop(); db = source = undefined; });

  async function open() {
    db = await makeDatabase();
    await migrate(db.pool);
    const chain = makeChain([{ txs: 2 }, { txs: 0 }, { txs: 3 }]);
    const indexer = createIndexer({ pool: db.pool, reads: chain.reads, ledger: chain.ledger, pins: PINS, chainId: CHAIN_ID, gateway: GATEWAY, derive: "behind" });
    const hash = (block: number, i: number) => chain.blocks[block - 1]!.block.transactions[i]!.hash;
    const start = (hub: ReturnType<typeof createStreamHub>, extra: object = {}) => {
      source = createStreamSource({ pool: db!.pool, connection: { connectionString: db!.url }, hub, retryMs: 50, log: () => undefined, ...extra });
      return source.start();
    };
    return { chain, indexer, hash, start };
  }

  it("tells each block the indexer commits, in order, with the transactions' hashes, and then that stage 2 reached it", async () => {
    const { indexer, hash, start } = await open();
    const hub = createStreamHub(), c = client();
    await start(hub);
    hub.attach("1.1.1.1", all, null, c);
    await indexer.open();
    try {
      await indexer.runOnce();
      await until(() => parse(c.text).filter((e) => e.event === "block").length === 3, "three blocks");
      await indexer.deriveOnce();
      await until(() => parse(c.text).filter((e) => e.event === "derived").length === 3, "three derived events");
    } finally {
      await indexer.close();
    }
    const e = parse(c.text);
    expect(e.filter((x) => x.event === "block").map((x) => x.id)).toEqual(["1", "2", "3"]);
    const first = e.find((x) => x.event === "block")!.data;
    expect(Object.keys(first).sort()).toEqual(["hash", "number", "recordTime", "txCount", "updateId"]);
    expect(first.txCount).toBe(2);
    expect(first.updateId).toMatch(/^1220/);
    const txs = e.filter((x) => x.event === "txs");
    expect(txs.map((x) => x.data.hashes)).toEqual([[hash(1, 0), hash(1, 1)], [], [hash(3, 0), hash(3, 1), hash(3, 2)]]);
    // A block's `block` event comes before its `txs`, and blocks come in order.
    expect(e.filter((x) => x.id).map((x) => `${x.id}:${x.event}`)).toEqual(["1:block", "1:txs", "2:block", "2:txs", "3:block", "3:txs"]);
    expect(e.filter((x) => x.event === "derived").map((x) => x.data.number)).toEqual([1, 2, 3]);
  });

  it("is seeded by a restarted instance from the database, so a client resumes after Last-Event-ID", async () => {
    const { indexer, start } = await open();
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }
    const hub = createStreamHub(), quiet = client();
    hub.attach("9.9.9.9", all, null, quiet);
    await start(hub);
    expect(quiet.text).toBe(""); // blocks that were there before are not told as news
    const resumed = client();
    hub.attach("1.1.1.1", new Set<Topic>(["blocks"]), 1, resumed);
    expect(parse(resumed.text).map((x) => x.id)).toEqual(["2", "3"]);
  });

  it("ignores a notification that is not the indexer's, and reads the in-flight state for an inflight one, one at a time", async () => {
    const { start } = await open();
    const hub = createStreamHub(), c = client();
    let reads = 0, release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await start(hub, { inflight: async () => { reads++; if (reads === 1) await gate; return { final: false, attempts: [], read: reads }; } });
    hub.attach("1.1.1.1", all, null, c);
    const notify = (text: string) => db!.pool.query("select pg_notify($1, $2)", [CHANNEL, text]);
    await notify("hello"); await notify("final:abc"); await notify("derived:-3");
    await notify("inflight"); await notify("inflight"); await notify("inflight");
    await until(() => reads === 1, "the first read");
    await new Promise((r) => setTimeout(r, 150)); // the other notices have been heard, and wait for it
    release();
    await until(() => parse(c.text).length >= 2, "two events");
    await new Promise((r) => setTimeout(r, 100));
    // The three notices that came while a read was going share one more read.
    expect(reads).toBe(2);
    expect(parse(c.text).map((x) => [x.event, x.data.read])).toEqual([["inflight", 1], ["inflight", 2]]);
  });

  it("listens again after its connection is cut, and makes up the blocks it missed", async () => {
    const { indexer, start } = await open();
    const hub = createStreamHub(), c = client();
    await start(hub);
    hub.attach("1.1.1.1", all, null, c);
    // Cut the listener, and write the blocks while it is away: whatever it does next must tell all three.
    await db!.pool.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'explorer-stream'");
    await indexer.open();
    try { await indexer.runOnce(); } finally { await indexer.close(); }
    await until(() => parse(c.text).filter((e) => e.event === "block").length === 3, "the missed blocks");
    expect(parse(c.text).filter((e) => e.event === "block").map((x) => x.id)).toEqual(["1", "2", "3"]);
    // And it hears again.
    await db!.pool.query("select pg_notify($1, 'derived:3')", [CHANNEL]);
    await until(() => parse(c.text).some((e) => e.event === "derived"), "a derived event after the reconnect");
  });
});
