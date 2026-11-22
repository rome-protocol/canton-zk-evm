import { describe, expect, it } from "vitest";
import { handoffView } from "./handoff.ts";
import { ostia, WETH } from "./fakes.ts";
import type { HandoffRow, HandoffToken } from "./setup.ts";

const none = { in: null, out: null };
const tok = (symbol: string, over: Partial<HandoffToken> = {}): HandoffToken => ({ symbol, name: symbol, decimals: 18, places: 9, ostia: WETH, times: none, ...over });
const row = (over: Partial<HandoffRow> = {}): HandoffRow => ({ id: "hadrian", name: "Hadrian", open: true, via: "solgate", available: true, solgate: "https://solgate.example", coin: "USDC", assets: [tok("ETH")], times: none, ...over });
const solana = (over: Partial<HandoffRow> = {}) => row({ id: "solana-devnet", name: "Solana devnet", coin: null, ...over });
const view = (r: HandoffRow) => handoffView(r, ostia, "tROME");
const strings = (r: HandoffRow) => { const v = view(r); return [v.intro, ...v.steps.flatMap((s) => [s.label, s.detail]), ...v.times, ...v.places, ...v.trust, v.back]; };

describe("the card of a route through Solgate", () => {
  it("has three steps to Hadrian: send from the Ostia wallet, wait, claim on Hadrian in an EVM wallet paid in Hadrian's coin", () => {
    const v = view(row());
    expect(v.intro).toBe("Every step to Hadrian is in Solgate.");
    expect(v.steps).toEqual([
      { label: "Send from your Ostia wallet", detail: "your EVM wallet, a little tROME" }, { label: "Wait until it is ready to claim", detail: "" }, { label: "Claim on Hadrian", detail: "your EVM wallet, a little USDC" },
    ]);
    expect(view(row({ coin: null })).steps[2]!.detail).toBe("your EVM wallet, a little of Hadrian's coin");
  });

  it("has three steps to Solana, the last in a Solana wallet paid in SOL, and names Solana, not the network of the route", () => {
    const v = view(solana());
    expect(v.intro).toBe("Every step to Solana is in Solgate.");
    expect(v.steps[2]).toEqual({ label: "Claim in your Solana wallet", detail: "your Solana wallet, a little SOL" });
  });

  it("opens Solgate and its Claim tab, the only tab Solgate reads from an address, whatever the address ends with", () => {
    const v = view(row({ solgate: "https://solgate.example/app" }));
    expect(v.open).toBe("https://solgate.example/app/");
    expect(v.claim).toBe("https://solgate.example/app/?tab=claim");
  });

  it("shows a token's own times, else the route's, and no line for a token with none", () => {
    const r = row({
      times: { in: null, out: { minSeconds: 600, maxSeconds: 900 } },
      assets: [tok("ETH", { times: { in: { minSeconds: 360, maxSeconds: 360 }, out: { minSeconds: 360, maxSeconds: 360 } } }), tok("SOL", { decimals: 9 }), tok("DAI", { times: { in: { minSeconds: 240, maxSeconds: 240 }, out: null } })],
    });
    expect(view(r).times).toEqual(["ETH: about 6 minutes from Ostia, about 6 minutes to Ostia", "SOL: about 10 to 15 minutes from Ostia", "DAI: about 10 to 15 minutes from Ostia, about 4 minutes to Ostia"]);
    expect(view(row()).times).toEqual([]);
  });

  it("says where a token loses places on Solana, from the places the server gives, and only on Solana", () => {
    const r = { assets: [tok("ETH"), tok("SOL", { decimals: 9, places: 9 }), tok("CC", { decimals: 10, places: 9 })] };
    expect(view(solana(r)).places).toEqual([
      "ETH has 18 decimal places on Ostia and 9 on Solana. The places past 9 are dropped on the way.", "CC has 10 decimal places on Ostia and 9 on Solana. The places past 9 are dropped on the way.",
    ]);
    expect(view(row(r)).places).toEqual([]);
  });

  it("carries the ETH line where ETH is offered and the Canton Coin line where Canton Coin is, each only there", () => {
    expect(view(solana()).trust).toEqual(["Ostia cannot send out more ETH than came in. On Solana it is Solgate's copy, under Solgate's terms."]);
    expect(view(row()).trust).toEqual(["Ostia cannot send out more ETH than came in."]);
    expect(view(solana({ assets: [tok("SOL")] })).trust).toEqual([]);
    const cc = view(solana({ assets: [tok("CC", { decimals: 10 })] })).trust;
    expect(cc).toEqual(["The copy of Canton Coin on Solana rests on the coin Rome holds on Canton and on Rome's key that signs what leaves Ostia. It travels through Solgate, which has its own terms. AggLayer's balance check does not cover it."]);
  });

  it("says how to come back, in Solgate", () => {
    expect(view(row()).back).toBe("To come back, send from your wallet on Hadrian in Solgate, then claim on Ostia there.");
    expect(view(solana()).back).toBe("To come back, send from your Solana wallet in Solgate, then claim on Ostia there.");
  });

  it("never uses the words the page does not: Receive, pending, gas, other chains, a certificate or a proof, or Rome acting after the person's own transaction", () => {
    const text = [row(), solana(), row({ assets: [tok("ETH"), tok("CC", { decimals: 10 }), tok("SOL", { decimals: 9 })], times: { in: { minSeconds: 60, maxSeconds: 120 }, out: null } })].flatMap(strings).join("\n");
    expect(text).not.toMatch(/receiv|pending|\bgas\b|other chains|certificate|exit root|\bproof\b|\bGER\b|trustless|audited|Rome (is|sends|processes|releases)/i);
  });
});
