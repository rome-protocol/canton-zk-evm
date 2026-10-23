// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiStatus, BlockListItem, StatsSummary, StatsWindow } from "../api.ts";
import { series, summary } from "./stats-fixtures.ts";
import { addr, blockItem, fakeApi, hash, inFlight, page, renderApp, reply, route, status, tokenItem, tx, txItem, update } from "../test-utils.tsx";

const NOW = Date.parse("2026-10-04T01:37:27Z");
const home = async (over: Partial<ApiStatus> = {}, code = 200, blocks?: BlockListItem[]) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const calls = fakeApi(route({ status: () => reply(status(over), code), ...(blocks && { blocks: () => reply(page(blocks)) }) }));
  renderApp("/");
  await screen.findByRole("region", { name: "Chain status" });
  // The lists are read once the first frame is drawn, so they arrive after the status.
  await vi.waitFor(() => expect(screen.queryByText("Reading the transactions…")).toBeNull());
  if (blocks) await screen.findByText(blocks.length ? "Latest final blocks" : "No final blocks yet.");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return calls;
};
const strip = () => within(screen.getByRole("region", { name: "Chain status" }));
/** /api/health with the named parts of screen 01 (the API's own reth row is left out of the count), and one of them, if named, not ok. */
const strip16 = (bad?: string, word: "degraded" | "down" = "degraded") => {
  const r = (id: string, role: string, value?: unknown) => ({ id, role, status: id === bad ? word : "ok", detail: id === bad ? "it says so" : null, ...(value ? { value } : {}) });
  return { status: "ok", instance: "api-1", starting: false, problems: [], checks: [
    r("api/api-1/reth", "api"), r("producer_alive", "indexer"), r("producer_state", "indexer"), r("prover", "indexer"), r("C5", "indexer", { lagBlocks: 0, lagSeconds: 0.3 }),
    r("faucet", "api"), r("verifier/compilers", "verifier"), r("C9", "indexer", { worstMs: 41, checked: 3 }),
  ] };
};

