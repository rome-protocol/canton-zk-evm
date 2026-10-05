// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, renderApp, status } from "../test-utils.tsx";

vi.mock("./Faucet.tsx", () => ({ Faucet: () => { throw new Error("this page cannot be drawn"); } }));

describe("a page that fails while drawing", () => {
  it("says so, and the next page the visitor goes to is drawn as usual", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/faucet");
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("banner")).getByRole("link", { name: /Ostia/ }));
    expect(await screen.findByText("Final on Canton")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Something went wrong" })).toBeNull();
  });
});
