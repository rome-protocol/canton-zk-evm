// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StatsSummary } from "../api.ts";
import { summary } from "./stats-fixtures.ts";
import type { Label } from "../api.ts";
import { addr, fakeApi, hash, inFlight, labelsOf, page, renderApp, reply, route, tx, txItem, waitingTx } from "../test-utils.tsx";

/** The route `base` plus a labels route that answers only the addresses asked, as the server does (so a page that forgot to ask gets no name). */
const withLabels = (base: (path: string) => { status: number; body: unknown }, items: unknown[]) => {
  const known = labelsOf(items as Label[]);
  return Object.assign((path: string) => (path.includes("/api/labels") ? known(path) : base(path)), { routed: true as const });
};
const labelsAsked = (calls: string[]) => calls.filter((c) => c.includes("/api/labels")).map((c) => decodeURIComponent(c)).join(" ");

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
    const title = screen.getByRole("heading", { name: "Transactions" }).parentElement!;
    expect(title).toHaveTextContent("40 being proven · 1,000 waiting");
    expect(title).not.toHaveTextContent(/(^|\D)10 (being proven|waiting)/);
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

describe("the all-time total", () => {
  const at = "2026-10-04T01:37:58Z";
  const counted = (total: number | null) => ({ ...page([txItem(3), txItem(2)], "2:0"), total, totalAsOfBlock: total === null ? null : 21, totalAsOf: total === null ? null : at });
  const title = () => screen.getByRole("heading", { name: "Transactions" }).parentElement!;
  const some = () => inFlight({ attempts: [{ ...inFlight().attempts[0]!, number: 22, txCount: 3 }], poolWaiting: { waiting: 1, at }, transactions: [] });

  it("says the total, how many are final, being proven and waiting, and the newest rows of the total", async () => {
    await open({ txs: () => reply(counted(1017)), inFlight: () => reply(some()) });
    await waitFor(() => expect(title()).toHaveTextContent("1,021 in all · 1,017 final · 3 being proven · 1 waiting"));
    expect(screen.getByText("Showing 2 of 1,021")).toBeInTheDocument();
  });

  it("says not counted yet when the server cannot count, and never writes 0 or a guess", async () => {
    await open({ txs: () => reply(counted(null)), inFlight: () => reply(some()) });
    await waitFor(() => expect(title()).toHaveTextContent("total not counted yet · 3 being proven · 1 waiting"));
    expect(title()).not.toHaveTextContent(/(^|\D)0 in all/);
    expect(title()).not.toHaveTextContent("in all");
    expect(screen.getByText(/Showing the newest 2 on this page · total not counted yet/)).toBeInTheDocument();
  });

  it("on page 2 and later, tells the page against the final total, or says the total is not counted", async () => {
    await open({ txs: () => reply(counted(1017)), inFlight: () => reply(some()) });
    await userEvent.click(await screen.findByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Showing 2 on page 2 · 1,017 final in all")).toBeInTheDocument();
  });

  it("on page 2, says the total is not counted yet when the server cannot count", async () => {
    await open({ txs: () => reply(counted(null)), inFlight: () => reply(some()) });
    await userEvent.click(await screen.findByRole("button", { name: "Older page" }));
    expect(await screen.findByText("Showing 2 on page 2 · total not counted yet")).toBeInTheDocument();
  });

  it("on page 1 with not-final rows, counts them in the rows shown and adds the not-final total to the figure", async () => {
    await open({ txs: () => reply(counted(1017)), inFlight: () => reply(flight()), tx: byHash("") });
    expect(await screen.findByText("Showing the newest 4 of 1,018")).toBeInTheDocument();
  });

  it("does not count twice the transactions of a block the final total already holds", async () => {
    const seen = inFlight({ attempts: [{ ...inFlight().attempts[0]!, number: 21, txCount: 3 }, { ...inFlight().attempts[0]!, number: 22, txCount: 2 }], poolWaiting: { waiting: 1, at }, transactions: [] });
    await open({ txs: () => reply(counted(1017)), inFlight: () => reply(seen) });
    await waitFor(() => expect(title()).toHaveTextContent("1,020 in all · 1,017 final · 2 being proven · 1 waiting"));
    expect(screen.getByText("Showing 2 of about 1,020")).toBeInTheDocument();
    // The Not final yet card counts the same attempts as the title: one total, not two.
    const card = within(screen.getByRole("region", { name: "Numbers" })).getByText("Not final yet").closest(".stat")!;
    await waitFor(() => expect(card).toHaveTextContent("2 being proven · 1 waiting"));
    expect(card).not.toHaveTextContent("5 being proven");
  });

  it("says at least when the pool is not counted, while Last and the page count still rest on the exact final total", async () => {
    await open({ txs: () => reply(counted(1017)), inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null, transactions: [] })) });
    await waitFor(() => expect(title()).toHaveTextContent("at least 1,017 in all · 1,017 final · 0 being proven · the pool is not counted"));
    expect(await screen.findByRole("button", { name: "Last" })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: "Pages of transactions" })).toHaveTextContent("Page 1 of 41");
  });

  it("makes no claim about a total on the failed list, which the server does not total", async () => {
    await open({ txs: () => reply(counted(1017)), inFlight: () => reply(some()) });
    await userEvent.click(screen.getByRole("button", { name: "Failed" }));
    await waitFor(() => expect(screen.getByText(/Showing the newest 2 on this page/)).toBeInTheDocument());
    expect(screen.queryByText(/of 1,021/)).toBeNull();
  });
});

