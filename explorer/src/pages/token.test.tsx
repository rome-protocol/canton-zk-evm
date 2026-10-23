// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TokenDetail } from "../api.ts";
import { addr, contractDetail, fakeApi, NOT_FOUND, page, renderApp, reply, route, tokenDetail, tokenHolder, tokenTransfer } from "../test-utils.tsx";

const A = addr(0xcb);
const derived = <T,>(items: T[], next: string | null = null, d = true) => reply({ ...page(items, next), derived: d });
const HOLDERS = [tokenHolder(0xe3, "995000000000"), tokenHolder(0xa1, "2500000000"), tokenHolder(0xa2, "2500000"), tokenHolder(0xa3, "1")];

type Subs = { holders?: (path: string) => ReturnType<typeof reply>; transfers?: (path: string) => ReturnType<typeof reply>; contract?: () => ReturnType<typeof reply> };
async function open(t: TokenDetail = tokenDetail(), subs: Subs = {}, path = `/token/${A}`) {
  const calls = fakeApi(route({
    tokenPages: (_a, sub, p) => (sub === "" ? reply(t) : sub === "holders" ? (subs.holders?.(p) ?? derived(HOLDERS)) : (subs.transfers?.(p) ?? derived([]))),
    contracts: () => subs.contract?.() ?? reply(contractDetail(0xcb)),
  }));
  renderApp(path);
  await screen.findByRole("heading", { level: 1 });
  return calls;
}
const card = (k: string) => screen.getByText(k, { selector: ".stat-k" }).parentElement!;
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("the token page: the overview", () => {
  it("names the token, its standard and whether its source is verified, and links back to the list", async () => {
    await open();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Test USD");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("tUSD");
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Tokens" })).toHaveAttribute("href", "/tokens");
    expect(await screen.findByText("Source code verified")).toBeInTheDocument();
    expect(screen.getAllByText("ERC-20").length).toBeGreaterThan(0);
  });

  it("shows the supply with decimals as of its block, the holders, the transfers, the decimals and the contract", async () => {
    await open();
    expect(card("Total supply")).toHaveTextContent("1,000,000");
    expect(card("Total supply")).toHaveTextContent("tUSD · as of block 21");
    expect(card("Holders")).toHaveTextContent("5");
    expect(card("Transfers")).toHaveTextContent("6");
    expect(card("Decimals")).toHaveTextContent("6");
    expect(within(card("Contract")).getByRole("link", { name: "0xcbcb…cbcb" })).toHaveAttribute("href", `/contract/${A}`);
    expect(await within(card("Contract")).findByText("created in block 18")).toBeInTheDocument();
  });

  it("says a token whose source is not verified is not verified, and still shows the token", async () => {
    await open(tokenDetail(), { contract: () => reply(contractDetail(0xcb, { verified: false, matchType: null, verification: null })) });
    expect(await screen.findByText("Source code not verified")).toBeInTheDocument();
  });

  it("does not claim a verification it could not read", async () => {
    await open(tokenDetail(), { contract: () => reply({ error: NOT_FOUND }, 404) });
    expect(screen.queryByText("Source code verified")).toBeNull();
    expect(screen.queryByText("Source code not verified")).toBeNull();
  });

  it("says the metadata could not be read, and shows the raw supply, when the contract did not answer", async () => {
    await open(tokenDetail(0xcb, { name: null, symbol: null, decimals: null, totalSupply: "12345", metadataStatus: "failed" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Name not read");
    expect(screen.getByText(/could not read this token's name, symbol and decimals/)).toBeInTheDocument();
    expect(screen.getByText(/so amounts are shown raw/)).toBeInTheDocument();
    expect(card("Total supply")).toHaveTextContent("12,345");
    expect(card("Decimals")).toHaveTextContent("—");
  });

  it("names only what could not be read: a failed supply does not claim the amounts are raw when the decimals are known", async () => {
    await open(tokenDetail(0xcb, { totalSupply: null, totalSupplyBlock: null, metadataStatus: "failed" }));
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("could not read this token's total supply");
    expect(note).not.toHaveTextContent("name");
    expect(note).not.toHaveTextContent("raw");
  });

  it("says a supply the contract has not told is not known", async () => {
    await open(tokenDetail(0xcb, { totalSupply: null, totalSupplyBlock: null }));
    expect(card("Total supply")).toHaveTextContent("—");
  });

  it("marks a token the gateway wrapped from Canton", async () => {
    await open(tokenDetail(0xcb, { gatewayWrapped: true }));
    expect(screen.getAllByText("From Canton").length).toBeGreaterThan(0);
  });

  it("shows the name as text, never as markup", async () => {
    await open(tokenDetail(0xcb, { name: "<img src=x onerror=alert(1)>" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("says an address that is no token is not found, in the server's words", async () => {
    fakeApi(route({ tokenPages: () => reply({ error: "No token is held at that address." }, 404) }));
    renderApp(`/token/${A}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("No token is held at that address.")).toBeInTheDocument();
  });
});

describe("the token page: holders", () => {
  it("lists the holders in the order the server gave, biggest balance first, with the share of the supply", async () => {
    const calls = await open();
    await screen.findByRole("table");
    expect(calls).toContain(`/api/tokens/${A}/holders?limit=25`);
    expect(rows()).toHaveLength(4);
    expect(rows()[0]).toHaveTextContent("995,000");
    expect(rows()[0]).toHaveTextContent("99.50%");
    expect(rows()[1]).toHaveTextContent("2,500");
    expect(rows()[1]).toHaveTextContent("0.25%");
    expect(rows()[2]).toHaveTextContent("2.5");
    expect(rows()[2]).toHaveTextContent("<0.01%");
    expect(within(rows()[0]!).getByRole("link", { name: "0xe3e3…e3e3" })).toHaveAttribute("href", `/address/${addr(0xe3)}`);
  });

  it("says a share too small to show is below it, never 0", async () => {
    await open(tokenDetail(0xcb, { totalSupply: "1000000000000" }), { holders: () => derived([tokenHolder(0xa3, "1")]) });
    await screen.findByRole("table");
    expect(rows()[0]).toHaveTextContent("<0.01%");
  });

  it("numbers the rows on a later page from where the page before stopped", async () => {
    await open(tokenDetail(), { holders: (p) => derived(HOLDERS.slice(0, 2), p.includes("before=") ? null : "cursor") });
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(rows()[0]!.querySelector("td")).toHaveTextContent("26");
  });

  it("shows an ERC-721 holder's balance as a count of tokens, as the API gives it, with no share and no token id", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-721", decimals: null, totalSupply: "3" }), { holders: () => derived([tokenHolder(0xa1, "2"), tokenHolder(0xa2, "1")]) });
    await screen.findByRole("table");
    expect(screen.queryByRole("columnheader", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Token id" })).toBeNull();
    expect(rows()[0]).toHaveTextContent("2 tokens");
    expect(rows()[1]).toHaveTextContent("1 token");
    expect(screen.queryByText(/#0/)).toBeNull();
  });

  it("names the final block the holders are as of, and says nothing of it while the explorer is still reading", async () => {
    await open();
    await screen.findByRole("table");
    expect(screen.getByLabelText("Holders")).toHaveTextContent("as of final block 3");
  });

  it("names no block while the explorer is still reading, because the list is then short of the newest rows", async () => {
    await open(tokenDetail(), { holders: () => derived(HOLDERS, null, false) });
    await screen.findByRole("table");
    expect(screen.getByLabelText("Holders")).not.toHaveTextContent("as of final block");
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows how much of the supply the top holder has, with a bar and a key for the biggest holders", async () => {
    await open();
    await screen.findByRole("table");
    const box = screen.getByRole("region", { name: "Holder distribution" });
    expect(box).toHaveTextContent("Share held by the top holder");
    expect(box).toHaveTextContent("99.50%");
    expect(box).toHaveTextContent("0xe3e3…e3e3 99.50%");
    expect(box).toHaveTextContent("0xa1a1…a1a1 0.25%");
    expect(box).toHaveTextContent("as of final block 3");
  });

  it("shows no distribution for an NFT", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-721", decimals: null, totalSupply: "3" }), { holders: () => derived([tokenHolder(0xa1, "2")]) });
    await screen.findByRole("table");
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows no distribution when the supply is not known", async () => {
    await open(tokenDetail(0xcb, { totalSupply: null, totalSupplyBlock: null }));
    await screen.findByRole("table");
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows the distribution on the first page only", async () => {
    await open(tokenDetail(), { holders: (p) => derived(HOLDERS.slice(0, 2), p.includes("before=") ? null : "cursor") });
    await screen.findByRole("table");
    expect(screen.getByRole("region", { name: "Holder distribution" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows an ERC-1155 balance by id with no share, because the supply of one id is not known", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-1155", name: null, symbol: null, decimals: null, totalSupply: null, totalSupplyBlock: null }), { holders: () => derived([tokenHolder(0xa1, "40", { tokenId: "7" })]) });
    await screen.findByRole("table");
    expect(screen.queryByRole("columnheader", { name: "Share" })).toBeNull();
    expect(rows()[0]).toHaveTextContent("#7");
    expect(rows()[0]).toHaveTextContent("40");
  });

  it("says how the balances are known: summed from the Transfer logs, or read with balanceOf", async () => {
    await open();
    expect(await screen.findByText(/summed from the Transfer logs of final blocks/)).toBeInTheDocument();
  });

  it("says balances are read with balanceOf when the token's balances are not summed", async () => {
    await open(tokenDetail(0xcb, { balanceMode: "read" }));
    expect(await screen.findByText(/read from the contract with balanceOf/)).toBeInTheDocument();
  });

  it("says nobody holds it yet, and that the list may be short while the explorer reads blocks", async () => {
    await open(tokenDetail(), { holders: () => derived([], null, false) });
    expect(await screen.findByText(/has not read these blocks yet/)).toBeInTheDocument();
  });
});

describe("the token page: transfers", () => {
  const go = async (items: ReturnType<typeof tokenTransfer>[], t = tokenDetail()) => {
    const calls = await open(t, { transfers: () => derived(items) });
    await userEvent.click(screen.getByRole("tab", { name: /Transfers/ }));
    await screen.findByRole("table");
    return calls;
  };

  it("lists the transfers with the amount in the token's decimals, and is in the link", async () => {
    const calls = await go([tokenTransfer(0xd1), tokenTransfer(0xd2, { amount: "2500000", from: "0x" + "00".repeat(20) })]);
    expect(calls).toContain(`/api/tokens/${A}/transfers?limit=25`);
    expect(screen.getByRole("tab", { name: /Transfers/ })).toHaveAttribute("aria-selected", "true");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent("100 tUSD");
    expect(rows()[1]).toHaveTextContent("2.5 tUSD");
    expect(within(rows()[0]!).getByRole("link", { name: "0xd1d1…d1d1" })).toHaveAttribute("href", `/tx/${"0x" + "d1".repeat(32)}`);
    expect(within(rows()[0]!).getByRole("link", { name: "20" })).toHaveAttribute("href", "/block/20");
  });

  it("opens on the transfers when the link says so", async () => {
    await open(tokenDetail(), { transfers: () => derived([tokenTransfer(0xd1)]) }, `/token/${A}?tab=transfers`);
    await screen.findByRole("table");
    expect(screen.getByRole("tab", { name: /Transfers/ })).toHaveAttribute("aria-selected", "true");
  });

  it("marks a mint, which comes from the zero address", async () => {
    await go([tokenTransfer(0xd1, { from: "0x" + "00".repeat(20) })]);
    expect(within(rows()[0]!).getByText("mint")).toBeInTheDocument();
  });

  it("shows an NFT transfer by its id, and an ERC-1155 transfer by its id and amount", async () => {
    await go([tokenTransfer(0xd1, { amount: null, tokenId: "3" }), tokenTransfer(0xd2, { amount: "40", tokenId: "7" })], tokenDetail(0xcb, { standard: "ERC-1155", name: null, symbol: null, decimals: null }));
    expect(rows()[0]).toHaveTextContent("#3");
    expect(rows()[1]).toHaveTextContent("#7");
    expect(rows()[1]).toHaveTextContent("40");
  });

  it("shows the raw amount, and says why, when the decimals are not known", async () => {
    await go([tokenTransfer(0xd1, { amount: "123456" })], tokenDetail(0xcb, { decimals: null, symbol: null, name: null, metadataStatus: "failed" }));
    expect(within(rows()[0]!).getByTitle("The token's decimals are not known, so this is the raw amount")).toHaveTextContent("123,456");
  });

  it("says only final transfers are listed, and that a reverted one is not a transfer", async () => {
    await go([tokenTransfer(0xd1)]);
    expect(screen.getByText(/Only transfers in final blocks are listed/)).toBeInTheDocument();
    expect(screen.getByText(/reverted transaction moved nothing/)).toBeInTheDocument();
  });

  it("says there are no transfers", async () => {
    await open(tokenDetail(), { transfers: () => derived([]) });
    await userEvent.click(screen.getByRole("tab", { name: /Transfers/ }));
    expect(await screen.findByText("No transfers yet.")).toBeInTheDocument();
  });
});