describe("the home page's status strip", () => {
  it("names how far the index is behind Canton, in blocks, and says nothing of it while that is not known", async () => {
    await home({ indexLag: 2 });
    expect(strip().getByText("Index lag 2 blocks")).toBeInTheDocument();
  });

  it("names no index lag when the status does not know it", async () => {
    await home({ indexLag: null });
    expect(strip().queryByText(/Index lag/)).toBeNull();
  });

  it("says the count of checks, names each part as screen 01 does, and the last final block with its time to the millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fakeApi(route({ health: () => reply(strip16()) }));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    await strip().findByText("All 6 checks ok");
    expect(strip().getByText("All 6 checks ok").closest(".sd")).toHaveClass("ok");
    for (const w of ["EVM node", "Canton ledger", "Producer", "Prover", "Index lag 0.3 s", "Faucet", "Verifier", "Clock gap 41 ms"]) expect(strip().getByText(w).closest(".sd")).toHaveClass("ok");
    const last = strip().getByText("Last final block", { exact: false });
    expect(within(last).getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
    expect(last).toHaveTextContent("Last final block 3 · 4 s ago · 01:37:23.412 UTC");
    expect(strip().queryByText("Final on Canton")).toBeNull();
  });

  it("marks a part red when its check is not ok", async () => {
    fakeApi(route({ health: () => reply(strip16("prover", "degraded")) }));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    await strip().findByText("1 of 6 checks not ok");
    expect(strip().getByText("Prover").closest(".sd")).toHaveClass("bad");
    expect(strip().getByText("Producer").closest(".sd")).toHaveClass("ok");
  });

  it("does not say all checks are ok in green beside a red Faucet: the faucet is the API's own check, so the count says whose checks it counts", async () => {
    fakeApi(route({ health: () => reply(strip16("faucet", "down")) }));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    await strip().findByText("All 6 indexer checks ok");
    expect(strip().getByText("Faucet").closest(".sd")).toHaveClass("bad");
    expect(strip().queryByText("All 6 checks ok")).toBeNull();
  });

  it("names the block when a check failed, in red", async () => {
    await home({ ok: false, problems: ["block 3: reth's hash is 0x1111…1111, the record's hash is 0x2222…2222"] }, 503);
    expect(strip().getByText("A check failed").closest(".sd")).toHaveClass("bad");
    expect(strip().getByText("block 3: reth's hash is 0x1111…1111, the record's hash is 0x2222…2222")).toBeInTheDocument();
    expect(strip().getByText("Last final block", { exact: false })).toBeInTheDocument();
  });

  it("says when Canton cannot be read, and keeps the blocks it last read", async () => {
    await home({ ok: false, canton: false }, 503);
    expect(strip().getByText("Canton ledger").closest(".sd")).toHaveClass("bad");
    expect(strip().getByText("Checks").closest(".sd")).toHaveClass("off");
    expect(strip().getByText("Canton cannot be read right now. The blocks below are what the explorer last read.")).toBeInTheDocument();
    expect(rowsOf()[0]).toHaveTextContent("12200303…0303");
  });

  it("says when the EVM node cannot be read", async () => {
    await home({ ok: false, evm: false }, 503);
    expect(strip().getByText("EVM node").closest(".sd")).toHaveClass("bad");
    expect(strip().getByText("The EVM node cannot be read right now. The blocks below are what the explorer last read.")).toBeInTheDocument();
  });

  it("says Starting while the first look is still reading the blocks, even with blocks already read", async () => {
    await home({ ok: false, starting: true }, 503);
    expect(strip().getByText("Starting").closest(".sd")).toHaveClass("off");
    expect(strip().queryByText("The explorer could not finish its last look at the chain.")).toBeNull();
    expect(strip().getByText("Reading the chain for the first time…", { exact: false })).toBeInTheDocument();
    expect(strip().getByText("block 3 so far", { exact: false })).toBeInTheDocument();
    expect(strip().queryByRole("link", { name: "Block 3" })).toBeNull();
    expect(strip().queryByText("committed", { exact: false })).toBeNull();
    expect(strip().queryByText("Being proven")).toBeNull();
  });

  it("says a failed check, in red, even while the first look is still going", async () => {
    await home({ ok: false, starting: true, problems: ["block 1: the record's parent is 0x6666…6666, not reth's genesis 0x0000…0000"] }, 503);
    expect(strip().getByText("A check failed").closest(".sd")).toHaveClass("bad");
    expect(strip().queryByText("Starting")).toBeNull();
    expect(strip().getByText("block 1: the record's parent is 0x6666…6666, not reth's genesis 0x0000…0000")).toBeInTheDocument();
  });

  it("says Starting with nothing read yet", async () => {
    await home({ ok: false, starting: true, final: null, proving: null, latest: [] }, 503);
    expect(strip().getByText("Starting").closest(".sd")).toHaveClass("off");
    expect(strip().getByText("Reading the chain for the first time…")).toBeInTheDocument();
    expect(strip().queryByText("Being proven")).toBeNull();
  });

  it("does not say Starting for a first look that failed, even with nothing read", async () => {
    await home({ ok: false, final: null, proving: null, latest: [] }, 503);
    expect(strip().queryByText("Starting")).toBeNull();
    expect(strip().getByText("The explorer could not finish its last look at the chain.")).toBeInTheDocument();
  });

  it("says when a look could not finish, with no check named", async () => {
    await home({ ok: false }, 503);
    expect(strip().getByText("Checks").closest(".sd")).toHaveClass("off");
    expect(strip().getByText("The explorer could not finish its last look at the chain.")).toBeInTheDocument();
  });

  it("says there is no final block yet, once it has looked", async () => {
    await home({ final: null, latest: [] });
    expect(strip().getByText("No final block yet.")).toBeInTheDocument();
  });

  it("keeps counting while the answer stays the same", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    fakeApi(route({ status: () => reply(status({ ok: false, canton: false }), 503) }));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    const last = async () => strip().findByText("Last final block", { exact: false });
    expect(await last()).toHaveTextContent("4 s ago");
    for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(await last()).toHaveTextContent("16 s ago");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(await last()).toHaveTextContent("17 s ago");
  });
});

const rowsOf = () => within(screen.getByRole("region", { name: "Latest final blocks" })).getAllByRole("row").slice(1);

