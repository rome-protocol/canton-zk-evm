// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { addr, block, fakeApi, reply, renderApp, route } from "../test-utils.tsx";

const match = (kind: "token" | "contract", name: string, symbol: string | null, n: number) => ({ kind, name, symbol, address: addr(n), warning: null as string | null, path: kind === "token" ? `/token/${addr(n)}` : `/address/${addr(n)}` });

describe("the search page", () => {
  it("opens the page when one thing was found, even for a name with a single match", async () => {
    const m = { ...match("contract", "Block Three", null, 0xcb), path: "/block/3" };
    fakeApi(route({ search: () => reply({ path: m.path, matches: [m] }), block: () => reply(block()) }));
    renderApp("/search?q=block");
    expect(await screen.findByRole("heading", { name: "Block #3" })).toBeInTheDocument();
  });

  it("lists the matches when a name matched more than one, tokens first, each with its kind and a link", async () => {
    const a = match("token", "Test USD", "tUSD", 0xcb), b = match("contract", "Test Router", null, 0xcc);
    fakeApi(route({ search: () => reply({ path: a.path, matches: [a, b] }) }));
    renderApp("/search?q=test");
    const list = within(await screen.findByRole("list"));
    const items = list.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole("link", { name: "Test USD (tUSD)" })).toHaveAttribute("href", a.path);
    expect(items[0]).toHaveTextContent("Token");
    expect(within(items[1]!).getByRole("link", { name: "Test Router" })).toHaveAttribute("href", b.path);
    expect(items[1]).toHaveTextContent("Contract");
  });

  it("shows the warning beside a match that has one, and keeps the order the server gave", async () => {
    const a = match("token", "Wrapped ROME", "WtROME", 0xcb), b = { ...match("token", "Wrapped ROME", "WtROME", 0xcc), warning: "Not Rome's WtROME twin" };
    fakeApi(route({ search: () => reply({ path: a.path, matches: [a, b] }) }));
    renderApp("/search?q=wtrome");
    const items = within(await screen.findByRole("list")).getAllByRole("listitem");
    expect(items[0]!.querySelector(".chip-warn")).toBeNull();
    expect(within(items[1]!).getByRole("note")).toHaveTextContent("Not Rome's WtROME twin");
    expect(within(items[1]!).getByRole("link")).toHaveAttribute("href", b.path);
  });

  it("is reached from the search box on the home page, which keeps what was typed", async () => {
    const a = match("token", "Test USD", "tUSD", 0xcb), b = match("token", "Test USD Two", "tUSD2", 0xcc);
    fakeApi(route({ search: () => reply({ path: a.path, matches: [a, b] }) }));
    renderApp("/");
    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Search" }), "test usd{Enter}");
    expect(await screen.findByRole("heading", { name: "Several match" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("test usd");
  });
});
