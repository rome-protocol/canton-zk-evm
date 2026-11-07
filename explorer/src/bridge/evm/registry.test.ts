import { describe, expect, it, vi } from "vitest";
import { LockRefused, registryClient } from "./registry.ts";

const reply = (status: number, body: unknown) => vi.fn(async () => ({ status, ok: status < 300, json: async () => body }) as unknown as Response);
const ask = { receiver: "alice::1220" + "ab".repeat(32), ref: "r1" };

describe("the twin registry client", () => {
  it("posts the receiver and ref to /twin/v1/lock-parts and gives the parts", async () => {
    const f = reply(200, { lockId: "0x01", vaults: ["0xv"], acceptance: "00ab", receiver: "x" });
    expect(await registryClient("https://r.example/twin-registry", f as never).lockParts(ask)).toEqual({ lockId: "0x01", vaults: ["0xv"], acceptance: "00ab" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://r.example/twin-registry/twin/v1/lock-parts");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);   // a registry that does not answer stops the lock after 20 seconds
    expect(JSON.parse(init.body as string)).toEqual(ask);
  });
  it("refuses with 409 for a receiver that has not accepted twins", async () => {
    await expect(registryClient("https://r", reply(409, { error: "x" }) as never).lockParts(ask)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("accepted twins") });
  });
  it("refuses with the registry's own message on another error, and when it cannot be reached", async () => {
    await expect(registryClient("https://r", reply(404, { error: "no twin erc20:aa" }) as never).lockParts(ask)).rejects.toMatchObject({ status: 404, message: "no twin erc20:aa" });
    await expect(registryClient("https://r", (async () => { throw new TypeError("offline"); }) as never).lockParts(ask)).rejects.toBeInstanceOf(LockRefused);
  });
});
