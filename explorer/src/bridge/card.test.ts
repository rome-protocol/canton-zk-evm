import { describe, expect, it } from "vitest";
import { amountSize, buttonOf, noteOf, offersTakeBack, progressWords, waitFor, waitWords, type ButtonInput } from "./card.ts";

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
  it("takes the test coin first when the wallet holds none: connect, get the coin, open the account, enter an amount, move", () => {
    const none = { ...base, accountReady: false, needCoin: "tROME" };
    expect(buttonOf({ ...none, connected: false })).toEqual({ label: "Connect MetaMask", action: "connect", disabled: false });
    expect(buttonOf(none)).toEqual({ label: "Get test tROME", action: "faucet", disabled: false });
    expect(buttonOf({ ...none, asking: true })).toEqual({ label: "Asking the faucet…", action: "faucet", disabled: true });
    expect(buttonOf({ ...none, coming: true })).toEqual({ label: "tROME is on its way…", action: "faucet", disabled: true });   // queued, not seen in the wallet yet: no second ask
    expect(buttonOf({ ...base, needCoin: "tROME" }).action).toBe("faucet");   // the account is open, the coin still comes first
    expect(buttonOf({ ...none, needCoin: undefined })).toEqual({ label: "Open my Canton account", action: "open", disabled: false });   // once the wallet holds some
    expect(buttonOf({ ...base, needCoin: "tROME", move: { phase: "paused", note: "x" } }).action).toBe("continue");   // a kept move is not held back
  });
  it("waits, in words, while the machinery of an opened account is built; and says the bridge is not available when its setup failed", () => {
    expect(buttonOf({ ...base, preparing: true })).toEqual({ label: "Getting ready…", action: "none", disabled: true });
    expect(buttonOf({ ...base, preparing: true, config: "failed" }).label).toBe("Not available here");
    expect(buttonOf({ ...base, preparing: true, config: "loading" }).label).toBe("Looking up the bridge…");
    expect(buttonOf({ ...base, preparing: true, accountReady: false }).label).toBe("Open my Canton account");
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
      [{ phase: "sending-evm", step: "approve" }, "Approve TKA in your wallet, then wait for it to be final…"], [{ phase: "sending-evm", step: "wrap" }, "Wrap TKA in your wallet, then wait for it to be final…"], [{ phase: "sending-evm", step: "pay" }, "Confirm in your wallet…"],
    ] as const) expect(buttonOf({ ...base, move })).toEqual({ label: words, action: "none", disabled: true });
    expect(progressWords({ phase: "idle" }, "TKA")).toBeNull();
    expect(buttonOf({ ...base, move: { phase: "paused", note: "x" } })).toEqual({ label: "Continue", action: "continue", disabled: false });
    expect(buttonOf({ ...base, move: { phase: "paused", note: "x" }, continueLabel: "Release on Ostia" }).label).toBe("Release on Ostia");
    expect(buttonOf({ ...base, move: { phase: "failed", reason: "x", from: "proving", kept: true } }).action).toBe("continue");
    expect(buttonOf({ ...base, move: { phase: "failed", reason: "x", from: "proving", kept: false } }).action).toBe("move");
  });
  it("does not ask for the wallet while a lock is only getting ready", () => {
    expect(waitWords({ phase: "sending-evm", step: "prepare" })).toBe("Getting ready…");
    expect(waitWords({ phase: "sending-evm", step: "pay" })).toBe("Confirm in your wallet…");
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

describe("how long a move is said to take", () => {
  it("is about 1 min for a move with one pop-up and about 2 min for two or three (approve then pay; the tROME lock)", () => {
    expect(waitFor(1)).toBe("About 1 min");
    expect([2, 3].map(waitFor)).toEqual(["About 2 min", "About 2 min"]);
  });
});

describe("taking a deposit back", () => {
  const deposit = (stage: string) => ({ input: { kind: "deposit" }, stage });
  it("is offered for a deposit with a Canton step begun, a claim asked for or sent included, once it is due", () => {
    for (const stage of ["signing", "allocated", "canton", "evm", "wallet", "sent"]) expect(offersTakeBack(deposit(stage), true)).toBe(true);
    expect(offersTakeBack(deposit("start"), true)).toBe(false);
    expect(offersTakeBack(deposit("canton"), false)).toBe(false);
  });
  it("is never offered for another kind of move, or when there is no record", () => {
    for (const kind of ["redeem", "lock", "withdraw"]) expect(offersTakeBack({ input: { kind }, stage: "evm" }, true)).toBe(false);
    expect(offersTakeBack(undefined, true)).toBe(false);
  });
});
