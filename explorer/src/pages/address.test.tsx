// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AddressDetail } from "../api.ts";
import { addr, addressDetail, fakeApi, hash, holding, NOT_FOUND, page, renderApp, reply, route, tick, txItem } from "../test-utils.tsx";

const A = addr(0x5b);
type Subs = Partial<Record<"txs" | "internal" | "token-transfers" | "tokens" | "coin-history", (path: string) => ReturnType<typeof reply>>>;
const derived = <T,>(items: T[], next: string | null = null, d = true) => reply({ ...page(items, next), derived: d });

async function open(d: AddressDetail = addressDetail(), subs: Subs = {}, path = `/address/${d.address}`, title = "Address") {
  const calls = fakeApi(route({
    addresses: (a, sub, p) => {
      if (a !== d.address) return reply(addressDetail({ address: a, kind: "contract", token: { name: "Test USD", symbol: "tUSD", decimals: 6 } }));
      return sub === "" ? reply(d) : (subs[sub as keyof Subs]?.(p) ?? (sub === "txs" ? reply(page([])) : derived([])));
    },
  }));
  renderApp(path);
  await screen.findByRole("heading", { name: title });
  return calls;
}
const row = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const kind = () => screen.getByRole("heading", { level: 1 }).parentElement!.querySelector(".chip-kind")!;
const tab = (name: RegExp | string) => screen.getByRole("tab", { name });

