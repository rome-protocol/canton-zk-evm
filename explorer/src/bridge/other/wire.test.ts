import { describe, expect, it, vi } from "vitest";
import { bridgeCall } from "./calls.ts";
import { ensureOther, createEnv } from "./wire.ts";
import { WrongChain } from "./transfer.ts";
import { hash, ME, memoryLocks, memoryStore, OSTIA_ID, plan, SEPOLIA_BRIDGE, SEPOLIA_ID } from "./fakes.ts";

const status = { chainId: OSTIA_ID, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } };
/** A wallet on `chain` that answers what a wallet answers, and records its requests. */
function wallet(start: number, answers: Record<string, (p: any[]) => unknown> = {}) {
  const state = { chain: start };
  const seen: { method: string; params: any[] }[] = [];
  return {
    state, seen,
    request: vi.fn(async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      seen.push({ method, params: params as any[] });
      if (answers[method]) return answers[method]!(params as any[]);
      if (method === "eth_chainId") return "0x" + state.chain.toString(16);
      if (method === "wallet_switchEthereumChain") { state.chain = Number(BigInt((params as any[])[0].chainId)); return null; }
      if (method === "eth_getTransactionCount") return (params as any[])[1] === "pending" ? "0x5" : "0x4";
      throw new Error(`the wallet was asked ${method}`);
    }),
  };
}
const build = (w: ReturnType<typeof wallet>, read = vi.fn(async (_m: string, _p: unknown[]): Promise<unknown> => null)) =>
  ({ read, env: createEnv({ wallet: w, account: ME.toUpperCase().replace("0X", "0x"), plan: plan(), ostia: status, read, store: memoryStore(), locks: memoryLocks(), newId: () => "id1" }) });

describe("putting the wallet on a chain", () => {
  it("does nothing when it is there, switches when it is not, and says so when it will not or does not know the chain", async () => {
    const a = wallet(SEPOLIA_ID);
    expect(await ensureOther(a, SEPOLIA_ID, "Ethereum Sepolia")).toBeNull();
    expect(a.seen.map((s) => s.method)).toEqual(["eth_chainId"]);
    const b = wallet(OSTIA_ID);
    expect(await ensureOther(b, SEPOLIA_ID, "Ethereum Sepolia")).toBeNull();
    expect(b.state.chain).toBe(SEPOLIA_ID);
    const c = wallet(OSTIA_ID, { wallet_switchEthereumChain: () => { throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }); } });
    expect(await ensureOther(c, SEPOLIA_ID, "Ethereum Sepolia")).toBe("Your wallet does not know Ethereum Sepolia yet. Add it in your wallet's network list, then try again.");
    expect(c.seen.map((s) => s.method)).not.toContain("wallet_addEthereumChain");   // no network details of its own to add
    const d = wallet(OSTIA_ID, { wallet_switchEthereumChain: () => { throw Object.assign(new Error("x"), { code: 4001 }); } });
    expect(await ensureOther(d, SEPOLIA_ID, "Ethereum Sepolia")).toBe("You declined it in your wallet.");
    const e = wallet(OSTIA_ID, { wallet_switchEthereumChain: () => null });
    expect(await ensureOther(e, SEPOLIA_ID, "Ethereum Sepolia")).toBe("Your wallet is not on Ethereum Sepolia yet.");
  });
  it("puts it on Ostia with the explorer's own network details, and on Sepolia with a switch", async () => {
    const w = wallet(SEPOLIA_ID);
    const { env } = build(w);
    expect(await env.ensure(OSTIA_ID)).toBeNull();
    expect(w.state.chain).toBe(OSTIA_ID);
    expect(await env.ensure(SEPOLIA_ID)).toBeNull();
    expect(w.state.chain).toBe(SEPOLIA_ID);
  });
});

