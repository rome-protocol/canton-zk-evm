// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, status } from "../test-utils.tsx";
import { AddToWallet } from "./AddToWallet.tsx";

afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.restoreAllMocks();
});

const st = (over: Partial<Parameters<typeof AddToWallet>[0]["status"]> = {}) => ({ chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 }, publicRpc: true, ...over });
const wallet = (request: (call: { method: string; params: unknown[] }) => Promise<unknown>) => {
  const spy = vi.fn(request);
  (window as unknown as { ethereum: unknown }).ethereum = { request: spy };
  return spy;
};
const button = () => screen.getByRole("button", { name: "Add Ostia to your wallet" });

describe("the Add to wallet card", () => {
  it("shows nothing at all when the public RPC is off", () => {
    const { container } = render(<AddToWallet status={st({ publicRpc: false })} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/\/rpc/)).toBeNull();
  });

  it("shows the button, and the RPC address on this host with the guarantee, when the public RPC is on", () => {
    render(<AddToWallet status={st()} />);
    expect(button()).toBeInTheDocument();
    expect(screen.getByLabelText("RPC address")).toHaveTextContent(`${location.origin}/rpc`);
    expect(screen.getByText("A receipt from this address means the block is proven and final on Canton.")).toBeInTheDocument();
  });

  it("asks the wallet to add the chain with the chain's id in hex, the coin, this host's RPC and the explorer", async () => {
    const request = wallet(async () => null);
    render(<AddToWallet status={st()} />);
    await userEvent.setup().click(button());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0xbc035", chainName: "Ostia", nativeCurrency: { name: "tROME", symbol: "tROME", decimals: 18 },
        rpcUrls: [`${location.origin}/rpc`], blockExplorerUrls: [location.origin],
      }],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Ostia is in your wallet.");
  });

  it("says so, and points to the address, when the browser has no wallet", async () => {
    render(<AddToWallet status={st()} />);
    await userEvent.setup().click(button());
    expect(await screen.findByRole("status")).toHaveTextContent("No wallet was found in this browser. Add the network by hand with the address below.");
  });

  it("says what the wallet said when the visitor refuses it", async () => {
    wallet(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); });
    render(<AddToWallet status={st()} />);
    await userEvent.setup().click(button());
    expect(await screen.findByRole("status")).toHaveTextContent("Your wallet did not add the network: User rejected the request.");
  });

  it("says it plainly when the wallet refuses with no message", async () => {
    wallet(async () => { throw {}; });
    render(<AddToWallet status={st()} />);
    await userEvent.setup().click(button());
    expect(await screen.findByRole("status")).toHaveTextContent(/^Your wallet did not add the network\.$/);
  });

  it("copies the RPC address, and says it was copied", async () => {
    const user = userEvent.setup();
    render(<AddToWallet status={st()} />);
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy the RPC address" }));
    expect(write).toHaveBeenCalledWith(`${location.origin}/rpc`);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});

describe("where the card appears", () => {
  it("is on the home page and on the faucet page when the public RPC is on", async () => {
    fakeApi((path) => (path === "/api/faucet" ? { status: 200, body: { on: false, address: null, balance: null, amount: "1", perAddressSeconds: 1 } } : { status: 200, body: status({ publicRpc: true }) }));
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Add Ostia to your wallet" })).toBeInTheDocument();
    cleanup();
    renderApp("/faucet");
    expect(await screen.findByRole("heading", { name: "Add Ostia to your wallet" })).toBeInTheDocument();
    expect(screen.getByLabelText("RPC address")).toHaveTextContent("/rpc");
  });

  it("is on neither page when the public RPC is off", async () => {
    fakeApi((path) => (path === "/api/faucet" ? { status: 200, body: { on: false, address: null, balance: null, amount: "1", perAddressSeconds: 1 } } : { status: 200, body: status({ publicRpc: false }) }));
    renderApp("/");
    await screen.findByText("Final on Canton");
    expect(screen.queryByText(/Add Ostia to your wallet/)).toBeNull();
    expect(screen.queryByLabelText("RPC address")).toBeNull();
    cleanup();
    renderApp("/faucet");
    await screen.findByText("The faucet is off.");
    expect(screen.queryByText(/Add Ostia to your wallet/)).toBeNull();
    expect(screen.queryByLabelText("RPC address")).toBeNull();
  });
});
