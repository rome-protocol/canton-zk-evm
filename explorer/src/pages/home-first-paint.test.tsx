// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, route } from "../test-utils.tsx";

/** What the browser asks the server for before it paints Home, and what it asks for only once it has painted. */
const BUDGET = 3;

/** A browser that reports paints: the first contentful paint is reported only when the test says the first frame has been drawn. */
function holdPaint() {
  let report: PerformanceObserverCallback = () => {};
  class Watch { static supportedEntryTypes = ["paint"]; constructor(cb: PerformanceObserverCallback) { report = cb; } observe() {} disconnect() {} }
  vi.stubGlobal("PerformanceObserver", Watch);
  const entry = { name: "first-contentful-paint" } as PerformanceEntry;
  return async () => { await act(async () => { report({ getEntries: () => [entry] } as PerformanceObserverEntryList, {} as PerformanceObserver); await new Promise((r) => setTimeout(r, 20)); }); };
}

const paths = (calls: string[]) => calls.map((c) => c.split("?")[0]!);

describe("Home's first paint", () => {
  it("asks the server for at most three things before the first frame, and the rest after it", async () => {
    const paint = holdPaint();
    const calls = fakeApi(route({}));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const before = [...calls];
    expect(before.length).toBeLessThanOrEqual(BUDGET);
    expect(paths(before)).toContain("/api/status");
    for (const late of ["/api/txs", "/api/in-flight", "/api/faucet", "/api/stats/series"]) expect(paths(before)).not.toContain(late);
    await paint();
    await waitFor(() => expect(paths(calls)).toEqual(expect.arrayContaining(["/api/status", "/api/blocks", "/api/txs", "/api/in-flight", "/api/faucet", "/api/stats/summary", "/api/stats/series"])));
  });

  it("reads every one of them once the first frame is drawn, as the page did before", async () => {
    const paint = holdPaint();
    const calls = fakeApi(route({}));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    await paint();
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/in-flight"))).toBe(true));
    expect(calls.filter((c) => c.startsWith("/api/stats/summary"))).toEqual(expect.arrayContaining(["/api/stats/summary?window=1h", "/api/stats/summary?window=24h"]));
  });
});
