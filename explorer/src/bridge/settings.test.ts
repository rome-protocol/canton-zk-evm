import { describe, expect, it } from "vitest";
import { accountsBase, settingsFromEnv } from "./settings.ts";

const env = { VITE_CHAIN_OPERATOR: "o", VITE_CHAIN_CONFIRMER: "c", VITE_CHAIN_GATEWAY: "g", VITE_CHAIN_BUILDER: "b", VITE_CHAIN_ID: "770101", VITE_CANTON_PARTICIPANT: "PAR::p", VITE_SITE_ORIGIN: "https://ostia.example" };

describe("the Bridge page's settings", () => {
  it("reads the chain, the participant, the service and the origin from the build's environment", () => {
    expect(settingsFromEnv(env)).toEqual({ chain: { operator: "o", confirmer: "c", gateway: "g", builder: "b", chainId: 770101 }, participant: "PAR::p", accountsBase: "", origin: "https://ostia.example" });
  });
  it("names the service by its /accounts address: this site's by default, or another origin's", () => {
    expect(accountsBase()).toBe("");
    expect(accountsBase("/accounts/")).toBe("");
    expect(accountsBase("https://accounts.example/accounts")).toBe("https://accounts.example");
    expect(accountsBase("https://accounts.example")).toBe("https://accounts.example");
    expect(settingsFromEnv({ ...env, VITE_ACCOUNTS_URL: "" }).accountsBase).toBe("");
    expect(settingsFromEnv({ ...env, VITE_ACCOUNTS_URL: "https://accounts.example/accounts" }).accountsBase).toBe("https://accounts.example");
  });
  it("throws, naming the setting, when one the page needs is missing", () => {
    for (const name of Object.keys(env)) expect(() => settingsFromEnv({ ...env, [name]: undefined }), name).toThrow(name);
  });
});
