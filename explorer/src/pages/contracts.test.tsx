// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ContractListItem } from "../api.ts";
import { addr, contractItem, fakeApi, genesisContract, page, renderApp, reply, route } from "../test-utils.tsx";

/** A page of the contract list as the API gives it: the totals are the list's own and each filter's, whatever the page holds. */
const L = (items: ContractListItem[], next: string | null = null, over: Record<string, unknown> = {}) =>
  reply({ ...page(items, next), total: items.length, counts: { all: items.length, verified: items.filter((c) => c.verified).length, notVerified: items.filter((c) => !c.verified).length }, derived: true, ...over });
const LIST = [contractItem(0xb1), contractItem(0xb2, { name: "Gateway", matchType: "partial", origin: "genesis", creator: null, creationBlock: null }), genesisContract(0xb3)];
async function open(answer: (path: string) => ReturnType<typeof reply> = () => L(LIST)) {
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
    expect(rows()[0]).toHaveTextContent("0xb1b1b1b1…b1b1b1");
    expect(rows()[0]).toHaveTextContent("9");
    expect(rows()[0]).toHaveTextContent("3,318 B");
  });

  it("shows what kind of contract it is: a token by its standard, any other as a contract", async () => {
    await open(() => L([contractItem(0xb1), contractItem(0xb2, { standard: "ERC-721" }), contractItem(0xb3, { standard: null })]));
    expect(rows()[0]).toHaveTextContent("ERC-20");
    expect(rows()[1]).toHaveTextContent("ERC-721");
    expect(within(rows()[2]!).getAllByText("Contract").length).toBeGreaterThan(0);
  });

  it("splits the interactions into transactions and internal calls, and says a contract nobody has called has no calls yet", async () => {
    await open(() => L([contractItem(0xb1, { txCount: 5, internalCount: 4 }), contractItem(0xb2, { interactionCount: 0, txCount: 0, internalCount: 0 }), contractItem(0xb3, { interactionCount: 1, txCount: 1, internalCount: 0 })]));
    expect(rows()[0]).toHaveTextContent("5 transactions · 4 internal calls");
    expect(rows()[1]).toHaveTextContent("no calls yet");
    expect(rows()[2]).toHaveTextContent("1 transaction · 0 internal calls");
  });

  it("shows the balance in the chain's coin as the explorer's copy, and a balance it has not read as unknown, never as 0", async () => {
    await open(() => L([contractItem(0xb1, { balance: "1500000000000000000", balanceBlock: 20 }), contractItem(0xb2, { balance: null, balanceBlock: null })]));
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
    expect(within(rows()[0]!).getByRole("link", { name: "0xe3e3e3…e3e3" })).toHaveAttribute("href", `/address/${addr(0xe3)}`);
    expect(rows()[2]).toHaveTextContent("genesis");
    expect(rows()[2]).toHaveTextContent("set by the chain, no creation");
    expect(within(rows()[2]!).queryByRole("link", { name: /Block/ })).toBeNull();
  });

  it("names a contract without a name by its address and says it has no name", async () => {
    await open();
    expect(within(rows()[2]!).getByRole("link", { name: "0xb3b3b3b3…b3b3b3" })).toHaveAttribute("href", `/contract/${addr(0xb3)}`);
  });

  it("says a destroyed contract is destroyed", async () => {
    await open(() => L([contractItem(0xb1, { destroyedBlock: 21 })]));
    expect(rows()[0]).toHaveTextContent("destroyed in block 21");
  });

  it("shows the partial-match note whenever a partial match is on the page", async () => {
    await open();
    expect(screen.getByText(/Partial match: the metadata differs from this compile/)).toBeInTheDocument();
  });

  it("leaves the note out when no partial match is shown", async () => {
    await open(() => L([contractItem(0xb1)]));
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
    await userEvent.click(screen.getByRole("button", { name: /^Verified/ }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=interactions&limit=25&verified=true"));
    await userEvent.click(screen.getByRole("button", { name: /^Not verified/ }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=interactions&limit=25&verified=false"));
    await userEvent.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(calls.filter((c) => c === "/api/contracts?sort=interactions&limit=25").length).toBeGreaterThan(0));
  });

  it("walks the pages by the server's cursor, with the page number and the count of pages", async () => {
    const calls = await open((p) => L([contractItem(p.includes("before=") ? 0xb4 : 0xb1)], p.includes("before=") ? null : "9:0xb1", { total: 40 }));
    const nav = screen.getByRole("navigation", { name: "Pages of contracts" });
    expect(nav).toHaveTextContent("Page 1 of 2");
    await userEvent.click(within(nav).getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(calls.some((c) => c.includes("before=9%3A0xb1"))).toBe(true));
    await waitFor(() => expect(rows()[0]).toHaveTextContent("0xb4b4b4b4…b4b4b4"));
    expect(nav).toHaveTextContent("Page 2 of 2");
  });

  it("opens the last page from the oldest end with exactly what that page holds, so it never repeats the page before", async () => {
    const all = Array.from({ length: 53 }, (_, i) => contractItem(0x30 + i));
    const calls = await open((p) => (p.includes("order=asc") ? L(all.slice(50).reverse(), "k1", { total: 53 }) : L(all.slice(0, 25), "d1", { total: 53 })));
    const nav = screen.getByRole("navigation", { name: "Pages of contracts" });
    await userEvent.click(within(nav).getByRole("button", { name: "Last" }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=interactions&order=asc&limit=3"));
    await waitFor(() => expect(nav).toHaveTextContent("Page 3 of 3"));
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toHaveTextContent("0x62626262…626262");
    expect(screen.getByText("Showing 51–53 of 53 contracts")).toBeInTheDocument();
  });

  it("keeps the filter on the last page", async () => {
    const calls = await open((p) => L([contractItem(0xb1)], "x", { total: p.includes("verified=false") ? 80 : 60 }));
    await userEvent.click(screen.getByRole("button", { name: /^Not verified/ }));
    const nav = screen.getByRole("navigation", { name: "Pages of contracts" });
    await waitFor(() => expect(nav).toHaveTextContent("Page 1 of 4"));
    await userEvent.click(within(nav).getByRole("button", { name: "Last" }));
    await waitFor(() => expect(calls).toContain("/api/contracts?sort=interactions&order=asc&limit=5&verified=false"));
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
    await open(() => L([evil]));
    expect(rows()[0]!.querySelector("img")).toBeNull();
    expect(rows()[0]).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("says when the explorer has not read every block yet, and when there are no contracts", async () => {
    await open(() => L(LIST, null, { derived: false }));
    expect(screen.getByText(/still reading blocks/)).toBeInTheDocument();
  });

  it("says so when there are no contracts", async () => {
    fakeApi(route({ contracts: () => L([]) }));
    renderApp("/contracts");
    expect(await screen.findByText("No contracts yet.")).toBeInTheDocument();
  });

  it("never calls the list empty while the explorer has not read every block", async () => {
    fakeApi(route({ contracts: () => L([], null, { derived: false }) }));
    renderApp("/contracts");
    expect(await screen.findByText(/still reading blocks/)).toBeInTheDocument();
    expect(screen.queryByText("No contracts yet.")).toBeNull();
  });

  it("says in the title how many contracts there are and how many have verified source", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Contracts" }).parentElement).toHaveTextContent("3 contracts · 2 with verified source");
  });

  it("counts each filter on its button", async () => {
    await open();
    expect(screen.getByRole("button", { name: "All 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verified 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not verified 1" })).toBeInTheDocument();
  });

  it("shows the compiler under the match kind, and says nothing for a contract with no source", async () => {
    await open(() => L([contractItem(0xb1), genesisContract(0xb3)]));
    expect(rows()[0]).toHaveTextContent("Solidity v0.8.28");
    expect(rows()[0]).not.toHaveTextContent("commit");
    expect(rows()[1]).not.toHaveTextContent("Solidity");
  });

  it("shows how long ago a contract was made under its block", async () => {
    await open(() => L([contractItem(0xb1, { createdAt: new Date(Date.now() - 35.5 * 60_000).toISOString() })]));
    expect(rows()[0]).toHaveTextContent("Block 18");
    expect(rows()[0]).toHaveTextContent("35 min ago");
  });

  it("gives every row a contract icon beside its name", async () => {
    await open();
    for (const r of rows()) expect(r.querySelector("td:first-child svg.ic")).not.toBeNull();
  });

  it("names the system contracts with their EIP and the kind System, and says their calls are not counted", async () => {
    const sys = (a: string) => genesisContract(0xb3, { address: a });
    await open(() => L([sys("0x000f3df6d732807ef1319fb7b8bb8522d0beac02"), sys("0x0000f90827f1c53a10cb7a02335b175320002935"), sys("0x00000961ef480eb55e80d19ad83579a64c007002"), sys("0x0000bbddc7ce488642fb579f8b00f3a590007251")]));
    const want = [["Beacon roots", "EIP-4788", "start"], ["Block hashes", "EIP-2935", "start"], ["Withdrawal requests", "EIP-7002", "end"], ["Consolidation requests", "EIP-7251", "end"]];
    want.forEach(([name, eip, when], i) => {
      expect(rows()[i]).toHaveTextContent(name!);
      expect(rows()[i]).toHaveTextContent(`system contract, ${eip}`);
      expect(within(rows()[i]!).getByText("System")).toBeInTheDocument();
      expect(rows()[i]).toHaveTextContent(`at its ${when}`);
      expect(rows()[i]).not.toHaveTextContent("no calls yet");
    });
    expect(screen.getByText(/does not see these calls/)).toBeInTheDocument();
  });

  it("does not call an ordinary contract a system contract", async () => {
    await open();
    expect(screen.queryByText("System")).toBeNull();
  });
});
