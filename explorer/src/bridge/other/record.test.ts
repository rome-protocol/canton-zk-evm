import { describe, expect, it } from "vitest";
import { KEEP_FINISHED, keptTransfers, loadTransfer, removeTransfer, saveTransfer, type Transfer } from "./record.ts";
import type { StoreLike } from "../moves/state.ts";

const memory = (): StoreLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
const ME = "0x" + "e3".repeat(20);
const make = (id: string, over: Partial<Transfer> = {}): Transfer => ({ id, account: ME, at: 1_000_000, route: "sepolia", dir: "in", symbol: "ETH", decimals: 18, native: true, amount: "2000000000000000", send: null, count: null, claim: null, ...over });

describe("the kept transfers", () => {
  it("keeps a record and reads it back as it was written", () => {
    const store = memory();
    const t = make("a", { send: { chainId: 11155111, to: "0x" + "52".repeat(20), data: "0x1234", value: "5", nonce: 3, tx: ("0x" + "ab".repeat(32)) as `0x${string}` }, count: 7 });
    saveTransfer(store, t);
    expect(loadTransfer(store, "a")).toEqual(t);
    expect(keptTransfers(store, ME, 1_000_000)).toEqual([t]);
  });
  it("lists the newest first, and only the account's own, whatever case the account is written in", () => {
    const store = memory();
    saveTransfer(store, make("a")); saveTransfer(store, make("b")); saveTransfer(store, make("c", { account: "0x" + "11".repeat(20) }));
    expect(keptTransfers(store, ME.toUpperCase().replace("0X", "0x"), 1_000_000).map((t) => t.id)).toEqual(["b", "a"]);
  });
  it("drops what is not a record, and a record more than 30 days old", () => {
    const store = memory();
    saveTransfer(store, make("old", { at: 1_000 })); saveTransfer(store, make("new", { at: 40 * 86_400_000 }));
    store.setItem("agglayer-transfer:junk", "{\"id\":1}"); store.setItem("agglayer-transfers", JSON.stringify(["old", "new", "junk", 5]));
    expect(keptTransfers(store, ME, 41 * 86_400_000).map((t) => t.id)).toEqual(["new"]);
    expect(store.map.has("agglayer-transfer:old")).toBe(false);
  });
  it("refuses a record whose transaction or amount is not what the page writes", () => {
    const store = memory();
    saveTransfer(store, make("x", { amount: "1e18" }));
    saveTransfer(store, make("y", { send: { chainId: 1, to: "0x", data: "0x00", value: "0", nonce: null, tx: "0xabc" as `0x${string}` } }));
    expect(loadTransfer(store, "x")).toBeNull();
    expect(loadTransfer(store, "y")).toBeNull();
  });
  it("removes a record and its place in the list", () => {
    const store = memory();
    saveTransfer(store, make("a")); removeTransfer(store, "a");
    expect(keptTransfers(store, ME, 1_000_000)).toEqual([]);
    expect(store.map.get("agglayer-transfers")).toBe("[]");
  });
  it("keeps the last 50 finished transfers, and every one that is not finished", () => {
    const store = memory();
    saveTransfer(store, make("open"));
    for (let i = 0; i < KEEP_FINISHED + 3; i++) saveTransfer(store, make(`d${i}`, { done: 5 }));
    const kept = keptTransfers(store, ME, 1_000_000).map((t) => t.id);
    expect(kept).toContain("open");
    expect(kept.filter((id) => id.startsWith("d"))).toHaveLength(KEEP_FINISHED);
    expect(kept).not.toContain("d0");   // the oldest finished is the one dropped
    expect(kept).toContain(`d${KEEP_FINISHED + 2}`);
  });
  it("works with no storage at all", () => {
    saveTransfer(null, make("a"));
    expect(loadTransfer(null, "a")).toBeNull();
    expect(keptTransfers(null, ME)).toEqual([]);
  });
});
