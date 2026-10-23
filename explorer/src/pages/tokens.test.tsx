// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { addr, fakeApi, page, renderApp, reply, route, tokenItem, tokenTransfer, hash } from "../test-utils.tsx";

const LIST = [tokenItem(0xb1, { verified: true }), tokenItem(0xb2, { standard: "ERC-721", name: "Ostia Pass", symbol: "OPASS", decimals: null, totalSupply: "2", holderCount: 2, transferCount: 2 })];
const COUNTS = { "ERC-20": 1, "ERC-721": 1, "ERC-1155": 0 };
/** A page of the token list as /api/tokens answers it: the list's own total, each standard's count and the gateway's. */
const list = (items: unknown[], over: Record<string, unknown> = {}) => reply({ ...page(items as never[], (over.next as string | null | undefined) ?? null), derived: true, total: 2, counts: COUNTS, gatewayCount: 0, ...over });
const FEED = [
  tokenTransfer(1, { methodId: "0xa9059cbb", token: addr(0xb1), amount: "100000000", block: 22 }),
  tokenTransfer(2, { methodId: "0xa1448194", token: addr(0xb2), standard: "ERC-721", amount: "1", tokenId: "3", from: "0x" + "00".repeat(20), block: 22 }),
];
const LABELS = [
  { address: addr(0xb1), name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: true },
  { address: addr(0xb2), name: "Ostia Pass", symbol: "OPASS", kind: "token", standard: "ERC-721", decimals: null, verified: true },
];
async function open(answer: (path: string) => ReturnType<typeof reply> = () => list(LIST), feed: (path: string) => ReturnType<typeof reply> = () => reply({ ...page(FEED), derived: true })) {
  const base = route({ tokenPages: (_a, _s, path) => answer(path) });
  const calls = fakeApi(Object.assign((p: string) => (p.startsWith("/api/token-transfers") ? feed(p) : p.startsWith("/api/labels") ? reply({ items: LABELS }) : base(p)), { routed: true }));
  renderApp("/tokens");
  await screen.findByRole("heading", { name: "Tokens" });
  await screen.findByRole("table", { name: "Tokens" });
  return calls;
}
const rows = () => within(screen.getByRole("table", { name: "Tokens" })).getAllByRole("row").slice(1);
const feedRows = () => within(screen.getByRole("table", { name: "Latest token transfers" })).getAllByRole("row").slice(1);

