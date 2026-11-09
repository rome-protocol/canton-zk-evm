// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetWallet, inWallet, loopNetwork, rememberWallet, wasConnected, walletsFromEnv } from "./wallets.ts";

afterEach(() => vi.restoreAllMocks());

describe("the switch for Canton wallets", () => {
  it("offers none when VITE_CANTON_WALLETS is unset or empty: the page is the Bridge as it was", () => {
    expect(walletsFromEnv({})).toEqual({ wallets: [], gatewayUrl: null });
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: "" })).toEqual({ wallets: [], gatewayUrl: null });
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: " , ," }).wallets).toEqual([]);
  });
  it("lists the wallets it names, in order, each once, in any case", () => {
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: "Loop, extension,loop", VITE_CANTON_GATEWAY_URL: "" }).wallets).toEqual(["loop", "extension"]);
  });
  it("leaves out a name that is no wallet of this build, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: "loop,lopp,metamask" }).wallets).toEqual(["loop"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it("takes the Wallet Gateway only with an http or https address", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: "loop,gateway" }).wallets).toEqual(["loop"]);
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: "gateway", VITE_CANTON_GATEWAY_URL: "javascript:alert(1)" }).wallets).toEqual([]);
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: "gateway", VITE_CANTON_GATEWAY_URL: "not a url" }).wallets).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(walletsFromEnv({ VITE_CANTON_WALLETS: "loop,gateway", VITE_CANTON_GATEWAY_URL: "https://gateway.example/api/v0/dapp" })).toEqual({ wallets: ["loop", "gateway"], gatewayUrl: "https://gateway.example/api/v0/dapp" });
  });
  it("gives Loop's library the network the chain is on, and nothing for a name it does not know", () => {
    expect(loopNetwork("DevNet")).toBe("devnet");
    expect(loopNetwork("Test Net")).toBe("testnet");
    expect(loopNetwork("MainNet")).toBe("mainnet");
    expect(loopNetwork("Localnet")).toBeUndefined();
    expect(loopNetwork(null)).toBeUndefined();
  });
  it("names the wallet where the person approves", () => {
    expect(inWallet("Loop")).toBe("Loop");
    expect(inWallet("Canton wallet")).toBe("your Canton wallet");
    expect(inWallet("Send Connect")).toBe("Send Connect");
  });
  it("remembers that a wallet was connected, and works without storage", () => {
    expect(wasConnected()).toBe(false);
    rememberWallet();
    expect(wasConnected()).toBe(true);
    forgetWallet();
    expect(wasConnected()).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(wasConnected()).toBe(false);
    expect(() => rememberWallet()).not.toThrow();
  });
});
