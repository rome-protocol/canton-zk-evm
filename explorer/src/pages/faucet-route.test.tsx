// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, reply, route, status } from "../test-utils.tsx";

describe("the faucet route", () => {
  it("is the two-column faucet page alone: the wallet card is on the API page and in the footer, not under the columns", async () => {
    fakeApi(route({ status: () => reply(status({ publicRpc: true, faucet: { on: true } })), faucet: () => reply({ on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 21 }) }));
    renderApp("/faucet");
    await screen.findByRole("heading", { level: 1, name: "Faucet" });
    await screen.findByRole("heading", { name: "The faucet" });
    expect(screen.queryByRole("heading", { name: /to your wallet/ })).not.toBeInTheDocument();
    expect(document.querySelector(".rpc-card")).toBeNull();
  });

  /** The route with a faucet that turns every request away on the address's limit; the status names (or not) a Swap site. */
  async function refused(swapUrl: string | null) {
    const served = route({ status: () => reply(status({ swapUrl, faucet: { on: true } })), faucet: () => reply({ on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 21 }) });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const a = init?.method === "POST" ? { status: 429, body: { error: "This address was given coins in the last 24 hours. Try again later.", reason: "address" } } : served(input);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json", ...(init?.method === "POST" ? { "Retry-After": "3600" } : {}) } });
    }));
    renderApp("/faucet");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Your address"), "0x5a04de5c5ebd085f5e3b3ec791ab5cdc8e2b56f0");
    await user.click(screen.getByRole("button", { name: /Request/ }));
    return screen.findByRole("alert");
  }

  it("points to the Ostia Swap under a refusal when the deployment names one", async () => {
    await refused("https://swap.ostia.testnet.romeprotocol.xyz/");
    const link = await within(document.querySelector(".faucet-page")!.parentElement!).findByRole("link", { name: "Ostia Swap" });
    expect(link).toHaveAttribute("href", "https://swap.ostia.testnet.romeprotocol.xyz/");
    expect(link.parentElement).toHaveTextContent("Have some tROME already? Swap CC, WETH or SOL for more on the Ostia Swap.");
  });

  it("says nothing of a Swap under a refusal when the deployment names none", async () => {
    await refused(null);
    expect(screen.queryByRole("link", { name: "Ostia Swap" })).toBeNull();
  });
});
