import { afterEach, describe, expect, it, vi } from "vitest";
import { ethCall, rpc, RpcError } from "./rpc.ts";

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
  it("calls at the final block it asked for, by number, and says which block that was", async () => {
    const f = vi.fn(async (_: string, init?: RequestInit) => {
      const { method } = JSON.parse(init!.body as string);
      return { json: async () => ({ result: method === "eth_blockNumber" ? "0x15" : "0x01" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", f);
    expect(await ethCall("0xabc", "0x1234")).toEqual({ result: "0x01", block: 21 });
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string).params).toEqual([{ to: "0xabc", data: "0x1234" }, "0x15"]);
  });
});