describe("the list of latest final blocks", () => {
  it("shows each block with its transactions, time to final and Canton update, from the blocks route", async () => {
    await home();
    const rows = rowsOf();
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
    expect(first.getByRole("link", { name: "12200303…0303" })).toHaveAttribute("href", `/canton/${update(3)}`);
    expect(rows[0]).toHaveTextContent("7.40 s");
    expect(rows[0]).toHaveTextContent("11 s ago");
    expect(first.getByText("Final")).toHaveClass("chip-final");
    expect(within(rows[1]!).getAllByRole("cell")[1]).toHaveTextContent("2");
  });

  it("draws the cube before each block, and the Canton update as plain text with no copy or expand button, as screen 01 does", async () => {
    await home();
    const first = rowsOf()[0]!;
    expect(first.querySelector("td svg.ic")).not.toBeNull();
    expect(within(first).getAllByRole("cell")[0]!.querySelector(".idcell")).not.toBeNull();
    expect(within(first).queryByRole("button")).toBeNull();
    // The update is 8 characters, then 4: "12204594…b509".
    expect(within(first).getByRole("link", { name: "12200303…0303" })).toBeInTheDocument();
  });

  it("gives the time to final from the producer's cut to Canton's record time, and a dash where the producer's log has none", async () => {
    // The block was made 7.4 s before Canton's record, but its way to final began at the cut and took 8.09 s.
    await home({}, 200, [blockItem(3, { finalSeconds: 8.09 }), blockItem(2, { finalSeconds: 89.3 }), blockItem(1, { finalSeconds: null })]);
    const cells = rowsOf().map((r) => within(r).getAllByRole("cell")[2]!.textContent);
    expect(cells).toEqual(["8.09 s", "1 min 29 s", "—"]);
  });

  it("reads the columns in a plain order, says each block is one Canton transaction, and leads to all of them", async () => {
    await home();
    expect(within(screen.getByRole("region", { name: "Latest final blocks" })).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Block", "Txs", "Time to final", "Canton update", "Stage"]);
    expect(screen.getByText("One Canton transaction each")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View all blocks →" })).toHaveAttribute("href", "/blocks");
  });

  it("writes a long wait in minutes, and never a negative one", async () => {
    await home({}, 200, [blockItem(5, { finalSeconds: -0.5 }), blockItem(4, { finalSeconds: 200 })]);
    expect(rowsOf()[0]).toHaveTextContent("0.00 s");
    expect(rowsOf()[1]).toHaveTextContent("3 min 20 s");
  });

  it("has an empty state", async () => {
    await home({ latest: [], final: null }, 200, []);
    expect(screen.getByText("No final blocks yet.")).toBeInTheDocument();
  });

  it("says so in the list's own place when the blocks cannot be read, and keeps the rest of the page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fakeApi(route({ blocks: () => reply({ error: "The explorer cannot read the chain right now." }, 502) }));
    renderApp("/");
    expect(await screen.findByText("The explorer cannot read this list right now.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Chain status" })).toBeInTheDocument();
  });
});

describe("the list of latest transactions", () => {
  it("shows the hash, who sent it to whom, the value in the chain's coin, and that it is final", async () => {
    await home();
    const region = within(screen.getByRole("region", { name: "Latest transactions" }));
    const rows = region.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "0xa3a3a3…a3a3" })).toHaveAttribute("href", `/tx/${txItem(3).hash}`);
    expect(rows[0]).toHaveTextContent("0.25 tROME");
    expect(within(rows[0]!).getByRole("link", { name: "0x5b5b5b…5b5b" })).toHaveAttribute("href", `/address/${txItem(3).from}`);
    expect(within(rows[0]!).getByText("Final")).toHaveClass("chip-final");
    expect(region.getByRole("link", { name: "View all transactions →" })).toHaveAttribute("href", "/txs");
  });
});

