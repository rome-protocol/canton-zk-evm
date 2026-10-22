// @vitest-environment jsdom
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, inFlight, renderApp, reply, route } from "../test-utils.tsx";

const NOT_READ = "The explorer cannot read what is in flight right now.";
const FINAL_LINE = "Nothing is in flight: every block made so far is final.";
const card = () => within(screen.getByRole("region", { name: "Numbers" })).getByText("Not final yet").parentElement!;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("the home page when it cannot tell what is in flight", () => {
  it("does not say every block is final when the in-flight route fails, and leaves the card at a dash", async () => {
    fakeApi(route({ inFlight: () => reply({ error: "down" }, 503) }));
    renderApp("/");
    expect(await screen.findByText(NOT_READ)).toBeInTheDocument();
    expect(screen.queryByText(FINAL_LINE)).toBeNull();
    expect(card()).toHaveTextContent("—");
    expect(card()).toHaveTextContent("cannot be read right now");
    expect(card()).not.toHaveTextContent("0 ·");
    // The status on the same page still says a block is being proven.
    expect(screen.getAllByText(/block 4 is being proven/).length).toBeGreaterThan(0);
  });

  it("says Reading while the in-flight route has not answered, and nothing about final", async () => {
    fakeApi(route({}));
    const answered = fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = answered.getMockImplementation()! as (input: string) => Promise<Response>;
    answered.mockImplementation((input: string) => (input.startsWith("/api/in-flight") ? new Promise(() => {}) : inner(input)));
    renderApp("/");
    await screen.findByText("Latest final blocks");
    await settle();
    expect(within(screen.getByRole("region", { name: "In flight" })).getByText("Reading…")).toBeInTheDocument();
    expect(screen.queryByText(FINAL_LINE)).toBeNull();
    expect(card()).toHaveTextContent("—");
    expect(card()).toHaveTextContent("Reading…");
  });

  it("says the pool count is not known when the route has no pool sample, and shows no waiting count", async () => {
    fakeApi(route({ inFlight: () => reply(inFlight({ poolWaiting: null })) }));
    renderApp("/");
    await screen.findByText("The pool count is not known right now.");
    expect(card()).toHaveTextContent("3");
    expect(card()).toHaveTextContent("pool count not known");
    expect(card()).not.toHaveTextContent("0 waiting");
    expect(screen.getByText("The pool count is not known right now.")).toBeInTheDocument();
  });

  it("says every block is final only when the route answered with no attempts", async () => {
    fakeApi(route({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: { waiting: 0, at: "2026-10-04T01:37:25.000Z" } })) }));
    renderApp("/");
    expect(await screen.findByText(FINAL_LINE)).toBeInTheDocument();
    expect(card()).toHaveTextContent("0 in blocks being made or proven · 0 waiting");
  });
});
