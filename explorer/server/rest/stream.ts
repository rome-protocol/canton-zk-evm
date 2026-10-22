/**
 * Live updates (design 6.4): the hub behind `GET /api/stream`. It keeps the newest blocks in a bounded buffer so that a client that reconnects
 * with `Last-Event-ID` gets what it missed, tells each connected client the events of the topics it asked for, and limits how many streams a
 * client and the instance hold. It does no I/O of its own: a client is a `Sink`, and the events are put in by `stream-source.ts`.
 *
 * Events: `block` and `txs` carry the block's number as their id (so the id is resumable); `derived` (stage 2 has the block), `inflight` and
 * `stats` have none, and are not replayed: a page that reconnects reads their state from the REST routes.
 */
export const TOPICS = ["blocks", "txs", "inflight", "stats"] as const;
export type Topic = (typeof TOPICS)[number];

/** Blocks kept for a client that comes back: design 6.4 says up to 100. */
export const BUFFER_BLOCKS = 100;
export const PER_CLIENT = 4, PER_INSTANCE = 5000;
/** Transaction hashes in a `txs` event. */
export const TXS_MAX = 50;
/** A client that has this many bytes waiting is too slow to keep, and is dropped (its page reconnects and resumes). */
export const BACKLOG_MAX = 1 << 20;

export interface BlockEvent { number: number; hash: string; txCount: number; recordTime: string | null; updateId: string | null }

/** Where a client's bytes go. */
export interface Sink { write(chunk: string): void; backlog(): number; end(): void }

interface Event { id: number | null; event: string; topic: Topic; data: unknown }

const frame = (e: Event): string => `${e.id === null ? "" : `id: ${e.id}\n`}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;

/** The client a connection counts as: its address, and for IPv6 its whole /64 (design 6.6). */
export function clientKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":") + "::/64";
}

export interface HubOptions { buffer?: number; perClient?: number; perInstance?: number; now?: () => number }

export type Attached = { ok: true; detach(): void } | { ok: false; error: string };

export function createStreamHub(o: HubOptions = {}) {
  const keep = o.buffer ?? BUFFER_BLOCKS, perClient = o.perClient ?? PER_CLIENT, perInstance = o.perInstance ?? PER_INSTANCE, now = o.now ?? Date.now;
  const buffer: { number: number; events: Event[] }[] = [];
  interface Client { key: string; topics: ReadonlySet<Topic>; sink: Sink }
  const clients = new Set<Client>();
  const perKey = new Map<string, number>();

  const newest = (): number | null => buffer.at(-1)?.number ?? null;

  function remember(b: BlockEvent, txs: readonly string[]): Event[] | null {
    if (buffer.length && b.number <= newest()!) return null; // already told: a replay, or a block that came twice
    const events: Event[] = [
      { id: b.number, event: "block", topic: "blocks", data: { number: b.number, hash: b.hash, txCount: b.txCount, recordTime: b.recordTime, updateId: b.updateId } },
      { id: b.number, event: "txs", topic: "txs", data: { number: b.number, hashes: txs.slice(0, TXS_MAX), more: txs.length > TXS_MAX } },
    ];
    buffer.push({ number: b.number, events });
    if (buffer.length > keep) buffer.splice(0, buffer.length - keep);
    return events;
  }

  function drop(c: Client): void {
    if (!clients.delete(c)) return;
    const left = (perKey.get(c.key) ?? 1) - 1;
    if (left > 0) perKey.set(c.key, left); else perKey.delete(c.key);
  }

  function send(c: Client, chunk: string): void {
    try {
      c.sink.write(chunk);
      if (c.sink.backlog() > BACKLOG_MAX) { drop(c); c.sink.end(); }
    } catch {
      drop(c);
    }
  }

  function tell(e: Event): void {
    const text = frame(e);
    for (const c of [...clients]) if (c.topics.has(e.topic)) send(c, text);
  }

  return {
    /** A new final block: kept for a client that comes back, and told to the clients now. False when it was told already. */
    publishBlock(b: BlockEvent, txs: readonly string[]): boolean {
      const events = remember(b, txs);
      if (!events) return false;
      for (const e of events) tell(e);
      return true;
    },
    /** Fills the buffer, oldest first, without telling anyone: what a restarted instance knows of the blocks before it came up. */
    seed(blocks: { block: BlockEvent; txs: readonly string[] }[]): void {
      for (const { block, txs } of blocks) remember(block, txs);
    },
    /** An event that has no id: stage 2 reached a block (`derived`), or an attempt changed step (`inflight`). */
    publish(topic: Topic, event: string, data: unknown): void {
      tell({ id: null, event, topic, data });
    },
    /** The `stats` event: the newest block this instance knows, and the time. Every 5 s (see `start`). */
    stats(): void {
      tell({ id: null, event: "stats", topic: "stats", data: { finalBlock: newest(), at: new Date(now()).toISOString() } });
    },
    /** A comment line, which keeps a proxy from closing a quiet stream. */
    heartbeat(): void {
      for (const c of [...clients]) send(c, ": keep-alive\n\n");
    },
    /** Adds a client. The blocks after `lastId` that the buffer still has go first, in order; then what happens. Refused when the client or the instance is full. */
    attach(ip: string, topics: ReadonlySet<Topic>, lastId: number | null, sink: Sink): Attached {
      const key = clientKey(ip);
      if ((perKey.get(key) ?? 0) >= perClient) return { ok: false, error: `This client already has ${perClient} streams open. Close one and try again.` };
      if (clients.size >= perInstance) return { ok: false, error: "This explorer has all the streams it holds open. Try again in a moment." };
      const c: Client = { key, topics, sink };
      clients.add(c);
      perKey.set(key, (perKey.get(key) ?? 0) + 1);
      if (lastId !== null) {
        for (const b of buffer) if (b.number > lastId) for (const e of b.events) if (topics.has(e.topic) && clients.has(c)) send(c, frame(e));
      }
      return { ok: true, detach: () => drop(c) };
    },
    count: () => clients.size,
    newest,
    /** Ends every stream (the server is shutting down). */
    close(): void {
      for (const c of [...clients]) { drop(c); try { c.sink.end(); } catch { /* the client is gone already */ } }
    },
  };
}
export type StreamHub = ReturnType<typeof createStreamHub>;

/** Every 15 s a comment, every 5 s the stats event: the timers of a running instance (they do not hold the process open). */
export function startStreamTimers(hub: StreamHub, heartbeatMs = 15_000, statsMs = 5_000): () => void {
  const timers = [setInterval(() => hub.heartbeat(), heartbeatMs), setInterval(() => hub.stats(), statsMs)];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}

/** `topics` from the query: absent or empty means all of them; a name that is not a topic is refused (null). */
export function topicsOf(raw: string | null): Set<Topic> | null {
  if (raw === null || raw === "") return new Set(TOPICS);
  const out = new Set<Topic>();
  for (const t of raw.split(",")) {
    if (!(TOPICS as readonly string[]).includes(t)) return null;
    out.add(t as Topic);
  }
  return out;
}

/** The `Last-Event-ID` header as a block number, or null when it is absent or not one. */
export function lastIdOf(header: string | string[] | undefined): number | null {
  const v = Array.isArray(header) ? header[0] : header;
  return v !== undefined && /^(0|[1-9][0-9]{0,15})$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
}
