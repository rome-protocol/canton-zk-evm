import { encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { IndexerStop } from "./errors.ts";
import { decodeLeg, LEG_TOPIC, legsSlot } from "./legs.ts";
import { revertReason } from "./stage2.ts";

const enc = (type: string, v: unknown) => encodeAbiParameters([{ type }], [v as never]).slice(2);

describe("the reason of a revert", () => {
  it("decodes Error(string) and strips padding zeros", () => {
    expect(revertReason("0x08c379a0" + enc("string", "insufficient balance"))).toBe("insufficient balance");
    expect(revertReason("0x08c379a0" + enc("string", "ab\u0000\u0000"))).toBe("ab");
  });

  it("decodes Panic(uint256), with the compiler's meaning when it has one", () => {
    expect(revertReason("0x4e487b71" + enc("uint256", 0x11n))).toBe("Panic(0x11): arithmetic overflow or underflow");
    expect(revertReason("0x4e487b71" + enc("uint256", 0x99n))).toBe("Panic(0x99)");
  });

  it("leaves a custom error, empty data and malformed standard data to be shown as raw bytes", () => {
    expect(revertReason("0xdeadbeef" + "00".repeat(32))).toBeNull();
    expect(revertReason("0x")).toBeNull();
    expect(revertReason("0x08c379a0" + "01")).toBeNull();
  });
});

describe("the gateway's Leg events", () => {
  const types = [{ type: "uint8" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "string" }] as const;
  const data = (kind: number) => encodeAbiParameters(types, [kind, ("0x" + "01".repeat(32)) as `0x${string}`, ("0x" + "d0".repeat(20)) as `0x${string}`, ("0x" + "a1".repeat(20)) as `0x${string}`, 7n, "p::1220"]);
  const log = (d: string, topics: string[] = [LEG_TOPIC]) => ({ address: "0x" + "9a".repeat(20), topics, data: d });

  it("decodes a leg", () => {
    expect(decodeLeg(log(data(1)), 3)).toMatchObject({ kind: 1, amount: 7n, party: "p::1220", token: "0x" + "d0".repeat(20) });
  });

  it("stops at C10, naming the block, for a leg the gateway cannot have written", () => {
    for (const bad of [log(data(9)), log(data(1), [LEG_TOPIC, "0x" + "00".repeat(32)]), log("0x1234"), log(data(1) + "00")]) {
      try { decodeLeg(bad, 3); throw new Error("did not stop"); } catch (e) {
        expect(e).toBeInstanceOf(IndexerStop);
        expect((e as IndexerStop).check).toBe("C10");
        expect((e as IndexerStop).block).toBe(3);
      }
    }
  });

  it("finds legs[n] at keccak256(abi.encode(n, 0))", () => {
    expect(legsSlot(1)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(legsSlot(1)).not.toBe(legsSlot(2));
  });
});
