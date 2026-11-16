import { describe, expect, it } from "vitest";
import { bridgeAccountFromEnv } from "./canton/env.ts";
import { accountsBase, settingsFromEnv } from "./settings.ts";

const env = { VITE_CHAIN_OPERATOR: "o", VITE_CHAIN_CONFIRMER: "c", VITE_CHAIN_GATEWAY: "g", VITE_CHAIN_BUILDER: "b", VITE_CHAIN_ID: "770101", VITE_CANTON_PARTICIPANT: "PAR::p", VITE_SITE_ORIGIN: "https://ostia.example" };

describe("the Bridge page's settings", () => {
  it("reads the chain, the participant, the service and the origin from the build's environment", () => {
    expect(settingsFromEnv(env)).toEqual({ chain: { operator: "o", confirmer: "c", gateway: "g", builder: "b", chainId: 770101 }, participant: "PAR::p", partyHint: "rome", accountsBase: "", origin: "https://ostia.example" });
  });
  it("names accounts with VITE_PARTY_HINT, rome when it is not set, and refuses a name the service would not accept", () => {
    expect(settingsFromEnv({ ...env, VITE_PARTY_HINT: "" }).partyHint).toBe("rome");
    expect(settingsFromEnv({ ...env, VITE_PARTY_HINT: "ostia-1" }).partyHint).toBe("ostia-1");
    for (const bad of ["a b", "a::b", "x".repeat(33), "é"]) expect(() => settingsFromEnv({ ...env, VITE_PARTY_HINT: bad }), bad).toThrow(/VITE_PARTY_HINT/);
  });
  it("asks this site for the service: /accounts is the only address, and another origin's is refused", () => {
    expect(accountsBase()).toBe("");
    expect(accountsBase("/accounts/")).toBe("");
    expect(settingsFromEnv({ ...env, VITE_ACCOUNTS_URL: "" }).accountsBase).toBe("");
    expect(settingsFromEnv({ ...env, VITE_ACCOUNTS_URL: "/accounts" }).accountsBase).toBe("");
    for (const other of ["https://accounts.example/accounts", "https://accounts.example", "//accounts.example/accounts", "/other"]) {
      expect(() => accountsBase(other), other).toThrow("VITE_ACCOUNTS_URL");
      expect(() => settingsFromEnv({ ...env, VITE_ACCOUNTS_URL: other }), other).toThrow("VITE_ACCOUNTS_URL");
    }
  });
  it("throws, naming the setting, when one the page needs is missing", () => {
    for (const name of Object.keys(env)) expect(() => settingsFromEnv({ ...env, [name]: undefined }), name).toThrow(name);
  });
  it("turns the Bridge account on only when VITE_BRIDGE_ACCOUNT is on: unset, empty and any other word are off", () => {
    expect(bridgeAccountFromEnv({})).toBe(false);
    for (const v of ["", "off", "0", "1", "true", "yes", "onn"]) expect(bridgeAccountFromEnv({ VITE_BRIDGE_ACCOUNT: v }), v).toBe(false);
    for (const v of ["on", "ON", " on "]) expect(bridgeAccountFromEnv({ VITE_BRIDGE_ACCOUNT: v }), v).toBe(true);
  });
  it("needs the participant and the party hint only when the build has the Bridge account", () => {
    const { VITE_CANTON_PARTICIPANT: _drop, ...bare } = env;
    expect(() => settingsFromEnv(bare, true)).toThrow("VITE_CANTON_PARTICIPANT");
    expect(() => settingsFromEnv({ ...env, VITE_PARTY_HINT: "a b" }, true)).toThrow("VITE_PARTY_HINT");
    // Off: no participant, no hint and no service, and a bad value of those is not read. The chain and the origin are still needed.
    expect(settingsFromEnv(bare, false)).toEqual({ chain: { operator: "o", confirmer: "c", gateway: "g", builder: "b", chainId: 770101 }, participant: "", partyHint: "", accountsBase: "", origin: "https://ostia.example" });
    expect(settingsFromEnv({ ...bare, VITE_PARTY_HINT: "a b", VITE_ACCOUNTS_URL: "/other" }, false).partyHint).toBe("");
    for (const name of ["VITE_CHAIN_OPERATOR", "VITE_SITE_ORIGIN"]) expect(() => settingsFromEnv({ ...bare, [name]: undefined }, false), name).toThrow(name);
  });
});
