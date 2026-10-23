// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, status } from "./test-utils.tsx";
import { addNetwork } from "./wallet.ts";

afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.restoreAllMocks();
});

const st = (over: Partial<Parameters<typeof addNetwork>[0]> = {}) => ({ chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 }, ...over });
const wallet = (request: (call: { method: string; params: unknown[] }) => Promise<unknown>) => {
  const spy = vi.fn(request);
  (window as unknown as { ethereum: unknown }).ethereum = { request: spy };
  return spy;
};

describe("addNetwork", () => {
  it("asks the wallet to add the chain with the chain's id in hex, the coin, this host's RPC and the explorer", async () => {
    const request = wallet(async () => null);
    expect(await addNetwork(st(), "Ostia", "below")).toBe("Ostia is in your wallet.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0xbc035", chainName: "Ostia", nativeCurrency: { name: "tROME", symbol: "tROME", decimals: 18 },
        rpcUrls: [`${location.origin}/rpc`], blockExplorerUrls: [location.origin],
      }],
    });
  });

  it("says so, and points to where the details are, when the browser has no wallet", async () => {
    expect(await addNetwork(st(), "Ostia", "below")).toBe("No wallet was found in this browser. Add the network by hand with the address below.");
    expect(await addNetwork(st(), "Ostia", "above")).toBe("No wallet was found in this browser. Add the network by hand with the details above.");
  });

  it("says what the wallet said when the visitor refuses it, cut when long", async () => {
    wallet(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); });
    expect(await addNetwork(st(), "Ostia", "below")).toBe("Your wallet did not add the network: User rejected the request.");
    wallet(async () => { throw new Error("x".repeat(400)); });
    expect((await addNetwork(st(), "Ostia", "below")).length).toBeLessThan(220);
  });

  it("says it plainly when the wallet refuses with no message", async () => {
    wallet(async () => { throw {}; });
    expect(await addNetwork(st(), "Ostia", "below")).toBe("Your wallet did not add the network.");
  });
});

describe("where the card appears", () => {
  it("is on neither the faucet page nor the home page, which leave it to the footer link and the API page, when the public RPC is on", async () => {
    fakeApi((path) => (path === "/api/faucet" ? { status: 200, body: { on: false, address: null, balance: null, amount: "1", perAddressSeconds: 1 } } : { status: 200, body: status({ publicRpc: true }) }));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    expect(screen.queryByRole("heading", { name: "Add Ostia to your wallet" })).toBeNull();
    expect(screen.getByRole("link", { name: "Add Ostia to your wallet" })).toHaveAttribute("href", "/docs/api#rpc-h");
    cleanup();
    renderApp("/faucet");
    await screen.findByRole("heading", { level: 1, name: "Faucet" });
    expect(screen.queryByRole("heading", { name: "Add Ostia to your wallet" })).toBeNull();
    expect(screen.getByRole("link", { name: "Add Ostia to your wallet" })).toHaveAttribute("href", "/docs/api#rpc-h");
  });

  it("is on no page when the public RPC is off", async () => {
    fakeApi((path) => (path === "/api/faucet" ? { status: 200, body: { on: false, address: null, balance: null, amount: "1", perAddressSeconds: 1 } } : { status: 200, body: status({ publicRpc: false }) }));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    expect(screen.queryByText(/Add Ostia to your wallet/)).toBeNull();
    expect(screen.queryByLabelText("RPC address")).toBeNull();
    cleanup();
    renderApp("/faucet");
    await screen.findByText("The faucet is off.");
    expect(screen.queryByText(/Add Ostia to your wallet/)).toBeNull();
    expect(screen.queryByLabelText("RPC address")).toBeNull();
  });
});
