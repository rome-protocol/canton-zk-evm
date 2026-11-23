// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeApi, route, status } from "../test-utils.tsx";
import { BridgeApp } from "./BridgeApp.tsx";

const mocks = vi.hoisted(() => ({ throws: false }));
// The page itself is the explorer's and has its own tests; here it is a stand-in that shows where the app put it.
vi.mock("../pages/Bridge.tsx", () => ({
  Bridge: () => {
    const { pathname, search } = useLocation();
    if (mocks.throws) throw new Error("the page cannot be drawn");
    return <div><p>the Bridge page at {pathname}{search}</p><div className="ptitle"><h1>Bridge</h1><span className="psub">Move tokens</span></div></div>;
  },
}));

const SITE = "https://ostia.testnet.romeprotocol.xyz";
beforeEach(() => {
  vi.stubEnv("VITE_SITE_ORIGIN", SITE);
  document.documentElement.setAttribute("data-app", "bridge");
  mocks.throws = false;
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); document.documentElement.removeAttribute("data-app"); });

function show(at: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[at]}><BridgeApp /></MemoryRouter></QueryClientProvider>);
}

describe("the Bridge as its own site", () => {
  it("has its own header: Ostia Bridge as the one h1, the network from the status, and an Explorer link that opens the explorer in a new tab", async () => {
    fakeApi(route({ status: () => ({ status: 200, body: status({ networkName: "TestNet" }) }) }));
    show("/");
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1, name: "Ostia Bridge" })).toBeInTheDocument();
    expect(await within(header).findByText("TestNet")).toBeInTheDocument();
    const explorer = within(header).getByRole("link", { name: "Explorer" });
    expect(explorer).toHaveAttribute("href", `${SITE}/`);
    expect(explorer).toHaveAttribute("target", "_blank");
    expect(explorer).toHaveAttribute("rel", "noopener");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(2); // the page's own "Bridge" is there, and hidden by app.css
  });

  it("shows the page at /, with the query it was opened with", () => {
    fakeApi(route({}));
    show("/?tab=other-chains");
    expect(screen.getByText("the Bridge page at /?tab=other-chains")).toBeInTheDocument();
  });

  it("replaces any other path by / and keeps the query", () => {
    fakeApi(route({}));
    show("/blocks?tab=other-chains");
    expect(screen.getByText("the Bridge page at /?tab=other-chains")).toBeInTheDocument();
  });

  it("serves its own file's address too, for a local run", () => {
    fakeApi(route({}));
    show("/bridge.html?tab=other-chains");
    expect(screen.getByText("the Bridge page at /bridge.html?tab=other-chains")).toBeInTheDocument();
  });

  it("has none of the explorer's frame: no menu, no search box, no status bar, no explorer footer", () => {
    fakeApi(route({}));
    show("/");
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Chain at a glance" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Footer" })).toBeNull();
  });

  it("ends with Docs and Source links that open in a new tab", () => {
    fakeApi(route({}));
    show("/");
    const foot = within(screen.getByRole("contentinfo"));
    expect(foot.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("target")])).toEqual([["Docs", "_blank"], ["Source code", "_blank"]]);
  });

  it("shows a planned-work notice above the header", async () => {
    // Times follow the clock, so the notice is still planned whatever day the test runs on.
    const hour = 60 * 60 * 1000;
    const notice = { level: "major", text: "Work is planned.", startsAt: new Date(Date.now() + hour).toISOString(), endsAt: new Date(Date.now() + 2 * hour).toISOString() };
    fakeApi(route({ status: () => ({ status: 200, body: status({ notices: [notice] as never }) }) }));
    show("/");
    const text = await screen.findByText(/Work is planned\./);
    const header = screen.getByRole("banner");
    expect(text.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the header when the page fails, and does not send the visitor to a search box that is not here", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.throws = true;
    fakeApi(route({}));
    show("/");
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText("This page could not be drawn. Reload it.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Ostia Bridge" })).toBeInTheDocument();
  });
});
