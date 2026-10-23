// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { StatsMetric, StatsWindow } from "../api.ts";
import { REST_FIELDS } from "../../server/rest/fields.ts";
import { fakeApi, renderApp, reply, route, status, type Reply } from "../test-utils.tsx";
import { series, summary, wave } from "./stats-fixtures.ts";

type Handlers = { summary?: (w: string) => Reply; series?: (metric: StatsMetric, window: StatsWindow, path: string) => Reply; faucetOn?: boolean; faucet?: () => Reply };
const ordinary = (metric: StatsMetric, window: StatsWindow) => {
  const base = { time_to_final_p50: 8.4, time_to_final_p95: 9.5, proof_time_p50: 7.1, proof_time_p95: 7.6, tps: 0.2, busiest_minute_tps: 0.9, blocks: 5, busy_ratio: 0.012 }[metric as string] ?? 1;
  return reply(series(metric, wave(base), { window }));
};
async function open(path = "/stats?window=7d", h: Handlers = {}) {
  const base = route({ status: h.faucetOn ? () => reply(status({ faucet: { on: true } })) : undefined, faucet: h.faucet });
  const calls = fakeApi(Object.assign((p: string): Reply => {
    const u = new URL(p, "http://x");
    if (u.pathname === "/api/stats/summary") return h.summary ? h.summary(u.searchParams.get("window")!) : reply(summary({ window: u.searchParams.get("window") as StatsWindow }));
    if (u.pathname === "/api/stats/series") {
      const [m, w] = [u.searchParams.get("metric") as StatsMetric, u.searchParams.get("window") as StatsWindow];
      return h.series ? h.series(m, w, p) : ordinary(m, w);
    }
    return base(p);
  }, { routed: true }));
  renderApp(path);
  await screen.findByRole("heading", { name: "Stats" });
  return calls;
}
const tile = async (name: string) => (await screen.findByText(name, { selector: ".stat-k" })).closest(".stat") as HTMLElement;

describe("the recorded answers", () => {
  it("hold the fields the server's lists name, so that the page is tested on what it will get", () => {
    const s = summary();
    expect(Object.keys(s).sort()).toEqual([...REST_FIELDS.statsSummary].sort());
    expect(Object.keys(s.tps).sort()).toEqual([...REST_FIELDS.statsTps].sort());
    expect(Object.keys(s.proofTime!).sort()).toEqual([...REST_FIELDS.statsProof].sort());
    expect(Object.keys(s.proofTime!.bySize[0]!).sort()).toEqual([...REST_FIELDS.statsSize].sort());
    expect(Object.keys(s.acceptedNotFinal).sort()).toEqual([...REST_FIELDS.statsOpen].sort());
    expect(Object.keys(s.faucet).sort()).toEqual([...REST_FIELDS.statsFaucet].sort());
    expect(Object.keys(s.prover).sort()).toEqual([...REST_FIELDS.statsProver].sort());
    expect(Object.keys(s.txs).sort()).toEqual([...REST_FIELDS.statsTxs].sort());
    expect(Object.keys(s.attempts).sort()).toEqual([...REST_FIELDS.statsAttempts].sort());
    expect(Object.keys(series("tps", () => 1)).sort()).toEqual([...REST_FIELDS.statsSeries].sort());
  });
});

