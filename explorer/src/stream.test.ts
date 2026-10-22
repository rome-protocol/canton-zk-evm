import { afterEach, describe, expect, it, vi } from "vitest";
import { openStream, parseFrames, type StreamEvent } from "./stream.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const BLOCK = (n: number) => `id: ${n}\nevent: block\ndata: ${JSON.stringify({ number: n })}\n\n`;

describe("parseFrames", () => {
  it("reads whole events, keeps the start of the next, and drops comment lines", () => {
    const { events, rest } = parseFrames(`: ping\n\n${BLOCK(7)}event: stats\ndata: {"at":"x"}\n\nid: 8\nevent: bl`);
    expect(events).toEqual([{ id: 7, event: "block", data: { number: 7 } }, { id: null, event: "stats", data: { at: "x" } }]);
    expect(rest).toBe("id: 8\nevent: bl");
  });

  it("ignores an event that is not JSON", () => {
    expect(parseFrames("event: block\ndata: nope\n\n").events).toEqual([]);
  });
});

/** A fake server: each call of fetch is answered by the next step, which is a body to stream or a status to refuse with. */
function server(steps: Array<{ chunks: string[]; hold?: boolean } | { status: number }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url, headers: init.headers });
    const step = steps[calls.length - 1] ?? { status: 503 };
    if ("status" in step) return new Response("{}", { status: step.status });
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      start(c) {
        for (const chunk of step.chunks) c.enqueue(enc.encode(chunk));
        if (!step.hold) c.close();
        init.signal.addEventListener("abort", () => { try { c.close(); } catch { /* closed already */ } });
      },
    }), { status: 200 });
  }));
  return calls;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("openStream", () => {
  it("asks for its topics and hands over each event, even when one arrives in two pieces", async () => {
    vi.useFakeTimers();
    const calls = server([{ chunks: [BLOCK(5).slice(0, 12), BLOCK(5).slice(12), BLOCK(6)], hold: true }]);
    const seen: StreamEvent[] = [], states: boolean[] = [];
    const close = openStream({ topics: ["blocks", "inflight"], onEvent: (e) => seen.push(e), onState: (s) => states.push(s) });
    await flush();
    expect(calls[0]!.url).toBe("/api/stream?topics=blocks,inflight");
    expect(calls[0]!.headers["Last-Event-ID"]).toBeUndefined();
    expect(seen.map((e) => e.id)).toEqual([5, 6]);
    expect(states).toEqual([true]);
    close();
  });

  it("reconnects after the stream ends, says where it left off, and goes back to live", async () => {
    vi.useFakeTimers();
    const calls = server([{ chunks: [BLOCK(9)] }, { chunks: [BLOCK(10)], hold: true }]);
    const seen: number[] = [], states: boolean[] = [];
    const close = openStream({ topics: ["blocks"], onEvent: (e) => seen.push(e.id!), onState: (s) => states.push(s), retryMs: { first: 1000, max: 4000 } });
    await flush();
    expect(states).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["Last-Event-ID"]).toBe("9");
    expect(seen).toEqual([9, 10]);
    expect(states).toEqual([true, false, true]);
    close();
  });

  it("tries again, with a growing wait, after a refusal such as the limit of streams", async () => {
    vi.useFakeTimers();
    const calls = server([{ status: 429 }, { status: 429 }, { chunks: [], hold: true }]);
    const states: boolean[] = [];
    const close = openStream({ topics: ["blocks"], onEvent: () => {}, onState: (s) => states.push(s), retryMs: { first: 1000, max: 4000 } });
    await flush();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    expect(states.at(-1)).toBe(true);
    close();
  });

  it("stops for good when it is closed", async () => {
    vi.useFakeTimers();
    const calls = server([{ chunks: [BLOCK(1)] }]);
    const close = openStream({ topics: ["blocks"], onEvent: () => {}, onState: () => {}, retryMs: { first: 1000, max: 4000 } });
    await flush();
    close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });
});
