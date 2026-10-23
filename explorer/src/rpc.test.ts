import { afterEach, describe, expect, it, vi } from "vitest";
import { ethCall, finalBlock, rpc, RpcError } from "./rpc.ts";

const answer = (body: unknown) => vi.fn(async (_: string, init?: RequestInit) => ({ json: async () => body, init }) as unknown as Response);
afterEach(() => vi.unstubAllGlobals());

describe("the explorer's RPC", () => {
  it("posts one JSON-RPC call to /rpc and gives its result", async () => {
    const f = answer({ jsonrpc: "2.0", id: 1, result: "0x15" });
    vi.stubGlobal("fetch", f);
    expect(await rpc("eth_blockNumber")).toBe("0x15");
    expect(f.mock.calls[0]![0]).toBe("/rpc");
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toMatchObject({ jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
  });
  it("throws the node's message and code when it answers an error, and a plain one when it cannot be reached", async () => {
    vi.stubGlobal("fetch", answer({ error: { code: 3, message: "execution reverted: nope" } }));
    await expect(rpc("eth_call")).rejects.toMatchObject({ message: "execution reverted: nope", code: 3 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(rpc("eth_call")).rejects.toBeInstanceOf(RpcError);
  });
  it("calls at the final block it is given, by number, and says which block that was; it does not ask for the block again", async () => {
    const f = vi.fn(async (_: string, init?: RequestInit) => {
      const { method } = JSON.parse(init!.body as string);
      return { json: async () => ({ result: method === "eth_blockNumber" ? "0x15" : "0x01" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", f);
    expect(await finalBlock()).toBe(21);
    expect(await ethCall("0xabc", "0x1234", 21)).toEqual({ result: "0x01", block: 21 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string).params).toEqual([{ to: "0xabc", data: "0x1234" }, "0x15"]);
  });
  it("keeps at most 6 reads in flight, and answers all of them", async () => {
    let now = 0, most = 0;
    const releases: (() => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      now++; most = Math.max(most, now);
      await new Promise<void>((go) => releases.push(go));
      now--;
      return { json: async () => ({ result: "0x01" }) } as unknown as Response;
    }));
    let done = false;
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => ethCall("0xabc", "0x" + i, 5))).finally(() => { done = true; });
    for (let spins = 0; spins < 200 && !done; spins++) {
      await new Promise((r) => setTimeout(r, 1));
      releases.splice(0).forEach((go) => go());
    }
    expect((await all).length).toBe(20);
    expect(most).toBeLessThanOrEqual(6);
    expect(most).toBeGreaterThan(1);
  });
});
