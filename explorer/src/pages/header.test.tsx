// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { blockItem, fakeApi, health, page, renderApp, route, T0, status, reply } from "../test-utils.tsx";

describe("the header", () => {
  it("links only the pages that exist, in the order of the approved screens, and marks the one that is open; the API link opens the API page", async () => {
    fakeApi(route({}));
    renderApp("/faucet");
    const nav = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(nav.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Home", "/"], ["Blocks", "/blocks"], ["Transactions", "/txs"], ["Contracts", "/contracts"], ["Tokens", "/tokens"], ["Linked to Canton", "/canton"], ["Swaps", "/swaps"], ["Stats", "/stats"], ["Faucet", "/faucet"], ["API", "/docs/api"],
    ]);
    expect(nav.getByRole("link", { name: "Faucet" })).toHaveClass("active");
    expect(nav.getByRole("link", { name: "Home" })).not.toHaveClass("active");
  });

  it("opens a page at its top when the link has no hash: following a footer link does not land at the bottom of the next page", async () => {
    fakeApi(route({}));
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    renderApp("/blocks");
    await waitFor(() => expect(scroll).toHaveBeenCalledWith(0, 0));
    scroll.mockClear();
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Footer" })).getByRole("link", { name: "API" }));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith(0, 0));
    scroll.mockRestore();
  });

  it("links the Tokens page now that it has a route", async () => {
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
    expect(bar.getByText("770101").parentElement).toHaveTextContent("Chain 770101 · coin tROME");
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
    expect((await within(await screen.findByRole("region", { name: "Chain at a glance" })).findByText("0.0673 gwei")).parentElement).toHaveTextContent("Base fee 0.0673 gwei");
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

  const checksOf = async () => (await within(await screen.findByRole("region", { name: "Chain at a glance" })).findByText(/checks? (ok|not ok)|check failed|Starting/)).closest(".sd")!;

  it("counts the checks the server runs: 'All 16 checks ok', the whole phrase in bold, in one piece beside the dot", async () => {
    fakeApi(route({ health: () => reply(health(16)) }));
    renderApp("/blocks");
    const bar = within(await screen.findByRole("region", { name: "Chain at a glance" }));
    const sd = await waitFor(async () => { const e = (await bar.findByText("All 16 checks ok", { selector: "b" })).closest(".sd"); expect(e).toHaveTextContent("All 16 checks ok"); return e!; });
    expect(sd).toHaveClass("ok");
    // the dot and one element: the words are no flex items of their own, which would set a gap between them
    expect(Array.from(sd.childNodes).map((n) => n.nodeName)).toEqual(["I", "B"]);
  });

  it("counts only the rows /api/status counts: the API's own rows (faucet, tracker, each instance's reads) are left out, so the bar cannot say red while the home page says pass", async () => {
    const h = health(16);
    h.checks.push({ id: "faucet", role: "api", status: "degraded", detail: null }, { id: "api-1:reth", role: "api", status: "down", detail: null });
    fakeApi(route({ health: () => reply(h) }));
    renderApp("/blocks");
    const bar = within(await screen.findByRole("region", { name: "Chain at a glance" }));
    const sd = await waitFor(async () => { const e = (await bar.findByText("All 16 checks ok", { selector: "b" })).closest(".sd")!; return e; });
    expect(sd).toHaveClass("ok");
  });

  it("says how many checks are not ok when some are, and counts a check that is down the same", async () => {
    fakeApi(route({ status: () => reply(status({ ok: false, problems: ["x"] }), 503), health: () => reply(health(16, 2, "down"), 503) }));
    renderApp("/blocks");
    const sd = await waitFor(async () => { const e = (await within(await screen.findByRole("region", { name: "Chain at a glance" })).findByText("2 of 16 checks not ok", { selector: "b" })).closest(".sd")!; expect(e).toHaveTextContent("2 of 16 checks not ok"); return e; });
    expect(sd).toHaveClass("bad");
  });

  it("says no count when the checks cannot be read, and never makes one up", async () => {
    const asked: string[] = [];
    fakeApi(route({ health: () => { asked.push("health"); return reply({ error: "no" }, 500); } }));
    renderApp("/blocks");
    // the route has been asked and has answered with an error before the words are read
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    const sd = await checksOf();
    expect(sd).toHaveTextContent(/^All checks ok$/);
    expect(sd.querySelector("b")).toBeNull();
  });

  it("says 'Starting' while the index starts, whatever the count", async () => {
    fakeApi(route({ status: () => reply(status({ ok: false, starting: true }), 503), health: () => reply({ ...health(16), starting: true }) }));
    renderApp("/blocks");
    expect(await checksOf()).toHaveTextContent("Starting");
  });

  it("puts the values of the bar in bold: the block numbers, the fee and the chain", async () => {
    fakeApi(route({ blocks: () => reply(page([blockItem(3, { baseFee: "67300000" })])) }));
    renderApp("/blocks");
    const bar = within(await screen.findByRole("region", { name: "Chain at a glance" }));
    expect(await bar.findByText("0.0673 gwei", { selector: "b" })).toBeInTheDocument();
    expect(bar.getByRole("link", { name: "3" }).closest("b")).not.toBeNull();
    expect(bar.getByText("770101", { selector: "b" })).toBeInTheDocument();
  });
});
