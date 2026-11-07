// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { Eip1193 } from "../../wallet.ts";
import { ensureOstia } from "./network.ts";

const chain = { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } };
afterEach(() => { delete (window as unknown as { ethereum?: unknown }).ethereum; });

function wallet(o: { on: number; knows: boolean; refuse?: number }) {
  let current = o.on;
  const calls: { method: string; params?: unknown[] }[] = [];
  const w: Eip1193 = {
    request: async (a) => {
      calls.push(a);
      if (a.method === "eth_chainId") return "0x" + current.toString(16);
      if (a.method === "wallet_switchEthereumChain") {
        if (o.refuse) throw { code: o.refuse, message: "no" };
        if (!o.knows) throw { code: 4902, message: "unknown chain" };
        current = chain.chainId;
        return null;
      }
      if (a.method === "wallet_addEthereumChain") { current = chain.chainId; o.knows = true; return null; }
      throw new Error(a.method);
    },
  };
  (window as unknown as { ethereum: Eip1193 }).ethereum = w;
  return { w, calls };
}

describe("ensureOstia", () => {
  it("does nothing when the wallet is on Ostia", async () => {
    const { w, calls } = wallet({ on: chain.chainId, knows: true });
    expect(await ensureOstia(w, chain)).toEqual({ ok: true, message: null });
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });
  it("switches a wallet that knows Ostia", async () => {
    const { w } = wallet({ on: 1, knows: true });
    expect((await ensureOstia(w, chain)).ok).toBe(true);
  });
  it("adds Ostia from the explorer's network details when the wallet does not know it", async () => {
    const { w, calls } = wallet({ on: 1, knows: false });
    expect((await ensureOstia(w, chain)).ok).toBe(true);
    const add = calls.find((c) => c.method === "wallet_addEthereumChain")!;
    expect(add.params![0]).toMatchObject({ chainId: "0x" + chain.chainId.toString(16), chainName: "Ostia", nativeCurrency: { symbol: "tROME", decimals: 18 } });
  });
  it("says so when the person declines", async () => {
    const { w } = wallet({ on: 1, knows: true, refuse: 4001 });
    expect(await ensureOstia(w, chain)).toEqual({ ok: false, message: "You declined it in your wallet." });
  });
});
