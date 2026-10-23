// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AddressDetail } from "../api.ts";
import { T0, addr, addressDetail, contractItem, fakeApi, hash, holding, labelsOf, NOT_FOUND, page, renderApp, reply, route, tick, txItem } from "../test-utils.tsx";

const A = addr(0x5b);
type Subs = Partial<Record<"txs" | "contracts" | "internal" | "token-transfers" | "tokens" | "coin-history", (path: string) => ReturnType<typeof reply>>>;
const derived = <T,>(items: T[], next: string | null = null, d = true) => reply({ ...page(items, next), derived: d });

async function open(d: AddressDetail = addressDetail(), subs: Subs = {}, path = `/address/${d.address}`, title = "Address", extra: Parameters<typeof route>[0] = {}) {
  const calls = fakeApi(route({
    tokens: (a) => reply({ address: a, standard: "ERC-20", name: "Test USD", symbol: "tUSD", decimals: 6, derived: true }),
    addresses: (a, sub, p) => {
      if (a !== d.address) return reply(addressDetail({ address: a, kind: "contract", token: { name: "Test USD", symbol: "tUSD", decimals: 6 } }));
      return sub === "" ? reply(d) : (subs[sub as keyof Subs]?.(p) ?? (sub === "txs" ? reply(page([])) : derived([])));
    },
    ...extra,
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
    await open(addressDetail(), { txs: (p) => reply(page(p.includes("direction=sent") ? [txItem(20, { from: A })] : [])) });
    const more = screen.getByRole("region", { name: "More information" });
    expect(within(more).getByText("Transactions sent", { selector: "dt" }).nextElementSibling).toHaveTextContent("3");
    expect(within(more).getByText("Transactions received", { selector: "dt" }).nextElementSibling).toHaveTextContent("1");
    expect(within(more).getByRole("link", { name: "Block 2" })).toHaveAttribute("href", "/block/2");
    expect(await within(more).findByRole("link", { name: "Block 20" })).toHaveAttribute("href", "/block/20");
  });

  it("says first seen and last active are not known for an address nothing in a block has touched", async () => {
    await open(addressDetail({ firstSeenBlock: null, lastActiveBlock: null }));
    const more = screen.getByRole("region", { name: "More information" });
    expect(within(more).getByText("First seen", { selector: "dt" }).nextElementSibling).toHaveTextContent("—");
  });

  it("says a count is partial while the explorer has not read every block", async () => {
    await open(addressDetail({ derived: false }));
    expect(screen.getByText(/still reading blocks/)).toBeInTheDocument();
  });
});

