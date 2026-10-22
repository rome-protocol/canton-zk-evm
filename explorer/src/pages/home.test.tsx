// @vitest-environment jsdom
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiStatus, BlockListItem } from "../api.ts";
import { addr, blockItem, fakeApi, hash, inFlight, page, renderApp, reply, route, status, tx, txItem, update } from "../test-utils.tsx";

const NOW = Date.parse("2026-10-04T01:37:27Z");
const home = async (over: Partial<ApiStatus> = {}, code = 200, blocks?: BlockListItem[]) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const calls = fakeApi(route({ status: () => reply(status(over), code), ...(blocks && { blocks: () => reply(page(blocks)) }) }));
  renderApp("/");
  await screen.findByText("Final on Canton");
  if (blocks) await screen.findByText(blocks.length ? "Latest final blocks" : "No final blocks yet.");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return calls;
};
const strip = () => within(screen.getByRole("region", { name: "Chain status" }));

describe("the home page's status strip", () => {
  it("names how far the index is behind Canton, in blocks, and says nothing of it while that is not known", async () => {
    await home({ indexLag: 2 });
    expect(strip().getByText("Index lag 2 blocks")).toBeInTheDocument();
  });

  it("names no index lag when the status does not know it", async () => {
    await home({ indexLag: null });
    expect(strip().queryByText(/Index lag/)).toBeNull();
  });

  it("says what is final, how long it took to commit, and what is being proven", async () => {
    await home();
    expect(strip().getByText("EVM node").closest(".sd")).toHaveClass("ok");
    expect(strip().getByText("Canton").closest(".sd")).toHaveClass("ok");
    expect(strip().getByText("Checks pass").closest(".sd")).toHaveClass("ok");
    const final = strip().getByText("Final on Canton").parentElement!;
    expect(within(final).getByRole("link", { name: "Block 3" })).toHaveAttribute("href", "/block/3");
    expect(final).toHaveTextContent("committed 7 s after it was made · 01:37:23 UTC");
    const proving = strip().getByText("Being proven").parentElement!;
    expect(within(proving).getByRole("link", { name: "Block 4" })).toHaveAttribute("href", "/block/4");
    expect(proving).toHaveTextContent("made 3 s ago");
  });

  it("says when nothing is being proven", async () => {
    await home({ proving: null });
    expect(strip().getByText("None right now.")).toBeInTheDocument();
  });

  it("names the block when a check failed, in red", async () => {
    await home({ ok: false, problems: ["block 3: reth's hash is 0x1111…1111, the record's hash is 0x2222…2222"] }, 503);
    expect(strip().getByText("A check failed").closest(".sd")).toHaveClass("bad");
    expect(strip().getByText("block 3: reth's hash is 0x1111…1111, the record's hash is 0x2222…2222")).toBeInTheDocument();
    expect(strip().getByText("Final on Canton")).toBeInTheDocument();
  });

  it("says when Canton cannot be read, and keeps the blocks it last read", async () => {
    await home({ ok: false, canton: false }, 503);
    expect(strip().getByText("Canton").closest(".sd")).toHaveClass("bad");
    expect(strip().getByText("Checks").closest(".sd")).toHaveClass("off");
    expect(strip().getByText("Canton cannot be read right now. The blocks below are what the explorer last read.")).toBeInTheDocument();
    expect(rowsOf()[0]).toHaveTextContent("1220 0303…0303");
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
    await screen.findByText("Final on Canton");
    const proving = () => strip().getByText("Being proven").parentElement!;
    expect(proving()).toHaveTextContent("made 3 s ago");
    for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(proving()).toHaveTextContent("made 15 s ago");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(proving()).toHaveTextContent("made 16 s ago");
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
    expect(first.getByRole("link", { name: "1220 0303…0303" })).toHaveAttribute("href", `/canton/${update(3)}`);
    expect(rows[0]).toHaveTextContent("7.40 s");
    expect(rows[0]).toHaveTextContent("11 s ago");
    expect(first.getByText("Final")).toHaveClass("chip-final");
    expect(within(rows[1]!).getAllByRole("cell")[1]).toHaveTextContent("2");
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
    expect(screen.getByText("Final on Canton")).toBeInTheDocument();
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
    expect(within(rows[0]!).getByRole("link", { name: "0x5b5b5b…b5b5b" })).toHaveAttribute("href", `/address/${txItem(3).from}`);
    expect(within(rows[0]!).getByText("Final")).toHaveClass("chip-final");
    expect(region.getByRole("link", { name: "View all transactions →" })).toHaveAttribute("href", "/txs");
  });
});

