import { describe, expect, it, vi } from "vitest";
import { memoryStore, OSTIA_ID } from "../other/fakes.ts";
import { keptAct, signOwn } from "./own.ts";
import { ME, ROUTER } from "./fakes.ts";

const hex = (n: bigint | number) => "0x" + n.toString(16);
const ostia = { chainId: OSTIA_ID, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } };
const call = { to: ROUTER, data: "0x1234" as const, value: "0" };
function wallet(over: Partial<Record<string, (p: unknown[]) => unknown>> = {}) {
  const sent: unknown[] = [];
  const request = vi.fn(async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    if (over[method]) return over[method]!(params);
    switch (method) {
      case "eth_chainId": return hex(OSTIA_ID);
      case "eth_estimateGas": return "0x30d40";
      case "eth_sendTransaction": sent.push(params[0]); return "0x" + "77".repeat(32);
      default: throw new Error(`the wallet was asked ${method}`);
    }
  });
  return { request, sent };
}

describe("the person's own steps on Ostia", () => {
  it("sends the call from the wallet's account on Ostia, with the estimate padded, and keeps its hash for the row", async () => {
    const w = wallet(), store = memoryStore();
    const hash = await signOwn({ wallet: w, account: ME, ostia, id: "r1", kind: "claim", call, store, now: () => 5000 });
    expect(hash).toBe("0x" + "77".repeat(32));
    expect(w.sent[0]).toMatchObject({ from: ME, to: ROUTER, data: "0x1234", chainId: hex(OSTIA_ID) });
    expect(keptAct(store, "r1", 6000)).toEqual({ kind: "claim", hash, at: 5000 });
  });
  it("puts the wallet on Ostia first, and signs nothing when it cannot", async () => {
    const w = wallet({ eth_chainId: () => hex(1), wallet_switchEthereumChain: () => { throw Object.assign(new Error("no"), { code: 4001 }); } });
    await expect(signOwn({ wallet: w, account: ME, ostia, id: "r1", kind: "claim", call, store: memoryStore() })).rejects.toBeDefined();
    expect(w.sent).toEqual([]);
  });
  it("sends nothing when the estimate reverts (the step is already done, or would not be taken), and says so in words", async () => {
    const w = wallet({ eth_estimateGas: () => { throw new Error("execution reverted"); } }), store = memoryStore();
    await expect(signOwn({ wallet: w, account: ME, ostia, id: "r1", kind: "forward", call, store })).rejects.toMatchObject({ name: "Stop", message: "Ostia would not take this now. It may already be done. Nothing was sent." });
    expect(w.sent).toEqual([]);
    expect(keptAct(store, "r1", 1)).toBeNull();
  });
  it("refuses a hash that is not one, and keeps a step for a day only", async () => {
    await expect(signOwn({ wallet: wallet({ eth_sendTransaction: () => "nope" }), account: ME, ostia, id: "r1", kind: "claim", call, store: memoryStore() })).rejects.toMatchObject({ name: "Stop" });
    const store = memoryStore();
    await signOwn({ wallet: wallet(), account: ME, ostia, id: "r2", kind: "refund", call, store, now: () => 1000 });
    expect(keptAct(store, "r2", 1000 + 86_399_000)).not.toBeNull();
    expect(keptAct(store, "r2", 1000 + 86_401_000)).toBeNull();
  });
  it("reads nothing from a store that is missing or holds something else", () => {
    expect(keptAct(null, "r1", 0)).toBeNull();
    const store = memoryStore();
    store.setItem("ostia-in-act-r1", "{not json");
    expect(keptAct(store, "r1", 0)).toBeNull();
    store.setItem("ostia-in-act-r1", JSON.stringify({ kind: "nuke", hash: "0x" + "77".repeat(32), at: 1 }));
    expect(keptAct(store, "r1", 2)).toBeNull();
  });
});