describe("the four cards, from the stats routes", () => {
  const tile = (label: string) => Array.from(screen.getByRole("region", { name: "Numbers" }).querySelectorAll(".stat")).find((e) => e.querySelector(".stat-k")!.textContent!.startsWith(label))! as HTMLElement;
  const stats = (hour: Partial<StatsSummary> = {}, day: Partial<StatsSummary> = {}) => (path: string) => {
    const w = new URL(path, "http://x").searchParams.get("window");
    return w === "1h" ? reply(summary(hour)) : w === "24h" ? reply(summary(day)) : reply({ error: "no" }, 404);
  };
  const dayOf = (over: Partial<StatsSummary> = {}): Partial<StatsSummary> => ({
    txs: { count: 1017, failed: 1, successRate: 1016 / 1017, accepted: 1017, allTime: { total: 1021, asOfBlock: 21, asOf: "2026-10-04T12:49:00.000Z" } },
    blocks: { count: 21, empty: 0, busy: 0, bySize: [] }, ...over,
  });

  it("shows, as screen 04 does, the day's transactions with the all-time total, the last hour's time to final, what is not final with how many are stuck, and the lost ones", async () => {
    await open({ stats: stats({}, dayOf()), inFlight: () => reply(inFlight({ attempts: [{ ...inFlight().attempts[0]!, number: 22, txCount: 3 }], poolWaiting: { waiting: 1, at: "2026-10-04T01:37:58Z" }, transactions: [] })) });
    await waitFor(() => expect(tile("Transactions · 24 h")).toHaveTextContent("1,017"));
    expect(tile("Transactions · 24 h")).toHaveTextContent("1,021 final in all · as of block 21");
    expect(tile("Time to final · last hour")).toHaveTextContent(/p95/);
    await waitFor(() => expect(tile("Not final yet")).toHaveTextContent("43 being proven · 1 waiting · 0 stuck (over 120 s)"));
    expect(tile("Lost · all time")).toHaveTextContent("0");
    expect(tile("Lost · all time")).toHaveClass("stat-ok");
    expect(tile("Lost · all time")).toHaveTextContent("accepted by Ostia and never made final");
  });

  it("leaves the Lost card red and leads to the stats page when some were lost", async () => {
    await open({ stats: stats({}, dayOf({ lost: { window: 2, total: 2, listed: [] } })) });
    await waitFor(() => expect(tile("Lost · all time")).toHaveTextContent("2"));
    expect(tile("Lost · all time")).not.toHaveClass("stat-ok");
    expect(within(tile("Lost · all time")).getByRole("link", { name: "Stats" })).toHaveAttribute("href", "/stats");
  });

  it("says a dash and why for each card the stats cannot give, never a made-up number", async () => {
    await open({ stats: () => reply({ error: "down" }, 500) });
    await waitFor(() => expect(tile("Transactions · 24 h")).toHaveTextContent("the stats cannot be read right now"));
    expect(tile("Lost · all time").querySelector(".stat-v")!.textContent).toBe("—");
    expect(tile("Time to final · last hour").querySelector(".stat-v")!.textContent).toBe("—");
  });
});

