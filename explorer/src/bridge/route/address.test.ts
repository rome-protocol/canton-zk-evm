import { describe, expect, it } from "vitest";
import { addressState, PARTY } from "./address.ts";
import { addressBody, INBOX, ME, PARTY as ALICE } from "./fakes.ts";
import { parseAddress } from "./setup.ts";

const read = (over: Record<string, unknown> = {}) => parseAddress(addressBody(over))!;
const base = { party: ALICE, wallet: ME, mine: null, askedAt: null, askFailed: false, now: 1_000_000, setupSeconds: 900 };

describe("where an account's Ostia address stands", () => {
  it("is reading until the first answer, and not available when the server cannot be read or Canton does not say", () => {
    expect(addressState({ ...base, read: "unread" })).toEqual({ kind: "reading" });
    expect(addressState({ ...base, read: null })).toEqual({ kind: "unavailable" });
    expect(addressState({ ...base, read: read({ accepts: null }) })).toEqual({ kind: "unavailable" });
  });
  it("says the account takes no transfers from Ostia, whatever else is true", () => {
    expect(addressState({ ...base, read: read({ accepts: false, opened: true }), mine: INBOX })).toEqual({ kind: "no-acceptance" });
  });
  it("shows the address only when a final block opened it and the page's own work of it agrees", () => {
    expect(addressState({ ...base, read: read({ opened: true }), mine: INBOX })).toEqual({ kind: "ready", inbox: INBOX });
    expect(addressState({ ...base, read: read({ opened: true }), mine: null })).toEqual({ kind: "reading" });
    expect(addressState({ ...base, read: read({ opened: true }), mine: "0x" + "22".repeat(20) })).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(addressState({ ...base, read: read({ opened: false, openTx: "0x" + "ab".repeat(32) }), askedAt: 999_000 }))).not.toContain(INBOX);
  });
  it("waits while it is set up, with the opening transaction once there is one", () => {
    expect(addressState({ ...base, read: read(), askedAt: null })).toEqual({ kind: "reading" });
    expect(addressState({ ...base, read: read(), askedAt: 900_000 })).toEqual({ kind: "setting-up", openTx: null, since: 900_000 });
    const tx = "0x" + "ab".repeat(32);
    expect(addressState({ ...base, read: read({ openTx: tx }), askedAt: 900_000 })).toEqual({ kind: "setting-up", openTx: tx, since: 900_000 });
  });
  it("ends as not available when the set time passes with no Sent mark, but not once the opening is in a block", () => {
    expect(addressState({ ...base, read: read(), askedAt: 100_000 })).toEqual({ kind: "unavailable" });
    expect(addressState({ ...base, read: read({ openTx: "0x" + "ab".repeat(32) }), askedAt: 100_000 })).toMatchObject({ kind: "setting-up" });
    expect(addressState({ ...base, read: read(), askedAt: 999_000, askFailed: true })).toEqual({ kind: "unavailable" });
  });
  it("is still reading when the answer is about another account or wallet than the one typed", () => {
    const final = read({ opened: true });
    expect(addressState({ ...base, read: final, mine: INBOX, party: "bob::1220" + "ab".repeat(16) })).toEqual({ kind: "reading" });
    expect(addressState({ ...base, read: final, mine: INBOX, wallet: "0x" + "44".repeat(20) })).toEqual({ kind: "reading" });
    expect(addressState({ ...base, read: final, mine: INBOX, wallet: ME.toUpperCase().replace("0X", "0x") })).toEqual({ kind: "ready", inbox: INBOX });
  });
  it("takes a party id of the server's shape only", () => {
    expect(PARTY.test("alice::1220ab")).toBe(true);
    for (const bad of ["", "a b", "a".repeat(301), "a/b"]) expect(PARTY.test(bad)).toBe(false);
  });
});
