// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("./pages/About.tsx"); vi.restoreAllMocks(); });

/** The app imported fresh, with none of its pages fetched yet (the other tests have every page ready before they draw a route), drawn at `route` over an API that has nothing. */
async function fresh(route: string) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Not found." }), { status: 404, headers: { "content-type": "application/json" } })));
  window.scrollTo = () => {};
  const { render, screen, within } = await import("@testing-library/react");
  const { MemoryRouter } = await import("react-router-dom");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { App } = await import("./App.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
  return { screen, within, ...view };
}

describe("a page that is fetched when its route is visited", () => {
  it("shows that it is loading, and then the page", async () => {
    const { screen, unmount } = await fresh("/about");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "What this explorer shows" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    unmount();
  });

  it("says in the page's own place that it could not be drawn when its script cannot be fetched, and the app does not cache the failure: the next visit imports the page again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    vi.doMock("./pages/About.tsx", () => {
      if (broken) throw new Error("the script could not be fetched");
      return { About: () => <h1>About, the second time</h1> };
    });
    const user = userEvent.setup();
    const { screen, within, unmount } = await fresh("/about");
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument(); // the header stays
    broken = false;
    await user.click(within(screen.getByRole("banner")).getAllByRole("link")[0]!); // the name on the left, to the home page
    await user.click(await screen.findByRole("link", { name: "About" }));
    expect(await screen.findByRole("heading", { name: "About, the second time" })).toBeInTheDocument();
    unmount();
  });
});
