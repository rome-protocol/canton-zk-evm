// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { block, blockItem, fakeApi, inFlight, page, renderApp, reply, route, status, update } from "../test-utils.tsx";

const NOW = Date.parse("2026-10-04T01:38:00Z");
async function open(h: Parameters<typeof route>[0] = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const calls = fakeApi(route({ block: () => reply(block({ status: "proving", number: 4, txCount: 3, gasUsed: 201706 })), ...h }));
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

  it("counts the blocks in the title: all, final on Canton (the genesis is not a record) and being proven", async () => {
    await open();
    expect(screen.getByText("5 blocks · 3 final on Canton · 1 being proven")).toBeInTheDocument();
    expect(screen.getByText(/Proof time/, { selector: "strong" })).toBeInTheDocument();
  });

  it("shows the block being proven with its transactions, its gas and the proof time so far", async () => {
    await open({ inFlight: () => reply(inFlight()) });
    const r = rows()[0]!;
    expect(await within(r).findByText("201,706", { exact: false })).toBeInTheDocument();
    expect(r).toHaveTextContent("3");
    expect(r).toHaveTextContent(/\d+(\.\d)? s so far/);
  });

  it("does not draw a block twice when the list already holds the block the status still says is being proven", async () => {
    await open({ blocks: () => reply(page([blockItem(4), blockItem(3)])) });
    const r = rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toHaveTextContent("Final");
    expect(r[0]).not.toHaveTextContent("Being proven");
  });

  it("has the screen's columns: proof time and time to final, no legs", async () => {
    await open();
    const heads = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Block", "Age", "Transactions", "Gas used", "Proof time", "Time to final", "Canton update", "Stage"]);
  });

  it("shows transactions, gas with its share of the limit, the proof time, the time to final and the update, which opens its Canton page", async () => {
    await open({ blocks: () => reply(page([blockItem(3, { txCount: 5, gasUsed: 3_000_000, gasLimit: 30_000_000, proofSeconds: 7.24, finalSeconds: 8.09 })])) });
    const r = rows()[1]!;
    expect(r).toHaveTextContent("5");
    expect(r).toHaveTextContent("3,000,000 10.0%");
    expect(r).toHaveTextContent("7.24 s");
    expect(r).toHaveTextContent("8.09 s");
    expect(within(r).getByRole("link", { name: "1220 0303…0303" })).toHaveAttribute("href", `/canton/${update(3)}`);
  });

  it("flags a slow proof, and writes minutes past one", async () => {
    await open({ blocks: () => reply(page([blockItem(3, { proofSeconds: 88.4, finalSeconds: 89.3 }), blockItem(2, { proofSeconds: 7.1 })])) });
    expect(rows()[1]).toHaveTextContent("1 min 28 s");
    expect(rows()[1]).toHaveTextContent("1 min 29 s");
    expect(rows()[1]).toHaveTextContent("slow proof");
    expect(rows()[2]).not.toHaveTextContent("slow proof");
  });

  it("shows a dash where the producer's journal has no times", async () => {
    await open({ blocks: () => reply(page([blockItem(3, { proofSeconds: null, finalSeconds: null })])) });
    const cells = within(rows()[1]!).getAllByRole("cell").map((c) => c.textContent);
    expect(cells[4]).toBe("—");
    expect(cells[5]).toBe("—");
  });

  it("says block 0 is the genesis, with no record", async () => {
    await open({ blocks: () => reply(page([blockItem(0, { updateId: "", recordTime: "", timestamp: 0, proofSeconds: null, finalSeconds: null })])) });
    const r = rows()[1]!;
    expect(r).toHaveTextContent("genesis");
    expect(r).toHaveTextContent("no record");
    expect(r).toHaveTextContent("Genesis");
  });

  it("pages by number, to any page and to the last, from the count of blocks", async () => {
    const user = userEvent.setup();
    const calls = await open({ status: () => reply(status({ proving: null, final: { ...status().final!, number: 59 } })), blocks: (path) => reply(page([blockItem(path.includes("before=") ? 10 : 59)])) });
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 3");
    expect(calls.some((c) => c.includes("/api/blocks?limit=25&before=35"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Last" }));
    await screen.findByText("Page 3 of 3");
    expect(calls.some((c) => c.includes("/api/blocks?limit=25&before=10"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "First" }));
    await screen.findByText("Page 1 of 3");
  });

  it("shows no block being proven on a later page", async () => {
    const user = userEvent.setup();
    await open({ status: () => reply(status({ final: { ...status().final!, number: 59 }, proving: { number: 60, hash: "0x" + "60".repeat(32), timestamp: 1 } })), blocks: () => reply(page([blockItem(3)])) });
    expect(rows()[0]).toHaveTextContent("Being proven");
    await user.click(await screen.findByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 3");
    expect(screen.queryByText("Being proven", { selector: ".chip" })).toBeNull();
  });

  it("filters to the blocks with transactions or the empty ones, from the first page, and keeps the CSV in step", async () => {
    const user = userEvent.setup();
    const calls = await open({ blocks: (path) => reply(path.includes("filter=empty") ? page([blockItem(1, { txCount: 0 })]) : page([blockItem(3), blockItem(2)])) });
    expect(screen.getByRole("link", { name: /CSV/ })).toHaveAttribute("href", "/api/blocks?format=csv&filter=all");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Empty" }));
    await screen.findByText("Showing blocks 1 to 1");
    expect(calls.some((c) => c.includes("/api/blocks?limit=25&filter=empty"))).toBe(true);
    expect(screen.getByRole("button", { name: "Empty" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: /CSV/ })).toHaveAttribute("href", "/api/blocks?format=csv&filter=empty");
    await user.click(screen.getByRole("button", { name: "With transactions" }));
    await screen.findByText("Showing blocks 3 to 2");
    expect(calls.some((c) => c.includes("filter=transactions"))).toBe(true);
    expect(screen.getByRole("link", { name: /CSV/ })).toHaveAttribute("href", "/api/blocks?format=csv&filter=transactions");
  });

  it("walks a filtered list by the server's cursor, with no count of pages", async () => {
    const user = userEvent.setup();
    const calls = await open({ status: () => reply(status({ proving: null })), blocks: (path) => reply(path.includes("before=c1") ? page([blockItem(1)]) : page([blockItem(3), blockItem(2)], "c1")) });
    await user.click(screen.getByRole("button", { name: "With transactions" }));
    await screen.findByRole("button", { name: "Older page" });
    await user.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(calls.some((c) => c.includes("/api/blocks?limit=25&before=c1&filter=transactions"))).toBe(true);
    expect(screen.getByRole("button", { name: "Older page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "First" }));
    await screen.findByText("Page 1");
  });

  it("says so when the chain cannot be read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fakeApi(route({ blocks: () => reply({ error: "The explorer cannot read the chain right now." }, 503) }));
    renderApp("/blocks");
    expect(await screen.findByText("The explorer cannot read the chain right now.")).toBeInTheDocument();
  });
});
