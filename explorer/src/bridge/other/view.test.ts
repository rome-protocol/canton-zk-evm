import { describe, expect, it } from "vitest";
import type { Transfer } from "./record.ts";
import { stage, ME, ostia, row, hash } from "./fakes.ts";
import { viewOf } from "./view.ts";
import { elapsedWords, otherWords, timeWords } from "./words.ts";
import { ReadError } from "./reads.ts";
import { Stop, Unsure } from "./transfer.ts";

const AMOUNT = "2000000000000000";
const attempt = (tx: string | null) => ({ chainId: 1, to: "0x" + "52".repeat(20), data: "0x12" as const, value: "0", nonce: 1, tx: tx as `0x${string}` | null });
const base = (over: Partial<Transfer> = {}): Transfer => ({ id: "a", account: ME, at: Date.parse("2026-11-22T21:40:00Z"), route: "sepolia", dir: "in", symbol: "ETH", decimals: 18, native: true, amount: AMOUNT, send: attempt(hash(1)), count: null, claim: null, ...over });
const names = (over = {}) => ({ ostia, other: row(over), ostiaCoin: "tROME" });
const at = (t: Transfer, d = stage("unknown"), n = names(), now = Date.parse("2026-11-22T21:44:00Z")) => viewOf(t, d, n, now);
const states = (v: ReturnType<typeof at>) => v.steps.map((s) => `${s.state}:${s.label}${s.detail ? ` (${s.detail})` : ""}`);

describe("Ethereum Sepolia to Ostia", () => {
  it("is not sent until the wallet is asked, and offers the send again", () => {
    const v = at(base({ send: null }));
    expect(v.phase).toBe("unsent");
    expect(v.action).toEqual({ kind: "send", label: "Send to Ostia", note: null });
    expect(v.word).toBe("Not sent");
  });
  it("waits for the send to be in a block, then for the deposit to reach Ostia", () => {
    expect(states(at(base()))).toEqual(["now:Sent on Ethereum Sepolia (Confirming…)", "todo:Ready to claim on Ostia", "todo:Claim on Ostia", "todo:Arrived"]);
    const v = at(base({ count: 3 }), stage("confirmed"));
    expect(states(v)).toEqual(["done:Sent on Ethereum Sepolia (21:40 UTC)", "now:Ready to claim on Ostia (Confirming…)", "todo:Claim on Ostia", "todo:Arrived"]);
    expect(v).toMatchObject({ phase: "waiting", word: "Sent", title: "Sending 0.002 ETH to Ostia", action: null, claimable: false, open: true });
  });
  it("is the person's move when it is ready: Claim on Ostia, paid in tROME", () => {
    const v = at(base({ count: 3 }), stage("ready"));
    expect(states(v)).toEqual(["done:Sent on Ethereum Sepolia (21:40 UTC)", "done:Ready to claim on Ostia (21:46 UTC)", "now:Claim on Ostia (Your move)", "todo:Arrived"]);
    expect(v.action).toEqual({ kind: "claim", label: "Claim on Ostia", note: "Your wallet switches to Ostia. Its fee is paid in tROME." });
    expect(v).toMatchObject({ word: "Ready to claim", claimable: true });
  });
  it("shows the claim on its way, and then that it arrived as WETH", () => {
    expect(at(base({ count: 3, claim: attempt(hash(2)) }), stage("ready"))).toMatchObject({ phase: "claiming", word: "Claiming", action: null, marksOf: "claim" });
    const v = at(base({ count: 3, claim: attempt(hash(2)), done: Date.parse("2026-11-22T21:50:00Z") }), stage("claimed"));
    expect(v).toMatchObject({ phase: "arrived", word: "Arrived", title: "Arrived. 0.002 WETH is in your wallet.", open: false });
    expect(states(v).at(-1)).toBe("done:Arrived (21:50 UTC)");
  });
  it("says Arrived when the bridge says it is paid out, even if this browser did not make the claim", () => {
    expect(at(base({ count: 3 }), stage("claimed"))).toMatchObject({ phase: "arrived", word: "Arrived" });
  });
  it("goes straight on, with no Claim to press, where a worker makes the claim", () => {
    const v = at(base({ count: 3 }), stage("ready"), names({ claimedForYou: { ostia: true, remote: false } }));
    expect(v).toMatchObject({ action: null, claimable: false, note: { text: "It is on its way to your wallet.", bad: false } });
    expect(v.steps[2]!.detail).toBeNull();
  });
  it("says again that a claim did not go through, and offers it again", () => {
    const v = at(base({ count: 3, claimFailed: true }), stage("ready"));
    expect(v.note).toEqual({ text: "The claim did not go through. Nothing was lost. Claim again.", bad: true });
    expect(v.action!.kind).toBe("claim");
  });
});

