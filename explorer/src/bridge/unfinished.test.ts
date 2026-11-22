import { describe, expect, it } from "vitest";
import { hasUnfinished } from "./unfinished.ts";
import { remember, entryOf } from "./activity.ts";
import { saveCheckpoint, type Checkpoint, type StoreLike } from "./moves/state.ts";
import { saveTransfer, type Transfer } from "./other/record.ts";

const memory = (): StoreLike => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const ME = "0x" + "e3".repeat(20);
const move = (over: Partial<Checkpoint> = {}): Checkpoint => ({ input: { kind: "lock", asset: ("0x" + "a1".repeat(20)) as `0x${string}`, amount: "1", receiver: "party::1" }, ref: "r1", account: ME as `0x${string}`, party: "party::1", vault: ("0x" + "cd".repeat(20)) as `0x${string}`, stage: "sent", at: Date.now(), ...over });
const transfer = (over: Partial<Transfer> = {}): Transfer => ({ id: "t1", account: ME, at: Date.now(), route: "sepolia", dir: "in", symbol: "ETH", decimals: 18, native: true, amount: "1000", send: null, count: null, claim: null, ...over });

describe("a move kept in this browser that is not over", () => {
  it("is none when there is no store or nothing kept", () => {
    expect(hasUnfinished(null)).toBe(false);
    expect(hasUnfinished(memory())).toBe(false);
  });

  it("is a kept Canton move that is not in the finished list", () => {
    const store = memory();
    saveCheckpoint(store, move());
    expect(hasUnfinished(store)).toBe(true);
  });

  it("is not a Canton move that finished and was written down", () => {
    const store = memory();
    saveCheckpoint(store, move());
    remember(store, { ...entryOf(move()), block: 5 });
    expect(hasUnfinished(store)).toBe(false);
  });

  it("is a kept transfer that has not arrived, including one not yet sent", () => {
    const store = memory();
    saveTransfer(store, transfer());
    expect(hasUnfinished(store)).toBe(true);
    saveTransfer(store, transfer({ id: "t2", count: 4, send: null }));
    expect(hasUnfinished(store)).toBe(true);
  });

  it("is not a transfer that arrived or was given up as lost", () => {
    const store = memory();
    saveTransfer(store, transfer({ done: Date.now() }));
    saveTransfer(store, transfer({ id: "t2", lost: "failed" }));
    expect(hasUnfinished(store)).toBe(false);
  });

  it("is none when the kept lists are not lists", () => {
    const store = memory();
    store.setItem("agglayer-transfers", "{");
    store.setItem("bridge-moves", '"x"');
    expect(hasUnfinished(store)).toBe(false);
    store.setItem("agglayer-transfers", '{"a":1}');
    expect(hasUnfinished(store)).toBe(false);
  });
});