describe("the rows, with names, token chips and the screen's cuts", () => {
  const usd = { address: addr(0xcb), name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: true };
  const moved = { count: 1, more: false, first: { token: addr(0xcb), amount: "100000000", tokenId: null, standard: "ERC-20", decimals: 6 } };
  const labelled = (items: unknown[]) => {
    const base = route({ txs: () => reply(page(items as never[])) });
    fakeApi(withLabels(base, [usd]));
    renderApp("/txs");
  };

  it("shows the receiver by name, the token moved as a chip, and cuts the hash 8 and 6", async () => {
    labelled([txItem(3, { value: "0", tokenMoves: moved, methodId: "0xa9059cbb" })]);
    const row = (await screen.findAllByRole("row"))[1]!;
    expect(await within(row).findByRole("link", { name: "Test USD (tUSD)" })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(within(row).getByText("100 tUSD")).toHaveClass("tname");
    expect(within(row).getByText("transfer")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "0xa3a3a3a3…a3a3a3" })).toHaveAttribute("href", `/tx/${txItem(3).hash}`);
    expect(within(row).getByRole("link", { name: "0x5b5b5b…5b5b" })).toHaveAttribute("href", `/address/${addr(0x5b)}`);
  });

  describe("a transfer that is being proven", () => {
    const at = "2026-10-04T01:37:58Z";
    const proving = (value: string) => tx({ hash: hash(0xd2), status: "proving", state: "proving", block: { number: 4, hash: null, updateId: null }, success: null, to: addr(0xcb), value, transfer: { symbol: "tUSD", decimals: 6, to: addr(0x72), value: "100000000" } });
    const run = async (value: string) => {
      const base = route({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null, transactions: [{ hash: hash(0xd2), stage: "proving", at }] })), tx: () => reply(proving(value)) });
      fakeApi(withLabels(base, [usd]));
      renderApp("/txs");
      const row = (await screen.findAllByRole("row"))[1]!;
      expect(await within(row).findByText("100 tUSD")).toHaveClass("tname");
      return row;
    };
    it("is the token chip, never 0 of the coin", async () => { expect(await run("0")).not.toHaveTextContent("tROME"); });
    it("has the coin beside the chip when some is sent", async () => { expect(await run("1000000000000000000")).toHaveTextContent("1 tROME"); });
    it("is reverted, with a cross and no chip, when the receipt says it reverted", async () => {
      const base = route({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null, transactions: [{ hash: hash(0xd2), stage: "proving", at }] })), tx: () => reply({ ...proving("0"), success: false, logs: [] }) });
      fakeApi(withLabels(base, [usd]));
      renderApp("/txs");
      const row = (await screen.findAllByRole("row"))[1]!;
      await waitFor(() => expect(row).toHaveTextContent("reverted"));
      expect(row.querySelector(".tchip")).toBeNull();
      expect(within(row).getByRole("img", { name: "Failed (reverted)" })).toBeInTheDocument();
    });
    it("takes the chip from the Transfer log of the receipt over the decoded input", async () => {
      const logs = [{ address: addr(0xcb), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(24) + "71".repeat(20), "0x" + "0".repeat(24) + "72".repeat(20)], data: "0x" + (7_000_000n).toString(16).padStart(64, "0") }];
      const base = route({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null, transactions: [{ hash: hash(0xd2), stage: "proving", at }] })), tx: () => reply({ ...proving("0"), success: true, logs }) });
      fakeApi(withLabels(base, [usd]));
      renderApp("/txs");
      const row = (await screen.findAllByRole("row"))[1]!;
      expect(await within(row).findByText("7 tUSD")).toHaveClass("tname");
      expect(row).not.toHaveTextContent("100 tUSD");
    });
    it("names the token of the receipt's Transfer when it is another token than the one the transaction was sent to", async () => {
      const other = { ...usd, address: addr(0xa5), name: "Other USD", symbol: "tOTH" };
      const logs = [{ address: addr(0xa5), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(24) + "71".repeat(20), "0x" + "0".repeat(24) + "72".repeat(20)], data: "0x" + (2_000_000n).toString(16).padStart(64, "0") }];
      const base = route({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null, transactions: [{ hash: hash(0xd2), stage: "proving", at }] })), tx: () => reply({ ...proving("0"), success: true, logs, transfer: null }) });
      const calls = fakeApi(withLabels(base, [usd, other]));
      renderApp("/txs");
      const row = (await screen.findAllByRole("row"))[1]!;
      expect(await within(row).findByText("2 tOTH")).toHaveClass("tname");
      expect(labelsAsked(calls)).toContain(addr(0xa5));
    });

    it("asks for the same token in Not final yet, which lists them from their receipts alone", async () => {
      const other = { ...usd, address: addr(0xa5), name: "Other USD", symbol: "tOTH" };
      const logs = [{ address: addr(0xa5), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(24) + "71".repeat(20), "0x" + "0".repeat(24) + "72".repeat(20)], data: "0x" + (2_000_000n).toString(16).padStart(64, "0") }];
      const base = route({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null, transactions: [{ hash: hash(0xd2), stage: "proving", at }] })), tx: () => reply({ ...proving("0"), success: true, logs, transfer: null }) });
      const calls = fakeApi(withLabels(base, [usd, other]));
      renderApp("/txs");
      await userEvent.click(await screen.findByRole("button", { name: "Not final yet" }));
      const row = (await screen.findAllByRole("row"))[1]!;
      expect(await within(row).findByText("2 tOTH")).toHaveClass("tname");
      expect(labelsAsked(calls)).toContain(addr(0xa5));
    });
  });

  it("says Create: and what the transaction made, and shows a plain send as the coin", async () => {
    labelled([txItem(3, { to: null, created: addr(0xd1), value: "0" }), txItem(2)]);
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(rows[0]).toHaveTextContent("Create contract");
    expect(rows[0]).toHaveTextContent("Create:");
    expect(within(rows[0]!).getByRole("link", { name: "0xd1d1d1…d1d1" })).toHaveAttribute("href", `/address/${addr(0xd1)}`);
    expect(rows[1]).toHaveTextContent("0.25 tROME");
  });

  it("asks for the names of a page of rows in one call, not one per row", async () => {
    const calls = (() => { const c: string[] = []; return c; })();
    const base = route({ txs: () => reply(page([txItem(3), txItem(2), txItem(1)])) });
    fakeApi(Object.assign((path: string) => { calls.push(path); return path.includes("/api/labels") ? reply({ items: [] }) : base(path); }, { routed: true }));
    renderApp("/txs");
    await screen.findAllByRole("row");
    await waitFor(() => expect(calls.some((c) => c.includes("/api/labels"))).toBe(true));
    expect(calls.filter((c) => c.includes("/api/labels")).length).toBeLessThanOrEqual(2);
  });
});