describe("the list of latest transactions, with names and token moves", () => {
  const usd = { address: addr(0xcb), name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: true };
  const moved = { count: 3, more: false, first: { token: addr(0xcb), amount: "100000000", tokenId: null, standard: "ERC-20", decimals: 6 } };
  const withLabels = (items: unknown[]) => {
    const base = route({ txs: () => reply(page(items as never[])) });
    fakeApi(Object.assign((path: string) => (path.includes("/api/labels") ? reply({ items: [usd] }) : base(path)), { routed: true }));
  };

  it("shows the token a transaction moved as a chip, how many more it moved, and the receiver by name", async () => {
    withLabels([txItem(3, { value: "0", tokenMoves: moved }), txItem(2, { to: null, created: addr(0xd1) })]);
    renderApp("/");
    const region = within(await screen.findByRole("region", { name: "Latest transactions" }));
    const rows = (await region.findAllByRole("row")).slice(1);
    expect(await within(rows[0]!).findByText("100 tUSD")).toHaveClass("tname");
    expect(rows[0]).toHaveTextContent("+2");
    expect(await within(rows[0]!).findByRole("link", { name: "Test USD (tUSD)" })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
  });

  it("says Create: and the new contract's short address for a creation, and cuts the hash 8 and 4", async () => {
    withLabels([txItem(3, { to: null, created: addr(0xd1) })]);
    renderApp("/");
    const region = within(await screen.findByRole("region", { name: "Latest transactions" }));
    const row = (await region.findAllByRole("row"))[1]!;
    expect(row).toHaveTextContent("Create:");
    expect(within(row).getByRole("link", { name: "0xd1d1d1…d1d1" })).toHaveAttribute("href", `/address/${addr(0xd1)}`);
    expect(within(row).getByRole("link", { name: /^0xa3a3a3…a3a3$/ })).toBeInTheDocument();
  });
});

describe("the list of latest transactions, with the faucet", () => {
  it("names the faucet as the sender of its transactions", async () => {
    fakeApi(route({ faucet: () => reply({ on: true, address: txItem(3).from }) }));
    renderApp("/");
    const region = within(await screen.findByRole("region", { name: "Latest transactions" }));
    expect((await region.findAllByRole("link", { name: "Ostia faucet" }))[0]).toHaveAttribute("href", `/address/${txItem(3).from}`);
  });

  it("leaves a sender that is not the faucet as an address", async () => {
    fakeApi(route({ faucet: () => reply({ on: true, address: addr(0xfa) }) }));
    renderApp("/");
    const region = within(await screen.findByRole("region", { name: "Latest transactions" }));
    await region.findAllByRole("row");
    expect(region.queryByRole("link", { name: "Ostia faucet" })).toBeNull();
    expect(region.getAllByRole("link", { name: "0x5b5b5b…5b5b" }).length).toBeGreaterThan(0);
  });
});

describe("the list of latest transactions, with those not final yet", () => {
  const at = new Date(NOW - 4000).toISOString();
  const open = async (over: { txs?: () => ReturnType<typeof reply>; inFlight?: () => ReturnType<typeof reply>; tx?: (h: string) => ReturnType<typeof reply> } = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fakeApi(route({
      txs: over.txs,
      inFlight: over.inFlight ?? (() => reply(inFlight({ transactions: [{ hash: hash(0xb1), stage: "waiting", at }, { hash: hash(0xb2), stage: "proving", at }] }))),
      tx: over.tx ?? ((h) => reply(tx({ hash: h, status: h === hash(0xb1) ? "waiting" : "proving", state: h === hash(0xb1) ? "pending" : "proving", block: null, value: h === hash(0xb1) ? "250000000000000000" : "1000000000000000000", from: addr(0x71), to: addr(0x9b) }))),
    }));
    renderApp("/");
    await screen.findByText("Latest transactions");
    await vi.waitFor(() => expect(screen.queryByText("Reading the transactions…")).toBeNull());
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    return within(screen.getByRole("region", { name: "Latest transactions" }));
  };

  it("lists the transactions that are not final first, each with its stage, who sent it to whom and its value, and the final ones after them", async () => {
    const region = await open();
    const rows = region.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByRole("link", { name: "0xb1b1b1…b1b1" })).toHaveAttribute("href", `/tx/${hash(0xb1)}`);
    expect(within(rows[0]!).getByText("Waiting")).toHaveClass("chip-waiting");
    expect(rows[0]).toHaveTextContent("4 s ago");
    expect(rows[0]).toHaveTextContent("0.25 tROME");
    expect(within(rows[0]!).getByRole("link", { name: "0x717171…7171" })).toHaveAttribute("href", `/address/${addr(0x71)}`);
    expect(within(rows[1]!).getByText("Being proven")).toHaveClass("chip-proving");
    expect(rows[1]).toHaveTextContent("1 tROME");
    expect(within(rows[2]!).getByText("Final")).toHaveClass("chip-final");
    expect(within(rows[3]!).getByText("Final")).toHaveClass("chip-final");
    expect(region.getByText("Including those not final yet")).toBeInTheDocument();
  });

  it("keeps the stage of a transaction whose details cannot be read, and says so in place of who and how much", async () => {
    const region = await open({ tx: () => reply({ error: "no" }, 500) });
    const row = region.getAllByRole("row").slice(1)[0]!;
    expect(within(row).getByText("Waiting")).toBeInTheDocument();
    expect(row).toHaveTextContent("cannot be read right now");
    expect(row).not.toHaveTextContent("tROME");
  });

  it("says that those not final yet cannot be read, and still lists the final ones, when the in-flight route fails", async () => {
    const region = await open({ inFlight: () => reply({ error: "no" }, 500) });
    expect(region.getByText("Transactions not final yet cannot be read right now.")).toBeInTheDocument();
    expect(region.getAllByRole("row").slice(1)).toHaveLength(2);
  });

  it("lists those not final yet, and says there is no final one, when the final list is empty", async () => {
    const region = await open({ txs: () => reply(page([])) });
    const rows = region.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Waiting")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Being proven")).toBeInTheDocument();
    expect(region.getByText("No final transactions yet.")).toBeInTheDocument();
  });

  it("lists those not final yet, and says the final list cannot be read, when the final list fails", async () => {
    const region = await open({ txs: () => reply({ error: "no" }, 502) });
    expect(region.getAllByRole("row").slice(1)).toHaveLength(2);
    expect(region.getByText("The explorer cannot read this list right now.")).toBeInTheDocument();
  });

  it("lists only the final ones, with no note, when none is waiting or being proven", async () => {
    const region = await open({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null })) });
    expect(region.getAllByRole("row").slice(1)).toHaveLength(2);
    expect(region.queryByText(/cannot be read/)).toBeNull();
  });
});

/** The card whose label begins with `label`; the first one when two do. */
const tile = (label: string) => Array.from(screen.getByRole("region", { name: "Numbers" }).querySelectorAll(".stat")).find((e) => e.querySelector(".stat-k")!.textContent!.startsWith(label))! as HTMLElement;