describe("the address page: the head and the overview", () => {
  it("says it is an account, shows the address in full with a copy button, and links back to the list", async () => {
    const user = userEvent.setup();
    await open();
    expect(kind()).toHaveTextContent("Account");
    expect(screen.getByRole("link", { name: "Addresses" })).toHaveAttribute("href", "/addresses");
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(screen.getByText(A).closest(".hl") as HTMLElement).getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith(A);
  });

  it("shows the balance in the chain's coin, read from reth at the final block, with every digit", async () => {
    await open();
    const card = screen.getByRole("region", { name: "Overview" });
    expect(card).toHaveTextContent("9.99791 tROME");
    expect(card).toHaveTextContent("as of final block 21, read from reth");
    expect(card).toHaveTextContent("exact: 9.99791 tROME");
  });

  it("says 0 for an empty account", async () => {
    await open(addressDetail({ balance: "0" }));
    expect(screen.getByRole("region", { name: "Overview" })).toHaveTextContent("0 tROME");
  });

  it("says the balance is not known when there is no final block yet", async () => {
    await open(addressDetail({ balance: null, balanceBlock: null }));
    const card = screen.getByRole("region", { name: "Overview" });
    expect(card).toHaveTextContent("Not known yet");
    expect(card).not.toHaveTextContent("0 tROME");
  });

  it("shows what the index knows: sent, received, first seen and last active", async () => {
    await open();
    const more = screen.getByRole("region", { name: "More information" });
    expect(within(more).getByText("Transactions sent", { selector: "dt" }).nextElementSibling).toHaveTextContent("3");
    expect(within(more).getByText("Transactions received", { selector: "dt" }).nextElementSibling).toHaveTextContent("1");
    expect(within(more).getByRole("link", { name: "Block 2" })).toHaveAttribute("href", "/block/2");
    expect(within(more).getByRole("link", { name: "Block 20" })).toHaveAttribute("href", "/block/20");
  });

  it("says first seen and last active are not known for an address nothing in a block has touched", async () => {
    await open(addressDetail({ firstSeenBlock: null, lastActiveBlock: null }));
    const more = screen.getByRole("region", { name: "More information" });
    expect(within(more).getByText("First seen", { selector: "dt" }).nextElementSibling).toHaveTextContent("—");
  });

  it("names the transaction and the block that created a contract", async () => {
    await open(addressDetail({ kind: "contract", createdBy: { txHash: hash(0xf5), block: 2 } }));
    expect(kind()).toHaveTextContent("Contract");
    expect(row("Created by")).toHaveTextContent("0xf5f5…f5f5 in block 2");
    expect(within(row("Created by")).getByRole("link", { name: "0xf5f5…f5f5" })).toHaveAttribute("href", `/tx/${hash(0xf5)}`);
  });

  it("names a token by its own name and symbol, and shows them as text", async () => {
    await open(addressDetail({ address: addr(0xcb), kind: "token", token: { name: "<img src=x onerror=alert(1)>", symbol: "TKA", decimals: 18 } }), {}, `/token/${addr(0xcb)}`, "<img src=x onerror=alert(1)> (TKA)");
    expect(kind()).toHaveTextContent("Token");
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("says a count is partial while the explorer has not read every block", async () => {
    await open(addressDetail({ derived: false }));
    expect(screen.getByText(/still reading blocks/)).toBeInTheDocument();
  });
});

describe("the address page: token holdings", () => {
  const withHoldings = (items: ReturnType<typeof holding>[], d = true) => ({ tokens: () => derived(items, null, d) });

  it("lists what the address holds, with each balance as of the block it last moved", async () => {
    await open(addressDetail(), withHoldings([holding(), holding({ token: addr(0xcc), standard: "erc721", name: "Ostia Pass", symbol: "OPASS", decimals: null, tokenId: "3", value: "1", updatedBlock: 22 })]));
    const card = await screen.findByRole("region", { name: "Token holdings" });
    await within(card).findByText("Test USD");
    expect(card).toHaveTextContent("995,000 tUSD");
    expect(card).toHaveTextContent("as of block 20");
    expect(within(card).getByRole("link", { name: "Test USD" })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(card).toHaveTextContent("OPASS #3");
    expect(card).toHaveTextContent("as of block 22");
  });

  it("says so when it holds nothing", async () => {
    await open(addressDetail(), withHoldings([]));
    expect(await screen.findByText("This address holds no tokens.")).toBeInTheDocument();
  });

  it("shows the raw value when a token's decimals are not known, never a guess", async () => {
    await open(addressDetail(), withHoldings([holding({ decimals: null, symbol: null, name: null })]));
    const card = await screen.findByRole("region", { name: "Token holdings" });
    await within(card).findByText("995000000000");
  });

  it("says the list may be missing tokens while the explorer is still reading blocks", async () => {
    await open(addressDetail(), withHoldings([holding()], false));
    expect(await screen.findByText(/may be missing/)).toBeInTheDocument();
  });
});

describe("the address page: the transactions tab", () => {
  const sent = txItem(3, { from: A, to: addr(0xcb), methodId: "0xa9059cbb" });
  const got = txItem(2, { from: addr(0x77), to: A, value: "1000000000000000000" });

  it("is the first tab, and lists the transactions newest first with the way each went", async () => {
    await open(addressDetail(), { txs: () => reply(page([sent, got])) });
    expect(tab("Transactions")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(rows()[0]!).getByRole("link", { name: "0xa3a3…a3a3" })).toHaveAttribute("href", `/tx/${hash(0xa3)}`);
    expect(rows()[0]).toHaveTextContent("OUT");
    expect(rows()[1]).toHaveTextContent("IN");
    expect(rows()[1]).toHaveTextContent("1 tROME");
    expect(rows()[0]).toHaveTextContent("Final");
    expect(within(rows()[0]!).getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
  });

  it("shows a fee with every digit, and marks a failed transaction", async () => {
    await open(addressDetail(), { txs: () => reply(page([txItem(3, { from: A, success: false })])) });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("0.00003507");
    expect(within(rows()[0]!).getByRole("img", { name: "Failed (reverted)" })).toBeInTheDocument();
  });

  it("says that the balance is never read from the list", async () => {
    await open(addressDetail(), { txs: () => reply(page([sent])) });
    expect(await screen.findByText(/read from reth at the final block, never from this list/)).toBeInTheDocument();
  });

  it("says so when there are no transactions", async () => {
    await open();
    expect(await screen.findByText("No transactions yet.")).toBeInTheDocument();
  });

  it("pages by the server's cursor, walking forward and back", async () => {
    const calls = await open(addressDetail(), { txs: (p) => (p.includes("before=") ? reply(page([got])) : reply(page([sent], "3:0"))) });
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await waitFor(() => expect(calls.some((c) => c.includes(`/txs?limit=25&before=3%3A0`))).toBe(true));
    await waitFor(() => expect(rows()[0]).toHaveTextContent("IN"));
    await userEvent.click(screen.getByRole("button", { name: "Newer page" }));
    await waitFor(() => expect(rows()[0]).toHaveTextContent("OUT"));
  });
});

describe("the address page: the other tabs", () => {
  it("lists token transfers with the token's symbol, and an NFT by its id", async () => {
    const t = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, token: addr(0xcb), from: A, to: addr(0x77), amount: "5000000000", tokenId: null };
    const n = { ...t, txHash: hash(0xe2), block: 19, amount: null, tokenId: "3", token: addr(0xcc) };
    await open(addressDetail({ tokenTransferCount: 2 }), { "token-transfers": () => derived([t, n]) });
    await userEvent.click(tab("Token transfers 2"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(rows()[0]).toHaveTextContent("5,000 tUSD"));
    expect(rows()[0]).toHaveTextContent("OUT");
    expect(rows()[1]).toHaveTextContent("#3");
    expect(screen.getByText(/read from the Transfer logs of final blocks/)).toBeInTheDocument();
  });

  it("lists the internal calls that moved value, with the calling transaction", async () => {
    const c = { txHash: hash(0xe1), block: 20, txIndex: 0, traceAddress: [0, 1], callType: "call", from: addr(0x77), to: A, value: "2000000000000000000", gas: 9000, gasUsed: 700, selector: null, inputSize: 0, error: null };
    await open(addressDetail({ internalCount: 1 }), { internal: () => derived([c, { ...c, traceAddress: [1], error: "reverted" }]) });
    await userEvent.click(tab("Internal calls 1"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent("2 tROME");
    expect(rows()[0]).toHaveTextContent("IN");
    expect(within(rows()[0]!).getByRole("link", { name: "0xe1e1…e1e1" })).toHaveAttribute("href", `/tx/${hash(0xe1)}`);
    expect(rows()[1]).toHaveTextContent("reverted");
  });

  it("lists the balance at each block where it changed", async () => {
    await open(addressDetail(), { "coin-history": () => derived([{ block: 20, balance: "1500000000000000000" }, { block: 3, balance: "0" }]) });
    await userEvent.click(tab("Coin history"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent("20");
    expect(rows()[0]).toHaveTextContent("1.5 tROME");
    expect(within(rows()[0]!).getByRole("link", { name: "20" })).toHaveAttribute("href", "/block/20");
  });

  it("keeps the tab in the link, so the same tab opens", async () => {
    await open(addressDetail(), {}, `/address/${A}?tab=coin-history`);
    expect(tab("Coin history")).toHaveAttribute("aria-selected", "true");
  });

  it("does not claim an empty list while the explorer has not read the blocks", async () => {
    await open(addressDetail(), { internal: () => derived([], null, false) });
    await userEvent.click(tab(/Internal calls/));
    expect(await screen.findByText(/not read these blocks yet/)).toBeInTheDocument();
    expect(screen.queryByText("No internal calls.")).toBeNull();
  });

  it("says plainly when a list is empty", async () => {
    await open();
    await userEvent.click(tab(/Token transfers/));
    expect(await screen.findByText("No token transfers.")).toBeInTheDocument();
  });
});

describe("the address page: reads", () => {
  it("asks for the address it was given and the first page of its transactions", async () => {
    const calls = await open();
    await screen.findByText("No transactions yet.");
    const asked = calls.filter((c) => c.startsWith("/api/addresses"));
    expect(asked).toHaveLength(3);
    expect(asked).toEqual(expect.arrayContaining([`/api/addresses/${A}`, `/api/addresses/${A}/txs?limit=25`, `/api/addresses/${A}/tokens?limit=25`]));
  });
});

describe("an address that cannot be shown", () => {
  it("says what an address is when the one in the link is not", async () => {
    fakeApi(route({ addresses: () => reply({ error: "An address is 0x and 40 hex digits." }, 400) }));
    renderApp("/address/0x5b2e");
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("An address is 0x and 40 hex digits.")).toBeInTheDocument();
  });

  it("says Not found in the server's words", async () => {
    fakeApi(route({ addresses: () => reply({ error: NOT_FOUND }, 404) }));
    renderApp(`/token/${addr(1)}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });

  it("says it cannot read the chain, and tries again by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let healthy = false;
    fakeApi(route({ addresses: (_a, sub) => (healthy ? (sub ? derived([]) : reply(addressDetail())) : reply({ error: "The explorer cannot read the chain right now." }, 502)) }));
    renderApp(`/address/${A}`);
    expect(await screen.findByRole("heading", { name: "Cannot read the chain" })).toBeInTheDocument();
    healthy = true;
    await tick();
    expect(screen.getByRole("heading", { name: "Address" })).toBeInTheDocument();
  });
});
