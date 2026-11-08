import { describe, expect, it, vi } from "vitest";
import { removeUnlessPending } from "./session.ts";

describe("removing a redeem started in another browser", () => {
  it("is refused while a transaction of the account waits in Ostia's pool, and nothing is cancelled", async () => {
    const cancel = vi.fn(async () => {});
    await expect(removeUnlessPending({ pendingNonce: async () => 5, nonce: async () => 4 }, cancel)).rejects.toThrow(/still waiting; cancel it in your wallet first/);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("goes ahead when the pool holds nothing past the final count, or cannot be asked", async () => {
    const cancel = vi.fn(async () => {});
    await removeUnlessPending({ pendingNonce: async () => 4, nonce: async () => 4 }, cancel);
    await removeUnlessPending({ pendingNonce: async () => { throw new Error("down"); }, nonce: async () => 4 }, cancel);
    await removeUnlessPending({ nonce: async () => 4 }, cancel);
    expect(cancel).toHaveBeenCalledTimes(3);
  });
});