describe("the tokens page to the screen", () => {
  it("says how many tokens there are and the final block the counts are as of", async () => {
    await open();
    expect(screen.getByText("2 tokens · counts as of final block 3")).toBeInTheDocument();
  });

  it("does not say 'as of' while the explorer is still reading blocks", async () => {
    await open(() => list(LIST, { derived: false }));
    expect(screen.queryByText(/counts as of final block/)).toBeNull();
    expect(screen.getByText(/2 tokens · the explorer is still reading blocks/)).toBeInTheDocument();
  });

  it("filters by standard with each tab's count, and by From Canton", async () => {
    const calls = await open(() => list(LIST, { gatewayCount: 4 }));
    const tabs = within(screen.getByRole("group", { name: "Show tokens" }));
    expect(tabs.getByRole("button", { name: "All 2" })).toHaveAttribute("aria-pressed", "true");
    expect(tabs.getByRole("button", { name: "ERC-20 1" })).toBeInTheDocument();
    expect(tabs.getByRole("button", { name: "ERC-721 1" })).toBeInTheDocument();
    expect(tabs.getByRole("button", { name: "ERC-1155 0" })).toBeInTheDocument();
    await userEvent.click(tabs.getByRole("button", { name: "ERC-20 1" }));
    await vi.waitFor(() => expect(calls).toContain("/api/tokens?sort=holders&limit=25&standard=ERC-20"));
    await userEvent.click(tabs.getByRole("button", { name: "From Canton 4" }));
    await vi.waitFor(() => expect(calls).toContain("/api/tokens?sort=holders&limit=25&gateway=true"));
    expect(tabs.getByRole("button", { name: "From Canton 4" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the tab counts of every standard while one standard is shown", async () => {
    await open((p) => (p.includes("standard=ERC-20") ? list([LIST[0]], { total: 1 }) : list(LIST)));
    await userEvent.click(screen.getByRole("button", { name: "ERC-20 1" }));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "ERC-721 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All 2" })).toBeInTheDocument();
  });

  it("draws an avatar of the name's initials and a check on a verified token only", async () => {
    await open();
    expect(within(rows()[0]!).getByTestId("avatar")).toHaveTextContent("TU");
    expect(within(rows()[1]!).getByTestId("avatar")).toHaveTextContent("OP");
    expect(within(rows()[0]!).getByRole("img", { name: "Verified" })).toBeInTheDocument();
    expect(within(rows()[1]!).queryByRole("img", { name: "Verified" })).toBeNull();
  });

  it("shows when each token was created and by whom, and says a genesis token has no creation", async () => {
    await open(() => list([tokenItem(0xb1, { creationBlock: 18, createdAt: new Date(Date.now() - 35 * 60_000 - 20_000).toISOString() }), tokenItem(0xb2, { creator: null, creationBlock: null, createdAt: null })]));
    const [a, b] = rows();
    expect(within(a!).getByRole("link", { name: "Block 18" })).toHaveAttribute("href", "/block/18");
    expect(a).toHaveTextContent("35 min ago");
    expect(within(a!).getByRole("link", { name: "0xa1a1a1…a1a1" })).toHaveAttribute("href", `/address/${addr(0xa1)}`);
    expect(b).toHaveTextContent("Genesis state");
    expect(screen.getByRole("columnheader", { name: "Created" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Creator" })).toBeInTheDocument();
  });

  it("shows Page 1 of 1 and the whole set of pager buttons on a list of one page", async () => {
    await open();
    const nav = screen.getByRole("navigation", { name: "Pages of tokens" });
    expect(nav).toHaveTextContent("Page 1 of 1");
    expect(within(nav).getByRole("button", { name: "Last" })).toBeDisabled();
    expect(within(nav).getByRole("button", { name: "First" })).toBeDisabled();
  });

  it("goes to the last page by reading from the other end with only what the last page holds, so it never overlaps", async () => {
    const all = Array.from({ length: 53 }, (_, i) => tokenItem(0x10 + i, { name: `T${i + 1}`, symbol: null }));
    const calls = await open((p) => {
      if (p.includes("order=asc") && !p.includes("after=")) return list(all.slice(50).reverse(), { total: 53, next: "k1" });
      if (p.includes("order=asc") && p.includes("after=k1")) return list(all.slice(25, 50).reverse(), { total: 53, next: "k2" });
      if (p.includes("order=asc") && p.includes("after=k2")) return list(all.slice(0, 25).reverse(), { total: 53, next: null });
      return list(all.slice(0, 25), { total: 53, next: "d1" });
    });
    const nav = screen.getByRole("navigation", { name: "Pages of tokens" });
    expect(nav).toHaveTextContent("Page 1 of 3");
    await userEvent.click(within(nav).getByRole("button", { name: "Last" }));
    await screen.findByText("Page 3 of 3");
    expect(calls).toContain("/api/tokens?sort=holders&order=asc&limit=3");
    expect(rows().map((r) => r.querySelector("td")!.textContent)).toEqual(["51", "52", "53"]);
    expect(rows()[2]).toHaveTextContent("T53");
    await userEvent.click(within(nav).getByRole("button", { name: "Previous page" }));
    await screen.findByText("Page 2 of 3");
    expect(calls).toContain("/api/tokens?sort=holders&order=asc&limit=25&after=k1");
    expect(rows()[0]!.querySelector("td")).toHaveTextContent("26");
    expect(rows()[24]!.querySelector("td")).toHaveTextContent("50");
    await userEvent.click(within(nav).getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 3 of 3");
    await userEvent.click(within(nav).getByRole("button", { name: "Previous page" }));
    await userEvent.click(within(nav).getByRole("button", { name: "Previous page" }));
    await screen.findByText("Page 1 of 3");
    expect(rows()[0]!.querySelector("td")).toHaveTextContent("1");
    await userEvent.click(within(nav).getByRole("button", { name: "Last" }));
    await screen.findByText("Page 3 of 3");
    await userEvent.click(within(nav).getByRole("button", { name: "First" }));
    await screen.findByText("Page 1 of 3");
    expect(rows()[0]).toHaveTextContent("T1");
  });

  it("reads the last page in full when the total is a whole number of pages", async () => {
    const calls = await open((p) => (p.includes("order=asc") ? list([tokenItem(0x30)], { total: 75, next: "k1" }) : list([tokenItem(0x31)], { total: 75, next: "d1" })));
    await userEvent.click(within(screen.getByRole("navigation", { name: "Pages of tokens" })).getByRole("button", { name: "Last" }));
    await vi.waitFor(() => expect(calls).toContain("/api/tokens?sort=holders&order=asc&limit=25"));
  });

  it("walks forward by the cursor the server gave", async () => {
    const calls = await open((p) => list([tokenItem(0xb1)], { total: 30, next: p.includes("before=") ? null : "5|0xb1" }));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 2");
    expect(calls.some((c) => c.includes("before=5%7C0xb1"))).toBe(true);
  });

  it("lists the latest token transfers with the method, block, age, stage, and the token by name", async () => {
    const calls = await open();
    await screen.findByRole("table", { name: "Latest token transfers" });
    expect(calls).toContain("/api/token-transfers?limit=10");
    const [a, b] = feedRows();
    expect(within(a!).getByRole("link", { name: "0x01010101…010101" })).toHaveAttribute("href", `/tx/${hash(1)}`);
    expect(a).toHaveTextContent("transfer");
    expect(within(a!).getByRole("link", { name: "22" })).toHaveAttribute("href", "/block/22");
    expect(a).toHaveTextContent("100");
    expect(a).toHaveTextContent("Test USD (tUSD)");
    expect(a).toHaveTextContent("Final");
    expect(b).toHaveTextContent("safeMint");
    expect(b).toHaveTextContent("#3");
    expect(b).toHaveTextContent("mint");
    expect(b).toHaveTextContent("Ostia Pass (OPASS)");
    expect(screen.getByText(/is not listed here/)).toHaveTextContent("not final yet");
  });

  it("filters the transfers feed by ERC-20 or ERC-721", async () => {
    const calls = await open();
    await screen.findByRole("table", { name: "Latest token transfers" });
    const f = within(screen.getByRole("group", { name: "Show token transfers" }));
    expect(f.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(f.queryByRole("button", { name: "ERC-1155" })).toBeNull();
    await userEvent.click(f.getByRole("button", { name: "ERC-721" }));
    await vi.waitFor(() => expect(calls).toContain("/api/token-transfers?limit=10&standard=ERC-721"));
    await userEvent.click(f.getByRole("button", { name: "ERC-20" }));
    await vi.waitFor(() => expect(calls).toContain("/api/token-transfers?limit=10&standard=ERC-20"));
  });

  it("never labels a raw amount with the symbol when the token's decimals are unknown", async () => {
    const feed = () => reply({ ...page([tokenTransfer(5, { token: addr(0xb3), amount: "123456", methodId: null })]), derived: true });
    await open(undefined, feed);
    await screen.findByRole("table", { name: "Latest token transfers" });
    const cell = feedRows()[0]!;
    expect(cell).toHaveTextContent("123,456");
    expect(within(cell).getByTitle(/decimals are not known/)).toBeInTheDocument();
  });

  it("says the feed is empty, honestly", async () => {
    await open(undefined, () => reply({ ...page([]), derived: true }));
    expect(await screen.findByText("No token transfers yet.")).toBeInTheDocument();
  });

  it("says the feed cannot be read when the server fails", async () => {
    await open(undefined, () => reply({ error: "the explorer could not read the transfers" }, 500));
    const card = screen.getByRole("region", { name: "Latest token transfers" });
    expect(await within(card).findByText(/could not read the transfers|500/)).toBeInTheDocument();
    expect(within(card).queryByRole("table")).toBeNull();
  });

  it("shows the amount in whole tokens, exactly, once the decimals are known", async () => {
    await open();
    await screen.findByRole("table", { name: "Latest token transfers" });
    await vi.waitFor(() => expect(feedRows()[0]!.querySelector("td.r")!.textContent).toBe("100"));
  });

  it("shows no amount while the decimals are still being read, never the raw count as if it were final", async () => {
    const base = route({ tokenPages: () => list(LIST) });
    fakeApi(Object.assign((p: string) => (p.startsWith("/api/token-transfers") ? reply({ ...page(FEED), derived: true }) : base(p)), { routed: true }));
    const answering = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => (String(input).startsWith("/api/labels") ? new Promise<Response>(() => {}) : answering(input, init))));
    renderApp("/tokens");
    await screen.findByRole("table", { name: "Latest token transfers" });
    const r = feedRows()[0]!;
    expect(r.querySelector("td.r")!.textContent).toBe("…");
    expect(within(r).queryByTitle(/decimals are not known/)).toBeNull();
  });

  it("gives the feed card a header that sits inside the card (a panel card pulls no header out of its edge)", async () => {
    await open();
    const css = readFileSync(resolve(__dirname, "token.css"), "utf8");
    expect(css).toMatch(/\.panel\s*>\s*\.card-head\s*\{[^}]*margin:\s*0/);
    const card = screen.getByRole("region", { name: "Latest token transfers" });
    expect(card).toHaveClass("panel");
    expect(card.querySelector(":scope > .card-head")).not.toBeNull();
  });

  it("keeps the standard tabs whole on a narrow screen: a label never breaks inside itself", () => {
    const css = readFileSync(resolve(__dirname, "token.css"), "utf8");
    expect(css).toMatch(/\.seg button\s*\{[^}]*white-space:\s*nowrap/);
  });

  it("shows the two note cards: From Canton and what a token page shows", async () => {
    await open();
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent("From Canton.");
    expect(notes[0]).toHaveTextContent("10 decimals");
    expect(notes[0]).toHaveTextContent("None has been made on this chain yet");
    expect(notes[1]).toHaveTextContent("What a token page shows.");
    expect(notes[1]).toHaveTextContent("A token's Canton holdings stay private to their parties, so they are never shown here.");
    expect(notes[1]).toHaveTextContent("Holders and transfers on Ostia");
  });

  it("counts the wrapped tokens in the From Canton note when there are some", async () => {
    await open(() => list(LIST, { gatewayCount: 3 }));
    expect(screen.getAllByRole("note")[0]).toHaveTextContent("3 have been made");
  });
});

describe("the tokens list that was there before", () => {
  it("lists the tokens by holders first, each linking to its own page", async () => {
    const calls = await open();
    expect(calls).toContain("/api/tokens?sort=holders&limit=25");
    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]!).getByRole("link", { name: "Test USD" })).toHaveAttribute("href", `/token/${addr(0xb1)}`);
    expect(rows()[0]).toHaveTextContent("tUSD");
    expect(rows()[0]).toHaveTextContent("0xb1b1b1b1…b1b1b1");
    expect(rows()[0]).toHaveTextContent("ERC-20");
    expect(rows()[1]).toHaveTextContent("ERC-721");
  });

  it("does not page with the old sort's cursor while the new sort's first page is still loading", async () => {
    const calls = await open((path) => list(LIST, { total: 60, next: path.includes("before=") ? null : "21|1" }));
    const ask = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => (input.includes("sort=transfers") ? (await gate, ask(input)) : ask(input))));
    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(calls.some((c) => c.includes("sort=transfers") && c.includes("before="))).toBe(false);
    release();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 3");
    expect(calls.some((c) => c.includes("sort=transfers") && c.includes("before=21%7C1"))).toBe(true);
  });

  it("numbers the rows from the first of the page", async () => {
    await open();
    expect(rows()[0]!.querySelector("td")).toHaveTextContent("1");
    expect(rows()[1]!.querySelector("td")).toHaveTextContent("2");
  });

  it("shows the supply with the token's decimals, and a count of tokens for an NFT", async () => {
    await open();
    expect(rows()[0]).toHaveTextContent("1,000,000 tUSD");
    expect(rows()[1]).toHaveTextContent("2 tokens");
  });

  it("shows the supply as unknown, never as 0, when the contract has not told it, and the raw count when the decimals are unknown", async () => {
    await open(() => list([tokenItem(0xb1, { totalSupply: null }), tokenItem(0xb2, { decimals: null, totalSupply: "12345", name: null, symbol: null, metadataStatus: "failed" })]));
    expect(rows()[0]!.querySelectorAll("td")[3]).toHaveTextContent("—");
    expect(rows()[1]!.querySelectorAll("td")[3]).toHaveTextContent("12,345");
    expect(within(rows()[1]!).getByText("Name not read")).toBeInTheDocument();
    expect(within(rows()[1]!).getByRole("link", { name: "0xb2b2b2b2…b2b2b2" })).toHaveAttribute("href", `/token/${addr(0xb2)}`);
  });

  it("shows the holders, the transfers and the block of the first transfer", async () => {
    await open();
    expect(rows()[0]).toHaveTextContent("5");
    expect(rows()[0]).toHaveTextContent("6");
    expect(within(rows()[0]!).getByRole("link", { name: "Block 19" })).toHaveAttribute("href", "/block/19");
  });

  it("marks a token the gateway wrapped from Canton", async () => {
    await open(() => list([tokenItem(0xb1, { gatewayWrapped: true }), tokenItem(0xb2)]));
    expect(within(rows()[0]!).getByText("From Canton")).toBeInTheDocument();
    expect(within(rows()[1]!).queryByText("From Canton")).toBeNull();
  });

  it("sorts by transfers or by newest, from the first page", async () => {
    const calls = await open();
    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));
    await screen.findByRole("table", { name: "Tokens" });
    expect(calls).toContain("/api/tokens?sort=transfers&limit=25");
    await userEvent.click(screen.getByRole("button", { name: "Newest" }));
    await screen.findByRole("table", { name: "Tokens" });
    expect(calls).toContain("/api/tokens?sort=newest&limit=25");
    expect(screen.getByRole("button", { name: "Newest" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says nothing is listed yet, and that the list may be short while the explorer reads blocks", async () => {
    fakeApi(route({ tokenPages: () => reply({ ...page([]), derived: false, total: 0, counts: { "ERC-20": 0, "ERC-721": 0, "ERC-1155": 0 }, gatewayCount: 0 }) }));
    renderApp("/tokens");
    expect(await screen.findByText("The explorer has not read this far yet.")).toBeInTheDocument();
  });

  it("says what could not be read, in the server's words", async () => {
    fakeApi(route({ tokenPages: () => reply({ error: "The explorer cannot read the chain right now." }, 502) }));
    renderApp("/tokens");
    expect(await screen.findByText("The explorer cannot read the chain right now.")).toBeInTheDocument();
  });

  it("shows a token's name as text, never as markup", async () => {
    await open(() => list([tokenItem(0xb1, { name: "<img src=x onerror=alert(1)>" })]));
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});