describe("Ostia to Ethereum Sepolia", () => {
  const out = (over: Partial<Transfer> = {}) => base({ dir: "out", ...over });
  it("shows the marks of the send on Ostia while it goes, and names the steps as the design does", () => {
    expect(states(at(out()))).toEqual(["now:Sent on Ostia (Confirming…)", "todo:Confirmed on Ethereum Sepolia", "todo:Ready to claim", "todo:Arrived"]);
    expect(at(out()).marksOf).toBe("send");
    const v = at(out({ count: 5 }), stage("sent"));
    expect(states(v)).toEqual(["done:Sent on Ostia (21:40 UTC)", "now:Confirmed on Ethereum Sepolia (Confirming…)", "todo:Ready to claim", "todo:Arrived"]);
    expect(v.word).toBe("Sent");
  });
  it("is Confirmed, then Ready to claim, and the claim is on Ethereum Sepolia, paid in Sepolia ETH", () => {
    expect(at(out({ count: 5 }), stage("confirmed"))).toMatchObject({ word: "Confirmed", action: null });
    const v = at(out({ count: 5 }), stage("ready"));
    expect(states(v)).toEqual(["done:Sent on Ostia (21:40 UTC)", "done:Confirmed on Ethereum Sepolia (21:44 UTC)", "done:Ready to claim (21:46 UTC)", "todo:Arrived"]);
    expect(v.action).toEqual({ kind: "claim", label: "Claim on Ethereum Sepolia", note: "Your wallet switches to Ethereum Sepolia. Its fee is paid in Sepolia ETH." });
  });
  it("arrives as ETH on Ethereum Sepolia", () => {
    expect(at(out({ count: 5, done: 1 }), stage("claimed")).title).toBe("Arrived. 0.002 ETH is in your wallet on Ethereum Sepolia.");
    expect(at(out({ count: 5 }), stage("ready")).title).toBe("Sending 0.002 ETH to Ethereum Sepolia");
  });
  it("takes the worker's setting of the other side", () => {
    expect(at(out({ count: 5 }), stage("ready"), names({ claimedForYou: { ostia: true, remote: false } })).action).not.toBeNull();
    expect(at(out({ count: 5 }), stage("ready"), names({ claimedForYou: { ostia: false, remote: true } })).action).toBeNull();
  });
});

describe("a transfer that stopped", () => {
  it("says a send the wallet did not answer is not known, and a send that failed was lost with nothing lost", () => {
    expect(at(base({ send: attempt(null) }))).toMatchObject({ phase: "unsure-send", word: "Check your wallet", action: null, note: { bad: true } });
    expect(at(base({ lost: "failed" })).note!.text).toBe("This send did not go through on Ethereum Sepolia. Nothing was lost.");
    expect(at(base({ lost: "unreadable" })).note!.text).toMatch(/cannot tell which deposit/);
    expect(at(base({ lost: "failed" }))).toMatchObject({ phase: "lost", open: false });
  });
  it("says a claim the wallet did not answer is not known", () => {
    expect(at(base({ count: 1, claim: attempt(null) }), stage("ready"))).toMatchObject({ phase: "unsure-claim", action: null });
  });
});