describe("sending", () => {
  const call = bridgeCall(SEPOLIA_BRIDGE, 75, ME, 2000n, "native");
  it("estimates through the wallet on the other chain, pads the limit by a fifth, and sends from the account in lower case", async () => {
    const w = wallet(SEPOLIA_ID, { eth_estimateGas: () => "0x186a0", eth_sendTransaction: () => hash(77) });
    const { env, read } = build(w);
    expect(await env.send(SEPOLIA_ID, call)).toBe(hash(77));
    const sent = w.seen.find((s) => s.method === "eth_sendTransaction")!.params[0];
    expect(sent).toMatchObject({ from: ME, to: SEPOLIA_BRIDGE, value: "0x7d0", gas: "0x1d4c0" });
    expect(read).not.toHaveBeenCalled();
  });
  it("estimates a send on Ostia through the explorer, not the wallet", async () => {
    const w = wallet(OSTIA_ID, { eth_sendTransaction: () => hash(78) });
    const { env, read } = build(w, vi.fn(async () => "0x5208"));
    await env.send(OSTIA_ID, call);
    expect(read).toHaveBeenCalledWith("eth_estimateGas", [expect.objectContaining({ from: ME })]);
    expect(w.seen.map((s) => s.method)).not.toContain("eth_estimateGas");
    expect(w.seen.find((s) => s.method === "eth_sendTransaction")!.params[0].gas).toBe("0x6270");
  });
  it("stops before the wallet is asked when the estimate fails: nothing was sent", async () => {
    const w = wallet(SEPOLIA_ID, { eth_estimateGas: () => { throw new Error("insufficient funds"); } });
    const { env } = build(w);
    await expect(env.send(SEPOLIA_ID, call)).rejects.toMatchObject({ name: "Error", message: "insufficient funds" });
    expect(w.seen.map((s) => s.method)).not.toContain("eth_sendTransaction");
  });
  it("refuses an answer that is not a hash", async () => {
    const w = wallet(SEPOLIA_ID, { eth_estimateGas: () => "0x1", eth_sendTransaction: () => "ok" });
    await expect(build(w).env.send(SEPOLIA_ID, call)).rejects.toThrow(/did not give a transaction hash/);
  });
  it("does not estimate on the other chain while the wallet is elsewhere", async () => {
    const w = wallet(OSTIA_ID);
    await expect(build(w).env.send(SEPOLIA_ID, call)).rejects.toMatchObject({ message: expect.any(String) });
    expect(w.seen.map((s) => s.method)).not.toContain("eth_sendTransaction");
  });
});

describe("reading", () => {
  it("reads the wallet's count of transactions, pending and in blocks, and says nothing when the wallet will not", async () => {
    expect(await build(wallet(SEPOLIA_ID)).env.nonces(SEPOLIA_ID)).toEqual({ pending: 5, latest: 4 });
    expect(await build(wallet(SEPOLIA_ID, { eth_getTransactionCount: () => { throw new Error("no"); } })).env.nonces(SEPOLIA_ID)).toBeNull();
  });
  it("reads a receipt on Ostia through the explorer with the wallet anywhere, and on Sepolia through the wallet only while it is there", async () => {
    const r = { status: "0x1", logs: [{ address: "0x1", topics: [], data: "0x" }] };
    const a = build(wallet(SEPOLIA_ID), vi.fn(async () => r));
    expect(await a.env.receipt(OSTIA_ID, hash(1))).toEqual({ ok: true, logs: r.logs });
    const b = build(wallet(SEPOLIA_ID, { eth_getTransactionReceipt: () => ({ status: "0x0" }) }));
    expect(await b.env.receipt(SEPOLIA_ID, hash(1))).toEqual({ ok: false, logs: [] });
    const c = build(wallet(OSTIA_ID));
    await expect(c.env.receipt(SEPOLIA_ID, hash(1))).rejects.toBeInstanceOf(WrongChain);
    expect(await build(wallet(SEPOLIA_ID, { eth_getTransactionReceipt: () => null })).env.receipt(SEPOLIA_ID, hash(1))).toBeNull();
  });
  it("reads a transaction by its hash in the form a record matches", async () => {
    const w = wallet(SEPOLIA_ID, { eth_getTransactionByHash: () => ({ from: ME, to: SEPOLIA_BRIDGE, input: "0x12", value: "0x7d0" }) });
    expect(await build(w).env.lookup(SEPOLIA_ID, hash(1))).toEqual({ from: ME, to: SEPOLIA_BRIDGE, input: "0x12", value: "2000" });
    expect(await build(wallet(SEPOLIA_ID, { eth_getTransactionByHash: () => null })).env.lookup(SEPOLIA_ID, hash(1))).toBeNull();
  });
  it("asks the account's own lock, with a random id of its own", () => {
    const { env } = build(wallet(SEPOLIA_ID));
    expect(env.account).toBe(ME);
    expect(env.newId()).toBe("id1");
  });
});
