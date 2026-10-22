import { describe, expect, it } from "vitest";
import { methodOf } from "./method.ts";

const t = (over: Partial<Parameters<typeof methodOf>[0]> = {}) => ({ methodId: null, to: "0x" + "cb".repeat(20), created: null, value: "0", ...over });

describe("methodOf", () => {
  it("calls an input-less send of coin a transfer, and one with no value a call", () => {
    expect(methodOf(t({ value: "1000" }))).toBe("Transfer");
    expect(methodOf(t())).toBe("Call");
  });
  it("calls a transaction with no recipient, or one that made a contract, a creation", () => {
    expect(methodOf(t({ to: null, created: "0x" + "dd".repeat(20) }))).toBe("Create");
    expect(methodOf(t({ created: "0x" + "dd".repeat(20), methodId: "0xa9059cbb" }))).toBe("Create");
  });
  it("names the token methods, and shows the bytes of any other", () => {
    expect(methodOf(t({ methodId: "0xa9059cbb" }))).toBe("Transfer");
    expect(methodOf(t({ methodId: "0x095ea7b3" }))).toBe("Approve");
    expect(methodOf(t({ methodId: "0x12345678" }))).toBe("0x12345678");
  });
});
