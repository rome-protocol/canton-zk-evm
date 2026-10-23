// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, route } from "../test-utils.tsx";

/** What the browser asks the server for before it paints Home, and what it asks for only once it has painted. */
const BUDGET = 3;

/** Holds the browser's paint: a frame callback runs only when the test says the first frame has been drawn. */
function holdFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", Object.assign((cb: FrameRequestCallback) => frames.push(cb), { held: true }));
  return async () => { await act(async () => { for (const f of frames.splice(0)) f(0); await new Promise((r) => setTimeout(r, 20)); }); };
}

const paths = (calls: string[]) => calls.map((c) => c.split("?")[0]!);

describe("Home's first paint", () => {
  it("asks the server for at most three things before the first frame, and the rest after it", async () => {
    const paint = holdFrames();
    const calls = fakeApi(route({}));
    renderApp("/");
    await screen.findByText("Final on Canton");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const before = [...calls];
    expect(before.length).toBeLessThanOrEqual(BUDGET);
    expect(paths(before)).toContain("/api/status");
    for (const late of ["/api/txs", "/api/in-flight", "/api/faucet", "/api/stats/series"]) expect(paths(before)).not.toContain(late);
    await paint();
    await waitFor(() => expect(paths(calls)).toEqual(expect.arrayContaining(["/api/status", "/api/blocks", "/api/txs", "/api/in-flight", "/api/faucet", "/api/stats/summary", "/api/stats/series"])));
  });

  it("reads every one of them once the first frame is drawn, as the page did before", async () => {
    const paint = holdFrames();
    const calls = fakeApi(route({}));
    renderApp("/");
    await screen.findByText("Final on Canton");
    await paint();
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/in-flight"))).toBe(true));
    expect(calls.filter((c) => c.startsWith("/api/stats/summary"))).toEqual(expect.arrayContaining(["/api/stats/summary?window=1h", "/api/stats/summary?window=24h"]));
  });
});