/** The stats routes of the fake chain: the hour and the day have their own answers, the series is the median time to final by the hour over seven days. */
const statsRoute = (h: { hour?: Partial<StatsSummary>; day?: Partial<StatsSummary>; failing?: boolean; series?: (i: number, n: number) => number | null } = {}) => (path: string) => {
  if (h.failing) return reply({ error: "stats are down" }, 500);
  const u = new URL(path, "http://x");
  if (u.pathname === "/api/stats/series") return reply(series("time_to_final_p50", h.series ?? (() => 8.5), { window: u.searchParams.get("window") as StatsWindow }));
  const w = u.searchParams.get("window") as StatsWindow;
  return reply(summary({ window: w, ...(w === "1h" ? h.hour : h.day) }));
};
const withStats = (h: Parameters<typeof statsRoute>[0] = {}, flight?: () => ReturnType<typeof reply>) => async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const calls = fakeApi(route({ status: () => reply(status()), stats: statsRoute(h), ...(flight && { inFlight: flight }) }));
  renderApp("/");
  await screen.findByRole("region", { name: "Chain status" });
  // The day and the series are read once the first frame is drawn.
  await vi.waitFor(() => expect(calls.some((c) => c.startsWith("/api/stats/series"))).toBe(true));
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return calls;
};