describe("the subtitle and the list header add up", () => {
  const at = "2026-10-04T01:37:58Z";
  const counted = { ...page([txItem(3), txItem(2)], "2:0"), total: 1017, totalAsOfBlock: 21, totalAsOf: at };
  const title = () => screen.getByRole("heading", { name: "Transactions" }).parentElement!;
  const pool = (poolAt: string) => inFlight({ attempts: [{ ...inFlight().attempts[0]!, number: 22, txCount: 3 }], poolWaiting: { waiting: 1, at: poolAt }, transactions: [] });

  it("calls the in-all figure about when the pool was read before the final total, since a waiting transaction may be final by then", async () => {
    await open({ txs: () => reply(counted), inFlight: () => reply(pool("2026-10-04T01:37:50Z")) });
    await waitFor(() => expect(title()).toHaveTextContent("about 1,021 in all · 1,017 final · 3 being proven · 1 waiting"));
  });

  it("says the figure exactly when nothing waits, whenever the pool was read: with none waiting nothing can be counted twice", async () => {
    const empty = inFlight({ attempts: [{ ...inFlight().attempts[0]!, number: 22, txCount: 3 }], poolWaiting: { waiting: 0, at: "2026-10-04T01:37:50Z" }, transactions: [] });
    await open({ txs: () => reply(counted), inFlight: () => reply(empty) });
    await waitFor(() => expect(title()).toHaveTextContent("1,020 in all · 1,017 final · 3 being proven · 0 waiting"));
    expect(title()).not.toHaveTextContent("about");
    expect(await screen.findByText("Showing 2 of 1,020")).toBeInTheDocument();
  });

  it("says about when an attempt's block is already in the final total, even with none waiting", async () => {
    const lapped = inFlight({ attempts: [{ ...inFlight().attempts[0]!, number: 21, txCount: 3 }], poolWaiting: { waiting: 0, at: "2026-10-04T01:37:50Z" }, transactions: [] });
    await open({ txs: () => reply(counted), inFlight: () => reply(lapped) });
    await waitFor(() => expect(title()).toHaveTextContent("about 1,017 in all · 1,017 final · 0 being proven · 0 waiting"));
  });

  it("says the figure exactly when the pool was read at or after the final total", async () => {
    await open({ txs: () => reply(counted), inFlight: () => reply(pool(at)) });
    await waitFor(() => expect(title()).toHaveTextContent("1,021 in all · 1,017 final"));
    expect(title()).not.toHaveTextContent("about");
  });

  it("does not call the rows the newest of the total when not-final rows are cut off", async () => {
    const burst = inFlight({
      attempts: [{ ...inFlight().attempts[0]!, number: 22, txCount: 40 }], poolWaiting: { waiting: 1000, at },
      transactions: Array.from({ length: 10 }, (_, i) => ({ hash: hash(0xe0 + i), stage: "waiting" as const, at })),
    });
    await open({ txs: () => reply(counted), inFlight: () => reply(burst) });
    expect(await screen.findByText("Showing 12 of 2,057")).toBeInTheDocument();
    expect(screen.queryByText(/newest 12/)).toBeNull();
  });
});

