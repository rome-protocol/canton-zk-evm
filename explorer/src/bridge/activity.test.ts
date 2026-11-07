import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { continueWords, entryOf, finished, openOnCanton, remember, rowsOf, seedOf, standing, track, whatMoved, type Entry } from "./activity.ts";
import { depositIdOf, saveCheckpoint, type Checkpoint, type MoveState, type StoreLike } from "./moves/state.ts";
import { pairsOf } from "./tokens.ts";
import { config, GATEWAY_PARTY, ME, PARTY, TKA, VAULT, WCC } from "../pages/bridge-fakes.ts";

const memory = (): StoreLike => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const NOW = Date.now();   // a record older than 30 days is dropped, so the times are recent
const keep = (store: StoreLike, c: Partial<Checkpoint> & Pick<Checkpoint, "input" | "stage">) => saveCheckpoint(store, { ref: "r1", account: ME, party: PARTY, vault: VAULT, at: NOW, ...c });
const TX = ("0x" + "ab".repeat(32)) as Hex;
const pairs = pairsOf(config, GATEWAY_PARTY);
const redeem: Checkpoint["input"] = { kind: "redeem", asset: TKA, amount: "3" };

describe("the moves of an account", () => {
  it("lists a kept move that is not finished, with where it stopped, and only for the account", () => {
    const store = memory();
    keep(store, { input: redeem, stage: "evm" });
    keep(store, { ref: "other", account: ("0x" + "9".repeat(40)) as Address, input: redeem, stage: "start" });
    expect(rowsOf(store, ME)).toEqual([expect.objectContaining({ ref: "r1", kind: "redeem", amount: "3", stage: "evm", done: false, tx: null })]);
    expect(rowsOf(store, ME.toUpperCase())).toHaveLength(1);   // the account's case does not matter
    expect(rowsOf(store, "0x" + "5".repeat(40))).toEqual([]);
  });
  it("lists a finished move once, newest first, after the kept record is gone", () => {
    const store = memory();
    remember(store, { ...entryOf({ input: redeem, ref: "old", account: ME, party: PARTY, vault: VAULT, stage: "sent", at: NOW - 5000 }), tx: TX, block: 5 });
    keep(store, { ref: "new", input: { kind: "lock", asset: TKA, amount: "1", receiver: PARTY }, stage: "start", at: NOW });
    expect(rowsOf(store, ME).map((r) => [r.ref, r.done, r.block])).toEqual([["new", false, null], ["old", true, 5]]);
    // the same move still kept and also finished is shown once, as finished
    keep(store, { ref: "old", input: redeem, stage: "sent", at: NOW - 5000 });
    expect(rowsOf(store, ME).filter((r) => r.ref === "old")).toHaveLength(1);
    expect(rowsOf(store, ME).find((r) => r.ref === "old")!.done).toBe(true);
  });
  it("keeps the latest 50 finished moves, and survives storage that is broken or absent", () => {
    const store = memory();
    for (let i = 0; i < 55; i++) remember(store, { ...entryOf({ input: redeem, ref: `r${i}`, account: ME, party: PARTY, vault: VAULT, stage: "sent", at: i }), tx: TX, block: i });
    expect(finished(store)).toHaveLength(50);
    expect(finished(store)[0]!.ref).toBe("r54");
    store.setItem("bridge-history", "not json");
    expect(finished(store)).toEqual([]);
    expect(finished(null)).toEqual([]);
    expect(() => remember(null, entryOf({ input: redeem, ref: "x", account: ME, party: PARTY, vault: VAULT, stage: "sent" }))).not.toThrow();
  });
});

describe("the transaction of a row", () => {
  it("is the move's own, never the approval or the wrap that came before it", () => {
    const lock: Checkpoint["input"] = { kind: "lock", asset: TKA, amount: "1", receiver: PARTY };
    const wallet = { ref: "r", account: ME, party: PARTY, vault: VAULT, tx: TX };
    for (const step of ["approve", "wrap"] as const) {
      const e = entryOf({ ...wallet, input: lock, stage: "wallet", step });
      expect(e.tx).toBeNull();
      expect(seedOf(e).sent).toBe(false);
    }
    expect(entryOf({ ...wallet, input: lock, stage: "wallet", step: "pay" }).tx).toBe(TX);
    expect(entryOf({ ...wallet, input: redeem, stage: "sent" }).tx).toBe(TX);
  });
});

describe("writing a move down when it ends", () => {
  it("remembers the move with its transaction and block when the move is final, and not before", () => {
    const store = memory();
    let fire: (s: MoveState) => void = () => {};
    const kept: Checkpoint[] = [];
    track({ subscribe: (fn) => { fire = fn; return () => {}; }, kept: () => kept }, store);
    keep(store, { input: redeem, stage: "evm" });
    kept.push({ input: redeem, ref: "r1", account: ME, party: PARTY, vault: VAULT, stage: "evm", at: NOW });
    fire({ phase: "sending-evm", step: "release" });
    fire({ phase: "proving", tx: TX });
    expect(finished(store)).toEqual([]);
    fire({ phase: "final", tx: TX, block: 42 });
    expect(finished(store)).toEqual([expect.objectContaining({ ref: "r1", done: true, tx: TX, block: 42, stage: null })]);
  });
});

