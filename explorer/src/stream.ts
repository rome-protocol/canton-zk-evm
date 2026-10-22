/**
 * The live stream, `GET /api/stream`: server-sent events, read with `fetch` so that a reconnect can say where it left off (`Last-Event-ID`) the way
 * the server expects, and so that a refusal (a fifth stream is answered with 429) is tried again instead of ending for good.
 */
export const TOPICS = ["blocks", "txs", "inflight", "stats"] as const;
export type Topic = (typeof TOPICS)[number];

export interface StreamEvent { id: number | null; event: string; data: unknown }

/** Splits what has arrived into whole events and what is left of the next one. Comment lines (the server's heartbeat) are dropped. */
export function parseFrames(buffer: string): { events: StreamEvent[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  const events: StreamEvent[] = [];
  for (const part of parts) {
    let id: number | null = null, event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id" && /^\d+$/.test(value)) id = Number(value);
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) continue;
    try {
      events.push({ id, event, data: JSON.parse(data.join("\n")) });
    } catch {
      // An event that is not JSON is not one of the server's.
    }
  }
  return { events, rest };
}

export interface StreamOptions {
  topics: readonly Topic[];
  onEvent: (e: StreamEvent) => void;
  /** True once the stream is open, false while it is down. */
  onState: (live: boolean) => void;
  /** Waits before trying again: the first, and the most it grows to. */
  retryMs?: { first: number; max: number };
}

/** Opens the stream, keeps it open (trying again with a growing wait), and resumes from the last event id it saw. Returns the function that closes it. */
export function openStream({ topics, onEvent, onState, retryMs = { first: 1000, max: 15_000 } }: StreamOptions): () => void {
  const stop = new AbortController();
  let lastId: number | null = null;
  let wait = retryMs.first;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run(): Promise<void> {
    try {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (lastId !== null) headers["Last-Event-ID"] = String(lastId);
      const res = await fetch(`/api/stream?topics=${topics.join(",")}`, { headers, signal: stop.signal });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      onState(true);
      wait = retryMs.first;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const e of parsed.events) {
          if (e.id !== null) lastId = e.id;
          onEvent(e);
        }
      }
    } catch {
      // Down for any reason: the wait below, then another try.
    }
    if (stop.signal.aborted) return;
    onState(false);
    timer = setTimeout(run, wait);
    wait = Math.min(wait * 2, retryMs.max);
  }

  void run();
  return () => {
    stop.abort();
    clearTimeout(timer);
  };
}
