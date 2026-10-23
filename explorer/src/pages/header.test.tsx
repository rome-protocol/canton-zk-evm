// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { blockItem, fakeApi, page, renderApp, route, T0, status, reply } from "../test-utils.tsx";

describe("the header", () => {
  it("links only the pages that exist, in the order of the approved screens, and marks the one that is open; the API link opens the API page", async () => {
    fakeApi(route({}));
    renderApp("/faucet");
    const nav = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(nav.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Home", "/"], ["Blocks", "/blocks"], ["Transactions", "/txs"], ["Contracts", "/contracts"], ["Canton", "/canton"], ["Stats", "/stats"], ["Faucet", "/faucet"], ["API", "/docs/api"],
    ]);
    expect(nav.getByRole("link", { name: "Faucet" })).toHaveClass("active");
    expect(nav.getByRole("link", { name: "Home" })).not.toHaveClass("active");
  });

  it("draws no link to a page that has no route, so that no header link leads to Not found", async () => {
    fakeApi(route({}));
    renderApp("/");
    const nav = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(nav.getByRole("link", { name: "Tokens" })).toHaveAttribute("href", "/tokens");
  });

  it("has the search box in the header on every page but the home page, where the big one is", async () => {
    fakeApi(route({}));
    renderApp("/blocks");
    expect(within(screen.getByRole("banner")).getByRole("searchbox", { name: "Search" })).toBeInTheDocument();
  });

  it("has one search box on the home page, in the page itself, with a button", async () => {
    fakeApi(route({}));
    renderApp("/");
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(within(screen.getByRole("banner")).queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });

  it("shows the home page's search box and offers the newest block, transaction and update to try", async () => {
    fakeApi(route({}));
    renderApp("/");
    const tries = within(await screen.findByText("Try").then((e) => e.parentElement!));
    expect(tries.getAllByRole("link").map((l) => l.getAttribute("href"))[0]).toBe("/search?q=3");
    expect(tries.getAllByRole("link")).toHaveLength(4);
  });

  it("says in a bar what the status says: the checks, the final block and the block being proven, and the chain and its coin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((T0 + 30) * 1000);
    fakeApi(route({}));
    renderApp("/blocks");
    const bar = within(await screen.findByRole("region", { name: "Chain at a glance" }));
    expect(bar.getByText("All checks ok")).toBeInTheDocument();
    expect(bar.getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
    expect(bar.getByRole("link", { name: "block 4" })).toHaveAttribute("href", "/block/4");
    expect(bar.getByText("Chain 770101 · coin tROME")).toBeInTheDocument();
  });

  it("names the network in a pill, and says that the coin is a test coin, when the status names a network", async () => {
    fakeApi(route({}));
    renderApp("/blocks");
    expect(await within(screen.getByRole("banner")).findByText("DevNet")).toHaveClass("pill");
    expect(within(screen.getByRole("banner")).queryByText("chain 770101")).toBeNull();
    expect(within(await screen.findByRole("region", { name: "Chain at a glance" })).getByText("tROME is a test coin. It has no value.")).toBeInTheDocument();
  });

  it("names no network, and does not call the coin a test coin, when the status names none", async () => {
    fakeApi(route({ status: () => reply(status({ networkName: null })) }));
    renderApp("/blocks");
    const bar = within(await screen.findByRole("region", { name: "Chain at a glance" }));
    expect(bar.getByText("All checks ok")).toBeInTheDocument();
    expect(bar.queryByText(/test coin/)).toBeNull();
    expect(screen.queryByText("DevNet")).toBeNull();
  });

  it("reads the base fee from the newest final block, to three digits, and says so when it cannot be read", async () => {
    fakeApi(route({ blocks: () => reply(page([blockItem(3, { baseFee: "67300000" })])) }));
    renderApp("/blocks");
    expect(await within(await screen.findByRole("region", { name: "Chain at a glance" })).findByText("Base fee 0.0673 gwei")).toBeInTheDocument();
  });

  it("says the base fee cannot be read when the blocks cannot be, and that none is known for a chain with no block", async () => {
    fakeApi(route({ blocks: () => reply({ error: "no" }, 500) }));
    renderApp("/faucet");
    expect(await within(await screen.findByRole("region", { name: "Chain at a glance" })).findByText("Base fee cannot be read right now")).toBeInTheDocument();
  });

  it("names a failed check in the bar", async () => {
    fakeApi(route({ status: () => reply(status({ ok: false, problems: ["block 3: a hash differs"] }), 503) }));
    renderApp("/blocks");
    expect(await within(await screen.findByRole("region", { name: "Chain at a glance" })).findByText("A check failed")).toBeInTheDocument();
  });
});
