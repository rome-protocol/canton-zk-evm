// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { InFlightAttempt, InFlightTx } from "../api.ts";
import { inFlight, T0 } from "../test-utils.tsx";
import type { StreamState } from "../useLive.ts";
import type { Read } from "../stats.ts";
import { InFlightPanel } from "./InFlight.tsx";

const show = (attempts: InFlightAttempt[], waiting: number | null, stream: StreamState = "live", read: Read = "ok", extra: { usual?: { lowMs: number; highMs: number } | null; later?: InFlightTx[] } = {}) => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime((T0 + 21) * 1000);
  render(<MemoryRouter><InFlightPanel attempts={attempts} waiting={waiting} stream={stream} read={read} {...extra} /></MemoryRouter>);
};
const steps = (n: number) => within(screen.getByRole("list", { name: `Steps of block ${n}` })).getAllByRole("listitem");

describe("the in-flight panel", () => {
  it("says it is not final, and shows a block being proven with the time of each step", () => {
    show(inFlight().attempts, 1);
    expect(screen.getByText(/Not final yet\. These can still change/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "4" })).toHaveAttribute("href", "/block/4");
    expect(screen.getByText("3 transactions")).toBeInTheDocument();
    expect(screen.getByText("Being proven", { selector: ".chip" })).toBeInTheDocument();
    const s = steps(4);
    expect(s).toHaveLength(5);
    expect(s[0]).toHaveClass("done");
    expect(s[1]).toHaveClass("done");
    expect(s[1]).toHaveTextContent("01:37:24.200 · +0.20 s");
    expect(s[2]).toHaveClass("now");
    expect(s[2]).toHaveTextContent("4 s so far");
    expect(s[3]).toHaveTextContent("—");
    expect(s[4]).not.toHaveClass("done");
  });

  it("says how long a proof usually takes, from the served blocks, under the step being proven and tagged as the producer's log", () => {
    show(inFlight().attempts, 1, "live", "ok", { usual: { lowMs: 7000, highMs: 7700 } });
    expect(steps(4)[2]).toHaveTextContent("usually 7.0–7.7 s");
    expect(within(steps(4)[2]!).getByText("producer log")).toHaveClass("tag");
  });

  it("says nothing about a usual time when none is served", () => {
    show(inFlight().attempts, 1, "live", "ok", { usual: null });
    expect(steps(4)[2]).not.toHaveTextContent("usually");
  });

  it("names the transaction that arrived after the newest block was cut, and the block that takes it", () => {
    const cut = inFlight().attempts[0]!.cutAt;
    const later: InFlightTx[] = [{ hash: "0x" + "55".repeat(32), stage: "waiting", at: new Date(Date.parse(cut) + 2000).toISOString() }, { hash: "0x" + "66".repeat(32), stage: "waiting", at: new Date(Date.parse(cut) - 2000).toISOString() }];
    show(inFlight().attempts, 2, "live", "ok", { later });
    const line = screen.getByText(/arrived after this block was cut/);
    expect(line).toHaveTextContent("1 more transaction, 0x555555…5555, arrived after this block was cut. It waits for block 5, which is cut when block 4 is final.");
    expect(within(line).getByRole("link", { name: "0x555555…5555" })).toHaveAttribute("href", `/tx/0x${"55".repeat(32)}`);
  });

  it("counts several that arrived after the cut, without naming them", () => {
    const cut = inFlight().attempts[0]!.cutAt;
    const at = new Date(Date.parse(cut) + 2000).toISOString();
    show(inFlight().attempts, 2, "live", "ok", { later: [{ hash: "0x" + "55".repeat(32), stage: "waiting", at }, { hash: "0x" + "66".repeat(32), stage: "waiting", at }] });
    expect(screen.getByText(/arrived after this block was cut/)).toHaveTextContent("2 more transactions arrived after this block was cut. They wait for block 5, which is cut when block 4 is final.");
  });

  it("marks the proof done once it ended and the block is waiting to be sent", () => {
    const a = { ...inFlight().attempts[0]!, stage: "proved" as const, proofEndedAt: new Date((T0 + 24) * 1000).toISOString() };
    show([a], 0);
    expect(steps(4)[2]).toHaveClass("done");
    expect(steps(4)[2]).toHaveTextContent("done in 7 s");
    expect(steps(4)[3]).toHaveClass("now");
  });

  it("counts the transactions waiting in the pool, and has an empty state", () => {
    show(inFlight().attempts, 2);
    expect(screen.getByText(/2 transactions are waiting in the pool, in no block yet/)).toBeInTheDocument();
  });

  it("says nothing is in flight, and whether the stream is live", () => {
    show([], 0, "down");
    expect(screen.getByText("Nothing is in flight: every block made so far is final.")).toBeInTheDocument();
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });

  it("says what the stream is doing: connecting, live, down, or off with a poll every 5 s", () => {
    for (const [stream, word] of [["connecting", "connecting…"], ["live", "updates live"], ["down", "reconnecting…"], ["off", "updates every 5 s"]] as const) {
      const { unmount } = render(<MemoryRouter><InFlightPanel attempts={[]} waiting={0} stream={stream} /></MemoryRouter>);
      expect(screen.getByText(word)).toBeInTheDocument();
      unmount();
    }
  });

  it("never says the blocks are final while it is reading, or when it cannot read", () => {
    show([], null, "live", "loading");
    expect(screen.getByText("Reading…")).toBeInTheDocument();
    expect(screen.queryByText(/every block made so far is final/)).toBeNull();
  });

  it("says each block's own word: being built before the proof, being proven after, not indexed once Canton has it", () => {
    const base = inFlight().attempts[0]!;
    show([{ ...base, number: 4, stage: "built", proofStartedAt: null }, { ...base, number: 5, stage: "proving" }, { ...base, number: 6, stage: "committed", proofEndedAt: base.proofStartedAt, submittedAt: base.builtAt }], 0);
    expect(screen.getByText("Being built", { selector: ".chip" })).toBeInTheDocument();
    expect(screen.getByText("Being proven", { selector: ".chip" })).toBeInTheDocument();
    expect(screen.getByText("Not indexed yet", { selector: ".chip" })).toBeInTheDocument();
    expect(steps(6)[4]).toHaveClass("done");
  });
});
