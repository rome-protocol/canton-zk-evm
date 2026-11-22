import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBase } from "./amount.ts";
import { readClaim, readDeposit, ReadError } from "./reads.ts";
import { AmountError } from "../amounts.ts";

afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

describe("the deposit read", () => {
  it("asks for the network and the number, and returns the stage and its times", async () => {
    answer(200, { network: 0, count: 7, stage: "ready", destinationNetwork: 75, sentAt: "2026-11-22T21:40:00Z", confirmedAt: "2026-11-22T21:44:00Z", readyAt: "nonsense", leaf: null });
    expect(await readDeposit(0, 7)).toEqual({ stage: "ready", sentAt: "2026-11-22T21:40:00Z", confirmedAt: "2026-11-22T21:44:00Z", readyAt: null });
    expect(fetch).toHaveBeenCalledWith("/api/agglayer/deposit?network=0&count=7", expect.anything());
  });
  it("fails with the server's status, and with 503 for an answer that is not one", async () => {
    answer(404, { error: "That deposit is not on a route this page serves." });
    await expect(readDeposit(0, 7)).rejects.toMatchObject({ name: "ReadError", status: 404, message: "That deposit is not on a route this page serves." });
    answer(200, { stage: "somewhere" });
    await expect(readDeposit(0, 7)).rejects.toMatchObject({ status: 503 });
    answer(429, null);
    await expect(readDeposit(0, 7)).rejects.toMatchObject({ status: 429 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(readDeposit(0, 7)).rejects.toBeInstanceOf(ReadError);
  });
});

describe("the claim read", () => {
  it("returns what the wallet needs", async () => {
    answer(200, { network: 0, count: 7, claimed: false, destinationNetwork: 75, chainId: 770101, to: "0x" + "53".repeat(20), l1InfoTreeIndex: 4, data: "0x1234", args: {} });
    expect(await readClaim(0, 7)).toEqual({ claimed: false, chainId: 770101, to: "0x" + "53".repeat(20), destinationNetwork: 75, data: "0x1234", args: null });
    expect(fetch).toHaveBeenCalledWith("/api/agglayer/claim?network=0&count=7", expect.anything());
  });
  it("has no data for a deposit that is paid out, and fails when the answer is not one", async () => {
    answer(200, { claimed: true, destinationNetwork: 75, chainId: 1, to: "0x1", data: null, args: null });
    expect((await readClaim(0, 7)).data).toBeNull();
    answer(200, { claimed: "no" });
    await expect(readClaim(0, 7)).rejects.toMatchObject({ status: 503 });
    answer(404, { error: "That deposit is not ready to claim yet." });
    await expect(readClaim(0, 7)).rejects.toMatchObject({ status: 404 });
  });
});

describe("an amount in a token of 18 decimals", () => {
  it("is exact: ether is not held to the ten decimals of Canton", () => {
    expect(parseBase("0.002", 18)).toBe(2_000_000_000_000_000n);
    expect(parseBase("0.000000000000000001", 18)).toBe(1n);
    expect(parseBase("12", 18)).toBe(12n * 10n ** 18n);
    expect(parseBase(".5", 6)).toBe(500_000n);
    expect(parseBase("5.", 6)).toBe(5_000_000n);
    expect(parseBase("1.500000", 6)).toBe(1_500_000n);
  });
  it("refuses what it cannot take exactly, in words", () => {
    expect(() => parseBase("0.0000000000000000001", 18)).toThrow(AmountError);
    expect(() => parseBase("1.0000001", 6)).toThrow("This token has 6 decimals: use at most 6.");
    expect(() => parseBase("0", 18)).toThrow("The amount must be more than zero.");
    expect(() => parseBase("0.0", 18)).toThrow("The amount must be more than zero.");
    for (const text of ["", "abc", "1e18", "-1", "1,5", "1.2.3", "0x10"]) expect(() => parseBase(text, 18), text).toThrow("Type an amount such as 0.5 or 12.");
  });
});