describe("the list of latest transactions, with those not final yet", () => {
  const at = new Date(NOW - 4000).toISOString();
  const open = async (over: { inFlight?: () => ReturnType<typeof reply>; tx?: (h: string) => ReturnType<typeof reply> } = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fakeApi(route({
      inFlight: over.inFlight ?? (() => reply(inFlight({ transactions: [{ hash: hash(0xb1), stage: "waiting", at }, { hash: hash(0xb2), stage: "proving", at }] }))),
      tx: over.tx ?? ((h) => reply(tx({ hash: h, status: h === hash(0xb1) ? "waiting" : "proving", state: h === hash(0xb1) ? "pending" : "proving", block: null, value: h === hash(0xb1) ? "250000000000000000" : "1000000000000000000", from: addr(0x71), to: addr(0x9b) }))),
    }));
    renderApp("/");
    await screen.findByText("Latest transactions");
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
    expect(within(rows[0]!).getByRole("link", { name: "0x717171…17171" })).toHaveAttribute("href", `/address/${addr(0x71)}`);
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

  it("lists only the final ones, with no note, when none is waiting or being proven", async () => {
    const region = await open({ inFlight: () => reply(inFlight({ attempts: [], poolWaiting: null })) });
    expect(region.getAllByRole("row").slice(1)).toHaveLength(2);
    expect(region.queryByText(/cannot be read/)).toBeNull();
  });
});

/** The card whose label begins with `label`; the first one when two do. */
const tile = (label: string) => Array.from(screen.getByRole("region", { name: "Numbers" }).querySelectorAll(".stat")).find((e) => e.querySelector(".stat-k")!.textContent!.startsWith(label))! as HTMLElement;

describe("the numbers, from what the API gives today", () => {
  it("shows the height, the times of the newest blocks from the producer's log, their transactions and what is not final yet", async () => {
    await home({}, 200, [blockItem(3, { finalSeconds: 8.5, proofSeconds: 7.4 }), blockItem(2, { finalSeconds: 8.5, proofSeconds: 7.4 })]);
    expect(tile("Block height")).toHaveTextContent("3final on Canton · block 4 is being proven");
    expect(tile("Time to final")).toHaveTextContent("latest 2 blocks8.5 s p95 8.5 sfrom the producer's cut to Canton's record time");
    expect(tile("Proof time")).toHaveTextContent("latest 2 blocks7.4 s p95 7.4 sZisK, one proof per block, 2 blocks · producer log");
    expect(tile("Transactions ·")).toHaveTextContent("2in 2 final blocks");
  });

  it("shows a dash and says why when the producer's log has no times for the blocks", async () => {
    await home({}, 200, [blockItem(3, { finalSeconds: null, proofSeconds: null, commitSeconds: null })]);
    expect(tile("Time to final")).toHaveTextContent("—the producer's log has no times for these blocks");
    expect(tile("Proof time")).toHaveTextContent("—the producer's log has no times for these blocks");
  });

  it("fills the Canton commit time from the latest blocks, the producer's submit to Canton's record time, and says so", async () => {
    await home({}, 200, [blockItem(3, { commitSeconds: 0.9 }), blockItem(2, { commitSeconds: 0.7 })]);
    expect(tile("Canton commit time")).toHaveTextContent("0.9");
    expect(tile("Canton commit time")).toHaveTextContent("latest 2 blocks");
    expect(tile("Canton commit time")).toHaveTextContent("producer log");
  });

  it("shows a dash and names the missing source for each number that needs the stats rollups, and invents none", async () => {
    await home();
    for (const label of ["Transactions per second", "Lost transactions", "Success rate", "Time to final · 72 h"]) {
      const t = tile(label);
      expect(t, label).toHaveTextContent("—");
      expect(t, label).toHaveTextContent("not served yet: the API has no stats route for it");
      expect(t.querySelector(".stat-v")!.textContent, label).toBe("—");
    }
  });
});

describe("what this explorer can and cannot show", () => {
  it("says it, with the proof's size, on every look at the home page", async () => {
    await home();
    const box = within(screen.getByRole("region", { name: "What this explorer can and cannot show" }));
    expect(box.getByText("Every EVM block, transaction and address, and for each final block its record on Canton: the update id, the commit time and the proof.")).toBeInTheDocument();
    expect(box.getByText("Anything else on Canton. Daml legs settled with a block are not shown to the public. Only the parties to each leg and the chain's operator, confirmer, gateway and builder see them, and each token's registry sees its own token move.")).toBeInTheDocument();
    expect(box.getByText("Every block is proven with ZisK 1.3.1 (a 1,344-byte proof) and checked by Canton's confirmers before it commits. Each block page can run that same check again, in your browser.")).toBeInTheDocument();
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
    await screen.findByText("Final on Canton");
    const first = calls.filter((c) => c === "/api/status").length;
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls.filter((c) => c === "/api/status").length).toBeGreaterThanOrEqual(first + 2);
  });
});
