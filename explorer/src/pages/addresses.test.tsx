// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AddressListItem } from "../api.ts";
import { addr, fakeApi, page, renderApp, reply, route } from "../test-utils.tsx";

const item = (n: number, over: Partial<AddressListItem> = {}): AddressListItem => ({ address: addr(n), kind: "account", balance: "1500000000000000000", balanceBlock: 20, txCount: n, ...over });
async function open(answer: (path: string) => ReturnType<typeof reply> = () => reply({ ...page([item(0x11), item(0x22, { kind: "contract", balance: null, balanceBlock: null })]), derived: true })) {
  const calls = fakeApi(route({ addresses: (_a, _s, path) => answer(path) }));
  renderApp("/addresses");
  await screen.findByRole("heading", { name: "Addresses" });
  await screen.findByRole("table");
  return calls;
}
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("the addresses page", () => {
  it("lists addresses by balance first, each linking to its own page, with its balance and its transactions", async () => {
    const calls = await open();
    expect(calls).toContain("/api/addresses?sort=balance&limit=25");
    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]!).getByRole("link", { name: "0x1111…1111" })).toHaveAttribute("href", `/address/${addr(0x11)}`);
    expect(rows()[0]).toHaveTextContent("1.5 tROME");
    expect(rows()[0]).toHaveTextContent("block 20");
    expect(rows()[0]).toHaveTextContent("Account");
    expect(rows()[1]).toHaveTextContent("Contract");
  });

  it("sends a contract to its contract page", async () => {
    await open();
    expect(within(rows()[1]!).getByRole("link", { name: "0x2222…2222" })).toHaveAttribute("href", `/contract/${addr(0x22)}`);
  });

  it("shows a balance the index has not read as unknown, never as 0", async () => {
    await open();
    expect(rows()[1]!.querySelectorAll("td")[2]).toHaveTextContent("—");
    expect(rows()[1]).not.toHaveTextContent("0 tROME");
  });

  it("says the balances are the index's copy and that the address page reads reth", async () => {
    await open();
    expect(screen.getByText(/the explorer's copy/)).toBeInTheDocument();
  });

  it("sorts by transactions when asked, from the first page", async () => {
    const calls = await open();
    await userEvent.click(screen.getByRole("button", { name: "Transactions" }));
    await waitFor(() => expect(calls).toContain("/api/addresses?sort=txs&limit=25"));
  });

  it("walks the pages by the server's cursor", async () => {
    const calls = await open((p) => reply({ ...page([item(p.includes("before=") ? 0x33 : 0x11)], p.includes("before=") ? null : "5:0x11"), derived: true }));
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await waitFor(() => expect(calls.some((c) => c.includes("before=5%3A0x11"))).toBe(true));
    await waitFor(() => expect(rows()[0]).toHaveTextContent("0x3333…3333"));
  });

  it("says when the explorer has not read every block yet", async () => {
    await open(() => reply({ ...page([item(0x11)]), derived: false }));
    expect(screen.getByText(/still reading blocks/)).toBeInTheDocument();
  });

  it("says so when there are no addresses", async () => {
    fakeApi(route({ addresses: () => reply({ ...page([]), derived: true }) }));
    renderApp("/addresses");
    expect(await screen.findByText("No addresses yet.")).toBeInTheDocument();
  });
});
