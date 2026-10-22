import { describe, expect, it } from "vitest";
import { ago, howItBecameFinal, secs, type Lifecycle } from "./block-times.ts";

const L: Lifecycle = {
  strategy: "timer", cutReason: "interval", cutAt: "2026-10-20T12:49:08.882Z", builtAt: "2026-10-20T12:49:09.096Z", proofStartedAt: "2026-10-20T12:49:09.120Z",
  proofEndedAt: "2026-10-20T12:49:16.520Z", submittedAt: "2026-10-20T12:49:16.543Z", answeredAt: "2026-10-20T12:49:16.600Z",
};
const RECORD = "2026-10-20T12:49:17.143780Z";

describe("secs", () => {
  it("writes seconds to the places asked", () => {
    expect(secs(7400)).toBe("7.40 s");
    expect(secs(8261.8, 3)).toBe("8.262 s");
    expect(secs(0, 3)).toBe("0.000 s");
  });
});

describe("ago", () => {
  const now = Date.parse("2026-10-20T18:00:00Z");
  it("tells seconds, minutes and hours", () => {
    expect(ago("2026-10-20T17:59:48Z", now)).toBe("12 s ago");
    expect(ago("2026-10-20T17:20:00Z", now)).toBe("40 min ago");
    expect(ago("2026-10-20T12:49:17Z", now)).toBe("5 h 10 min ago");
    expect(ago("2026-10-18T12:00:00Z", now)).toBe("2 d 6 h ago");
  });
  it("never says the future", () => expect(ago("2026-10-20T18:00:05Z", now)).toBe("0 s ago"));
});

describe("howItBecameFinal", () => {
  it("measures the tiles from the journal's times and Canton's record time", () => {
    const h = howItBecameFinal(L, RECORD);
    expect(h.proofMs).toBeCloseTo(7400, 3);
    expect(h.commitMs).toBeCloseTo(600.78, 2);
    expect(h.totalMs).toBeCloseTo(8261.78, 2);
  });

  it("has the six steps, each with its time, what it took and where the time comes from", () => {
    const { steps } = howItBecameFinal(L, RECORD);
    expect(steps.map((s) => s.name)).toEqual(["Cut", "Built", "Proof started", "Proof done", "Sent to Canton", "Final on Canton"]);
    expect(steps.map((s) => s.clock)).toEqual(["12:49:08.882", "12:49:09.096", "12:49:09.120", "12:49:16.520", "12:49:16.543", "12:49:17.143780"]);
    expect(steps.map((s) => s.delta)).toEqual([null, "+0.214 s", "+0.024 s", "+7.400 s", "+0.023 s", "+0.601 s"]);
    expect(steps.map((s) => s.source)).toEqual(["producer log", "producer log", "producer log", "producer log", "producer log", "Canton record time"]);
  });

  it("lays the bar out in parts of the whole, in order", () => {
    const { bar } = howItBecameFinal(L, RECORD);
    expect(bar!.map((p) => p.name)).toEqual(["prepare", "proof", "send", "canton"]);
    expect(bar!.reduce((a, p) => a + p.ms, 0)).toBeCloseTo(8261.78, 2);
  });

  it("says so when the journal has no row, and still gives the record time", () => {
    const h = howItBecameFinal(null, RECORD);
    expect(h.bar).toBeNull();
    expect(h.proofMs).toBeNull();
    expect(h.commitMs).toBeNull();
    expect(h.totalMs).toBeNull();
    const last = h.steps[5]!;
    expect(last.clock).toBe("12:49:17.143780");
    expect(h.steps.slice(0, 5).every((s) => s.clock === null && s.delta === null && s.source === null)).toBe(true);
  });

  it("leaves out a time the journal did not write, and the difference that needs it", () => {
    const h = howItBecameFinal({ ...L, proofStartedAt: null, submittedAt: null }, RECORD);
    expect(h.steps[2]!.clock).toBeNull();
    expect(h.steps[3]!.delta).toBeNull();
    expect(h.proofMs).toBeNull();
    expect(h.commitMs).toBeNull();
    expect(h.totalMs).toBeCloseTo(8261.78, 2);
    expect(h.bar).toBeNull();
  });

  it("has no steps after the first for a block with no record on Canton", () => {
    const h = howItBecameFinal(L, null);
    expect(h.steps[5]!.clock).toBeNull();
    expect(h.totalMs).toBeNull();
  });
});
