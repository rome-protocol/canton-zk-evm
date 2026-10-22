/**
 * Where the stream's events come from (design 6.4): the indexer's NOTIFY (`indexer/notify.ts`), heard on a connection of its own. A notification
 * only says where to look. The block is read from the database, and told through the hub, which keeps the newest 100 for a client that comes back.
 * Whatever notifications were missed (the connection was down, or the instance was just started) are made up by reading the blocks after the
 * newest one the hub knows, so no block is told twice, none is skipped, and a restarted instance can resume a client.
 */
import pg from "pg";
import { CHANNEL, parseEvent } from "../indexer/notify.ts";
import { hex, US } from "./chain-rest.ts";
import { BUFFER_BLOCKS, TXS_MAX, type BlockEvent, type StreamHub } from "./stream.ts";

export interface StreamSourceOptions {
  pool: pg.Pool;
  /** The connection the listener opens for itself (it holds one connection for as long as the instance runs). */
  connection: pg.ClientConfig;
  hub: StreamHub;
  /** The body of the `inflight` event: what the in-flight route says now. Without it the event says only that something changed. */
  inflight?: () => Promise<unknown>;
  /** How long to wait before listening again after the connection fails. Default 2000. */
  retryMs?: number;
  log?: (line: string) => void;
}

interface Loaded { block: BlockEvent; txs: string[] }

export function createStreamSource(o: StreamSourceOptions) {
  const log = o.log ?? ((l: string) => console.error(l));
  let client: pg.Client | null = null;
  let stopped = false;
  let work: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let inflightBusy = false, inflightAgain = false;
  /** True once the hub has been filled from the database: from then on a block that is not in it is news, even when the hub is empty. */
  let primed = false;

  /** The final blocks after `after` (or the newest `limit` when it is null), oldest first, each with the hashes of its first transactions. */
  async function load(after: number | null, limit: number): Promise<Loaded[]> {
    const rows = (await o.pool.query(
      `select b.number, b.hash, b.tx_count, b.update_id, ${US("b.record_time")} as record_time,
         array(select t.hash from transactions t where t.block_number = b.number order by t.tx_index limit ${TXS_MAX + 1}) as txs
       from blocks b where ($1::bigint is null or b.number > $1) order by b.number ${after === null ? "desc" : "asc"} limit $2`,
      [after, limit],
    )).rows as { number: string; hash: Buffer; tx_count: number; update_id: string | null; record_time: string | null; txs: Buffer[] }[];
    if (after === null) rows.reverse();
    return rows.map((r) => ({
      block: { number: Number(r.number), hash: hex(r.hash), txCount: Number(r.tx_count), recordTime: r.record_time, updateId: r.update_id },
      txs: r.txs.map(hex),
    }));
  }

  /** Tells every block the hub has not told yet, oldest first. A hub with nothing in it is filled from the newest blocks, and tells nobody. */
  async function catchUp(): Promise<void> {
    for (;;) {
      const after = primed ? (o.hub.newest() ?? -1) : null;
      const found = await load(after, BUFFER_BLOCKS);
      if (after === null) { o.hub.seed(found); primed = true; return; }
      if (!found.length) return;
      for (const { block, txs } of found) o.hub.publishBlock(block, txs);
      if (found.length < BUFFER_BLOCKS) return;
    }
  }

  async function sendInflight(): Promise<void> {
    if (inflightBusy) { inflightAgain = true; return; }
    inflightBusy = true;
    try {
      do {
        inflightAgain = false;
        o.hub.publish("inflight", "inflight", o.inflight ? await o.inflight() : { changed: true });
      } while (inflightAgain && !stopped);
    } finally {
      inflightBusy = false;
    }
  }

  /** Handles one notification after the one before it is done, so the events go out in the order the indexer sent them. */
  function heard(text: string | undefined): void {
    const e = parseEvent(text);
    if (!e || stopped) return;
    // The in-flight state is read on its own: notices that come while a read is going share the next one.
    if (e.kind === "inflight") return void sendInflight().catch((err: Error) => log(`explorer: the live stream could not read the in-flight state: ${err.message}`));
    work = work.then(async () => {
      if (stopped) return;
      if (e.kind === "final") await catchUp();
      else o.hub.publish("blocks", "derived", { number: e.number });
    }).catch((err: Error) => log(`explorer: the live stream could not read ${text}: ${err.message}`));
  }

  async function listen(): Promise<void> {
    if (stopped) return;
    const c = new pg.Client({ ...o.connection, application_name: "explorer-stream" });
    let down = false;
    const lost = (why: string) => {
      if (down) return;
      down = true;
      if (client === c) client = null;
      c.end().catch(() => undefined);
      if (stopped) return;
      log(`explorer: the live stream lost its connection to the database (${why}); listening again`);
      timer = setTimeout(() => void listen(), o.retryMs ?? 2000);
    };
    c.on("error", (e) => lost(e.message));
    c.on("end", () => lost("closed"));
    c.on("notification", (m) => { if (m.channel === CHANNEL) heard(m.payload); });
    try {
      await c.connect();
      if (stopped) return void (await c.end());
      client = c;
      await c.query(`listen ${CHANNEL}`);
      // Anything that happened before the listening began, or while the last connection was down.
      work = work.then(() => catchUp()).catch((err: Error) => log(`explorer: the live stream could not read the newest blocks: ${err.message}`));
      await work;
    } catch (e) {
      lost((e as Error).message);
    }
  }

  return {
    /** Starts listening, and returns when the newest blocks are read (or the first try failed, which is retried). */
    start: listen,
    /** Stops listening; what is being told is finished first. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await work.catch(() => undefined);
      const c = client;
      client = null;
      await c?.end().catch(() => undefined);
    },
  };
}
export type StreamSource = ReturnType<typeof createStreamSource>;
