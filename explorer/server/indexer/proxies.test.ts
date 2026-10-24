import { describe, expect, it } from "vitest";
import { addressOfWord, EIP1822_SLOT, EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, TREX_AUTHORITY_SLOT, TREX_GETTERS, minimalProxyTarget, trexGetter } from "./proxies.ts";

describe("proxy detection", () => {
  it("looks in the slots the standards name", () => {
    expect(EIP1967_IMPLEMENTATION_SLOT).toBe("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    expect(EIP1967_BEACON_SLOT).toBe("0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50");
    expect(EIP1822_SLOT).toBe("0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7");
  });

  it("reads an address from a storage word, and nothing from an empty word or one that is not an address", () => {
    expect(addressOfWord("0x" + "00".repeat(12) + "ab".repeat(20))).toBe("0x" + "ab".repeat(20));
    expect(addressOfWord("0x" + "00".repeat(32))).toBeNull();
    expect(addressOfWord("0x" + "00".repeat(11) + "01" + "ab".repeat(20))).toBeNull();
  });

  it("recognises exactly the EIP-1167 minimal proxy, with the implementation it names", () => {
    const code = "0x363d3d373d3d3d363d73" + "bc".repeat(20) + "5af43d82803e903d91602b57fd5bf3";
    expect(minimalProxyTarget(code)).toBe("0x" + "bc".repeat(20));
    expect(minimalProxyTarget(code + "00")).toBeNull();
    expect(minimalProxyTarget("0x363d3d373d3d3d363d74" + "bc".repeat(20) + "5af43d82803e903d91602b57fd5bf3")).toBeNull();
    expect(minimalProxyTarget("0x6001")).toBeNull();
  });

  it("looks for the implementation authority of T-REX and ONCHAINID proxies in their own slot, and asks the getter their code names", () => {
    expect(TREX_AUTHORITY_SLOT).toBe("0x821f3e4d3d679f19eacc940c87acf846ea6eae24a63058ea750304437a62aafc");
    expect(TREX_GETTERS).toHaveLength(7);
    expect(new Set(TREX_GETTERS).size).toBe(7);
    const push = (g: number) => "63" + TREX_GETTERS[g]!.slice(2);
    // a code that pushes one getter asks that one; a code that pushes none of them has no getter
    expect(trexGetter("0x6080604052" + push(0) + "5afa")).toBe(TREX_GETTERS[0]);
    expect(trexGetter("0X6080" + "63" + TREX_GETTERS[2]!.slice(2).toUpperCase() + "00")).toBe(TREX_GETTERS[2]);
    expect(trexGetter("0x6080604052" + TREX_GETTERS[6]!.slice(2))).toBeNull(); // the bytes are there but not pushed
    // a real proxy pushes all six getters once (setImplementationAuthority checks each on the new authority) and its own once more: its own is the one pushed most
    const six = [0, 1, 2, 3, 4, 5].map(push).join("5afa");
    expect(trexGetter("0x6080" + six + "00" + push(2) + "5afa")).toBe(TREX_GETTERS[2]);
    expect(trexGetter("0x6080" + push(5) + "00" + six)).toBe(TREX_GETTERS[5]);
    expect(trexGetter("0x6080" + six)).toBeNull(); // all pushed the same number of times: the code does not say which it asks
    // the selector is only counted where an opcode pushes it: not inside the data of another push, and not at an offset that is no byte boundary
    expect(trexGetter("0x7f" + "00".repeat(27) + push(0) + "6080")).toBeNull();
    expect(trexGetter("0x5" + push(0) + "0")).toBeNull();
    expect(trexGetter("0x6080" + "7f" + "00".repeat(27) + push(0) + push(1))).toBe(TREX_GETTERS[1]);
    expect(trexGetter("0x")).toBeNull();
  });
});
