import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./evm/config.ts";
import { cantonSignatures, popups, stepsOf } from "./moves/steps.ts";
import { arrivesAs, factsOf, groupsOf, inputOf, moveOf, pairsOf, search } from "./tokens.ts";

const a = (c: string) => ("0x" + c.repeat(40)) as `0x${string}`;
const config: BridgeConfig = {
  chain: { chainId: 1, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } }, gateway: a("2"), vault: a("3"), vaults: [a("3")], registryUrl: "https://r.example", wrapper: a("b"),
  twins: [{ address: a("a"), symbol: "TKA", decimals: 18 }, { address: a("b"), symbol: "WtROME", decimals: 18 }],
  wrapped: [{ address: a("c"), symbol: "wCC", decimals: 10, instrument: { admin: "DSO::1220cd", id: "Amulet" } }, { address: a("d"), symbol: "wTKB", decimals: 10, instrument: { admin: "OTHER::1220ee", id: "TKB" } }],
};
const pairs = pairsOf(config, "gateway::1220aa");

describe("the pairs this build supports", () => {
  it("are the twins (the chain's coin first, under its own name) and the wrapped tokens, and nothing else", () => {
    expect(pairs.map((p) => [p.kind, p.ostia.symbol, p.canton.symbol, p.native])).toEqual([["twin", "tROME", "tROME", true], ["twin", "TKA", "TKA", false], ["wrapped", "wCC", "Canton Coin", false], ["wrapped", "wTKB", "TKB", false]]);
    expect(pairs[1]!.canton).toEqual({ symbol: "TKA", admin: "gateway::1220aa", id: `erc20:${"aa".repeat(20)}`, decimals: 10 });
    expect(pairs[2]!.canton).toMatchObject({ admin: "DSO::1220cd", id: "Amulet", decimals: 10 });
  });
  it("show the chain's coin under its own name only when a wrapped coin is pinned", () => {
    expect(pairsOf({ ...config, wrapper: null }, "g").map((p) => p.ostia.symbol)).toEqual(["TKA", "WtROME", "wCC", "wTKB"]);
    expect(pairsOf({ ...config, twins: [], wrapped: [] }, "g")).toEqual([]);
  });
  it("make two groups of the same tokens, and a search finds a token by its name, its address or its id", () => {
    const g = groupsOf(pairs);
    expect(g.ostia.map((t) => t.symbol)).toEqual(["tROME", "TKA", "wCC", "wTKB"]);
    expect(g.canton.map((t) => t.symbol)).toEqual(["tROME", "TKA", "Canton Coin", "TKB"]);
    expect(search(g.ostia, pairs, "tk").map((t) => t.symbol)).toEqual(["TKA", "wTKB"]);
    expect(search(g.canton, pairs, "amulet").map((t) => t.symbol)).toEqual(["Canton Coin"]);
    expect(search(g.ostia, pairs, "AAAA").map((t) => t.symbol)).toEqual(["TKA"]);
    expect(search(g.ostia, pairs, "nothing like it")).toEqual([]);
    expect(search(g.ostia, pairs, "  ")).toHaveLength(4);
  });
  it("give each token's facts: its address or id, its decimals, and what it is a twin of", () => {
    const g = groupsOf(pairs);
    expect(factsOf(g.ostia[1]!, pairs, "Ostia")).toEqual([{ label: "Address", value: a("a") }, { label: "Decimals", value: "18" }, { label: "Twin of", value: "TKA on Canton" }]);
    expect(factsOf(g.canton[1]!, pairs, "Ostia")).toEqual([{ label: "Token id", value: `erc20:${"aa".repeat(20)}` }, { label: "Decimals", value: "10" }, { label: "Twin of", value: "TKA on Ostia" }]);
    expect(factsOf(g.ostia[2]!, pairs, "Ostia")[2]).toEqual({ label: "Twin of", value: "Canton Coin on Canton (wrapped here)" });
    expect(factsOf(g.ostia[0]!, pairs, "Ostia")[0]!.label).toBe("Wrapped form's address");
  });
});

describe("what a token arrives as", () => {
  it("is its own name, except the chain's coin coming back from Canton, which arrives as its wrapped form", () => {
    const coin = pairs.find((p) => p.native)!, twin = pairs.find((p) => p.erc20 === a("a"))!, cc = pairs.find((p) => p.kind === "wrapped")!;
    expect([coin.ostia.symbol, coin.wrapped]).toEqual(["tROME", "WtROME"]);
    expect([arrivesAs(coin, "ostia"), arrivesAs(coin, "canton")]).toEqual(["tROME", "WtROME"]);
    expect([arrivesAs(twin, "ostia"), arrivesAs(twin, "canton"), twin.wrapped]).toEqual(["TKA", "TKA", null]);
    expect([arrivesAs(cc, "ostia"), arrivesAs(cc, "canton")]).toEqual(["Canton Coin", "wCC"]);
  });
  it("is named in the redeem step of the chain's coin", () => {
    expect(stepsOf("redeem", "tROME", true, "Ostia", "WtROME").map((s) => s.text)).toContain("Release WtROME on Ostia");
    expect(stepsOf("redeem", "TKA", false, "Ostia", null).map((s) => s.text)).toContain("Release TKA on Ostia");
  });
});

describe("the four moves", () => {
  const [coin, tka, cc] = pairs as [typeof pairs[0], typeof pairs[0], typeof pairs[0]];
  it("are chosen by the token and the side it is moved from", () => {
    expect([moveOf(tka, "ostia"), moveOf(tka, "canton"), moveOf(cc, "canton"), moveOf(cc, "ostia")]).toEqual(["lock", "redeem", "deposit", "withdraw"]);
  });
  it("give the library's input", () => {
    expect(inputOf(tka, "ostia", "5", "p::1220")).toEqual({ kind: "lock", asset: a("a"), amount: "5", receiver: "p::1220" });
    expect(inputOf(coin, "ostia", "5", "p::1220")).toEqual({ kind: "lock", asset: a("b"), amount: "5", receiver: "p::1220", wrapNative: true });
    expect(inputOf(tka, "canton", "5", "p")).toEqual({ kind: "redeem", asset: a("a"), amount: "5" });
    expect(inputOf(cc, "canton", "5", "p")).toEqual({ kind: "deposit", asset: a("c"), amount: "5" });
    expect(inputOf(cc, "ostia", "5", "p")).toEqual({ kind: "withdraw", asset: a("c"), amount: "5" });
  });
  it("count the pop-ups: 2 (3 for the chain's coin) to Canton, and 1 for each of the others", () => {
    const n = (kind: Parameters<typeof stepsOf>[0], native = false) => popups(stepsOf(kind, "X", native, "Ostia"));
    expect([n("lock"), n("lock", true), n("redeem"), n("deposit"), n("withdraw")]).toEqual([2, 3, 1, 1, 1]);
    expect([cantonSignatures("lock"), cantonSignatures("redeem"), cantonSignatures("deposit"), cantonSignatures("withdraw")]).toEqual([0, 1, 2, 0]);
  });
  it("describe their steps without naming a part of the bridge", () => {
    for (const kind of ["lock", "redeem", "deposit", "withdraw"] as const) for (const s of stepsOf(kind, "TKA", true, "Ostia")) expect(s.text, s.text).not.toMatch(/party|allocation|vault|gateway|registry|contract|EIP|ERC|lock/i);
  });
});
