import { describe, expect, it } from "vitest";
import { BRIDGE_EVENT_TOPIC, claimAssetCall, isClaimedCall, rollupIdCall } from "./abi.ts";

describe("the bridge's calls", () => {
  it("have the selectors and the event topic the bridge contract has", () => {
    expect(BRIDGE_EVENT_TOPIC).toBe("0x501781209a1f8899323b96b4ef08b168df93e0a90c673d1e4cce39366cb62f9b");
    expect(isClaimedCall(1, 0).slice(0, 10)).toBe("0xcc461632");
    expect(isClaimedCall(1, 0)).toHaveLength(2 + 8 + 128);
    expect(rollupIdCall(770101)).toHaveLength(2 + 8 + 64);
  });

  it("builds claimAsset's calldata from 32 and 32 proof words", () => {
    const w = (n: number) => "0x" + n.toString(16).padStart(64, "0");
    const data = claimAssetCall({
      smtProofLocalExitRoot: Array.from({ length: 32 }, (_, i) => w(i)), smtProofRollupExitRoot: Array.from({ length: 32 }, (_, i) => w(100 + i)), globalIndex: "1", mainnetExitRoot: w(1), rollupExitRoot: w(2),
      originNetwork: 0, originTokenAddress: "0x" + "00".repeat(20), destinationNetwork: 75, destinationAddress: "0x" + "11".repeat(20), amount: "5", metadata: "0x",
    });
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(2 + 8 + 64 * 64);
  });
});