describe("a move that is not finished, in words", () => {
  const e = (kind: Entry["kind"], stage: Entry["stage"]): Entry => ({ ref: "r", kind, asset: TKA, amount: "3", account: ME, party: PARTY, at: 0, tx: null, block: null, done: false, stage });
  it("says where each kind of move stopped", () => {
    expect(standing(e("redeem", "start"), "Ostia")).toBe("Saved. Not signed on Canton yet.");
    expect(standing(e("redeem", "canton"), "Ostia")).toBe("Signed on Canton. Waiting for Canton to show it.");
    expect(standing(e("redeem", "evm"), "Ostia")).toBe("Canton has it. Release it on Ostia.");
    expect(standing(e("deposit", "evm"), "Ostia")).toBe("Canton has it. Claim it on Ostia.");
    expect(standing(e("lock", "start"), "Ostia")).toBe("Saved. Your wallet has not been asked yet.");
    expect(standing(e("lock", "wallet"), "Ostia")).toBe("Your wallet was asked. Check it, then continue.");
    expect(standing(e("withdraw", "sent"), "Ostia")).toBe("Sent. Waiting for the block to be final.");
  });
  it("trusts Canton's own list of open requests over a record that has not caught up", () => {
    expect(standing(e("redeem", "canton"), "Ostia", true)).toBe("Canton has it. Release it on Ostia.");
    expect(standing(e("deposit", "signing"), "Ostia", true)).toBe("Canton has it. Claim it on Ostia.");
    expect(standing(e("lock", "start"), "Ostia", true)).toBe("Saved. Your wallet has not been asked yet.");   // a lock has no Canton step of its own
  });
  it("names the step the row carries on with: the release or the claim on Ostia", () => {
    expect(continueWords(e("redeem", "evm"), "Ostia")).toBe("Release on Ostia");
    expect(continueWords(e("deposit", "wallet"), "Ostia")).toBe("Claim on Ostia");
    expect(continueWords(e("redeem", "canton"), "Ostia")).toBe("Continue");
    expect(continueWords(e("redeem", "canton"), "Ostia", true)).toBe("Release on Ostia");
    expect(continueWords(e("deposit", "sent"), "Ostia")).toBe("Continue");
    expect(continueWords(e("lock", "start"), "Ostia")).toBe("Continue");
  });
  it("finds a move's request in the account service's open list", () => {
    const redeemRow = e("redeem", "canton"), depositRow = { ...e("deposit", "canton"), ref: "d1" };
    const open = { redeemRequests: [{ contractId: "c", arguments: { ref: "r" } }], depositRequests: [{ contractId: "c", arguments: { depositId: depositIdOf(PARTY, "d1").toUpperCase().replace("0X", "0x") } }] };
    expect(openOnCanton(redeemRow, open)).toBe(true);
    expect(openOnCanton(depositRow, open)).toBe(true);
    expect(openOnCanton(redeemRow, { redeemRequests: [], depositRequests: [] })).toBe(false);
    expect(openOnCanton(e("lock", "start"), open)).toBe(false);
  });
});

describe("what moved, and the marks a row starts from", () => {
  it("names the token on the side it leaves, and the chain it goes to", () => {
    const row = (kind: Entry["kind"], asset: Address): Entry => ({ ref: "r", kind, asset, amount: "5", account: ME, party: PARTY, at: 0, tx: null, block: null, done: false, stage: "start" });
    expect(whatMoved(row("lock", TKA), pairs, "Ostia")).toBe("5 TKA to Canton");
    expect(whatMoved(row("redeem", TKA), pairs, "Ostia")).toBe("5 TKA to Ostia");
    expect(whatMoved(row("deposit", WCC), pairs, "Ostia")).toBe("5 CC to Ostia");
    expect(whatMoved(row("withdraw", WCC), pairs, "Ostia")).toBe("5 wCC to Canton");
    expect(whatMoved(row("lock", ("0x" + "7".repeat(40)) as Address), pairs, "Ostia")).toBe("5 tokens to Canton");
  });
  it("starts a finished move as final in its block, and an unfinished one as sent only once it has a transaction", () => {
    const base = { ref: "r", kind: "redeem", asset: TKA, amount: "1", account: ME, party: PARTY, at: 0, stage: null } as const;
    expect(seedOf({ ...base, tx: TX, block: 9, done: true })).toEqual({ sent: true, proven: true, final: true, block: 9, updateId: null });
    expect(seedOf({ ...base, tx: null, block: null, done: false })).toMatchObject({ sent: false, final: false });
    expect(seedOf({ ...base, tx: TX, block: null, done: false })).toMatchObject({ sent: true, final: false });
  });
});