describe("the numbers, from the stats routes", () => {
  it("shows the last hour's times from the hour's summary: time to final, proof time and Canton commit time, each with its 95th percentile", async () => {
    await withStats({ hour: { timeToFinal: { median: 8.5, p95: 8.7, samples: 12, capped: false }, proofTime: { median: 7.4, p95: 7.7, samples: 4, capped: false, bySize: [] }, commitTime: { median: 0.59, p95: 0.6, samples: 4, capped: false } } })();
    expect(tile("Time to final · last hour")).toHaveTextContent("8.5 s p95 8.7 saccepted to final on Canton, 12 transactions");
    expect(tile("Proof time · last hour")).toHaveTextContent("7.4 s p95 7.7 sZisK, one proof per block, 4 blocks");
    expect(tile("Canton commit time · last hour")).toHaveTextContent("0.59 s p95 0.60 ssent to Canton's record time");
  });

  it("shows the rate now with the busiest minute of the day, and says when it was", async () => {
    await withStats({ day: { tps: { now: 0.03, peak: 10.2, peakAt: "2026-10-04T12:49:00.000Z" } } })();
    expect(tile("Transactions per second")).toHaveTextContent("0.03 now peak 10.2peak: the busiest minute in 24 h, 12:49 UTC");
  });

  it("shows a rate of nothing as 0, and no peak when the day had no transaction", async () => {
    await withStats({ day: { tps: { now: 0, peak: null, peakAt: null }, txs: { count: 0, failed: 0, successRate: null, accepted: 0, allTime: null } } })();
    expect(tile("Transactions per second")).toHaveTextContent("0 nowno transaction in 24 h");
    expect(tile("Transactions per second")).not.toHaveTextContent("peak");
  });

  it("counts the day's transactions and blocks, and gives the success rate with the reverted ones, cut and never rounded up", async () => {
    await withStats({ day: { txs: { count: 1017, failed: 1, successRate: 1016 / 1017, accepted: 1017, allTime: null }, blocks: { count: 21, empty: 0, busy: 0, bySize: [] } } })();
    expect(tile("Transactions · 24 h")).toHaveTextContent("1,017total not counted yetin 21 blocks, each one Canton transaction");
    expect(tile("Success rate")).toHaveTextContent("99.9%1,016 of 1,017 final transactions; 1 reverted");
  });

  it("shows the all-time total under the day's count, with the block it is as of", async () => {
    await withStats({ day: { txs: { count: 1017, failed: 1, successRate: 1016 / 1017, accepted: 1017, allTime: { total: 1021, asOfBlock: 21, asOf: "2026-10-04T12:49:00.000Z" } }, blocks: { count: 21, empty: 0, busy: 0, bySize: [] } } })();
    expect(tile("Transactions · 24 h")).toHaveTextContent("1,0171,021 final in all · as of block 21 · test runs includedin 21 blocks, each one Canton transaction");
    expect(screen.getByText("1,021 final in all · as of block 21")).toHaveAttribute("title", "All time, as of block 21; runs marked as tests are counted");
  });

  it("says not counted yet, never 0, when the all-time total is not known", async () => {
    await withStats({ day: { txs: { count: 5, failed: 0, successRate: 1, accepted: 5, allTime: null }, blocks: { count: 2, empty: 0, busy: 0, bySize: [] } } })();
    expect(within(tile("Transactions · 24 h")).getByText("total not counted yet")).toBeInTheDocument();
    expect(tile("Transactions · 24 h")).not.toHaveTextContent("0 in all");
  });

  it("shows no success rate for a day with no transaction, and never makes one up", async () => {
    await withStats({ day: { txs: { count: 0, failed: 0, successRate: null, accepted: 0, allTime: null }, blocks: { count: 0, empty: 0, busy: 0, bySize: [] } } })();
    expect(tile("Success rate").querySelector(".stat-v")!.textContent).toBe("—");
    expect(tile("Success rate")).toHaveTextContent("no transaction in 24 h");
  });

  it("gives every card an icon before its label, as screen 01 does", async () => {
    await withStats()();
    const cards = Array.from(screen.getByRole("region", { name: "Numbers" }).querySelectorAll(".stat"));
    expect(cards).toHaveLength(10);
    for (const c of cards) expect(c.querySelector(".stat-k > svg.ic"), c.textContent!).not.toBeNull();
  });

  it("adds how many are stuck to what is not final yet, and says nothing of it while the stats are unread", async () => {
    await withStats({ hour: { acceptedNotFinal: { ...summary().acceptedNotFinal, stuck: 2 } } })();
    expect(tile("Not final yet")).toHaveTextContent("pool count not known · 2 stuck");
  });

  it("says nothing of stuck transactions when the stats cannot be read", async () => {
    await withStats({ failing: true })();
    expect(tile("Not final yet")).toHaveTextContent("pool count not known");
    expect(tile("Not final yet")).not.toHaveTextContent("stuck");
  });

  it("says none are lost, in green, and says how many and where to look when some are", async () => {
    await withStats()();
    expect(tile("Lost transactions").querySelector(".stat-v")!.textContent).toBe("0");
    expect(tile("Lost transactions").querySelector(".stat-v")).toHaveClass("ok");
    expect(tile("Lost transactions")).toHaveClass("stat-ok");
    expect(tile("Lost transactions")).toHaveTextContent("Accepted by Ostia and never made final");
  });

  it("names lost transactions in red and leads to the stats page, which lists them with the reason", async () => {
    await withStats({ day: { lost: { window: 2, total: 2, listed: [] } } })();
    const t = tile("Lost transactions");
    expect(t.querySelector(".stat-v")!.textContent).toBe("2");
    expect(t.querySelector(".stat-v")).toHaveClass("bad");
    expect(t).not.toHaveClass("stat-ok");
    expect(within(t).getByRole("link", { name: /Stats/ })).toHaveAttribute("href", "/stats");
  });

  it("draws the median time to final of the last 72 hours, one bar an hour, with a gap for an hour with no block", async () => {
    await withStats({ series: (i) => (i % 10 === 3 ? null : 8 + (i % 4)) })();
    const t = tile("Time to final · 72 h");
    expect(t.querySelectorAll(".stat-v svg rect")).toHaveLength(65); // the last 72 of 168 hourly points, and 7 of them (every 10th from 103) have no block
    expect(t.querySelector(".stat-v svg")).toHaveAccessibleName(/last 72 hours/);
    expect(t).toHaveTextContent("median per hour; gaps are hours with no blocks");
  });

  it("shows a dash and says why for every number the stats cannot give, while the rest of the page stays", async () => {
    await withStats({ failing: true })();
    for (const label of ["Time to final · last hour", "Proof time", "Canton commit time", "Transactions per second", "Transactions · 24 h", "Lost transactions", "Success rate", "Time to final · 72 h"]) {
      const t = tile(label);
      expect(t.querySelector(".stat-v")!.textContent, label).toBe("—");
      expect(t, label).toHaveTextContent("the stats cannot be read right now");
    }
    expect(tile("Block height")).toHaveTextContent("3");
  });

  it("asks for the hour, the day and the seven-day series, and for nothing from the blocks to fill its cards", async () => {
    const calls = await withStats()();
    expect(calls).toContain("/api/stats/summary?window=1h");
    expect(calls).toContain("/api/stats/summary?window=24h");
    expect(calls).toContain("/api/stats/series?metric=time_to_final_p50&window=7d&step=1h");
  });

  it("keeps the height, and what is not final yet from the in-flight route, and says nothing of a log window of ten blocks", async () => {
    await withStats()();
    expect(tile("Block height")).toHaveTextContent("3final on Canton · block 4 is being proven");
    expect(screen.getByRole("region", { name: "Numbers" })).not.toHaveTextContent(/latest \d+ blocks|producer log|not served yet/);
  });
});

