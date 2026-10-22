// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { InFlightAttempt } from "../api.ts";
import { inFlight, T0 } from "../test-utils.tsx";
import { InFlightPanel } from "./InFlight.tsx";

const show = (attempts: InFlightAttempt[], waiting: number | null, live = true) => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime((T0 + 21) * 1000);
  render(<MemoryRouter><InFlightPanel attempts={attempts} waiting={waiting} live={live} /></MemoryRouter>);
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
    show([], null, false);
    expect(screen.getByText("Nothing is in flight: every block made so far is final.")).toBeInTheDocument();
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
  });
});
