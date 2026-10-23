// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ContractListItem } from "../api.ts";
import { addr, contractItem, fakeApi, genesisContract, page, renderApp, reply, route } from "../test-utils.tsx";

const LIST = [contractItem(0xb1), contractItem(0xb2, { name: "Gateway", matchType: "partial", origin: "genesis", creator: null, creationBlock: null }), genesisContract(0xb3)];
async function open(answer: (path: string) => ReturnType<typeof reply> = () => reply({ ...page(LIST), derived: true })) {
  const calls = fakeApi(route({ contracts: (_a, _s, path) => answer(path) }));
  renderApp("/contracts");
  await screen.findByRole("heading", { name: "Contracts" });
  await screen.findByRole("table");
  return calls;
}
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("the contracts page", () => {
  it("lists the contracts by interactions first, each linking to its own page", async () => {
    const calls = await open();
    expect(calls).toContain("/api/contracts?sort=interactions&limit=25");
    expect(rows()).toHaveLength(3);
    expect(within(rows()[0]!).getByRole("link", { name: "TestUSD" })).toHaveAttribute("href", `/contract/${addr(0xb1)}`);
    expect(rows()[0]).toHaveTextContent("0xb1b1…b1b1");
    expect(rows()[0]).toHaveTextContent("9");
    expect(rows()[0]).toHaveTextContent("3,318 B");
  });

  it("shows what kind of contract it is: a token by its standard, any other as a contract", async () => {
    await open(() => reply({ ...page([contractItem(0xb1), contractItem(0xb2, { standard: "ERC-721" }), contractItem(0xb3, { standard: null })]), derived: true }));
    expect(rows()[0]).toHaveTextContent("ERC-20");
    expect(rows()[1]).toHaveTextContent("ERC-721");
    expect(within(rows()[2]!).getAllByText("Contract").length).toBeGreaterThan(0);
  });

  it("splits the interactions into transactions and internal calls, and says a contract nobody has called has no calls yet", async () => {
    await open(() => reply({ ...page([contractItem(0xb1, { txCount: 5, internalCount: 4 }), contractItem(0xb2, { interactionCount: 0, txCount: 0, internalCount: 0 }), contractItem(0xb3, { interactionCount: 1, txCount: 1, internalCount: 0 })]), derived: true }));
    expect(rows()[0]).toHaveTextContent("5 transactions · 4 internal calls");
    expect(rows()[1]).toHaveTextContent("no calls yet");
    expect(rows()[2]).toHaveTextContent("1 transaction · 0 internal calls");
  });

  it("shows the balance in the chain's coin as the explorer's copy, and a balance it has not read as unknown, never as 0", async () => {
    await open(() => reply({ ...page([contractItem(0xb1, { balance: "1500000000000000000", balanceBlock: 20 }), contractItem(0xb2, { balance: null, balanceBlock: null })]), derived: true }));
    expect(screen.getByRole("columnheader", { name: "Balance (tROME)" })).toBeInTheDocument();
    expect(rows()[0]).toHaveTextContent("1.5");
    expect(rows()[1]!.querySelectorAll("td")[7]).toHaveTextContent("—");
    expect(screen.getByText(/the explorer's copy/)).toBeInTheDocument();
  });

  it("shows the match kind of a verified contract and says an unverified one is not verified", async () => {
    await open();
    expect(rows()[0]).toHaveTextContent("Full match");
    expect(rows()[1]).toHaveTextContent("Partial match");
    expect(rows()[2]).toHaveTextContent("Not verified");
  });

  it("shows where a contract was made: the block and the creator, or the genesis", async () => {
    await open();
    expect(within(rows()[0]!).getByRole("link", { name: "Block 18" })).toHaveAttribute("href", "/block/18");
    expect(within(rows()[0]!).getByRole("link", { name: "0xe3e3…e3e3" })).toHaveAttribute("href", `/address/${addr(0xe3)}`);
    expect(rows()[2]).toHaveTextContent("genesis");
    expect(rows()[2]).toHaveTextContent("set by the chain, no creation");
    expect(within(rows()[2]!).queryByRole("link", { name: /Block/ })).toBeNull();
  });

  it("names a contract without a name by its address and says it has no name", async () => {
    await open();
    expect(within(rows()[2]!).getByRole("link", { name: "0xb3b3…b3b3" })).toHaveAttribute("href", `/contract/${addr(0xb3)}`);
  });

  it("says a destroyed contract is destroyed", async () => {
    await open(() => reply({ ...page([contractItem(0xb1, { destroyedBlock: 21 })]), derived: true }));
    expect(rows()[0]).toHaveTextContent("destroyed in block 21");
  });

  it("shows the partial-match note whenever a partial match is on the page", async () => {
    await open();
    expect(screen.getByText(/Partial match: the metadata differs from this compile/)).toBeInTheDocument();
  });

  it("leaves the note out when no partial match is shown", async () => {
    await open(() => reply({ ...page([contractItem(0xb1)]), derived: true }));
    expect(screen.queryByText(/the metadata differs/)).toBeNull();
  });

  it("sorts by newest and oldest from the first page", async () => {
    const calls = await open();
    await userEvent.click(screen.getByRole("button", { name: "Newest" }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=newest&limit=25"));
    await userEvent.click(screen.getByRole("button", { name: "Oldest" }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=oldest&limit=25"));
  });

  it("filters to the verified or the not verified, and back to all", async () => {
    const calls = await open();
    await userEvent.click(screen.getByRole("button", { name: "Verified" }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=interactions&limit=25&verified=true"));
    await userEvent.click(screen.getByRole("button", { name: "Not verified" }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=interactions&limit=25&verified=false"));
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(calls.filter((c) => c === "/api/contracts?sort=interactions&limit=25").length).toBeGreaterThan(0));
  });

  it("walks the pages by the server's cursor", async () => {
    const calls = await open((p) => reply({ ...page([contractItem(p.includes("before=") ? 0xb4 : 0xb1)], p.includes("before=") ? null : "9:0xb1"), derived: true }));
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await waitFor(() => expect(calls.some((c) => c.includes("before=9%3A0xb1"))).toBe(true));
    await waitFor(() => expect(rows()[0]).toHaveTextContent("0xb4b4…b4b4"));
  });

  it("points to the tools that verify a contract, with this explorer's own address", async () => {
    await open();
    const how = screen.getByRole("note", { name: "How to verify a contract" });
    expect(how).toHaveTextContent(/forge verify-contract/);
    expect(how).toHaveTextContent(`${window.location.origin}/api`);
    expect(within(how).getByRole("link", { name: "API" })).toHaveAttribute("href", "/docs/api");
  });

  it("shows source and names as text, never as markup", async () => {
    const evil: ContractListItem = contractItem(0xb1, { name: "<img src=x onerror=alert(1)>" });
    await open(() => reply({ ...page([evil]), derived: true }));
    expect(rows()[0]!.querySelector("img")).toBeNull();
    expect(rows()[0]).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("says when the explorer has not read every block yet, and when there are no contracts", async () => {
    await open(() => reply({ ...page(LIST), derived: false }));
    expect(screen.getByText(/still reading blocks/)).toBeInTheDocument();
  });

  it("says so when there are no contracts", async () => {
    fakeApi(route({ contracts: () => reply({ ...page([]), derived: true }) }));
    renderApp("/contracts");
    expect(await screen.findByText("No contracts yet.")).toBeInTheDocument();
  });

  it("never calls the list empty while the explorer has not read every block", async () => {
    fakeApi(route({ contracts: () => reply({ ...page([]), derived: false }) }));
    renderApp("/contracts");
    expect(await screen.findByText(/still reading blocks/)).toBeInTheDocument();
    expect(screen.queryByText("No contracts yet.")).toBeNull();
  });
});
