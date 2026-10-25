// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenDetail } from "../api.ts";
import { addr, cantonCustody, contractDetail, fakeApi, NOT_FOUND, page, renderApp, reply, route, status, tick, tokenDetail, tokenHolder, tokenTransfer } from "../test-utils.tsx";

afterEach(() => { vi.useRealTimers(); });
const A = addr(0xcb);
const derived = <T,>(items: T[], next: string | null = null, d = true) => reply({ ...page(items, next), derived: d });
const HOLDERS = [tokenHolder(0xe3, "995000000000"), tokenHolder(0xa1, "2500000000"), tokenHolder(0xa2, "2500000"), tokenHolder(0xa3, "1")];

type Subs = { holders?: (path: string) => ReturnType<typeof reply>; transfers?: (path: string) => ReturnType<typeof reply>; contract?: () => ReturnType<typeof reply>; status?: () => ReturnType<typeof reply> };
async function open(t: TokenDetail = tokenDetail(), subs: Subs = {}, path = `/token/${A}`) {
  const calls = fakeApi(route({
    tokenPages: (_a, sub, p) => (sub === "" ? reply(t) : sub === "holders" ? (subs.holders?.(p) ?? derived(HOLDERS)) : (subs.transfers?.(p) ?? derived([]))),
    contracts: () => subs.contract?.() ?? reply(contractDetail(0xcb)),
    ...(subs.status ? { status: subs.status } : {}),
  }));
  renderApp(path);
  await screen.findByRole("heading", { level: 1 });
  return calls;
}
const card = (k: string) => screen.getByText(k, { selector: ".stat-k" }).parentElement!;
const rows = (name = "Token holders") => within(screen.getByRole("table", { name })).getAllByRole("row").slice(1);

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

  it("keeps a long supply inside its card: the number alone is the value, and the symbol is in the line under it", async () => {
    await open(tokenDetail(0xcb, { symbol: "TKA", decimals: 18, totalSupply: "1" + "0".repeat(24) }));
    const c = card("Total supply");
    expect(c.querySelector(".stat-v")).toHaveTextContent(/^1,000,000$/);
    expect(c).toHaveTextContent("TKA · as of block 21");
    expect(c.closest(".stats")).toHaveClass("tok-stats");
  });

  it("marks a 13-digit supply with a break point after every comma, so it wraps only between groups", async () => {
    await open(tokenDetail(0xcb, { symbol: "TKA", decimals: 18, totalSupply: "1" + "0".repeat(30) }));
    const v = card("Total supply").querySelector(".stat-v")!;
    expect(v).toHaveTextContent(/^1,000,000,000,000$/);
    expect(v.innerHTML.match(/,<wbr>/g)).toHaveLength(4);
  });

  it("lets the contract address wrap inside its card instead of running out of it", async () => {
    await open();
    const v = card("Contract").querySelector(".stat-v")!;
    expect(v).toHaveClass("stat-hash");
    await userEvent.click(within(v as HTMLElement).getByRole("button", { name: "Show in full" }));
    expect(v).toHaveTextContent(A);
  });

  it("titles the holder, transfer and information cards in the small card-header style, not a large heading", async () => {
    await open();
    await screen.findByRole("region", { name: "Holder distribution" });
    for (const [region, title] of [["Holder distribution", "Holder distribution"], ["Token information", "Token information"]] as const) {
      const h = screen.getByRole("region", { name: region }).querySelector(".card-head")!;
      expect(h, region).not.toBeNull();
      expect(within(h as HTMLElement).getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    }
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

  describe("backed on Canton", () => {
    const WRAPPED = { gatewayWrapped: true, totalSupplyBlock: 21 };
    const check = () => screen.getByRole("region", { name: "Backed on Canton" });
    const kv = (k: string) => within(check()).getByText(k, { selector: "dt" }).nextElementSibling as HTMLElement;

    it("shows nothing of Canton for a token the gateway did not register: today's DevNet, with no token registered", async () => {
      await open();
      expect(screen.queryByRole("region", { name: "Backed on Canton" })).toBeNull();
    });

    it("shows nothing for a wrapped token with no custody row: a token anyone made through the register is not shown as backed", async () => {
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: null }));
      expect(screen.queryByRole("region", { name: "Backed on Canton" })).toBeNull();
    });

    it("sets what the gateway holds on Canton against the supply read at the same block, and says they are equal at that block", async () => {
      // 1,000 whole units on both sides: 10 decimals on Canton, 6 on the wrapped token.
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: cantonCustody() }));
      expect(kv("Held on Canton")).toHaveTextContent("1,000 TKB");
      expect(kv("Wrapped supply")).toHaveTextContent("1,000 tUSD");
      expect(kv("Check")).toHaveTextContent("Equal at block 21");
      expect(kv("Check")).toHaveAttribute("data-state", "equal");
      expect(kv("Read")).toHaveTextContent("Both at block 21");
    });

    it("compares the stored supply, not the token's live one, which a later deposit may have raised", async () => {
      // The page's token row has moved on to 1,010 (a deposit in a later block); the custody row was read as a pair at block 21, 1,000 and 1,000.
      await open(tokenDetail(0xcb, { ...WRAPPED, totalSupply: "1010000000", totalSupplyBlock: 22, canton: cantonCustody() }));
      expect(kv("Check")).toHaveAttribute("data-state", "equal");
      expect(kv("Wrapped supply")).toHaveTextContent("1,000 tUSD");
      expect(within(check()).queryByText(/more than/)).toBeNull();
    });

    it("names the registered instrument, the admin in full, and the ledger offset the custody was read at", async () => {
      const c = cantonCustody();
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: c }));
      expect(kv("Instrument")).toHaveTextContent(`TKB`);
      expect(kv("Instrument")).toHaveTextContent(c.instrumentAdmin);
      expect(kv("Read")).toHaveTextContent("Canton offset 4,242");
    });

    it("says by how much Canton holds more, and by how much the supply is more, at the block, in the token's own units", async () => {
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: cantonCustody({ supply: "999500000" }) }));
      expect(kv("Check")).toHaveTextContent("At block 21, Canton holds 0.5 more than the wrapped supply");
      expect(kv("Check")).toHaveAttribute("data-state", "custody-higher");
      cleanup();
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: cantonCustody({ supply: "1000250000" }) }));
      expect(kv("Check")).toHaveTextContent("At block 21, the wrapped supply is 0.25 more than Canton holds");
      expect(kv("Check")).toHaveAttribute("data-state", "supply-higher");
    });

    it("compares nothing when the supply or the decimals are not known, and still shows the custody", async () => {
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: cantonCustody({ supply: null }) }));
      expect(kv("Held on Canton")).toHaveTextContent("1,000 TKB");
      expect(kv("Check")).toHaveTextContent("not known");
      expect(kv("Check")).toHaveAttribute("data-state", "unknown");
    });

    it("shows an empty custody as 0, not as a missing number", async () => {
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: cantonCustody({ custody: "0", holdings: 0, supply: "0" }) }));
      expect(kv("Held on Canton")).toHaveTextContent("0 TKB");
      expect(kv("Check")).toHaveTextContent("Equal");
    });

    it("shows no owner, holding or contract of the gateway's Daml side", async () => {
      await open(tokenDetail(0xcb, { ...WRAPPED, canton: cantonCustody() }));
      expect(within(check()).queryByText(/contract id|owner|allocation/i)).toBeNull();
    });
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
    await screen.findByRole("table", { name: "Token holders" });
    expect(calls).toContain(`/api/tokens/${A}/holders?limit=25`);
    expect(rows()).toHaveLength(4);
    expect(rows()[0]).toHaveTextContent("995,000");
    expect(rows()[0]).toHaveTextContent("99.50%");
    expect(rows()[1]).toHaveTextContent("2,500");
    expect(rows()[1]).toHaveTextContent("0.25%");
    expect(rows()[2]).toHaveTextContent("2.5");
    expect(rows()[2]).toHaveTextContent("<0.01%");
    expect(within(rows()[0]!).getByRole("link", { name: "0xe3e3e3e3…e3e3e3" })).toHaveAttribute("href", `/address/${addr(0xe3)}`);
  });

  it("says a share too small to show is below it, never 0", async () => {
    await open(tokenDetail(0xcb, { totalSupply: "1000000000000" }), { holders: () => derived([tokenHolder(0xa3, "1")]) });
    await screen.findByRole("table", { name: "Token holders" });
    expect(rows()[0]).toHaveTextContent("<0.01%");
  });

  it("numbers the rows on a later page from where the page before stopped", async () => {
    await open(tokenDetail(), { holders: (p) => derived(HOLDERS.slice(0, 2), p.includes("before=") ? null : "cursor") });
    await screen.findByRole("table", { name: "Token holders" });
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(rows()[0]!.querySelector("td")).toHaveTextContent("26");
  });

  it("shows an ERC-721 holder's balance as a count of tokens, as the API gives it, with no share and no token id", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-721", decimals: null, totalSupply: "3" }), { holders: () => derived([tokenHolder(0xa1, "2"), tokenHolder(0xa2, "1")]) });
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.queryByRole("columnheader", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Token id" })).toBeNull();
    expect(rows()[0]).toHaveTextContent("2 tokens");
    expect(rows()[1]).toHaveTextContent("1 token");
    expect(screen.queryByText(/#0/)).toBeNull();
  });

  it("names the final block the holders are as of, and says nothing of it while the explorer is still reading", async () => {
    await open();
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.getByRole("region", { name: "Holder distribution" })).toHaveTextContent("as of final block 3");
  });

  it("names the block the balances are summed through, as the Tokens list does, when the index is behind Canton's final head", async () => {
    // Canton's final head (9) is ahead of the index (5), which has summed through block 5: the page says 5.
    const base = status();
    await open(tokenDetail(), { status: () => reply(status({ final: { ...base.final!, number: 9 }, indexHead: 5, indexLag: 4, deriveCursor: 5 })) });
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.getByRole("region", { name: "Holder distribution" })).toHaveTextContent("as of final block 5");
    expect(screen.getByRole("region", { name: "Holder distribution" })).not.toHaveTextContent("as of final block 9");
  });

  it("shows each balance as a bare number under 'Balance (tUSD)', as screen 09b does, with the symbol in the tooltip", async () => {
    await open();
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.getByRole("columnheader", { name: "Balance (tUSD)" })).toBeInTheDocument();
    const first = rows()[0]!;
    expect(first).not.toHaveTextContent("tUSD");
    expect(within(first).getByTitle("995,000 tUSD")).toHaveTextContent(/^995,000$/);
  });

  it("names no block while the explorer is still reading, because the list is then short of the newest rows", async () => {
    await open(tokenDetail(), { holders: () => derived(HOLDERS, null, false) });
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.getByRole("region", { name: "Holders" })).not.toHaveTextContent("as of final block");
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows how much of the supply the top holder has, with a bar and a key for the biggest holders", async () => {
    await open();
    await screen.findByRole("table", { name: "Token holders" });
    const box = screen.getByRole("region", { name: "Holder distribution" });
    expect(box).toHaveTextContent("Share held by the top holder");
    expect(box).toHaveTextContent("99.50%");
    expect(box).toHaveTextContent("0xe3e3…e3e3 99.50%");
    expect(box).toHaveTextContent("0xa1a1…a1a1 0.25%");
    expect(box).toHaveTextContent("as of final block 3");
  });

  it("shows no distribution for an NFT", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-721", decimals: null, totalSupply: "3" }), { holders: () => derived([tokenHolder(0xa1, "2")]) });
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows no distribution when the supply is not known", async () => {
    await open(tokenDetail(0xcb, { totalSupply: null, totalSupplyBlock: null }));
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows the distribution on the first page only", async () => {
    await open(tokenDetail(), { holders: (p) => derived(HOLDERS.slice(0, 2), p.includes("before=") ? null : "cursor") });
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.getByRole("region", { name: "Holder distribution" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(screen.queryByRole("region", { name: "Holder distribution" })).toBeNull();
  });

  it("shows an ERC-1155 balance by id with no share, because the supply of one id is not known", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-1155", name: null, symbol: null, decimals: null, totalSupply: null, totalSupplyBlock: null }), { holders: () => derived([tokenHolder(0xa1, "40", { tokenId: "7" })]) });
    await screen.findByRole("table", { name: "Token holders" });
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
    await screen.findByRole("table", { name: "Token transfers" });
    return calls;
  };

  it("lists the transfers with the amount in the token's decimals, and is in the link", async () => {
    const calls = await go([tokenTransfer(0xd1), tokenTransfer(0xd2, { amount: "2500000", from: "0x" + "00".repeat(20) })]);
    expect(calls).toContain(`/api/tokens/${A}/transfers?limit=25`);
    expect(rows("Token transfers")).toHaveLength(2);
    // A bare number, as screen 09b has it: the unit is the token's own, and the tooltip names it with the exact amount.
    expect(within(rows("Token transfers")[0]!).getByTitle("100 tUSD")).toHaveTextContent(/^100$/);
    expect(within(rows("Token transfers")[1]!).getByTitle("2.5 tUSD")).toHaveTextContent(/^2\.5$/);
    expect(rows("Token transfers")[0]).not.toHaveTextContent("tUSD");
    expect(within(rows("Token transfers")[0]!).getByRole("link", { name: "0xd1d1d1d1…d1d1d1" })).toHaveAttribute("href", `/tx/${"0x" + "d1".repeat(32)}`);
    expect(within(rows("Token transfers")[0]!).getByRole("link", { name: "20" })).toHaveAttribute("href", "/block/20");
  });

  it("marks a mint, which comes from the zero address", async () => {
    await go([tokenTransfer(0xd1, { from: "0x" + "00".repeat(20) })]);
    expect(within(rows("Token transfers")[0]!).getByText("mint")).toBeInTheDocument();
  });

  it("shows an NFT transfer by its id, and an ERC-1155 transfer by its id and amount", async () => {
    await go([tokenTransfer(0xd1, { amount: null, tokenId: "3" }), tokenTransfer(0xd2, { amount: "40", tokenId: "7" })], tokenDetail(0xcb, { standard: "ERC-1155", name: null, symbol: null, decimals: null }));
    expect(rows("Token transfers")[0]).toHaveTextContent("#3");
    expect(rows("Token transfers")[1]).toHaveTextContent("#7");
    expect(rows("Token transfers")[1]).toHaveTextContent("40");
  });

  it("shows the raw amount, and says why, when the decimals are not known", async () => {
    await go([tokenTransfer(0xd1, { amount: "123456" })], tokenDetail(0xcb, { decimals: null, symbol: null, name: null, metadataStatus: "failed" }));
    expect(within(rows("Token transfers")[0]!).getByTitle("The token's decimals are not known, so this is the raw amount")).toHaveTextContent("123,456");
  });

  it("says only final transfers are listed, and that a reverted one is not a transfer", async () => {
    await go([tokenTransfer(0xd1)]);
    expect(screen.getByText(/Only transfers in final blocks are listed/)).toBeInTheDocument();
    expect(screen.getByText(/reverted transaction moved nothing/)).toBeInTheDocument();
  });

  it("says there are no transfers", async () => {
    await open(tokenDetail(), { transfers: () => derived([]) });
    expect(await screen.findByText("No transfers yet.")).toBeInTheDocument();
  });
});

