import { describe, expect, it } from "vitest";
import { accountsBase, settingsFromEnv } from "./settings.ts";

const env = { VITE_CHAIN_OPERATOR: "o", VITE_CHAIN_CONFIRMER: "c", VITE_CHAIN_GATEWAY: "g", VITE_CHAIN_BUILDER: "b", VITE_CHAIN_ID: "770101", VITE_CANTON_PARTICIPANT: "PAR::p", VITE_SITE_ORIGIN: "https://ostia.example" };

describe("the Bridge page's settings", () => {
  it("reads the chain, the participant, the service and the origin from the build's environment", () => {
    expect(settingsFromEnv(env)).toEqual({ chain: { operator: "o", confirmer: "c", gateway: "g", builder: "b", chainId: 770101 }, participant: "PAR::p", accountsBase: "", origin: "https://ostia.example" });
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
});
