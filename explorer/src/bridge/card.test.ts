import { describe, expect, it } from "vitest";
import { amountSize, buttonOf, noteOf, progressWords, type ButtonInput } from "./card.ts";

const base: ButtonInput = { connected: true, accountReady: true, config: "ready", amount: "ok", enough: true, symbol: "TKA", to: "Canton", move: { phase: "idle" } };

describe("the move button", () => {
  it("walks the steps: connect, open the account, enter an amount, then move", () => {
    expect(buttonOf({ ...base, connected: false, accountReady: false })).toEqual({ label: "Connect MetaMask", action: "connect", disabled: false });
    expect(buttonOf({ ...base, accountReady: false })).toEqual({ label: "Open my Canton account", action: "open", disabled: false });
    expect(buttonOf({ ...base, amount: "empty" })).toEqual({ label: "Enter an amount", action: "none", disabled: true });
    expect(buttonOf({ ...base, amount: "bad" })).toMatchObject({ label: "Enter an amount", disabled: true });
    expect(buttonOf(base)).toEqual({ label: "Move to Canton", action: "move", disabled: false });
    expect(buttonOf({ ...base, to: "Ostia" }).label).toBe("Move to Ostia");
  });
  it("says so when the balance does not cover the amount, and waits while the bridge is looked up", () => {
    expect(buttonOf({ ...base, enough: false })).toEqual({ label: "Not enough TKA", action: "none", disabled: true });
    expect(buttonOf({ ...base, enough: null }).label).toBe("Move to Canton");   // a balance not known yet does not stop the move: the move checks it itself
    expect(buttonOf({ ...base, config: "loading" })).toMatchObject({ label: "Looking up the bridge…", disabled: true });
    expect(buttonOf({ ...base, config: "failed" })).toMatchObject({ label: "Not available here", disabled: true });
    expect(buttonOf({ ...base, config: "failed", connected: false, accountReady: false }).label).toBe("Connect MetaMask");   // the account does not need the bridge's tokens
    expect(buttonOf({ ...base, config: "loading", accountReady: false }).label).toBe("Open my Canton account");
  });
  it("shows the move's progress while it runs, and offers Continue for a move that is paused or failed and kept", () => {
    for (const [move, words] of [
      [{ phase: "signing-canton" }, "Signing on Canton…"], [{ phase: "waiting-canton", ref: "r" }, "Waiting for Canton…"], [{ phase: "proving", tx: "0x00" }, "Sent. Waiting for the block to be final…"],
      [{ phase: "sending-evm", step: "approve" }, "Confirm approving TKA in your wallet…"], [{ phase: "sending-evm", step: "wrap" }, "Confirm wrapping TKA in your wallet…"], [{ phase: "sending-evm", step: "pay" }, "Confirm in your wallet…"],
    ] as const) expect(buttonOf({ ...base, move })).toEqual({ label: words, action: "none", disabled: true });
    expect(progressWords({ phase: "idle" }, "TKA")).toBeNull();
    expect(buttonOf({ ...base, move: { phase: "paused", note: "x" } })).toEqual({ label: "Continue", action: "continue", disabled: false });
    expect(buttonOf({ ...base, move: { phase: "failed", reason: "x", from: "proving", kept: true } }).action).toBe("continue");
    expect(buttonOf({ ...base, move: { phase: "failed", reason: "x", from: "proving", kept: false } }).action).toBe("move");
  });
  it("puts a pause or a failure in plain words", () => {
    expect(noteOf({ phase: "paused", note: "Canton has your redeem. Continue to ask your wallet for the release." })).toEqual({ text: "Canton has it. Continue to release it on Ostia.", bad: false });
    expect(noteOf({ phase: "failed", reason: "execution reverted: 0x08c379a0", from: "sending-evm", kept: false })?.bad).toBe(true);
    expect(noteOf({ phase: "idle" })).toBeNull();
  });
  it("shrinks the type of an amount as it grows", () => {
    expect(["5", "123456789", "1234567890", "12345678901234", "123456789012345", "1".repeat(22), "1".repeat(23), "1".repeat(61)].map(amountSize)).toEqual(["xl", "xl", "l", "l", "m", "m", "s", "s"]);
  });
});