describe("the token page: one stacked page", () => {
  it("is one page with no tabs: the holders, the transfers and the information, one under the other", async () => {
    await open(tokenDetail(), { transfers: () => derived([tokenTransfer(0xd1)]) });
    await screen.findByRole("table", { name: "Token transfers" });
    expect(screen.queryByRole("tablist")).toBeNull();
    const cards = ["Holder distribution", "Transfers", "Token information"].map((n) => screen.getByRole("region", { name: n }));
    cards.slice(1).forEach((c, i) => expect(cards[i]!.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
  });

  it("puts the holders table beside the distribution, in two columns, with a space before the sub-title", async () => {
    await open();
    const box = await screen.findByRole("region", { name: "Holder distribution" });
    expect(box.querySelector(".holds-cols")).not.toBeNull();
    expect(within(box).getByRole("table", { name: "Token holders" })).toBeInTheDocument();
    expect(box.querySelector(".card-title")!.textContent).toBe("Holder distribution as of final block 3");
  });

  it("tags the holder the API says made the token as its creator", async () => {
    await open(tokenDetail(0xcb, { creator: addr(0xe3) }));
    await screen.findByRole("table", { name: "Token holders" });
    expect(within(rows()[0]!).getByText("creator")).toBeInTheDocument();
    expect(within(rows()[1]!).queryByText("creator")).toBeNull();
  });

  it("claims no owner, because the API does not serve one", async () => {
    await open(tokenDetail(0xcb, { creator: addr(0xe3) }));
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.queryByText(/owner/i)).toBeNull();
  });

  it("gives the transfers a Method, an age and a CSV of the newest 1,000", async () => {
    const t = tokenTransfer(0xd1, { methodId: "0xa9059cbb", timestamp: Math.floor(Date.now() / 1000) - 7200 });
    await open(tokenDetail(), { transfers: () => derived([t, tokenTransfer(0xd2, { creation: false, methodId: null })]) });
    const t20 = await screen.findByRole("table", { name: "Token transfers" });
    expect(within(t20).getByRole("columnheader", { name: "Method" })).toBeInTheDocument();
    expect(rows("Token transfers")[0]).toHaveTextContent("transfer");
    expect(rows("Token transfers")[0]).toHaveTextContent("2 h ago");
    const csv = within(screen.getByRole("region", { name: "Transfers" })).getByRole("link", { name: /CSV/ });
    expect(csv).toHaveAttribute("href", `/api/tokens/${A}/transfers?format=csv`);
  });

  it("says the transfers are the final ones only", async () => {
    await open(tokenDetail(), { transfers: () => derived([tokenTransfer(0xd1)]) });
    const box = await screen.findByRole("region", { name: "Transfers" });
    expect(box.querySelector(".card-title")).toHaveTextContent("newest first, final blocks only");
  });

  it("gives the token information in three columns, with where and by which transaction it was created", async () => {
    await open(tokenDetail(0xcb, { creator: addr(0xe3), creationBlock: 18 }), { contract: () => reply(contractDetail(0xcb, { creationTxHash: "0x" + "d7".repeat(32), creationBlock: 18 })) });
    const box = screen.getByRole("region", { name: "Token information" });
    expect(box.querySelector(".kv-3")).not.toBeNull();
    const created = await within(box).findByText("Block 18");
    expect(created.closest("dd")).toHaveTextContent(/Block 18\s*·\s*0xd7d7d7…d7d7/);
    expect(within(created.closest("dd") as HTMLElement).getByRole("link", { name: "0xd7d7d7…d7d7" })).toHaveAttribute("href", `/tx/${"0x" + "d7".repeat(32)}`);
    expect(within(box).getByRole("link", { name: "Block 18" })).toHaveAttribute("href", "/block/18");
    expect(within(box).getByText("Creator")).toBeInTheDocument();
  });

  it("says a token of the genesis state was made by no transaction", async () => {
    await open(tokenDetail(0xcb, { creator: null, creationBlock: null, createdAt: null }), { contract: () => reply(contractDetail(0xcb, { origin: "genesis", creator: null, creationBlock: null, creationTxHash: null })) });
    expect(await within(screen.getByRole("region", { name: "Token information" })).findByText("Genesis state")).toBeInTheDocument();
  });

  it("breaks a long supply only after a comma", async () => {
    await open(tokenDetail(0xcb, { symbol: "TKA", decimals: 18, totalSupply: "1" + "0".repeat(24) }));
    const v = card("Total supply").querySelector(".stat-v")!;
    expect(v.querySelectorAll("wbr")).toHaveLength(2);
    expect(v.innerHTML).toContain(",<wbr>");
  });

  it("never puts the symbol on a raw amount: the decimals are not known", async () => {
    await open(tokenDetail(0xcb, { decimals: null, symbol: "tUSD", totalSupply: "12345" }));
    expect(card("Total supply")).not.toHaveTextContent("tUSD");
    expect(card("Total supply")).toHaveTextContent("12,345");
    await screen.findByRole("table", { name: "Token holders" });
    expect(screen.getByRole("columnheader", { name: /Balance/ })).not.toHaveTextContent("tUSD");
  });

  it("says an ERC-1155 has no total supply by standard", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-1155", name: null, symbol: null, decimals: null, totalSupply: null, totalSupplyBlock: null }));
    expect(card("Total supply")).toHaveTextContent("ERC-1155 has no total supply");
    expect(card("Total supply")).not.toHaveTextContent("has not told it");
  });

  it("says a read balance is read at the last block that moved it, not as of the final block", async () => {
    await open(tokenDetail(0xcb, { balanceMode: "read" }));
    const box = await screen.findByRole("region", { name: "Holder distribution" });
    expect(box).toHaveTextContent("each balance is read at the last block that moved it");
    expect(box).not.toHaveTextContent("as of final block");
  });

  it("asks for the token again at the lists' interval, so the supply and the counts move with the lists", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let supply = "1000000000";
    fakeApi(route({
      tokenPages: (_a, sub) => (sub === "" ? reply(tokenDetail(0xcb, { totalSupply: supply })) : derived(sub === "holders" ? HOLDERS : [])),
      contracts: () => reply(contractDetail(0xcb)),
    }));
    renderApp(`/token/${A}`);
    await screen.findByRole("heading", { level: 1 });
    expect(card("Total supply")).toHaveTextContent("1,000");
    supply = "2000000000";
    await tick(5000);
    expect(card("Total supply")).toHaveTextContent("2,000");
    vi.useRealTimers();
  });
});

