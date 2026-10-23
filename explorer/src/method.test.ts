import { describe, expect, it } from "vitest";
import { methodOf } from "./method.ts";

const t = (over: Partial<Parameters<typeof methodOf>[0]> = {}) => ({ methodId: null, to: "0x" + "cb".repeat(20), created: null, value: "0", ...over });

describe("methodOf", () => {
  it("calls an input-less send of coin a Transfer, and one with no value a call", () => {
    expect(methodOf(t({ value: "1000" }))).toBe("Transfer");
    expect(methodOf(t())).toBe("Call");
  });
  it("calls a transaction with no recipient, or one that made a contract, Create contract", () => {
    expect(methodOf(t({ to: null, created: "0x" + "dd".repeat(20) }))).toBe("Create contract");
    expect(methodOf(t({ created: "0x" + "dd".repeat(20), methodId: "0xa9059cbb" }))).toBe("Create contract");
  });
  it("names a call by its function in the standard ABI, in lowercase, and never as the coin's Transfer", () => {
    expect(methodOf(t({ methodId: "0xa9059cbb" }))).toBe("transfer");
    expect(methodOf(t({ methodId: "0xa9059cbb", value: "5" }))).toBe("transfer");
    expect(methodOf(t({ methodId: "0x095ea7b3" }))).toBe("approve");
    expect(methodOf(t({ methodId: "0xa1448194" }))).toBe("safeMint");
    expect(methodOf(t({ methodId: "0x23b872dd" }))).toBe("transferFrom");
  });
  it("takes the name from the verified ABI first, and the standard one only when there is none", () => {
    const verified = [{ type: "function", name: "deposit", inputs: [{ type: "address", name: "to" }] }];
    const id = "0xf340fa01";
    expect(methodOf(t({ methodId: id }), verified)).toBe("deposit");
    expect(methodOf(t({ methodId: "0xa9059cbb" }), verified)).toBe("0xa9059cbb");
    expect(methodOf(t({ methodId: "0xa9059cbb" }), [])).toBe("transfer");
  });
  it("shows the raw selector of a method that no ABI names", () => {
    expect(methodOf(t({ methodId: "0x12345678" }))).toBe("0x12345678");
  });
  it("reads the selector whatever its case", () => {
    expect(methodOf(t({ methodId: "0xA9059CBB" }))).toBe("transfer");
  });
});
