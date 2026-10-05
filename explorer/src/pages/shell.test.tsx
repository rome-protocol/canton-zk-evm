// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { addr, fakeApi, renderApp, status } from "../test-utils.tsx";

const FOOTER = "This explorer reads Canton as the chain's reader party, which is shown the record of every block and nothing else on Canton.";
const NOT_FOUND = "Not found. Search takes a block number, a block or transaction hash, an address, or a Canton update id. A block that Canton refused is gone, and cannot be found.";

describe("the shell", () => {
  it("names the chain with Rome's mark, shows the chain id, links home, and offers search and the Faucet", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("img", { name: "Rome" })).toBeInTheDocument();
    const home = within(header).getByRole("link", { name: /Ostia/ });
    expect(home).toHaveAttribute("href", "/");
    expect(await within(header).findByText("chain 770101")).toBeInTheDocument();
    expect(within(home).getByText("chain 770101")).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "Faucet" })).toHaveAttribute("href", "/faucet");
    expect(within(header).getByRole("searchbox", { name: "Search" })).toHaveAttribute("placeholder", "Block number, transaction or block hash, address, or Canton update id");
  });

  it("gives the search box a shorter hint at phone width", async () => {
    const wide = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === "(max-width: 720px)", media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      fakeApi(() => ({ status: 200, body: status() }));
      renderApp("/faucet");
      expect(screen.getByRole("searchbox", { name: "Search" })).toHaveAttribute("placeholder", "Block, transaction, address or Canton update");
    } finally { window.matchMedia = wide; }
  });

  it("uses the name the server gives, and Ostia until it has answered", async () => {
    fakeApi(() => ({ status: 200, body: status({ chainName: "Another" }) }));
    renderApp("/faucet");
    expect(within(screen.getByRole("banner")).getByRole("link", { name: /Ostia/ })).toBeInTheDocument();
    expect(await within(screen.getByRole("banner")).findByRole("link", { name: /Another/ })).toBeInTheDocument();
  });

  it("ends every page with the reader-party line", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    for (const route of ["/", "/faucet", "/nowhere"]) {
      const { unmount } = renderApp(route);
      expect(within(screen.getByRole("contentinfo")).getByText(FOOTER)).toBeInTheDocument();
      unmount();
    }
  });

  it("sends what was typed to the search page, which opens what the server finds", async () => {
    const user = userEvent.setup();
    const calls = fakeApi((p) => (p === "/api/search?q=3" ? { status: 200, body: { path: "/faucet" } } : { status: 200, body: status() }));
    renderApp("/");
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "  3 {Enter}");
    expect(await screen.findByRole("heading", { name: "Faucet" })).toBeInTheDocument();
    expect(calls).toContain("/api/search?q=3");
  });

  it("says Not found, with the server's own message and what was searched, and keeps the query in the box", async () => {
    const user = userEvent.setup();
    const long = "0x" + "44".repeat(32);
    fakeApi((p) => (p.startsWith("/api/search") ? { status: 404, body: { error: NOT_FOUND } } : { status: 200, body: status() }));
    renderApp("/");
    await user.type(screen.getByRole("searchbox", { name: "Search" }), `${long}{Enter}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText(NOT_FOUND.replace("Not found. ", ""))).toBeInTheDocument();
    expect(screen.getByText(/You searched for/)).toHaveTextContent("You searched for 0x44444444…44444444.");
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue(long);
  });

  it("does not search for nothing", async () => {
    const user = userEvent.setup();
    const calls = fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/");
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "   {Enter}");
    expect(calls.filter((c) => c.startsWith("/api/search"))).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Not found" })).toBeNull();
    expect(await screen.findByText("Final on Canton")).toBeInTheDocument();
  });

  it("says so when the search itself cannot read the chain", async () => {
    const user = userEvent.setup();
    fakeApi((p) => (p.startsWith("/api/search") ? { status: 502, body: { error: "The explorer cannot read the chain right now." } } : { status: 200, body: status() }));
    renderApp("/");
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "7{Enter}");
    expect(await screen.findByRole("heading", { name: "Cannot read the chain" })).toBeInTheDocument();
  });

  it("gives a page that does not exist its own plain answer", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/nowhere");
    expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("There is no page at this address.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/"));
  });
});

describe("the Faucet route", () => {
  const FAUCET = addr(0xfa);
  const faucetApi = (info: Record<string, unknown>) => fakeApi((path) =>
    path === "/api/faucet" ? { status: 200, body: { amount: "1000000000000000000", perAddressSeconds: 86400, ...info } } : { status: 200, body: status() });

  it("shows the faucet page: the form, with the coin from the status, and the faucet's address and balance from /api/faucet", async () => {
    const calls = faucetApi({ on: true, address: FAUCET, balance: "999997000000000000000000" });
    renderApp("/faucet");
    expect(await screen.findByText("tROME is this chain's test coin. It has no value. The faucet sends 1 tROME to an address, once a day.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request 1 tROME" })).toBeEnabled();
    const line = screen.getByRole("link", { name: /^0xfafa/ }).closest("li")!;
    expect(line).toHaveTextContent("holds 999,997 tROME.");
    expect(screen.getByRole("link", { name: /^0xfafa/ })).toHaveAttribute("href", `/address/${FAUCET}`);
    expect(calls).toContain("/api/faucet");
    expect(screen.getAllByRole("heading", { name: "Faucet" })).toHaveLength(1);
  });

  it("says the faucet is off, and shows no form, when the explorer has no key", async () => {
    faucetApi({ on: false, address: null, balance: null });
    renderApp("/faucet");
    expect(await screen.findByText("The faucet is off.")).toBeInTheDocument();
    expect(screen.getByText("The faucet is off.").closest(".alert")?.querySelector("svg.ic")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says when the faucet cannot be read, in the page's own place", async () => {
    fakeApi((path) => (path === "/api/faucet" ? { status: 500, body: { error: "The faucet cannot be read right now." } } : { status: 200, body: status() }));
    renderApp("/faucet");
    expect(await screen.findByText("The faucet cannot be read right now.")).toBeInTheDocument();
  });

  it("waits for the status, which names the coin, and says so", () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    expect(screen.getByText("Looking up the faucet…")).toBeInTheDocument();
  });
});
