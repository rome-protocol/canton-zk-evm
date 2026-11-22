import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import type { ClaimArgs } from "../other/reads.ts";
import { asset, cc, CC, ME, PARTY, ROUTER, BOOK, INBOX, inFlow } from "./fakes.ts";
import { canPay, checkInRead, claimCall, dayTime, holdCall, inboxFrom, inboxRead, isClaimInto, payoutLine, quoteIn, refundFee, short, shortParty, smallestIn, waitWords, wayBackLine } from "./in.ts";

const a = asset({ feeIn: cc(0.1), feeRefund: cc(0.05) });
const proof = Array.from({ length: 32 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const args: ClaimArgs = {
  smtProofLocalExitRoot: proof, smtProofRollupExitRoot: proof, globalIndex: 7n, mainnetExitRoot: "0x" + "aa".repeat(32), rollupExitRoot: "0x" + "bb".repeat(32),
  originNetwork: 75, originTokenAddress: CC, destinationNetwork: 75, destinationAddress: INBOX, amount: cc(4.8), metadata: "0x1234",
};
const routerAbi = parseAbi([
  "struct ClaimArgs { bytes32[32] smtProofLocalExitRoot; bytes32[32] smtProofRollupExitRoot; uint256 globalIndex; bytes32 mainnetExitRoot; bytes32 rollupExitRoot; uint32 originNetwork; address originTokenAddress; uint32 destinationNetwork; address destinationAddress; uint256 amount; bytes metadata; }",
  "function claimAndWithdraw(ClaimArgs c, string party, uint32 refundNetwork, address refundAddress)",
  "function claimToInbox(ClaimArgs c, string party, uint32 refundNetwork, address refundAddress)",
  "function forward(string party, uint32 refundNetwork, address refundAddress, address token)",
  "function refund(string party, uint32 refundNetwork, address refundAddress, address token)",
]);

describe("what a send to Canton pays", () => {
  it("takes the book's fee from the amount, and has nothing for an amount at or below it", () => {
    expect(quoteIn(a, cc(4.8))).toEqual({ fee: cc(0.1), get: cc(4.7) });
    expect(quoteIn(a, cc(0.1))).toBeNull();
    expect(quoteIn(a, cc(0.05))).toBeNull();
    expect(quoteIn(a, cc(0.1) + 1n)).toEqual({ fee: cc(0.1), get: 1n });
  });
  it("says the smallest amount from the fee, and a send back's fee as the refund fee with the destination's claim part", () => {
    expect(smallestIn(a)).toBe("Send more than 0.1 CC; 0.1 CC or less is all fee.");
    expect(refundFee(a)).toBe(cc(0.2));
  });
});

describe("whether Canton can pay", () => {
  const p = inFlow().payout!;
  it("says yes within the quota, and no with the reason when the account does not accept, the legs are paused or the quota is short", () => {
    expect(canPay(p, true, CC, cc(6.2))).toEqual({ ok: true });
    expect(canPay(p, true, CC, cc(6.3))).toEqual({ ok: false, reason: "limit" });
    expect(canPay(p, false, CC, 1n)).toEqual({ ok: false, reason: "no-acceptance" });
    expect(canPay({ ...p, paused: true }, true, CC, 1n)).toEqual({ ok: false, reason: "paused" });
  });
  it("has no limit where the quota is not set, and does not know while Canton cannot be read", () => {
    expect(canPay({ ...p, assets: { [CC]: { left: null, renewsAt: null } } }, true, CC, cc(1000))).toEqual({ ok: true });
    expect(canPay(null, true, CC, 1n)).toEqual({ ok: null });
    expect(canPay(p, null, CC, 1n)).toEqual({ ok: null });
    expect(canPay(null, false, CC, 1n)).toEqual({ ok: false, reason: "no-acceptance" });
  });
});

describe("the line about the payout limit", () => {
  const p = inFlow().payout!;
  it("says what Canton can pay today and when that renews", () => {
    expect(payoutLine(a, p, cc(4.7), 259_200)).toBe("Canton can pay out 6.2 CC more today. That renews at 14:05 UTC.");
  });
  it("says a coin sent now is held when the amount is over what is left, with the way back's wait", () => {
    expect(payoutLine(a, { ...p, assets: { [CC]: { left: 0n, renewsAt: "2026-11-22T14:05:00.000Z" } } }, cc(4.7), 259_200)).toBe("Canton can pay out 0 CC more today. A coin sent now is held on Ostia. Canton can pay out again from 14:05 UTC; after 3 days it can go back.");
  });
  it("says payouts are paused, and has no line where there is no quota or Canton cannot be read", () => {
    expect(payoutLine(a, { ...p, paused: true }, cc(1), 259_200)).toBe("Payouts to Canton are paused. A coin sent now is held on Ostia. After 3 days it can go back.");
    expect(payoutLine(a, { ...p, assets: { [CC]: { left: null, renewsAt: null } } }, cc(1), 259_200)).toBeNull();
    expect(payoutLine(a, null, cc(1), 259_200)).toBeNull();
  });
  it("says the way back with the wallet and the fee", () => {
    expect(wayBackLine(a, ME, 259_200)).toBe(`If Canton cannot pay it within 3 days, you can send it back to ${short(ME)} on Ethereum Sepolia, less a 0.2 CC fee.`);
  });
});

describe("words for the waits and the names", () => {
  it("says a wait in days, hours or minutes, and a day and time in UTC", () => {
    expect(waitWords(259_200)).toBe("3 days");
    expect(waitWords(86_400)).toBe("1 day");
    expect(waitWords(7_200)).toBe("2 hours");
    expect(waitWords(300)).toBe("5 minutes");
    expect(dayTime("2026-11-25T21:45:00Z")).toBe("Wed 25 Nov 21:45 UTC");
  });
  it("shortens an address and a party id", () => {
    expect(short(ME)).toBe("0xe3e3…e3e3");
    expect(shortParty(PARTY)).toBe("alice::1220…9f9f");
    expect(shortParty("a::b")).toBe("a::b");
  });
});

describe("the router's calls", () => {
  it("makes the claim that pays on to Canton, and the one that only holds, with the party and the way back", () => {
    for (const kind of ["claimAndWithdraw", "claimToInbox"] as const) {
      const call = claimCall(kind, ROUTER, args, PARTY, ME);
      expect(call).toMatchObject({ to: ROUTER, value: "0" });
      const d = decodeFunctionData({ abi: routerAbi, data: call.data });
      expect(d.functionName).toBe(kind);
      const [c, party, network, refund] = d.args as unknown as [{ globalIndex: bigint; destinationAddress: string; amount: bigint; metadata: string }, string, number, string];
      expect(c).toMatchObject({ globalIndex: 7n, amount: cc(4.8), metadata: "0x1234" });
      expect(c.destinationAddress.toLowerCase()).toBe(INBOX);
      expect([party, network, refund.toLowerCase()]).toEqual([PARTY, 0, ME]);
    }
  });
  it("makes the move on and the send back from the party, the way back and the token", () => {
    for (const kind of ["forward", "refund"] as const) {
      const d = decodeFunctionData({ abi: routerAbi, data: holdCall(kind, ROUTER, PARTY, ME, CC).data });
      expect(d.functionName).toBe(kind);
      expect((d.args as unknown as unknown[]).map((x) => (typeof x === "string" ? x.toLowerCase() : x))).toEqual([PARTY.toLowerCase(), 0, ME, CC]);
    }
  });
  it("reads the account's address and whether a claim-and-pay would be taken, as fixed calls", () => {
    const r = inboxRead(ROUTER, PARTY, ME);
    expect(r.to).toBe(ROUTER);
    expect(inboxFrom("0x" + "00".repeat(12) + "1B".repeat(20))).toBe(INBOX);
    expect(checkInRead(BOOK, CC).to).toBe(BOOK);
  });
});

describe("whether a claim handed over is this send's", () => {
  const want = { inbox: INBOX, ostiaNetwork: 75, amount: cc(4.8), count: 7, erc20: CC };
  it("holds exactly this address, network, token, amount and deposit number", () => {
    expect(isClaimInto(args, want)).toBe(true);
    expect(isClaimInto({ ...args, destinationAddress: ME }, want)).toBe(false);
    expect(isClaimInto({ ...args, destinationNetwork: 0 }, want)).toBe(false);
    expect(isClaimInto({ ...args, originNetwork: 0 }, want)).toBe(false);
    expect(isClaimInto({ ...args, originTokenAddress: ME }, want)).toBe(false);
    expect(isClaimInto({ ...args, amount: cc(4.9) }, want)).toBe(false);
    expect(isClaimInto({ ...args, globalIndex: 8n }, want)).toBe(false);
    expect(isClaimInto({ ...args, globalIndex: (1n << 64n) + 7n }, want)).toBe(true);   // the high bits name the network, the low 32 the deposit
    expect(isClaimInto(null, want)).toBe(false);
    expect(isClaimInto(undefined, want)).toBe(false);
  });
});
