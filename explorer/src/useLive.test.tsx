// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveState } from "./useLive.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const frame = (id: number) => `id: ${id}\nevent: txs\ndata: {"number":${id}}\n\n`;

/** One fetch answer per call: a body held open and closed by the test, or a status. */
function fakeStream(steps: Array<{ status: number } | "open">) {
  const closers: Array<() => void> = [];
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { signal: AbortSignal }) => {
    const step = steps[n++] ?? { status: 503 };
    if (step !== "open") return new Response("{}", { status: step.status });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame(n))); closers.push(() => c.close()); init.signal.addEventListener("abort", () => { try { c.close(); } catch { /* closed */ } }); } }), { status: 200 });
  }));
  return closers;
}

function mount() {
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useLiveState(["blocks", "inflight"]), { wrapper });
  return { ...hook, spy };
}
const keys = (spy: ReturnType<typeof mount>["spy"]) => spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe("the live state", () => {
  it("is connecting until the first try is answered, then live", async () => {
    vi.useFakeTimers();
    fakeStream(["open"]);
    const { result } = mount();
    expect(result.current).toBe("connecting");
    await settle();
    expect(result.current).toBe("live");
  });

  it("reads the status and the in-flight attempts again when the stream comes back, because the server does not replay them", async () => {
    vi.useFakeTimers();
    const closers = fakeStream(["open", "open"]);
    const { result, spy } = mount();
    await settle();
    expect(keys(spy)).not.toContain("in-flight");
    spy.mockClear();
    closers[0]!();
    await settle();
    expect(result.current).toBe("down");
    expect(keys(spy)).not.toContain("in-flight");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current).toBe("live");
    expect(keys(spy)).toEqual(expect.arrayContaining(["in-flight", "status"]));
  });

  it("is off, and stays off, when the server has no stream", async () => {
    vi.useFakeTimers();
    fakeStream([{ status: 404 }, "open"]);
    const { result } = mount();
    await settle();
    expect(result.current).toBe("off");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current).toBe("off");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is down while it is being tried again after a refusal", async () => {
    vi.useFakeTimers();
    fakeStream([{ status: 429 }, "open"]);
    const { result } = mount();
    await settle();
    expect(result.current).toBe("down");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current).toBe("live");
  });
});