describe("times", () => {
  it("shows no time where none is measured, and the measured one where it is", () => {
    expect(timeWords(null)).toBeNull();
    expect(at(base()).progress).toBeNull();
    const times = { in: { minSeconds: 240, maxSeconds: 420 }, out: { minSeconds: 480, maxSeconds: 960 } };
    expect(timeWords(times.in)).toBe("about 4 to 7 minutes");
    expect(timeWords(times.out)).toBe("about 8 to 16 minutes");
    expect(timeWords({ minSeconds: 300, maxSeconds: 330 })).toBe("about 5 to 6 minutes");
    expect(timeWords({ minSeconds: 60, maxSeconds: 60 })).toBe("about 1 minute");
    expect(timeWords({ minSeconds: 20, maxSeconds: 40 })).toBe("about 20 to 40 seconds");
    expect(timeWords({ minSeconds: 30, maxSeconds: 80 })).toBe("about 1 minute");
    expect(at(base(), stage("unknown"), names({ times }), Date.parse("2026-11-22T21:44:00Z")).progress).toBe("4 min of about 7");
    expect(at(base({ dir: "out" }), stage("unknown"), names({ times }), Date.parse("2026-11-22T21:49:30Z")).progress).toBe("9 min of about 16");
    expect(elapsedWords(times.in, -5)).toBe("0 min of about 7");
    expect(elapsedWords({ minSeconds: 10, maxSeconds: 40 }, 30)).toBeNull();
  });
});

describe("the words", () => {
  const all = () => {
    const texts: string[] = [];
    const times = { in: { minSeconds: 240, maxSeconds: 420 }, out: { minSeconds: 480, maxSeconds: 960 } };
    for (const dir of ["in", "out"] as const) {
      const cases: [Partial<Transfer>, string][] = [[{ send: null }, "unknown"], [{ send: attempt(null) }, "unknown"], [{}, "unknown"], [{ count: 1 }, "unknown"], [{ count: 1 }, "sent"], [{ count: 1 }, "confirmed"], [{ count: 1 }, "ready"], [{ count: 1, claimFailed: true }, "ready"],
        [{ count: 1, claim: attempt(null) }, "ready"], [{ count: 1, claim: attempt(hash(4)) }, "ready"], [{ count: 1, done: 5 }, "claimed"], [{ lost: "failed" }, "unknown"], [{ lost: "unreadable" }, "unknown"]];
      for (const [over, st] of cases) {
        const v = at(base({ dir, ...over }), stage(st as never), names({ times }));
        texts.push(v.title, v.word, ...v.steps.flatMap((s) => [s.label, s.detail ?? ""]), v.action?.label ?? "", v.action?.note ?? "", v.note?.text ?? "", v.progress ?? "");
      }
    }
    return texts;
  };
  it("never says pending, receive, certificate, exit root, proof, GER, trustless, bridgeless, audited or first", () => {
    for (const text of all()) expect(text, text).not.toMatch(/pending|receiv|certificate|exit root|proof|\bGER\b|pessimistic|trustless|bridgeless|audited|\bfirst\b/i);
  });
  it("never says Rome acts after the person's own transaction", () => {
    for (const text of all()) expect(text, text).not.toMatch(/Rome (is |will )?(send|process|releas|claim)/i);
  });
  it("turns a failed step into a sentence, never a code", () => {
    expect(otherWords(new Stop("Already arrived."), "Ostia", "tROME")).toBe("Already arrived.");
    expect(otherWords(new Unsure(null), "Ethereum Sepolia", "Sepolia ETH")).toMatch(/Look in its activity on Ethereum Sepolia/);
    expect(otherWords({ code: 4001 }, "Ostia", "tROME")).toBe("You declined it in your wallet.");
    expect(otherWords(new Error("insufficient funds for gas * price + value"), "Ethereum Sepolia", "Sepolia ETH")).toBe("You do not have enough Sepolia ETH on Ethereum Sepolia for this amount and the fee. Get some, then try again.");
    expect(otherWords({ message: "x", cause: { message: "gas required exceeds allowance" } }, "Ostia", "tROME")).toMatch(/enough tROME on Ostia/);
    expect(otherWords(new Error("execution reverted: 0xdeadbeef"), "Ostia", "tROME")).toBe("Ostia would not take this. Nothing was sent.");
    expect(otherWords(new ReadError("x", 503), "Ostia", "tROME")).toMatch(/^Something went wrong/);
    expect(otherWords(null, "Ostia", "tROME")).toMatch(/^Something went wrong/);
  });
});
