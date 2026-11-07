import { describe, expect, it } from "vitest";
import type { AllocationView } from "./canton/accounts.ts";
import { depositRecord, redeemRecord, typedAmount } from "./adopt.ts";
import { depositIdOf } from "./moves/state.ts";
import { config, FIELD, ME, PARTY, TKA, CC_ADMIN, WCC } from "../pages/bridge-fakes.ts";

const o = { account: ME, party: PARTY, config };
const redeem = (a: Record<string, unknown> = {}) => ({ contractId: "00", arguments: { holder: PARTY, [FIELD]: TKA.slice(2), amount: "1.5000000000", recipient: ME.slice(2), ref: "r-1", ...a } });
const alloc = (label: string, amount = "5.0000000000", id = "Amulet"): AllocationView => ({ contractId: "00", allocation: { settlement: { settlementRef: { id: label } }, transferLegId: "l", transferLeg: { sender: PARTY, receiver: "g", amount, instrumentId: { admin: CC_ADMIN, id } } }, holdingCids: [] });

describe("a move kept from what Canton lists as open", () => {
  it("writes a Canton amount as it is typed", () => {
    expect([typedAmount("1.5000000000"), typedAmount("3.0000000000"), typedAmount("0.0000000001"), typedAmount("12")]).toEqual(["1.5", "3", "0.0000000001", "12"]);
  });
  it("makes a redeem's record from its request, at the stage where only the wait is left", () => {
    expect(redeemRecord(redeem(), o)).toMatchObject({ input: { kind: "redeem", asset: TKA, amount: "1.5", to: ME }, ref: "r-1", account: ME, party: PARTY, to: ME, stage: "canton", vault: config.vault });
  });
  it("refuses a redeem of a token the bridge does not move, another holder's, one with a bad recipient, or no ref", () => {
    expect(redeemRecord(redeem({ [FIELD]: "ee".repeat(20) }), o)).toBeNull();
    expect(redeemRecord(redeem({ holder: "bob::1220" + "cd".repeat(32) }), o)).toBeNull();
    expect(redeemRecord(redeem({ recipient: "12" }), o)).toBeNull();
    expect(redeemRecord(redeem({ ref: "" }), o)).toBeNull();
    expect(redeemRecord(redeem({ ref: "x".repeat(129) }), o)).toBeNull();
    expect(redeemRecord(redeem({ amount: "0.0000000000" }), o)).toBeNull();
  });
  const dep = (label = "d-1", extra: Record<string, unknown> = {}) => ({ contractId: "00", arguments: { depositor: PARTY, depositId: depositIdOf(PARTY, label).slice(2), label, ...extra } });
  it("makes a deposit's record from its request and the allocation under its label", async () => {
    expect(await depositRecord(dep(), { ...o, allocations: async () => [alloc("other"), alloc("d-1")] })).toMatchObject({ input: { kind: "deposit", asset: WCC, amount: "5" }, ref: "d-1", stage: "canton", party: PARTY });
  });
  it("refuses a deposit whose id is not its label's, whose allocation is gone, or whose token the bridge does not move", async () => {
    const some = { ...o, allocations: async () => [alloc("d-1")] };
    expect(await depositRecord(dep("d-1", { depositId: "00".repeat(32) }), some)).toBeNull();
    expect(await depositRecord(dep(), { ...o, allocations: async () => [] })).toBeNull();
    expect(await depositRecord(dep(), { ...o, allocations: async () => [alloc("d-1", "5.0000000000", "Other")] })).toBeNull();
    expect(await depositRecord(dep("d-1", { depositor: "bob::1220" + "cd".repeat(32) }), some)).toBeNull();
  });
});