describe("the value of a transaction that is not final yet", () => {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const at = "2026-10-04T01:37:58Z";
  const usd = { address: addr(0x9b), name: "Test USD", symbol: "tUSD", kind: "token", standard: "ERC-20", decimals: 6, verified: true };
  const proving = (over: Parameters<typeof tx>[0] = {}) => tx({ hash: hash(0xb2), status: "proving", state: "proving", block: null, success: null, logs: [], from: addr(0x71), to: addr(0x9b), value: "0", transfer: { symbol: "tUSD", decimals: 6, to: addr(0x72), value: "100000000" }, ...over });
  const open = async (t: ReturnType<typeof tx>, labels: unknown[] = [usd]) => {
    const base = route({ inFlight: () => reply(inFlight({ transactions: [{ hash: hash(0xb2), stage: "proving", at }] })), tx: () => reply(t) });
    fakeApi(Object.assign((path: string) => (path.includes("/api/labels") ? reply({ items: labels }) : base(path)), { routed: true }));
    renderApp("/");
    const region = within(await screen.findByRole("region", { name: "Latest transactions" }));
    return (await region.findAllByRole("row"))[1]!;
  };

  it("shows a proving transfer as the token chip, as screen 01 does, and not as 0 of the coin", async () => {
    const row = await open(proving());
    expect(await within(row).findByText("100 tUSD")).toHaveClass("tname");
    expect(row).not.toHaveTextContent("tROME");
  });

  it("adds the coin when some is sent with it", async () => {
    const row = await open(proving({ value: "1000000000000000000" }));
    expect(await within(row).findByText("100 tUSD")).toBeInTheDocument();
    expect(row).toHaveTextContent("1 tROME");
  });

  it("names the token by the symbol the transaction route read when the index does not know it yet", async () => {
    const row = await open(proving(), []);
    expect(await within(row).findByText("100 tUSD")).toBeInTheDocument();
  });

  it("shows a reverted transfer as reverted, with no chip built from its input", async () => {
    const row = await open(proving({ block: { number: 4, hash: null, updateId: null }, success: false }));
    await waitFor(() => expect(row).toHaveTextContent("reverted"));
    expect(row.querySelector(".tchip")).toBeNull();
    expect(row).not.toHaveTextContent("100 tUSD");
  });

  it("builds the chip from the Transfer in the receipt when there is one, not from the input", async () => {
    const logs = [{ address: addr(0x9b), topics: [TRANSFER, "0x" + "0".repeat(24) + "71".repeat(20), "0x" + "0".repeat(24) + "72".repeat(20)], data: "0x" + (7_000_000n).toString(16).padStart(64, "0") }];
    const row = await open(proving({ block: { number: 4, hash: null, updateId: null }, success: true, logs }));
    expect(await within(row).findByText("7 tUSD")).toHaveClass("tname");
    expect(row).not.toHaveTextContent("100 tUSD");
  });

  it("reads an NFT mint from the receipt's four-topic Transfer", async () => {
    const logs = [{ address: addr(0x9c), topics: [TRANSFER, "0x" + "0".repeat(64), "0x" + "0".repeat(24) + "72".repeat(20), "0x" + (3).toString(16).padStart(64, "0")], data: "0x" }];
    const nft = { address: addr(0x9c), name: "Test NFT", symbol: "tNFT", kind: "token", standard: "ERC-721", decimals: null, verified: true };
    const row = await open(proving({ to: addr(0x9c), block: { number: 4, hash: null, updateId: null }, success: true, logs, transfer: null }), [nft]);
    // The symbol stands in a <bdi> inside the name, so the name's text is read whole.
    await waitFor(() => expect(row.querySelector(".tname")).toHaveTextContent("tNFT #3"));
    expect(row.querySelector(".tname bdi")).toHaveTextContent("tNFT");
  });

  const topic = (b: number) => "0x" + "0".repeat(24) + b.toString(16).padStart(2, "0").repeat(20);
  const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  const done = { block: { number: 4, hash: null, updateId: null }, success: true };

  it("asks the labels route for the token of the receipt's Transfer when it is not the token the transaction was sent to", async () => {
    const other = { address: addr(0xa5), name: "Other USD", symbol: "tOTH", kind: "token", standard: "ERC-20", decimals: 6, verified: true };
    const logs = [{ address: addr(0xa5), topics: [TRANSFER, topic(0x71), topic(0x72)], data: word(2_000_000n) }];
    const row = await open(proving({ ...done, to: addr(0x77), logs, transfer: null }), [other]);
    expect(await within(row).findByText("2 tOTH")).toHaveClass("tname");
  });

  it("takes only the log shapes the indexer takes: 3 topics with one 32-byte word, 4 topics with no data", async () => {
    const logs = [
      { address: addr(0x9b), topics: [TRANSFER, topic(0x71), topic(0x72)], data: "0x" },
      { address: addr(0x9b), topics: [TRANSFER, topic(0x71), topic(0x72)], data: word(1n) + "00" },
      { address: addr(0x9c), topics: [TRANSFER, topic(0x71), topic(0x72), word(3n)], data: word(1n) },
      { address: addr(0x9b), topics: [TRANSFER, topic(0x71), topic(0x72)], data: word(5_000_000n) },
    ];
    const row = await open(proving({ ...done, logs }));
    expect(await within(row).findByText("5 tUSD")).toBeInTheDocument();
  });

  it("shows no chip for a receipt whose only Transfer is not shaped as the standards say", async () => {
    const logs = [{ address: addr(0x9b), topics: [TRANSFER, topic(0x71), topic(0x72)], data: "0x" }];
    const row = await open(proving({ ...done, logs, transfer: null, value: "1000000000000000000" }));
    await waitFor(() => expect(row).toHaveTextContent("1 tROME"));
    expect(row.querySelector(".tchip")).toBeNull();
  });

  it("shows the coin alone when the transaction decodes to no transfer", async () => {
    const row = await open(proving({ transfer: null, value: "1000000000000000000" }));
    await waitFor(() => expect(row).toHaveTextContent("1 tROME"));
    expect(row.querySelector(".tchip")).toBeNull();
  });
});

