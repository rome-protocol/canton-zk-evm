// @vitest-environment jsdom
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { blockItem, inFlight, page, renderApp, reply, route, status, txItem } from "../test-utils.tsx";

/** A fetch that answers the API from `state` and holds `/api/stream` open, so that a test can send it events. */
function live() {
  const state = { blocks: [blockItem(3), blockItem(2)], attempts: inFlight().attempts, waiting: 1 };
  const enc = new TextEncoder();
  let push: (text: string) => void = () => {};
  const urls: string[] = [];
  const api = route({
    blocks: () => reply(page(state.blocks)),
    txs: () => reply(page(state.blocks.map((b) => txItem(b.number)))),
    inFlight: () => reply(inFlight({ attempts: state.attempts, poolWaiting: { waiting: state.waiting, at: "2026-10-04T01:37:25.000Z" } })),
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    urls.push(input);
    if (input.startsWith("/api/stream")) {
      return new Response(new ReadableStream({ start(c) { push = (t) => c.enqueue(enc.encode(t)); } }), { status: 200 });
    }
    const a = api(input);
    return new Response(JSON.stringify(a.body), { status: a.status });
  }));
  return { state, urls, send: async (text: string) => { await act(async () => { push(text); await new Promise((r) => setTimeout(r, 30)); }); } };
}
const blockRows = () => within(screen.getByRole("region", { name: "Latest final blocks" })).getAllByRole("row").slice(1);

describe("the home page, live", () => {
  it("asks for the stream with every topic, and says the updates are live once it is open", async () => {
    const { urls } = live();
    renderApp("/");
    expect(await screen.findByText("updates live")).toBeInTheDocument();
    expect(urls).toContain("/api/stream?topics=blocks,txs,inflight,stats");
  });

  it("draws a new final block when the stream says there is one, with no timer running", async () => {
    const { state, send } = live();
    renderApp("/");
    await screen.findByText("updates live");
    expect(blockRows()).toHaveLength(2);
    state.blocks = [blockItem(4), ...state.blocks];
    state.attempts = [];
    state.waiting = 0;
    await send(`id: 4\nevent: block\ndata: ${JSON.stringify({ number: 4 })}\n\n`);
    await vi.waitFor(() => expect(blockRows()).toHaveLength(3));
    expect(within(blockRows()[0]!).getByRole("link", { name: "4" })).toHaveAttribute("href", "/block/4");
    expect(await screen.findByText("Nothing is in flight: every block made so far is final.")).toBeInTheDocument();
  });

  it("moves the in-flight panel on an inflight event, and labels it not final", async () => {
    const { state, send } = live();
    renderApp("/");
    expect(await screen.findByText(/Not final yet\. These can still change/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Steps of block 4" })).toBeInTheDocument();
    state.attempts = [{ ...state.attempts[0]!, stage: "submitted", proofEndedAt: "2026-10-04T01:37:31.000Z", submittedAt: "2026-10-04T01:37:31.500Z" }];
    await send(`event: inflight\ndata: ${JSON.stringify({ number: 4 })}\n\n`);
    const steps = within(screen.getByRole("list", { name: "Steps of block 4" })).getAllByRole("listitem");
    expect(steps[3]).toHaveClass("now");
    expect(steps[3]).toHaveTextContent("01:37:31.500");
  });

  it("falls back to asking every few seconds while the stream is down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      calls.push(input);
      if (input.startsWith("/api/stream")) return new Response("{}", { status: 429 });
      const a = route({ status: () => reply(status()) })(input);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }));
    renderApp("/");
    expect(await screen.findByText("reconnecting…")).toBeInTheDocument();
    const before = calls.filter((c) => c.startsWith("/api/blocks")).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5200); });
    expect(calls.filter((c) => c.startsWith("/api/blocks")).length).toBeGreaterThan(before);
  });
});
