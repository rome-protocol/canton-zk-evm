import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { releaseIdOf } from "./moves/state.ts";
import { releaseUsed, removeUnlessPending } from "./session.ts";

const GATEWAY = "0x" + "11".repeat(20) as Address, V1 = "0x" + "22".repeat(20) as Address, V2 = "0x" + "33".repeat(20) as Address;

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
  it("is refused when the release is already on Ostia (mined, perhaps not yet proven), and nothing is cancelled", async () => {
    const cancel = vi.fn(async () => {});
    await expect(removeUnlessPending({ pendingNonce: async () => 4, nonce: async () => 4 }, cancel, async () => true)).rejects.toThrow(/release is already on Ostia; wait for it to finish/);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("removes nothing when it cannot be read whether the release is on Ostia", async () => {
    const cancel = vi.fn(async () => {});
    await expect(removeUnlessPending({ nonce: async () => 4 }, cancel, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(cancel).not.toHaveBeenCalled();
  });
  it("tells a release used for any configured vault, and none when no vault's id is used", async () => {
    const config = { gateway: GATEWAY, vaults: [V1, V2] };
    const asked: string[] = [];
    const evm = (usedId: string | null) => ({ used: async (g: Address, id: string) => { expect(g).toBe(GATEWAY); asked.push(id); return id === usedId; } });
    expect(await releaseUsed(evm(releaseIdOf(V2, "r1")), config, "r1")).toBe(true);
    expect(asked).toEqual([releaseIdOf(V1, "r1"), releaseIdOf(V2, "r1")]);
    expect(await releaseUsed(evm(null), config, "r1")).toBe(false);
    expect(await releaseUsed(evm(releaseIdOf(V1, "other")), config, "r1")).toBe(false);
  });
});
