import { describe, expect, it } from "vitest";
import type { Deposit } from "../other/reads.ts";
import { asset, on, requested, taken } from "./fakes.ts";
import { viewOfMove } from "./view.ts";

const T = (hhmm: string) => Date.parse(`2026-11-22T${hhmm}:00.000Z`);
const dep = (stage: Deposit["stage"], over: Partial<Deposit> = {}): Deposit => ({ stage, sentAt: null, confirmedAt: null, readyAt: null, ...over });
const setup = on({ time: { minSeconds: 480, maxSeconds: 960 } });
const a = asset();
const states = (v: ReturnType<typeof viewOfMove>) => v.steps.map((s) => `${s.key}:${s.state}`);

describe("a move signed on Canton that Ostia has not taken", () => {
  it("shows the first step done with its time, the second now, and says nothing of a wait before the set time", () => {
    const v = viewOfMove(requested(), null, setup, a, false, T("21:45"));
    expect(v.phase).toBe("sent");
    expect(v.title).toBe("Sending 5 CC to Ethereum Sepolia");
    expect(states(v)).toEqual(["sent:done", "through:now", "confirmed:todo", "arrived:todo"]);
    expect(v.steps[0]!.detail).toBe("21:40 UTC");
    expect(v.note).toBeNull();
    expect(v.progress).toBe("5 min of about 16");
    expect(v.marksOf).toBeNull();
  });
  it("says it is not taken yet, with its real end, once the set time has passed", () => {
    const v = viewOfMove(requested(), null, setup, a, false, T("21:51"));
    expect(v.phase).toBe("not-taken");
    expect(v.note).toBe("Not taken yet. If it is not taken by 23:40 UTC, your 5 CC is free again in your Canton account.");
    expect(v.word).toBe("Not taken yet");
    expect(v.open).toBe(true);
  });
  it("says it did not move, and that the coin is free again, once its end has passed", () => {
    const v = viewOfMove(requested(), null, setup, a, false, T("23:41"));
    expect(v.phase).toBe("lapsed");
    expect(v.note).toBe("Not moved. Your 5 CC is free again in your Canton account.");
    expect(v.open).toBe(false);
    expect(v.claimable).toBe(false);
    expect(states(v)).toEqual(["sent:done", "through:todo", "confirmed:todo", "arrived:todo"]);
  });
  it("is not 'not taken yet' with no end known: it cannot name a time it does not have", () => {
    const v = viewOfMove(requested({ settleBefore: null }), null, setup, a, false, T("22:30"));
    expect(v.note).toBeNull();
    expect(v.phase).toBe("not-taken");
  });
  it("names no amount it does not have", () => {
    expect(viewOfMove(requested({ amount: null }), null, setup, a, false, T("21:45")).title).toBe("Sending CC to Ethereum Sepolia");
  });
});

describe("a move Ostia took", () => {
  it("is through Ostia with the block and the marks of its transaction, until the bridge says it is confirmed", () => {
    for (const d of [null, dep("unknown"), dep("sent"), dep("confirmed")]) {
      const v = viewOfMove(taken(), d, setup, a, false, T("21:50"));
      expect(v.phase).toBe("through");
      expect(states(v)).toEqual(["sent:done", "through:done", "confirmed:now", "arrived:todo"]);
      expect(v.steps[1]!.detail).toBe("block 88,214");
      expect(v.marksOf).toBe("0x" + "ab".repeat(32));
      expect(v.action).toBeNull();
    }
  });
  it("is confirmed on Ethereum Sepolia once the send is ready to claim there, with the bridge's time, and offers no claim of its own at first", () => {
    const v = viewOfMove(taken(), dep("ready", { readyAt: "2026-11-22T21:52:00Z" }), setup, a, false, T("21:54"));
    expect(v.phase).toBe("confirmed");
    expect(states(v)).toEqual(["sent:done", "through:done", "confirmed:done", "arrived:todo"]);
    expect(v.steps[2]!.detail).toBe("21:52 UTC");
    expect(v.action).toBeNull();
    expect(v.claimable).toBe(false);
    expect(v.progress).toBeNull();
  });
  it("offers the person's own claim once it has been ready for the set time, with the design's words", () => {
    const v = viewOfMove(taken(), dep("ready", { readyAt: "2026-11-22T21:52:00Z" }), setup, a, false, T("21:58"));
    expect(v.phase).toBe("ready");
    expect(v.note).toBe("Ready to claim on Ethereum Sepolia. You can claim it now with your wallet.");
    expect(v.action).toEqual({ label: "Claim on Ethereum Sepolia", note: "Your wallet switches to Ethereum Sepolia. Its fee is paid in Sepolia ETH." });
    expect(v.claimable).toBe(true);
  });
  it("offers no claim of its own without a time for when it was ready, or while the claim the browser asked for is on its way", () => {
    expect(viewOfMove(taken(), dep("ready"), setup, a, false, T("23:00")).action).toBeNull();
    const v = viewOfMove(taken(), dep("ready", { readyAt: "2026-11-22T21:52:00Z" }), setup, a, true, T("23:00"));
    expect(v.phase).toBe("claiming");
    expect(v.action).toBeNull();
    expect(states(v)).toEqual(["sent:done", "through:done", "confirmed:done", "arrived:now"]);
  });
  it("has arrived once the bridge says it was paid out, and says what the wallet got on Ethereum Sepolia", () => {
    const v = viewOfMove(taken(), dep("claimed", { readyAt: "2026-11-22T21:52:00Z" }), setup, a, false, T("22:30"));
    expect(v.phase).toBe("arrived");
    expect(v.title).toBe("Arrived. 4.8 CC is in your wallet on Ethereum Sepolia.");
    expect(states(v)).toEqual(["sent:done", "through:done", "confirmed:done", "arrived:done"]);
    expect(v.open).toBe(false);
    expect(v.action).toBeNull();
    expect(v.marksOf).toBeNull();
  });
  it("shows no time while the setup carries none", () => {
    expect(viewOfMove(taken(), null, on(), a, false, T("21:50")).progress).toBeNull();
  });
});

describe("the words of every state", () => {
  const all = [
    viewOfMove(requested(), null, setup, a, false, T("21:45")), viewOfMove(requested(), null, setup, a, false, T("21:51")), viewOfMove(requested(), null, setup, a, false, T("23:41")),
    viewOfMove(taken(), null, setup, a, false, T("21:50")), viewOfMove(taken(), dep("ready", { readyAt: "2026-11-22T21:52:00Z" }), setup, a, false, T("21:54")),
    viewOfMove(taken(), dep("ready", { readyAt: "2026-11-22T21:52:00Z" }), setup, a, false, T("21:58")), viewOfMove(taken(), dep("claimed"), setup, a, false, T("22:30")),
  ];
  it("never say Receive, pending, gas, or that Rome or anyone will act, and use none of the builder's words", () => {
    const text = all.flatMap((v) => [v.title, v.word, v.note, v.progress, v.action?.label, v.action?.note, ...v.steps.flatMap((x) => [x.label, x.detail])]).join(" | ");
    for (const bad of [/receive/i, /pending/i, /\bgas\b/i, /rome will/i, /will (claim|send|take)/i, /certificate|exit root|proof|\bGER\b|inbox|relayer|label/i]) expect(text).not.toMatch(bad);
  });
});