describe("the address page: token holdings", () => {
  const withHoldings = (items: ReturnType<typeof holding>[], d = true) => ({ tokens: () => derived(items, null, d) });

  it("lists what the address holds, with each balance as of the block it last moved", async () => {
    await open(addressDetail(), withHoldings([holding(), holding({ token: addr(0xcc), standard: "ERC-721", name: "Ostia Pass", symbol: "OPASS", decimals: null, tokenId: "0", value: "2", updatedBlock: 22 }), holding({ token: addr(0xcd), standard: "ERC-1155", name: null, symbol: "ITEM", decimals: null, tokenId: "7", value: "40", updatedBlock: 23 })]));
    const card = await screen.findByRole("region", { name: "Token holdings" });
    await within(card).findByText("Test USD");
    expect(card).toHaveTextContent("995,000 tUSD");
    expect(card).not.toHaveTextContent("tUSD #0");
    expect(card).toHaveTextContent("ERC-20");
    expect(card).toHaveTextContent("as of block 3");
    expect(card).toHaveTextContent("99.50% of supply");
    expect(card).toHaveTextContent("3 tokens");
    expect(card.querySelector(".r[title='Last moved in block 20']")).not.toBeNull();
    expect(within(card).getByRole("link", { name: "Test USD" })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(card).toHaveTextContent("ERC-721 · Ostia Pass (OPASS)");
    expect(card).toHaveTextContent("2 tokens");
    expect(card).not.toHaveTextContent("OPASS #0");
    expect(card).toHaveTextContent("ERC-1155 · #7 · ITEM");
    expect(card.querySelector(".r[title='Last moved in block 22']")).not.toBeNull();
  });

  it("keeps the token count a lower bound on every page, as it only counts the page in view", async () => {
    const pageOf = (p: string) => (p.includes("after=") ? derived([holding({ token: addr(0xcc), name: "Other", symbol: "OTH" })]) : derived([holding()], "20:cb"));
    await open(addressDetail(), { tokens: pageOf });
    const card = await screen.findByRole("region", { name: "Token holdings" });
    await within(card).findByText("Test USD");
    expect(card).toHaveTextContent("1+ tokens");
    await userEvent.click(within(card).getByRole("button", { name: "Older page" }));
    await within(card).findByText("Other");
    expect(card).toHaveTextContent("1+ tokens");
    expect(card).not.toHaveTextContent(/\b1 token\b/);
  });

  it("says so when it holds nothing", async () => {
    await open(addressDetail(), withHoldings([]));
    expect(await screen.findByText("This address holds no tokens.")).toBeInTheDocument();
  });

  it("shows the raw value when a token's decimals are not known, never a guess", async () => {
    await open(addressDetail(), withHoldings([holding({ decimals: null, symbol: null, name: null })]));
    const card = await screen.findByRole("region", { name: "Token holdings" });
    const v = await within(card).findByText("995,000,000,000");
    expect(v).toHaveAttribute("title", "The token's decimals are not known, so this is the raw value");
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
    expect(tab("Transactions 4")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(rows()[0]!).getByRole("link", { name: "0xa3a3a3a3…a3a3a3" })).toHaveAttribute("href", `/tx/${hash(0xa3)}`);
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
  it("lists token transfers with method, age and the token by its name, and an NFT by its id", async () => {
    const t = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: "0xa9059cbb", creation: false, timestamp: T0, token: addr(0xcb), standard: "ERC-20", from: A, to: addr(0x77), amount: "5000000000", tokenId: null };
    const n = { ...t, txHash: hash(0xe2), block: 19, amount: null, tokenId: "3", token: addr(0xcc), standard: "ERC-721" };
    const calls = await open(addressDetail({ tokenTransferCount: 2 }), { "token-transfers": () => derived([t, n]) }, `/address/${A}`, "Address", {
      labels: labelsOf([{ address: addr(0xcb), name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: true }]),
    });
    await userEvent.click(tab("Token transfers"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(rows()[0]).toHaveTextContent("5,000 tUSD"));
    const head = within(screen.getByRole("table")).getAllByRole("columnheader").map((c) => c.textContent);
    expect(head).toEqual(["Transaction hash", "Method", "Block", "Age", "From", "To", "Amount", "Token", "Stage"]);
    expect(rows()[0]).toHaveTextContent("transfer");
    expect(rows()[0]).toHaveTextContent("ago");
    expect(rows()[0]).toHaveTextContent("OUT");
    expect(rows()[0]).toHaveTextContent("Test USD");
    expect(rows()[0]).toHaveTextContent(`${hash(0xe1).slice(0, 10)}…${hash(0xe1).slice(-6)}`);
    expect(rows()[1]).toHaveTextContent("#3");
    // the token's decimals come from the labels, so no token route and no address route (which reads a balance from reth) is asked
    expect(calls.some((c) => c === `/api/addresses/${addr(0xcb)}` || c === `/api/addresses/${addr(0xcc)}`)).toBe(false);
    expect(screen.getByText(/read from the Transfer logs of final blocks/)).toBeInTheDocument();
  });

  it("tags a transfer from the zero address as a mint", async () => {
    const ZERO = "0x" + "00".repeat(20);
    const t = { txHash: hash(0xe1), block: 19, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: "0x40c10f19", creation: false, timestamp: T0, token: addr(0xcb), standard: "ERC-20", from: ZERO, to: A, amount: "1000000", tokenId: null };
    await open(addressDetail({ tokenTransferCount: 1 }), { "token-transfers": () => derived([t, { ...t, txHash: hash(0xe2), methodId: null, from: A, to: ZERO }]) });
    await userEvent.click(tab("Token transfers"));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent("mint");
    expect(rows()[0]).toHaveTextContent("IN");
    expect(rows()[1]).toHaveTextContent("burn");
    expect(rows()[1]).not.toHaveTextContent("mint");
  });

  it("falls back to the token route for the decimals, and says when they are not known", async () => {
    const t = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: null, creation: false, timestamp: T0, token: addr(0xcb), standard: "ERC-20", from: A, to: addr(0x77), amount: "5000000000", tokenId: null };
    // the label does not describe the token; the token route does, with its decimals but no symbol
    await open(addressDetail({ tokenTransferCount: 2 }), { "token-transfers": () => derived([t, { ...t, txHash: hash(0xe2), token: addr(0xcc) }]) }, `/address/${A}`, "Address", {
      tokens: (a) => reply(a === addr(0xcb) ? { address: a, standard: "ERC-20", name: null, symbol: null, decimals: 6 } : { address: a, standard: "ERC-20", name: null, symbol: null, decimals: null }),
    });
    await userEvent.click(tab("Token transfers"));
    await waitFor(() => expect(rows()[0]!.querySelector("[title='5,000']")).not.toBeNull());
    expect(rows()[0]).not.toHaveTextContent("tUSD");
    await waitFor(() => expect(rows()[1]!.querySelector("[title*='decimals are not known']")).not.toBeNull());
    expect(rows()[1]).toHaveTextContent("5,000,000,000");
  });

  it("does not ask the token route for a token the label already describes", async () => {
    const t = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: null, creation: false, timestamp: T0, token: addr(0xcb), standard: "ERC-20", from: A, to: addr(0x77), amount: "5000000", tokenId: null };
    const calls = await open(addressDetail({ tokenTransferCount: 1 }), { "token-transfers": () => derived([t]) }, `/address/${A}`, "Address", {
      labels: labelsOf([{ address: addr(0xcb), name: "Test USD", symbol: null, kind: "token", standard: "ERC-20", decimals: 6, verified: false }]),
    });
    await userEvent.click(tab("Token transfers"));
    // the labelled amount (5 units of 6 decimals) only shows once the labels have loaded, so the check below runs on the labelled path
    await waitFor(() => expect(rows()[0]!.querySelector("[title*='5 Test USD'], [title='5']")).not.toBeNull());
    expect(calls.some((c) => c.startsWith("/api/tokens/"))).toBe(false);
  });

  it("filters the token transfers by token and keeps the CSV to the filter", async () => {
    const t = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: null, creation: false, timestamp: T0, token: addr(0xcb), standard: "ERC-20", from: A, to: addr(0x77), amount: "5", tokenId: null };
    const calls = await open(addressDetail({ tokenTransferCount: 2 }), { "token-transfers": (p) => derived(p.includes(`token=${addr(0xcb)}`) ? [t] : [t, { ...t, txHash: hash(0xe2), token: addr(0xcc) }]) }, `/address/${A}`, "Address", {
      labels: labelsOf([{ address: addr(0xcb), name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: false }]),
    });
    await userEvent.click(tab("Token transfers"));
    await screen.findByText("2 ERC-20 transfers to or from this address");
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", `/api/addresses/${A}/token-transfers?format=csv&standard=ERC-20`);
    await userEvent.click(await screen.findByRole("button", { name: "Test USD" }));
    await waitFor(() => expect(document.querySelector(".list-h")).toHaveTextContent("1 Test USD transfer to or from this address"));
    expect(calls).toContain(`/api/addresses/${A}/token-transfers?limit=25&token=${addr(0xcb)}&standard=ERC-20`);
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", `/api/addresses/${A}/token-transfers?format=csv&token=${addr(0xcb)}&standard=ERC-20`);
    // the filter keeps offering both tokens while one is chosen
    expect(screen.getByRole("button", { name: "All tokens" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All tokens" }));
    await screen.findByText("2 ERC-20 transfers to or from this address");
  });

  it("offers each token once in the filter, however many rows it has", async () => {
    const t = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: null, creation: false, timestamp: T0, token: addr(0xcb), standard: "ERC-20", from: A, to: addr(0x77), amount: "5", tokenId: null };
    await open(addressDetail({ tokenTransferCount: 3 }), { "token-transfers": () => derived([t, { ...t, txHash: hash(0xe2) }, { ...t, txHash: hash(0xe3) }]) });
    await userEvent.click(tab("Token transfers"));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(within(screen.getByRole("group", { name: "Show tokens" })).getAllByRole("button")).toHaveLength(2);
  });

  it("lists the NFT transfers with method, age and an ERC-1155 count before its id", async () => {
    const n = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: "0xa1448194", creation: false, timestamp: T0, token: addr(0xcc), standard: "ERC-1155", from: "0x" + "00".repeat(20), to: A, amount: "1500", tokenId: "7" };
    const calls = await open(addressDetail(), { "token-transfers": () => derived([n]) });
    await userEvent.click(tab("NFT transfers"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("safeMint");
    expect(rows()[0]).toHaveTextContent("ago");
    expect(rows()[0]).toHaveTextContent("mint");
    expect(rows()[0]).toHaveTextContent("1,500 · #7");
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", `/api/addresses/${A}/token-transfers?format=csv&standard=nft`);
    expect(calls).toContain(`/api/addresses/${A}/token-transfers?limit=25&standard=nft`);
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
    expect(asked).toHaveLength(4);
    expect(asked).toEqual(expect.arrayContaining([`/api/addresses/${A}`, `/api/addresses/${A}/txs?limit=25`, `/api/addresses/${A}/tokens?limit=25`, `/api/addresses/${A}/txs?limit=1&direction=sent`]));
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

describe("the address page: the header facts", () => {
  const chip = () => screen.queryByRole("link", { name: /^Created / });

  it("says how many contracts it created, and that it made more when the count stopped at its ceiling", async () => {
    await open(addressDetail({ createdCount: 3 }));
    expect(chip()).toHaveTextContent("Created 3 contracts");
    expect(chip()).toHaveAttribute("href", `/address/${A}?tab=contracts`);
  });
  it("says one contract in the singular", async () => {
    await open(addressDetail({ createdCount: 1 }));
    expect(chip()).toHaveTextContent("Created 1 contract");
  });
  it("says 100,000+ at the ceiling", async () => {
    await open(addressDetail({ createdCount: 100000, createdCountCapped: true }));
    expect(chip()).toHaveTextContent("Created 100,000+ contracts");
    expect(tab(/Contracts created/)).toHaveTextContent("100,000+");
  });
  it("shows no chip for an address that made none, but the tab says 0", async () => {
    await open(addressDetail({ createdCount: 0 }));
    expect(chip()).toBeNull();
    expect(tab(/Contracts created/)).toHaveTextContent("Contracts created 0");
  });

  it("names the faucet that funded it, with the block and the transaction", async () => {
    const f = { from: addr(0x77), txHash: hash(0xf1), block: 16, timestamp: T0, value: "1000000000000000000" };
    await open(addressDetail({ fundedBy: f }), {}, `/address/${A}`, "Address", { faucet: () => reply({ address: addr(0x77) }) });
    const more = screen.getByRole("region", { name: "More information" });
    const funded = await waitFor(() => { const e = row("Funded by"); expect(e).toHaveTextContent("Ostia faucet"); return e; });
    expect(within(funded).getByRole("link", { name: "block 16" })).toHaveAttribute("href", "/block/16");
    expect(within(funded).getByRole("link", { name: "0xf1f1f1f1…f1f1f1" })).toHaveAttribute("href", `/tx/${hash(0xf1)}`);
    expect(more).toBeInTheDocument();
  });
  it("says not known when nothing says who funded it", async () => {
    await open(addressDetail({ fundedBy: null }));
    expect(row("Funded by")).toHaveTextContent("not known");
  });

  it("gives the first seen block with its age, and the last sent from its newest sent transaction, not from last active", async () => {
    const calls = await open(addressDetail({ lastActiveBlock: 25 }), { txs: (p) => reply(page(p.includes("direction=sent") ? [txItem(20, { from: A })] : [])) });
    expect(row("First seen")).toHaveTextContent(/Block 2\s*· .* ago/);
    await waitFor(() => expect(row("Last sent")).toHaveTextContent(/Block 20\s*· .* ago/));
    expect(row("Last sent")).not.toHaveTextContent(/Block 25\b/); // the last active block, not its age (an age such as "476 h 25 min ago" holds "25")
    expect(calls).toContain(`/api/addresses/${A}/txs?limit=1&direction=sent`);
  });
  it("does not say it has sent nothing while the counts may be short", async () => {
    const calls = await open(addressDetail({ sentCount: 0, receivedCount: 1, derived: false }), { txs: () => reply(page([txItem(20, { from: A })])) });
    await waitFor(() => expect(row("Last sent")).toHaveTextContent(/Block 20/));
    expect(row("Last sent")).not.toHaveTextContent("never");
    expect(calls.some((c) => c.includes("direction=sent"))).toBe(true);
  });
  it("does not sit on a loading mark when the counts may be short and nothing was sent", async () => {
    await open(addressDetail({ sentCount: 0, receivedCount: 1, derived: false }), { txs: () => reply(page([])) });
    await waitFor(() => expect(row("Last sent")).toHaveTextContent("none counted yet"));
    expect(row("Last sent")).not.toHaveTextContent("never");
  });
  it("says it has sent nothing without asking", async () => {
    const calls = await open(addressDetail({ sentCount: 0, receivedCount: 1 }));
    expect(row("Last sent")).toHaveTextContent("never");
    expect(calls.some((c) => c.includes("direction=sent"))).toBe(false);
  });
});

describe("the address page: the tab card", () => {
  it("holds the tab bar inside the card, with no count for the transfer tabs", async () => {
    await open(addressDetail({ tokenTransferCount: 4, createdCount: 2 }));
    const card = screen.getByRole("region", { name: "Activity" });
    expect(within(card).getByRole("tablist")).toBeInTheDocument();
    expect(within(card).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Transactions 4", "Token transfers", "NFT transfers", "Internal calls 0", "Contracts created 2", "Coin history"]);
  });
  it("lists the contracts it created", async () => {
    await open(addressDetail({ createdCount: 2 }), { contracts: () => derived([contractItem(0xc1), contractItem(0xc2, { name: null, verified: false })]) }, `/address/${A}?tab=contracts`);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent("18");
    expect(rows()[0]).toHaveTextContent("Verified");
    expect(rows()[1]).toHaveTextContent("Not verified");
  });
  it("lists the NFT transfers apart from the token transfers", async () => {
    const calls = await open(addressDetail(), {}, `/address/${A}`);
    await userEvent.click(tab("NFT transfers"));
    await screen.findByText("No NFT transfers.");
    expect(calls).toContain(`/api/addresses/${A}/token-transfers?limit=25&standard=nft`);
    await userEvent.click(tab("Token transfers"));
    await screen.findByText("No token transfers.");
    expect(calls).toContain(`/api/addresses/${A}/token-transfers?limit=25&standard=ERC-20`);
  });
});

describe("the address page: an older API", () => {
  it("shows what it is given and no chip or age for what the API does not serve", async () => {
    const old = addressDetail() as unknown as Record<string, unknown>;
    delete old.createdCount; delete old.createdCountCapped; delete old.firstSeenTimestamp; delete old.lastActiveTimestamp; delete old.fundedBy;
    await open(old as unknown as AddressDetail);
    expect(screen.queryByText(/Created .* contract/)).toBeNull();
    expect(screen.getByRole("region", { name: "More information" })).toHaveTextContent("Funded by");
  });
});

describe("the address page: sent and received", () => {
  it("filters the transactions by direction and offers the CSV for the filter", async () => {
    const calls = await open(addressDetail(), { txs: (p) => reply(page(p.includes("direction=received") ? [txItem(2, { from: addr(0x77), to: A })] : [txItem(3, { from: A }), txItem(2, { from: addr(0x77), to: A })])) });
    await screen.findByText("Showing all 2 transactions, newest first");
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", `/api/addresses/${A}/txs?format=csv`);
    await userEvent.click(screen.getByRole("button", { name: "Received" }));
    await screen.findByText("Showing all 1 received transaction, newest first");
    expect(calls).toContain(`/api/addresses/${A}/txs?limit=25&direction=received`);
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", `/api/addresses/${A}/txs?format=csv&direction=received`);
    expect(screen.getByRole("button", { name: "Received" })).toHaveAttribute("aria-pressed", "true");
  });
  it("does not say all when there are more pages", async () => {
    await open(addressDetail(), { txs: () => reply(page([txItem(3, { from: A })], "3:0")) });
    await screen.findByText("Showing 1 on this page, newest first");
  });
});

describe("the address page: the holdings' amounts", () => {
  const card = async () => screen.findByRole("region", { name: "Token holdings" });
  const holds = (h: Partial<ReturnType<typeof holding>>) => ({ tokens: () => derived([holding(h)]) });
  it("shows whole units with the exact amount in the title when only the decimals are known", async () => {
    await open(addressDetail(), holds({ symbol: null, name: null, decimals: 6, value: "995000123456" }));
    const v = await within(await card()).findByText("995,000.12345");
    expect(v).toHaveAttribute("title", "995,000.123456");
  });
  it("groups an ERC-1155 value and shows no share of supply for an NFT", async () => {
    await open(addressDetail(), holds({ standard: "ERC-1155", decimals: null, totalSupply: null, tokenId: "7", value: "1234567" }));
    const c = await card();
    await within(c).findByText("1,234,567");
    expect(c).not.toHaveTextContent("of supply");
  });
  it("shows no share when the supply is not known", async () => {
    await open(addressDetail(), holds({ totalSupply: null }));
    expect(await card()).not.toHaveTextContent("of supply");
  });
});

describe("the address page: hostile token text", () => {
  const RLO = "\u202E";
  const T = { txHash: hash(0xe1), block: 20, txIndex: 0, logIndex: 1, batchIndex: 0, methodId: null, creation: false, timestamp: T0, token: addr(0xcb), standard: "ERC-20", from: A, to: addr(0x77), amount: "5", tokenId: null };
  const label = (name: string) => labelsOf([{ address: addr(0xcb), name, symbol: null, kind: "token", standard: "ERC-20", decimals: 6, verified: false }]);

  it("keeps a 256-character name, a U+202E symbol, a 78-digit id and a 77-digit value inside the holdings card", async () => {
    const name = "W".repeat(256), id = "9".repeat(78), value = "8".repeat(77), symbol = `${RLO}${"X".repeat(63)}`;
    await open(addressDetail(), { tokens: () => derived([holding({ standard: "ERC-1155", name, symbol, decimals: null, tokenId: id, value })]) });
    const card = await screen.findByRole("region", { name: "Token holdings" });
    const link = await within(card).findByRole("link", { name });
    expect(link).toHaveClass("hold-name");
    expect(link).toHaveAttribute("title", name);
    expect(link.querySelector("bdi")).not.toBeNull();
    const sym = card.querySelector(".hold-sym")!;
    expect(sym.tagName).toBe("BDI");
    expect(sym).toHaveAttribute("title", symbol);
    expect(card.querySelector(".hold-id")).toHaveAttribute("title", `#${id}`);
    expect(card.querySelector(".hold-amt")).not.toBeNull();
    expect(card.querySelector(".hold-main")).not.toBeNull();
    // the bounds themselves are in the stylesheet that the page loads
    const css = readFileSync("src/pages/address.css", "utf8");
    expect(css).toMatch(/\.hold-name[^{]*\{[^}]*max-width[^}]*text-overflow: ellipsis[^}]*unicode-bidi: isolate/);
    expect(css).toMatch(/\.hold-main \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.hold-amt \{[^}]*overflow-wrap: anywhere/);
  });

  it("isolates and shortens a token name in the filtered header, the buttons and the options", async () => {
    const name = `${RLO}${"A".repeat(39)}`;
    await open(addressDetail({ tokenTransferCount: 2 }), { "token-transfers": () => derived([T]) }, `/address/${A}`, "Address", { labels: label(name) });
    await userEvent.click(tab("Token transfers"));
    const btn = await screen.findByRole("button", { name: /^A+…$/ });
    expect(btn.textContent).toBe(`${"A".repeat(23)}…`);
    expect(btn).toHaveAttribute("title", "A".repeat(39));
    expect(btn.querySelector("bdi")).not.toBeNull();
    await userEvent.click(btn);
    const head = await screen.findByText(/transfer to or from this address/);
    const b = head.querySelector("bdi")!;
    expect(b).toHaveTextContent(`${"A".repeat(23)}…`);
    expect(b).toHaveAttribute("title", "A".repeat(39));
    expect(head.textContent).not.toMatch(/[\u202A-\u202E]/);
  });

  it("puts a long name in the filter's options with the full name in the title, when there are more than three tokens", async () => {
    const name = "B".repeat(40);
    const tx = [0xcb, 0xcc, 0xcd, 0xce].map((n, i) => ({ ...T, txHash: hash(0xe0 + i), token: addr(n) }));
    await open(addressDetail({ tokenTransferCount: 4 }), { "token-transfers": () => derived(tx) }, `/address/${A}`, "Address", { labels: label(name) });
    await userEvent.click(tab("Token transfers"));
    const opt = await screen.findByRole("option", { name: `${"B".repeat(23)}…` });
    expect(opt).toHaveAttribute("title", name);
  });

  it("does not state a whole count while the explorer is still reading blocks", async () => {
    await open(addressDetail({ tokenTransferCount: 1 }), { "token-transfers": () => derived([T], null, false) });
    await userEvent.click(tab("Token transfers"));
    await screen.findByText("Showing 1 on this page, newest first");
    expect(screen.queryByText(/ERC-20 transfer to or from this address/)).toBeNull();
  });
});