describe("the stats page", () => {
  it("heads the page with the window, the step and UTC, and says how the numbers are made", async () => {
    await open();
    expect(await screen.findByText("14 – 20 Oct 2026, by the hour, UTC")).toBeInTheDocument();
    expect(screen.getByText(/Every number is computed from stored facts/)).toHaveTextContent("at most 5% above");
  });

  it("gives the six figures: times with their p95, transactions, the busiest minute and the success rate", async () => {
    await open();
    const ttf = await tile("Time to final");
    expect(ttf).toHaveTextContent("8.4 s"); expect(ttf).toHaveTextContent("p95 80.6 s");
    const proof = await tile("Proof time");
    expect(proof).toHaveTextContent("7.1 s"); expect(proof).toHaveTextContent("p95 7.9 s"); expect(proof).toHaveTextContent("per block, 901 proofs");
    expect(await tile("Canton commit")).toHaveTextContent("0.58 s");
    const txs = await tile("Transactions");
    expect(txs).toHaveTextContent("5,899"); expect(txs).toHaveTextContent("in 901 blocks · 6.5 per block");
    const peak = await tile("Peak rate");
    expect(peak).toHaveTextContent("20.8 tx/s"); expect(peak).toHaveTextContent("busiest minute, 15 Oct 14:07");
    const ok = await tile("Success rate");
    expect(ok).toHaveTextContent("99.7%"); expect(ok).toHaveTextContent("16 reverted of 5,899");
  });

  it("shows the all-time total beside the window's transactions, with the block it is as of", async () => {
    await open("/stats", { summary: () => reply(summary({ txs: { count: 5899, failed: 16, successRate: 5883 / 5899, accepted: 5903, allTime: { total: 6021, asOfBlock: 901, asOf: "2026-10-15T14:07:00.000Z" } } })) });
    const txs = await tile("Transactions");
    expect(txs).toHaveTextContent("5,899 6,021 final all time");
    expect(within(txs).getByText("6,021 final all time")).toHaveAttribute("title", "All time, as of block 901");
    expect(txs).toHaveTextContent("all time as of block 901");  });

  it("says the all-time total is not counted yet, never 0, when the server cannot say", async () => {
    await open();
    const txs = await tile("Transactions");
    expect(txs).toHaveTextContent("total not counted yet");
    expect(txs).not.toHaveTextContent("0 all time");
  });

  it("counts every accepted transaction by what became of it, and says none was lost", async () => {
    await open();
    const card = (await screen.findByRole("heading", { name: "Reliability" })).closest("section")!;
    const w = within(card);
    expect(w.getByText("Accepted").parentElement).toHaveTextContent("5,903");
    expect(w.getByText("Final").parentElement).toHaveTextContent("5,899");
    expect(w.getByText("Not final yet").parentElement).toHaveTextContent("4");
    expect(w.getByText("Not final yet").parentElement).toHaveTextContent("3 being proven · 1 waiting · 0 stuck");
    expect(w.getByText("Lost").parentElement).toHaveTextContent("0");
    expect(w.getByText("none lost")).toBeInTheDocument();
    expect(card).toHaveTextContent("Blocks refused by Canton: 0 of 901 attempts");
    expect(card).toHaveTextContent("Empty blocks: 1");
  });

  it("gives the lost transactions' hashes the hash font, not the figure font", async () => {
    const hash = "0x" + "ab".repeat(32);
    await open("/stats?window=7d", { summary: () => reply(summary({ lost: { window: 1, total: 1, listed: [{ txHash: hash, state: "lost", reason: "never made final", at: "2026-10-20T10:00:00.000Z" }] } })) });
    const card = (await screen.findByText("1 lost")).closest("section")!;
    expect(within(card).getAllByRole("link")[0]).toHaveClass("mono");
    expect(within(card).getAllByRole("link")[0]).not.toHaveClass("num");
  });

  it("names the lost transactions when there are some, by their hashes and reasons", async () => {
    const hash = "0x" + "ab".repeat(32);
    await open("/stats?window=7d", { summary: () => reply(summary({ lost: { window: 1, total: 1, listed: [{ txHash: hash, state: "lost", reason: "never made final", at: "2026-10-20T10:00:00.000Z" }] } })) });
    const card = (await screen.findByRole("heading", { name: "Reliability" })).closest("section")!;
    expect(within(card).getByText("1 lost")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /0xabab/ })).toHaveAttribute("href", `/tx/${hash}`);
    expect(card).toHaveTextContent("never made final");
  });

  it("opens on the window of the address, and asks for another when one is chosen", async () => {
    const calls = await open("/stats?window=7d");
    expect(calls).toContain("/api/stats/summary?window=7d");
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Last hour" }));
    await waitFor(() => expect(calls).toContain("/api/stats/summary?window=1h"));
    expect(screen.getByRole("button", { name: "Last hour" })).toHaveAttribute("aria-pressed", "true");
    expect(calls.filter((c) => c.startsWith("/api/stats/series") && c.includes("window=1h")).length).toBeGreaterThanOrEqual(7);
  });

  it("opens on 24 hours, the window the server defaults to, when the address names none, and links the data it reads", async () => {
    const calls = await open("/stats");
    expect(calls).toContain("/api/stats/summary?window=24h");
    expect(screen.getByRole("link", { name: /Data/ })).toHaveAttribute("href", "/api/stats/summary?window=24h");
  });

  it("draws five charts from seven series, and marks an hour above the scale with a caret and its time", async () => {
    await open("/stats?window=7d", { series: (m, w) => m === "time_to_final_p95" ? reply(series(m, wave(9.5, { at: 142, value: 88.6 }), { window: w })) : ordinary(m, w) });
    const ttf = (await screen.findByRole("heading", { name: "Time to final" })).closest("section")!;
    await waitFor(() => expect(within(ttf).getByRole("img")).toBeInTheDocument());
    expect(ttf.querySelectorAll(".ch-caret")).toHaveLength(1);
    expect(ttf).toHaveTextContent(/Above the scale.*p95 88.6 s/);
    expect(ttf.querySelector("svg")!.textContent).toContain("Wed 14 Oct");
    for (const name of ["Proof time", "Transactions per second", "Blocks per hour", "Prover busy"]) expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
    expect(screen.getAllByRole("img").filter((i) => i.closest(".chart"))).toHaveLength(5);
  });

  it("leaves a gap where a step has no fact, and draws no zero there", async () => {
    await open("/stats?window=7d", { series: (m, w) => m === "proof_time_p50" || m === "proof_time_p95" ? reply(series(m, (i) => (i >= 50 && i < 60 ? null : 7), { window: w })) : ordinary(m, w) });
    const card = (await screen.findByRole("heading", { name: "Proof time" })).closest("section")!;
    await waitFor(() => expect(card.querySelectorAll("polyline").length).toBeGreaterThan(0));
    expect(card.querySelectorAll("polyline")).toHaveLength(4); // two lines, each in two runs
  });

  it("says by the step of the series: per minute over an hour, per day over a month", async () => {
    await open("/stats?window=30d", { series: (m, w) => reply(series(m, wave(1), { window: w })) });
    expect(await screen.findByRole("heading", { name: "Blocks per day" })).toBeInTheDocument();
  });

  it("counts the final blocks by size, and gives the proof time of each size, with a dash where there was no block", async () => {
    await open();
    const card = (await screen.findByRole("heading", { name: "Transactions per block" })).closest("section")!;
    expect(card).toHaveTextContent("901 final blocks · mean 6.5 · median 3 · largest 100");
    const rows = within(within(card).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveTextContent("1–10");
    expect(rows[1]).toHaveTextContent("813");
    expect(rows[1]).toHaveTextContent("7.08 s");
    expect(rows[1]).toHaveTextContent("7.66 s");
    expect(rows[3]).toHaveTextContent("—");
    expect(within(card).getByText("813 blocks")).toBeInTheDocument();
    expect(within(card).getByText("1 block")).toBeInTheDocument();
  });

  it("gives the numbers the block-cutting rule watches, from the producer's own record, and says nothing it was not told", async () => {
    await open();
    const card = (await screen.findByRole("heading", { name: "The two numbers the block-cutting rule watches" })).closest("div")!;
    expect(card).toHaveTextContent("p95 time to final");
    expect(card).toHaveTextContent("80.6 s");
    expect(card).toHaveTextContent("Busiest ten minutes");
    expect(card).toHaveTextContent("3.5%");
    expect(card).toHaveTextContent("0 of 1,008 ten-minute windows above 60%");
    expect(card).toHaveTextContent("on_demand");
    expect(card).toHaveTextContent("a block when transactions wait");
  });

  it("draws the transactions-per-second chart with two series, the average as bars and the busiest minute as a line, and a legend that names both", async () => {
    const calls = await open("/stats?window=7d");
    const card = (await screen.findByRole("heading", { name: "Transactions per second" })).closest("section")!;
    await waitFor(() => expect(card.querySelectorAll("rect").length).toBeGreaterThan(0));
    expect(card.querySelectorAll("polyline").length).toBeGreaterThan(0);
    const legend = card.querySelector(".legend")!;
    expect(legend).toHaveTextContent("average");
    expect(legend).toHaveTextContent("busiest minute");
    expect(legend.querySelectorAll(".sw")).toHaveLength(2);
    expect(calls.some((c) => c.includes("metric=busiest_minute_tps") && c.includes("window=7d"))).toBe(true);
  });

  it("draws the block-size table with the shared table class, so its numbers align", async () => {
    await open();
    const card = (await screen.findByRole("heading", { name: "Transactions per block" })).closest("section")!;
    expect(card.querySelector("table")).toHaveClass("tbl");
  });

  it("gives the rule's p95 time to final by the step of the window: the worst one, and how many were above 20 s", async () => {
    await open("/stats?window=7d", { series: (m, w) => m === "time_to_final_p95" ? reply(series(m, (i) => (i === 10 ? 25 : i === 11 ? 31 : 9), { window: w })) : ordinary(m, w) });
    const card = (await screen.findByRole("heading", { name: "The two numbers the block-cutting rule watches" })).closest("div")!;
    await waitFor(() => expect(card).toHaveTextContent("31.0 s by the hour"));
    expect(card).toHaveTextContent("2 steps above 20 s");
  });

  it("gives the faucet's requests, what it sent, its time to final, and says what it did not record", async () => {
    await open();
    const card = (await screen.findByRole("heading", { name: "Faucet" })).closest("section")!;
    const w = within(card);
    expect(w.getByText("Requests").parentElement).toHaveTextContent("1,388");
    expect(w.getByText("Sent").parentElement).toHaveTextContent("1,311");
    expect(w.getByText("Sent").parentElement).toHaveTextContent("all final");
    expect(w.getByText("Turned away by the limits").parentElement).toHaveTextContent("Not recorded");
    expect(w.getByText("Time to final, faucet sends").parentElement).toHaveTextContent("45.8 s");
    expect(w.getByRole("link", { name: /Open the faucet/ })).toHaveAttribute("href", "/faucet");
  });

  it("gives the number turned away when the server counts it, and the balance and queue when the faucet is on", async () => {
    await open("/stats?window=7d", {
      faucetOn: true,
      summary: () => reply(summary({ faucet: { ...summary().faucet, turnedAway: 77 } })),
      faucet: () => reply({ on: true, address: "0x" + "fa".repeat(20), balance: "998996990000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0 }),
    });
    const card = (await screen.findByRole("heading", { name: "Faucet" })).closest("section")!;
    expect(within(card).getByText("Turned away by the limits").parentElement).toHaveTextContent("77");
    await waitFor(() => expect(within(card).getByText("Faucet balance").parentElement).toHaveTextContent("998,996.99"));
    expect(within(card).getByText("Faucet balance").parentElement).toHaveTextContent("queue now 0");
  });

  it("shows a dash, not a zero or NaN, for what a window with no block cannot say", async () => {
    await open("/stats?window=1h", {
      summary: () => reply(summary({
        window: "1h", rows: "minute", timeToFinal: null, proofTime: null, commitTime: null, blockTime: null, served: null,
        txsPerBlock: { mean: null, median: null, max: null, nonEmptyMean: null, nonEmptyMedian: null },
        blocks: { count: 0, empty: 0, busy: 0, bySize: [] }, txs: { count: 0, failed: 0, successRate: null, accepted: 0, allTime: null }, tps: { now: 0, peak: null, peakAt: null },
        attempts: { total: 0, refused: 0, failed: 0, notTaken: 0, refusedShare: null, failedShare: null, notTakenShare: null }, faucet: { requests: 0, sent: 0, final: 0, failed: 0, timeToFinal: null, turnedAway: null },
      })),
    });
    expect(await tile("Time to final")).toHaveTextContent("—");
    expect(await tile("Peak rate")).toHaveTextContent("—");
    expect(await tile("Success rate")).toHaveTextContent("—");
    expect(document.body.textContent).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("says so when the rollups have not run, instead of drawing empty numbers as facts", async () => {
    await open("/stats?window=7d", { summary: () => reply(summary({ asOf: null, dataSince: null })) });
    expect(await screen.findByText(/The rollups have not run yet/)).toBeInTheDocument();
  });

  it("says that the stats cannot be read when the summary fails, and a chart that cannot be read says so in its own card", async () => {
    fakeApi(Object.assign((p: string): Reply => (p.startsWith("/api/stats/summary") ? reply({ error: "the database cannot be read" }, 503) : route({})(p)), { routed: true }));
    renderApp("/stats");
    expect(await screen.findByText("Cannot read the chain")).toBeInTheDocument();
  });

  it("keeps the rest of the page when one chart cannot be read", async () => {
    await open("/stats?window=7d", { series: (m, w) => (m === "busy_ratio" ? reply({ error: "the database cannot be read" }, 503) : ordinary(m, w)) });
    const busy = (await screen.findByRole("heading", { name: "Prover busy" })).closest("section")!;
    await waitFor(() => expect(busy).toHaveTextContent("This chart cannot be read right now"));
    expect(await tile("Time to final")).toHaveTextContent("8.4 s");
  });
});
