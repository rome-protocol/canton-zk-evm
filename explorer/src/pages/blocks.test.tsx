// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { blockItem, fakeApi, page, renderApp, reply, route, status, update } from "../test-utils.tsx";

const NOW = Date.parse("2026-10-04T01:38:00Z");
async function open(h: Parameters<typeof route>[0] = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const calls = fakeApi(route(h));
  renderApp("/blocks");
  await screen.findByRole("heading", { name: "Blocks" });
  await screen.findByRole("table");
  return calls;
}
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("the blocks page", () => {
  it("lists the final blocks newest first, with the block being proven above them", async () => {
    await open();
    const r = rows();
    expect(r).toHaveLength(3);
    expect(within(r[0]!).getByRole("link", { name: "4" })).toHaveAttribute("href", "/block/4");
    expect(r[0]).toHaveTextContent("Being proven");
    expect(r[0]).toHaveTextContent("not on Canton yet");
    expect(within(r[1]!).getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
    expect(r[1]).toHaveTextContent("Final");
    expect(r[2]).toHaveTextContent("2");
  });

  it("shows transactions, gas with its share of the limit, legs, time to final and the update, which opens its Canton page", async () => {
    await open({ blocks: () => reply(page([blockItem(3, { txCount: 5, gasUsed: 3_000_000, gasLimit: 30_000_000, legsCount: 2 })])) });
    const r = rows()[1]!;
    expect(r).toHaveTextContent("5");
    expect(r).toHaveTextContent("3,000,000 10.0%");
    expect(r).toHaveTextContent("2");
    expect(r).toHaveTextContent("7.4 s");
    expect(within(r).getByRole("link", { name: "1220 0303…0303" })).toHaveAttribute("href", `/canton/${update(3)}`);
  });

  it("says block 0 is the genesis, with no record", async () => {
    await open({ blocks: () => reply(page([blockItem(0, { updateId: "", recordTime: "", timestamp: 0 })])) });
    const r = rows()[1]!;
    expect(r).toHaveTextContent("genesis");
    expect(r).toHaveTextContent("no record");
    expect(r).toHaveTextContent("Genesis");
  });

  it("walks the pages by the server's cursor: forward, back and to the first", async () => {
    const user = userEvent.setup();
    const calls = await open({ status: () => reply(status({ proving: null })), blocks: (path) => reply(path.includes("before=c1") ? page([blockItem(1)]) : page([blockItem(3), blockItem(2)], "c1")) });
    expect(rows()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(calls.some((c) => c.includes("/api/blocks?limit=25&before=c1"))).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Older page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "First" }));
    await screen.findByText("Page 1");
    expect(rows()).toHaveLength(2);
  });

  it("shows no block being proven on a later page", async () => {
    const user = userEvent.setup();
    await open({ blocks: (path) => reply(path.includes("before=c1") ? page([blockItem(1)]) : page([blockItem(3)], "c1")) });
    expect(rows()[0]).toHaveTextContent("Being proven");
    await user.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(screen.queryByText("Being proven", { selector: ".chip" })).toBeNull();
  });

  it("says so when the chain cannot be read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fakeApi(route({ blocks: () => reply({ error: "The explorer cannot read the chain right now." }, 503) }));
    renderApp("/blocks");
    expect(await screen.findByText("The explorer cannot read the chain right now.")).toBeInTheDocument();
  });
});
