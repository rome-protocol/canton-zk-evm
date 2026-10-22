// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, route, T0, status, reply } from "../test-utils.tsx";

describe("the header", () => {
  it("links only the pages that exist, in the order of the approved screens, and marks the one that is open; the API link opens the API's description", async () => {
    fakeApi(route({}));
    renderApp("/faucet");
    const nav = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(nav.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Home", "/"], ["Blocks", "/blocks"], ["Canton", "/canton"], ["Faucet", "/faucet"], ["API", "/api/openapi.json"],
    ]);
    expect(nav.getByRole("link", { name: "Faucet" })).toHaveClass("active");
    expect(nav.getByRole("link", { name: "Home" })).not.toHaveClass("active");
  });

  it("draws no link to a page that has no route, so that no header link leads to Not found", async () => {
    fakeApi(route({}));
    renderApp("/");
    const nav = within(screen.getByRole("navigation", { name: "Pages" }));
    for (const gone of ["Transactions", "Contracts", "Tokens", "Stats"]) expect(nav.queryByRole("link", { name: gone })).toBeNull();
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

  it("names a failed check in the bar", async () => {
    fakeApi(route({ status: () => reply(status({ ok: false, problems: ["block 3: a hash differs"] }), 503) }));
    renderApp("/blocks");
    expect(await within(await screen.findByRole("region", { name: "Chain at a glance" })).findByText("A check failed")).toBeInTheDocument();
  });
});
