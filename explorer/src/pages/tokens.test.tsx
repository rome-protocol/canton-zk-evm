// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { addr, fakeApi, page, renderApp, reply, route, tokenItem } from "../test-utils.tsx";

const LIST = [tokenItem(0xb1), tokenItem(0xb2, { standard: "ERC-721", name: "Ostia Pass", symbol: "OPASS", decimals: null, totalSupply: "2", holderCount: 2, transferCount: 2 })];
async function open(answer: (path: string) => ReturnType<typeof reply> = () => reply({ ...page(LIST), derived: true })) {
  const calls = fakeApi(route({ tokenPages: (_a, _s, path) => answer(path) }));
  renderApp("/tokens");
  await screen.findByRole("heading", { name: "Tokens" });
  await screen.findByRole("table");
  return calls;
}
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("the tokens page", () => {
  it("lists the tokens by holders first, each linking to its own page", async () => {
    const calls = await open();
    expect(calls).toContain("/api/tokens?sort=holders&limit=25");
    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]!).getByRole("link", { name: "Test USD" })).toHaveAttribute("href", `/token/${addr(0xb1)}`);
    expect(rows()[0]).toHaveTextContent("tUSD");
    expect(rows()[0]).toHaveTextContent("0xb1b1…b1b1");
    expect(rows()[0]).toHaveTextContent("ERC-20");
    expect(rows()[1]).toHaveTextContent("ERC-721");
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
    await open(() => reply({ ...page([tokenItem(0xb1, { totalSupply: null }), tokenItem(0xb2, { decimals: null, totalSupply: "12345", name: null, symbol: null, metadataStatus: "failed" })]), derived: true }));
    expect(rows()[0]!.querySelectorAll("td")[3]).toHaveTextContent("—");
    expect(rows()[1]!.querySelectorAll("td")[3]).toHaveTextContent("12,345");
    expect(within(rows()[1]!).getByText("Name not read")).toBeInTheDocument();
    expect(within(rows()[1]!).getByRole("link", { name: "0xb2b2…b2b2" })).toHaveAttribute("href", `/token/${addr(0xb2)}`);
  });

  it("shows the holders, the transfers and the block of the first transfer", async () => {
    await open();
    expect(rows()[0]).toHaveTextContent("5");
    expect(rows()[0]).toHaveTextContent("6");
    expect(within(rows()[0]!).getByRole("link", { name: "Block 19" })).toHaveAttribute("href", "/block/19");
  });

  it("marks a token the gateway wrapped from Canton", async () => {
    await open(() => reply({ ...page([tokenItem(0xb1, { gatewayWrapped: true }), tokenItem(0xb2)]), derived: true }));
    expect(within(rows()[0]!).getByText("From Canton")).toBeInTheDocument();
    expect(within(rows()[1]!).queryByText("From Canton")).toBeNull();
  });

  it("sorts by transfers or by newest, from the first page", async () => {
    const calls = await open();
    await userEvent.click(screen.getByRole("button", { name: "Transfers" }));
    await screen.findByRole("table");
    expect(calls).toContain("/api/tokens?sort=transfers&limit=25");
    await userEvent.click(screen.getByRole("button", { name: "Newest" }));
    await screen.findByRole("table");
    expect(calls).toContain("/api/tokens?sort=newest&limit=25");
    expect(screen.getByRole("button", { name: "Newest" })).toHaveAttribute("aria-pressed", "true");
  });

  it("pages by the cursor the server gave", async () => {
    const calls = await open((path) => reply({ ...page([tokenItem(0xb1)], path.includes("before=") ? null : "5|0xb1"), derived: true }));
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(calls.some((c) => c.includes("before=5%7C0xb1"))).toBe(true);
  });

  it("says nothing is listed yet, and that the list may be short while the explorer reads blocks", async () => {
    fakeApi(route({ tokenPages: () => reply({ ...page([]), derived: false }) }));
    renderApp("/tokens");
    expect(await screen.findByText("The explorer has not read this far yet.")).toBeInTheDocument();
  });

  it("says what could not be read, in the server's words", async () => {
    fakeApi(route({ tokenPages: () => reply({ error: "The explorer cannot read the chain right now." }, 502) }));
    renderApp("/tokens");
    expect(await screen.findByText("The explorer cannot read the chain right now.")).toBeInTheDocument();
  });

  it("shows a token's name as text, never as markup", async () => {
    await open(() => reply({ ...page([tokenItem(0xb1, { name: "<img src=x onerror=alert(1)>" })]), derived: true }));
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});