describe("the token page: review fixes", () => {
  const icons = (el: HTMLElement) => [...within(el).queryAllByRole("button", { name: /Show in full|Copy/ })];

  it("lists plain hashes in the holders and transfers tables and in the information card: no copy or show-in-full icons on a row", async () => {
    await open(tokenDetail(0xcb, { creator: addr(0xe3), creationBlock: 18 }), { transfers: () => derived([tokenTransfer(0xd1), tokenTransfer(0xd2)]), contract: () => reply(contractDetail(0xcb, { creationTxHash: "0x" + "d7".repeat(32), creationBlock: 18 })) });
    await screen.findByRole("table", { name: "Token transfers" });
    expect(icons(screen.getByRole("table", { name: "Token holders" }))).toHaveLength(0);
    expect(icons(screen.getByRole("table", { name: "Token transfers" }))).toHaveLength(0);
    const info = screen.getByRole("region", { name: "Token information" });
    await within(info).findByText("Block 18");
    expect(icons(info)).toHaveLength(0);
  });

  it("says in the supply value itself that an ERC-1155 has no total supply", async () => {
    await open(tokenDetail(0xcb, { standard: "ERC-1155", name: null, symbol: null, decimals: null, totalSupply: null, totalSupplyBlock: null }));
    const v = card("Total supply").querySelector(".stat-v")!;
    expect(v.querySelector("[title]")).toHaveAttribute("title", "ERC-1155 has no total supply");
    expect(v.querySelector("[title]")!.getAttribute("title")).not.toMatch(/not told/);
  });

  it("keeps a token name of the longest stored length inside the page: the title wraps anywhere", async () => {
    await open(tokenDetail(0xcb, { name: "N".repeat(256) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("N".repeat(256));
    const css = readFileSync(resolve(__dirname, "..", "styles.css"), "utf8");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("N".repeat(256));
    expect(css).toMatch(/nav\[aria-label="Breadcrumb"\]\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.ptitle h1\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*min-width:\s*0|\.ptitle h1\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  });

  it("does not repeat the contract address under the title: the Contract card carries it", async () => {
    await open();
    expect(document.querySelector(".bighash")).toBeNull();
  });
});
