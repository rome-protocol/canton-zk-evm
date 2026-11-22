import { describe, expect, it } from "vitest";
import { asset, cc } from "./fakes.ts";
import { checkAddress, checkAmount, quote } from "./form.ts";
import { capWords, overCapWords } from "./words.ts";

describe("what a move costs, before the wallet is asked", () => {
  it("is the book's fee (the move's and the claim's) taken from the amount, so 5 CC pays 0.2 and sends 4.8", () => {
    expect(quote(asset(), 1n, cc(5))).toEqual({ fee: cc(0.2), send: cc(4.8) });
  });
  it("cuts what is sent down to the destination's unit and puts the cut in the fee, so the fee shown is the fee taken", () => {
    const q = quote(asset(), 10n, cc(5) + 7n)!;
    expect(q.send % 10n).toBe(0n);
    expect(q.fee + q.send).toBe(cc(5) + 7n);
    expect(q.fee).toBe(cc(0.2) + 7n);
  });
  it("is nothing when nothing is left after the fee, or when less than one unit is", () => {
    expect(quote(asset(), 1n, cc(0.2))).toBeNull();
    expect(quote(asset(), 1n, cc(0.1))).toBeNull();
    expect(quote(asset(), 100n, cc(0.2) + 99n)).toBeNull();
  });
  it("is the fee the page writes as the label's maxFee: never less than the book's fee", () => {
    for (const unit of [1n, 10n, 1000n]) for (const n of [1.2, 5, 9.99]) { const q = quote(asset(), unit, cc(n))!; expect(q.fee).toBeGreaterThanOrEqual(cc(0.2)); }
  });
});

describe("the amount typed", () => {
  const a = asset({ lockRoom: cc(2.5) });
  it("is empty, or reads", () => {
    expect(checkAmount(a, 1n, "")).toEqual({ state: "empty" });
    expect(checkAmount(a, 1n, "2")).toEqual({ state: "ok", amount: cc(2), quote: { fee: cc(0.2), send: cc(1.8) } });
  });
  it("says what the smallest amount is when it is below the minimum or leaves nothing after the fee", () => {
    expect(checkAmount(a, 1n, "0.5")).toEqual({ state: "bad", why: "The smallest amount for this route is 1 CC." });
    expect(checkAmount(asset({ minAmount: cc(0.1) }), 1n, "0.1")).toEqual({ state: "bad", why: "The smallest amount for this route is 0.2000000001 CC." });
  });
  it("is refused with the cap's words when what is sent is more than the room under the cap", () => {
    expect(checkAmount(a, 1n, "5")).toEqual({ state: "bad", why: "Up to 10 CC of Canton Coin can be on AggLayer chains at once for now. 7.5 CC is out, so you can send up to 2.5 CC." });
    expect(checkAmount(a, 1n, "2.7")).toMatchObject({ state: "ok" });
    expect(checkAmount(a, 1n, "2.8")).toMatchObject({ state: "bad" });
    expect(checkAmount(asset({ lockRoom: 0n }), 1n, "2")).toEqual({ state: "bad", why: "Up to 10 CC of Canton Coin can be on AggLayer chains at once for now, and that is reached. You can send again when some comes back to Canton." });
    expect(checkAmount(asset(), 1n, "11")).toEqual({ state: "bad", why: "Up to 10 CC of Canton Coin can be on AggLayer chains at once for now." });
  });
  it("is refused in words when it is not an amount", () => {
    for (const t of ["abc", "-1", "1e3", "1.12345678901"]) expect(checkAmount(a, 1n, t).state, t).toBe("bad");
  });
});

describe("the address on Ethereum Sepolia", () => {
  it("is 0x and 40 hex digits, and never the zero address", () => {
    expect(checkAddress("0x" + "e3".repeat(20))).toBeNull();
    expect(checkAddress(" 0x" + "E3".repeat(20) + " ")).toBeNull();
    expect(checkAddress("0x12")).toMatch(/Type an address on Ethereum Sepolia/);
    expect(checkAddress("0x" + "0".repeat(40))).toMatch(/zero address/);
  });
});

describe("the words about the cap", () => {
  it("name AggLayer chains and never say \"other chains\"", () => {
    const lines = [capWords(asset({ lockRoom: 0n })), capWords(asset({ lockRoom: cc(2.5) })), overCapWords(asset())];
    for (const l of lines) { expect(l).toContain("can be on AggLayer chains at once for now"); expect(l).not.toMatch(/other chains/i); }
  });
});
