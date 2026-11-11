// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addr, fakeApi, renderApp, route, status } from "../test-utils.tsx";

const FOOTER = "Every number on this site is read from the chain, from Canton or from the chain's own producer log; nothing is loaded from another host.";
const NOT_FOUND = "Not found. Search takes a block number, a block or transaction hash, an address, or a Canton update id. A block that Canton refused is gone, and cannot be found.";

describe("the shell", () => {
  it("names the chain with Rome's mark, shows the network, links home, and offers search and the Faucet", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("img", { name: "Rome" })).toBeInTheDocument();
    const home = within(header).getByRole("link", { name: /Ostia/ });
    expect(home).toHaveAttribute("href", "/");
    expect(await within(header).findByText("DevNet")).toBeInTheDocument();
    expect(within(home).getByText("DevNet")).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "Faucet" })).toHaveAttribute("href", "/faucet");
    expect(within(header).getByRole("searchbox", { name: "Search" })).toHaveAttribute("placeholder", "Block, transaction, address or Canton update id");
    expect(within(header).getByText("/", { selector: "kbd" })).toBeInTheDocument();
  });

  it("gives the home page's big search box a shorter hint at phone width", async () => {
    const wide = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === "(max-width: 720px)", media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      fakeApi(() => ({ status: 200, body: status() }));
      renderApp("/");
      expect(screen.getByRole("searchbox", { name: "Search" })).toHaveAttribute("placeholder", "Block, transaction, address or Canton update");
    } finally { window.matchMedia = wide; }
  });

  it("focuses the search box on the / key, unless the key is typed into a field", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const box = screen.getByRole("searchbox", { name: "Search" });
    expect(box).not.toHaveFocus();
    await userEvent.keyboard("/");
    expect(box).toHaveFocus();
    expect(box).toHaveValue("");
    await userEvent.keyboard("0/1");
    expect(box).toHaveValue("0/1");
  });

  it("keeps / for other fields and for key combinations", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    await userEvent.keyboard("/");
    expect(other).toHaveFocus();
    expect(other).toHaveValue("/");
    other.remove();
    await userEvent.keyboard("{Control>}/{/Control}");
    expect(screen.getByRole("searchbox", { name: "Search" })).not.toHaveFocus();
  });

  it("keeps the parent page lit on a detail page, and lights nothing where no page of the header owns the route", async () => {
    const lit = (route: string) => {
      fakeApi((p) => (p.startsWith("/api/status") ? { status: 200, body: status() } : { status: 404, body: { error: "not found" } }));
      const { unmount } = renderApp(route);
      const on = within(screen.getByRole("navigation", { name: "Pages" })).queryAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent);
      unmount();
      return on;
    };
    const A = "0x" + "ab".repeat(20);
    expect(lit("/")).toEqual(["Home"]);
    expect(lit("/blocks")).toEqual(["Blocks"]);
    expect(lit("/block/1")).toEqual(["Blocks"]);
    expect(lit("/txs")).toEqual(["Transactions"]);
    expect(lit("/tx/0x" + "cd".repeat(32))).toEqual(["Transactions"]);
    expect(lit("/contract/" + A)).toEqual(["Contracts"]);
    expect(lit("/token/" + A)).toEqual(["Tokens"]);
    expect(lit("/canton")).toEqual(["External calls"]);
    expect(lit("/canton/1220ab")).toEqual(["External calls"]);
    expect(lit("/docs/api")).toEqual(["API"]);
    expect(lit("/address/" + A)).toEqual([]);
    expect(lit("/leg/abc")).toEqual([]);
    expect(lit("/blocks-nowhere")).toEqual([]);
  });

  it("uses the name the server gives, and Ostia until it has answered", async () => {
    fakeApi(() => ({ status: 200, body: status({ chainName: "Another" }) }));
    renderApp("/faucet");
    expect(within(screen.getByRole("banner")).getByRole("link", { name: /Ostia/ })).toBeInTheDocument();
    expect(await within(screen.getByRole("banner")).findByRole("link", { name: /Another/ })).toBeInTheDocument();
  });

  it("names the tab after the page and the site", async () => {
    const { unmount } = renderApp("/bridge");
    await waitFor(() => expect(document.title).toMatch(/^Bridge · Ostia/));
    unmount();
  });

  it("ends every page with the numbers line and the seven links: About, API, Health, the wallet, the docs, help and the source", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    for (const route of ["/", "/faucet", "/nowhere"]) {
      const { unmount } = renderApp(route);
      const foot = within(screen.getByRole("contentinfo"));
      expect(foot.getByText(FOOTER)).toBeInTheDocument();
      expect(foot.getByRole("link", { name: "API" })).toHaveAttribute("href", "/docs/api");
      expect(foot.getByRole("link", { name: "Health" })).toHaveAttribute("href", "/api/health");
      expect(foot.getByRole("link", { name: "Source code" })).toHaveAttribute("href", "https://github.com/rome-protocol/canton-zk-evm");
      expect(await foot.findByRole("link", { name: "Add Ostia to your wallet" })).toHaveAttribute("href", "/docs/api#rpc-h");
      expect(foot.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://docs.rome.builders/canton-zk-evm/");
      expect(foot.getByRole("link", { name: "Get help" })).toHaveAttribute("href", "https://github.com/rome-protocol/canton-zk-evm/issues");
      expect(foot.getAllByRole("link").map((a) => a.textContent)).toEqual(["About", "API", "Health", "Add Ostia to your wallet", "Docs", "Get help", "Source code"]);
      unmount();
    }
  });

  it("scrolls to the wallet card when the page is opened at #rpc-h, and again when a section above it has been drawn later", async () => {
    const scrolled: Array<string | null> = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      fakeApi(route({}));
      renderApp("/docs/api#rpc-h");
      await screen.findByRole("heading", { name: /to your wallet/ });
      await waitFor(() => expect(scrolled).toContain("rpc-h"));
      const before = scrolled.length;
      // a section drawn above the card, after the first scroll, moves the card: the page scrolls to it again
      const late = document.createElement("section");
      document.querySelector("main")!.prepend(late);
      await waitFor(() => expect(scrolled.length).toBeGreaterThan(before));
    } finally { Element.prototype.scrollIntoView = original; }
  });

  it("leaves the wallet link out when the explorer serves no public RPC, because the page would have no card to show", async () => {
    fakeApi(() => ({ status: 200, body: status({ publicRpc: false }) }));
    renderApp("/faucet");
    await within(screen.getByRole("banner")).findByText("DevNet");
    expect(within(screen.getByRole("contentinfo")).queryByRole("link", { name: /wallet/ })).toBeNull();
  });

  it("has a menu button for phones that shows and hides the pages, and closes when a page is chosen", async () => {
    const user = userEvent.setup();
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const menu = within(screen.getByRole("banner")).getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(nav).not.toHaveClass("open");
    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(nav).toHaveClass("open");
    await user.click(within(nav).getByRole("link", { name: "Blocks" }));
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(nav).not.toHaveClass("open");
  });

  it("lets Escape leave the search box, which is what closes it to its compact width", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const box = screen.getByRole("searchbox", { name: "Search" });
    expect(box.closest(".search-slot")).not.toBeNull();
    await userEvent.keyboard("/");
    expect(box).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(box).not.toHaveFocus();
  });

  it("sends what was typed to the search page, which opens what the server finds", async () => {
    const user = userEvent.setup();
    const calls = fakeApi((p) => (p === "/api/search?q=3" ? { status: 200, body: { path: "/faucet" } } : p === "/api/faucet" ? { status: 500, body: { error: "The faucet cannot be read right now." } } : { status: 200, body: status() }));
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
    expect(await screen.findByRole("region", { name: "Chain status" })).toBeInTheDocument();
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

describe("the header's links, folded into the menu when the row cannot hold them", () => {
  // jsdom lays nothing out: the widths the header measures (the header's room, the name, each link, the search slot) are set here, and the header's size change is signalled by hand.
  const WIDTHS = { header: 1280, brand: 160, link: 80, slot: 210 };   // ten links of 80 px and the name and search box: 1170 px with the gaps counted as nil
  let observed: (() => void)[] = [];
  const widths = { ...WIDTHS };
  const resize = async (header: number) => { widths.header = header; await act(async () => { observed.forEach((f) => f()); }); };
  const saved = { offset: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"), client: Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth") };
  beforeEach(() => {
    observed = [];
    Object.assign(widths, WIDTHS);
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observed.push(cb); } observe() {} disconnect() {} unobserve() {} });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get(this: HTMLElement) {
      return this.classList.contains("navlink") ? widths.link : this.classList.contains("brand") ? widths.brand : this.classList.contains("search-slot") ? widths.slot : 0;
    } });
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get(this: Element) { return this.tagName === "HEADER" ? widths.header : 0; } });
  });
  afterEach(() => {
    if (saved.offset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", saved.offset);
    if (saved.client) Object.defineProperty(Element.prototype, "clientWidth", saved.client);
    vi.unstubAllGlobals();
  });

  it("keeps the links in the row while the name, the links and the search box fit, and folds them into the menu when they do not, and back", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const header = screen.getByRole("banner");
    expect(header).not.toHaveClass("folded");
    await resize(1100);
    expect(header).toHaveClass("folded");
    // exactly as wide as the parts need: the row holds them (the check leaves a pixel of slack, so a rounding never wraps the last link)
    await resize(1170);
    expect(header).toHaveClass("folded");
    await resize(1171);
    expect(header).not.toHaveClass("folded");
  });

  it("measures again when a link is added (a wider need folds the row at a width that held it before)", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    const header = screen.getByRole("banner");
    await resize(1300);
    expect(header).not.toHaveClass("folded");
    widths.link = 100;   // the links are wider now (a longer label, or a font that has just loaded)
    await resize(1300);
    expect(header).toHaveClass("folded");
  });

  it("needs no search box on the home page, whose big box sits in the page: the links fold later there", async () => {
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/");
    const header = screen.getByRole("banner");
    await resize(960);   // 160 + 800 = 960, and a pixel of slack
    expect(header).toHaveClass("folded");
    await resize(961);
    expect(header).not.toHaveClass("folded");
  });

  it("opens and closes the folded links with the menu button, and closes the menu when the row has room for the links again", async () => {
    const user = userEvent.setup();
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    await resize(900);
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const menu = within(screen.getByRole("banner")).getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveAttribute("aria-controls", "pages");
    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(nav).toHaveClass("open");
    await resize(1400);
    expect(screen.getByRole("banner")).not.toHaveClass("folded");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(nav).not.toHaveClass("open");
  });
});

describe("the Faucet route", () => {
  const FAUCET = addr(0xfa);
  const faucetApi = (info: Record<string, unknown>) => fakeApi((path) =>
    path === "/api/faucet" ? { status: 200, body: { amount: "1000000000000000000", perAddressSeconds: 86400, ...info } } : { status: 200, body: status() });

  it("shows the faucet page: the form, with the coin from the status, and the faucet's address and balance from /api/faucet", async () => {
    const calls = faucetApi({ on: true, address: FAUCET, balance: "999997000000000000000000" });
    renderApp("/faucet");
    expect(await screen.findByText("tROME is this chain's test coin. It has no value.")).toBeInTheDocument();
    expect(document.querySelector(".lead")).toHaveTextContent("The faucet sends 1 tROME to an address, once a day.");
    expect(screen.getByRole("button", { name: "Request 1 tROME" })).toBeEnabled();
    const line = screen.getByRole("link", { name: /^0xfafa/ }).closest("div")!;
    expect(line).toHaveTextContent("Address");
    expect(screen.getByRole("heading", { name: "The faucet" }).closest("section")).toHaveTextContent("Balance999,997 tROME");
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