describe("the hero", () => {
  const tries = () => within(screen.getByRole("region", { name: "Ostia block explorer" }).querySelector(".try") as HTMLElement).getAllByRole("link");
  it("puts the search box under the intro with the long placeholder of screen 01", async () => {
    await home();
    expect(screen.getAllByRole("searchbox", { name: "Search" })[0]).toHaveAttribute("placeholder", "Search by block number, transaction or block hash, address, or Canton update id");
  });

  it("offers the newest block, transaction, sender and Canton update, the hashes as screen 01 cuts them, and a token when there is one", async () => {
    fakeApi(route({ tokenPages: () => reply(page([tokenItem(0xcb)])) }));
    renderApp("/");
    await screen.findByRole("link", { name: "tUSD" });
    expect(tries().map((a) => a.textContent)).toEqual(["3", "0xa3a3a3…a3a3", "0x5b5b5b…5b5b", "122003030303…", "tUSD"]);
    expect(tries()[4]).toHaveAttribute("href", `/search?q=${addr(0xcb)}`);
    expect(tries()[3]).toHaveAttribute("href", `/search?q=${update(3)}`);
  });

  it("keeps a token's symbol in its own bidi-isolated element, whole in the tooltip, and cut short by the style", async () => {
    const hostile = "\u202eEvil".padEnd(256, "x");
    fakeApi(route({ tokenPages: () => reply(page([tokenItem(0xcb, { symbol: hostile })])) }));
    renderApp("/");
    await waitFor(() => expect(tries()).toHaveLength(5));
    const chip = tries()[4]!;
    expect(chip.querySelector("bdi.tname")?.textContent).toBe(hostile);
    expect(chip).toHaveAttribute("title", hostile);
    const css = readFileSync(join(import.meta.dirname, "home.css"), "utf8");
    const r = css.split("\n").find((l) => l.startsWith(".try .tname {")) ?? "";
    expect(r).toMatch(/max-width:\s*[\d.]+ch/);
    expect(r).toMatch(/overflow:\s*hidden/);
    expect(r).toMatch(/text-overflow:\s*ellipsis/);
    expect(r).toMatch(/white-space:\s*nowrap/);
    expect(r).toMatch(/unicode-bidi:\s*isolate/);
  });

  it("offers no token chip when the explorer knows no token", async () => {
    await home();
    expect(tries().map((a) => a.textContent)).toEqual(["3", "0xa3a3a3…a3a3", "0x5b5b5b…5b5b", "122003030303…"]);
  });
});

describe("what this explorer can and cannot show", () => {
  it("is one line, as on screen 01: what is shown, what is not, and who sees the legs, with no proof size or ZisK version", async () => {
    await home();
    const box = screen.getByRole("region", { name: "What this explorer can and cannot show" });
    expect(box).toHaveTextContent("What this explorer can and cannot show. Shown: every EVM block, transaction and address, and for each final block its record on Canton (update id, record time, synchronizer, offset and the proof). Not shown: anything else on Canton. Daml legs settled with a block are seen only by their parties, the chain's operator, confirmer, gateway and builder, and each token's registry.");
    expect(box.querySelectorAll("p")).toHaveLength(1);
    expect(box).not.toHaveTextContent("1.3.1");
  });

  it("leaves no wallet card on the home page", async () => {
    await home({ publicRpc: true });
    expect(screen.queryByRole("heading", { name: "Add Ostia to your wallet" })).toBeNull();
  });

  it("shows no count of Daml legs anywhere", async () => {
    await home();
    expect(document.body.textContent).not.toMatch(/\d+ legs?\b/i);
  });
});

describe("when the explorer cannot read the chain", () => {
  it("says so plainly, and keeps the shell", async () => {
    fakeApi(() => ({ status: 502, body: { error: "The explorer cannot read the chain right now." } }));
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Cannot read the chain" })).toBeInTheDocument();
    expect(screen.getByText("The explorer cannot read the chain right now.")).toBeInTheDocument();
    expect(screen.getByText("The page tries again in a few seconds.")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
});

describe("following the chain", () => {
  it("asks for the status again every two seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = fakeApi(route({}));
    renderApp("/");
    await screen.findByRole("region", { name: "Chain status" });
    const first = calls.filter((c) => c === "/api/status").length;
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls.filter((c) => c === "/api/status").length).toBeGreaterThanOrEqual(first + 2);
  });
});
