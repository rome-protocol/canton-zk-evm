// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, hash, inFlight, page, renderApp, reply, route, tx, txItem, waitingTx } from "../test-utils.tsx";

const NOW = Date.parse("2026-10-04T01:38:00Z");
async function open(h: Parameters<typeof route>[0] = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const calls = fakeApi(route(h));
  renderApp("/txs");
  await screen.findByRole("heading", { name: "Transactions" });
  await screen.findByRole("table");
  return calls;
}
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const flight = (at = "2026-10-04T01:37:58Z") => inFlight({ attempts: [], poolWaiting: { waiting: 1, at }, transactions: [{ hash: hash(0xd1), stage: "waiting", at }, { hash: hash(0xd2), stage: "proving", at }] });
const byHash = (h: string) => (x: string) => (x === hash(0xd1) ? reply(waitingTx({ hash: hash(0xd1) })) : x === hash(0xd2) ? reply(tx({ hash: hash(0xd2), status: "proving", state: "proving", block: { number: 4, hash: null, updateId: null }, success: null })) : reply(tx({ hash: h })));

describe("the transactions page", () => {
  it("lists the not-final transactions above the final ones, each with its stage", async () => {
    await open({ inFlight: () => reply(flight()), tx: byHash("") });
    const r = rows();
    expect(r).toHaveLength(4);
    expect(r[0]).toHaveTextContent("Waiting");
    expect(r[0]).toHaveTextContent("pool");
    await waitFor(() => expect(rows()[1]).toHaveTextContent("4"));
    expect(rows()[1]).toHaveTextContent("Being proven");
    expect(rows()[2]).toHaveTextContent("Final");
    expect(within(rows()[2]!).getAllByRole("link")[0]).toHaveAttribute("href", `/tx/${hash(0xa3)}`);
    expect(within(rows()[2]!).getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
  });

  it("marks a failed transaction and shows the fee with every digit", async () => {
    await open({ txs: () => reply(page([txItem(3, { success: false, gasUsed: 21000, gasPrice: "1670000000" })])) });
    expect(within(rows()[0]!).getByRole("img", { name: "Failed (reverted)" })).toBeInTheDocument();
    expect(rows()[0]).toHaveTextContent("0.00003507");
  });

  it("asks the server for the failed ones and for contract calls, and offers a CSV of the filter", async () => {
    const calls = await open({ txs: () => reply(page([txItem(3)])) });
    await userEvent.click(screen.getByRole("button", { name: "Failed" }));
    await waitFor(() => expect(calls.some((c) => c.includes("filter=failed"))).toBe(true));
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", "/api/txs?format=csv&filter=failed");
    await userEvent.click(screen.getByRole("button", { name: "Contract calls" }));
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", "/api/txs?format=csv&filter=calls");
  });

  it("Not final yet shows only the transactions that are not final, and says so when there are none", async () => {
    await open({ inFlight: () => reply(flight()), tx: byHash("") });
    await userEvent.click(screen.getByRole("button", { name: "Not final yet" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByText("Final")).toBeNull();
  });

  it("shows nothing for a transaction it has not read, never a made-up value", async () => {
    await open({ inFlight: () => reply(flight()) });
    expect(rows()[0]!.querySelectorAll("td")[7]).toHaveTextContent("—");
  });

  it("pages by the server's cursor", async () => {
    const calls = await open({ txs: () => reply(page([txItem(3)], "3:0")) });
    await userEvent.click(await screen.findByRole("button", { name: "Older page" }));
    await waitFor(() => expect(calls.some((c) => c.includes("before=3%3A0"))).toBe(true));
  });
});

describe("the count of what is not final yet", () => {
  const at = "2026-10-04T01:37:58Z";
  /** A burst: the in-flight route lists only the newest ten, the rest are counted by the attempts and the pool. */
  const burst = () => inFlight({
    attempts: [{ ...inFlight().attempts[0]!, txCount: 40 }], poolWaiting: { waiting: 1000, at },
    transactions: Array.from({ length: 10 }, (_, i) => ({ hash: hash(0xe0 + i), stage: "waiting" as const, at })),
  });
  const total = "1,040";

  it("says the total in the title and the newest ten in the list, never the ten as the count", async () => {
    await open({ inFlight: () => reply(burst()) });
    expect(screen.getByRole("heading", { name: "Transactions" }).parentElement).toHaveTextContent(`${total} not final yet`);
    expect(screen.getByRole("heading", { name: "Transactions" }).parentElement).not.toHaveTextContent(/(^|\D)10 not final yet/);
    expect(screen.getByText(/1,030 more not final yet, older than the rows shown, are not listed/)).toBeInTheDocument();
  });

  it("in Not final yet, counts the total, labels the list as the newest ten, and says the rest are older and not listed", async () => {
    await open({ inFlight: () => reply(burst()) });
    await userEvent.click(screen.getByRole("button", { name: "Not final yet" }));
    const list = await screen.findByRole("region", { name: "Transactions not final yet" });
    expect(list).toHaveTextContent(`The newest 10 of ${total} not final yet`);
    expect(list).toHaveTextContent("1,030 more, older than these, are not listed");
    expect(list).not.toHaveTextContent("newer than");
  });

  it("does not say nothing is waiting when the list is empty but the pool holds some", async () => {
    await open({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: { waiting: 7, at }, transactions: [] })) });
    await userEvent.click(screen.getByRole("button", { name: "Not final yet" }));
    const list = await screen.findByRole("region", { name: "Transactions not final yet" });
    expect(list).not.toHaveTextContent("Nothing is waiting or being proven.");
    expect(list).toHaveTextContent("7 not final yet, none listed");
  });

  it("says nothing is waiting only when the total is zero", async () => {
    await open({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: { waiting: 0, at }, transactions: [] })) });
    await userEvent.click(screen.getByRole("button", { name: "Not final yet" }));
    expect(await screen.findByText("Nothing is waiting or being proven.")).toBeInTheDocument();
  });

  it("heads the fee column with the chain's coin and offers no CSV for the not-final view", async () => {
    await open({ inFlight: () => reply(flight()), tx: byHash("") });
    expect(screen.getByRole("columnheader", { name: "Fee (tROME)" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Not final yet" }));
    await screen.findByRole("region", { name: "Transactions not final yet" });
    expect(screen.queryByRole("link", { name: "CSV" })).toBeNull();
  });
});
