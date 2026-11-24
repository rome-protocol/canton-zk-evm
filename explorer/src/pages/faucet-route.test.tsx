// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