describe("the pages of All: Page x of y and Last", () => {
  const at = "2026-10-04T01:37:58Z";
  const withTotal = (items: ReturnType<typeof txItem>[], next: string | null, total: number | null = 53) => ({ ...page(items, next), total, totalAsOfBlock: total === null ? null : 99, totalAsOf: total === null ? null : at });
  // 53 transactions, one per block, block 53 the newest.
  const all = Array.from({ length: 53 }, (_, i) => txItem(i + 1));
  const newestFirst = (a: number, b: number) => all.slice(a, b).reverse();
  const blocks = () => rows().map((r) => r.querySelectorAll("td")[2]!.textContent);
  const nav = () => screen.getByRole("navigation", { name: "Pages of transactions" });
  const feed = (p: string) => {
    if (p.includes("order=asc") && !p.includes("after=")) return reply(withTotal(all.slice(0, 3), "1:0"));
    if (p.includes("order=asc") && p.includes("after=1%3A0")) return reply(withTotal(all.slice(3, 28), "28:0"));
    return reply(withTotal(newestFirst(28, 53), "29:0"));
  };

  it("says Page 1 of 3 from the exact total, with First and Last", async () => {
    await open({ txs: feed });
    expect(await within(await screen.findByRole("navigation", { name: "Pages of transactions" })).findByText("Page 1 of 3")).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: "Last" })).toBeEnabled();
    expect(within(nav()).getByRole("button", { name: "First" })).toBeDisabled();
  });

  it("opens the last page from the other end with only what it holds (total mod page size), so it never overlaps the page before", async () => {
    const calls = await open({ txs: feed });
    await userEvent.click(await within(await screen.findByRole("navigation", { name: "Pages of transactions" })).findByRole("button", { name: "Last" }));
    await screen.findByText("Page 3 of 3");
    expect(calls).toContain("/api/txs?order=asc&limit=3");
    // The oldest three, drawn newest first like the rest of the list.
    expect(blocks()).toEqual(["3", "2", "1"]);
    await userEvent.click(within(nav()).getByRole("button", { name: "Previous page" }));
    await screen.findByText("Page 2 of 3");
    expect(calls).toContain("/api/txs?order=asc&limit=25&after=1%3A0");
    expect(blocks()[0]).toBe("28");
    expect(blocks()[24]).toBe("4");
    expect(blocks()).not.toContain("3");
    await userEvent.click(within(nav()).getByRole("button", { name: "First" }));
    await screen.findByText("Page 1 of 3");
    expect(blocks()[0]).toBe("53");
  });

  it("reads the last page in full when the total is a whole number of pages", async () => {
    const calls = await open({ txs: (p) => reply(withTotal([txItem(3)], "3:0", 75)) });
    await userEvent.click(await within(await screen.findByRole("navigation", { name: "Pages of transactions" })).findByRole("button", { name: "Last" }));
    await waitFor(() => expect(calls).toContain("/api/txs?order=asc&limit=25"));
  });

  it("keeps the older/newer pager on the filtered lists, which have no total", async () => {
    await open({ txs: () => reply(withTotal([txItem(3)], "3:0")) });
    await userEvent.click(screen.getByRole("button", { name: "Failed" }));
    const n = await screen.findByRole("navigation", { name: "Pages of transactions" });
    expect(n).toHaveTextContent("Page 1");
    expect(n).not.toHaveTextContent("of");
    expect(within(n).queryByRole("button", { name: "Last" })).toBeNull();
    expect(within(n).getByRole("button", { name: "Older page" })).toBeEnabled();
  });

  it("keeps the older/newer pager on All while the server cannot count", async () => {
    await open({ txs: () => reply(withTotal([txItem(3)], "3:0", null)) });
    const n = await screen.findByRole("navigation", { name: "Pages of transactions" });
    expect(within(n).queryByRole("button", { name: "Last" })).toBeNull();
    expect(within(n).getByRole("button", { name: "Older page" })).toBeEnabled();
  });
});

describe("the fee column", () => {
  it("writes the fee in whole coins to ten decimals, cut and never rounded, and a fee below the tenth place as '<'", async () => {
    await open({ txs: () => reply(page([txItem(3, { gasUsed: 21000, gasPrice: "1670000000" }), txItem(2, { gasUsed: 1, gasPrice: "99999999" }), txItem(1, { gasUsed: 21000, gasPrice: "1999999999999" })])) });
    expect(rows()[0]).toHaveTextContent("0.00003507");
    expect(rows()[1]).toHaveTextContent("<0.0000000001");
    expect(rows()[2]).toHaveTextContent("0.0419999999");
  });
});
