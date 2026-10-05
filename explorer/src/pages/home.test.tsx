// @vitest-environment jsdom
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiStatus } from "../api.ts";
import { fakeApi, hash, renderApp, status, T0, update } from "../test-utils.tsx";

const NOW = Date.parse("2026-10-04T01:37:27Z");
const home = async (over: Partial<ApiStatus> = {}, code = 200) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const calls = fakeApi(() => ({ status: code, body: status(over) }));
  renderApp("/");
  await screen.findByText("Final on Canton");
  return calls;
};
const strip = () => within(screen.getByRole("region", { name: "Chain status" }));

describe("the home page's status strip", () => {
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
    expect(screen.getByRole("link", { name: "0x0303…0303" })).toBeInTheDocument();
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
    fakeApi(() => ({ status: 503, body: status({ ok: false, canton: false }) }));
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

describe("the list of latest final blocks", () => {
  it("shows each block with its hash, transactions, Canton update, time and the time to commit", async () => {
    await home();
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
    expect(first.getByRole("link", { name: "0x0303…0303" })).toHaveAttribute("href", `/block/${hash(3)}`);
    expect(first.getByText("1220 0303…0303")).toBeInTheDocument();
    expect(first.queryByRole("link", { name: /1220/ })).toBeNull();
    expect(first.getByText("01:37:16 UTC")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("7 s");
    expect(first.getByText("Final")).toHaveClass("chip-final");
    const cells = within(rows[1]!).getAllByRole("cell");
    expect(cells[2]).toHaveTextContent("0");
    expect(cells[5]).toHaveTextContent("0 s");
  });

  it("reads the columns in a plain order and explains the list", async () => {
    await home();
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Block", "Hash", "Txs", "Canton update", "Made", "Committed after", ""]);
    expect(screen.getByText("Each block is one transaction on Canton, so this is also the list of the chain's Canton updates.")).toBeInTheDocument();
    expect(screen.getByText("Showing all 2 final blocks so far.")).toBeInTheDocument();
  });

  it("writes a long wait in minutes, and never a negative one", async () => {
    await home({
      latest: [
        { number: 5, hash: hash(5), timestamp: T0 + 100, txCount: 1, updateId: update(5), recordTime: new Date((T0 + 100) * 1000 - 500).toISOString() },
        { number: 4, hash: hash(4), timestamp: T0, txCount: 1, updateId: update(4), recordTime: new Date((T0 + 200) * 1000).toISOString() },
      ],
    });
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("0 s");
    expect(rows[1]).toHaveTextContent("3 min 20 s");
  });

  it("says when ten are shown, and when there are none", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ number: 20 - i, hash: hash(20 - i), timestamp: T0, txCount: 0, updateId: update(20 - i), recordTime: "2026-10-04T01:37:09.000Z" }));
    await home({ latest: ten });
    expect(screen.getByText("Showing the newest ten final blocks.")).toBeInTheDocument();
  });

  it("has an empty state", async () => {
    await home({ latest: [], final: null });
    expect(screen.getByText("No final blocks yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("what this explorer can and cannot show", () => {
  it("says it, with the proof's size, on every look at the home page", async () => {
    await home();
    const box = within(screen.getByRole("region", { name: "What this explorer can and cannot show" }));
    expect(box.getByText("Every EVM block, transaction and address, and for each final block its record on Canton: the update id, the commit time and the proof.")).toBeInTheDocument();
    expect(box.getByText("Anything else on Canton. Daml legs settled with a block are not shown to the public. Only the two traders and the chain's operator, confirmer and builder see them, and each token's registry sees its own token move.")).toBeInTheDocument();
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
    const calls = fakeApi(() => ({ status: 200, body: status() }));
    renderApp("/");
    await screen.findByText("Final on Canton");
    const first = calls.filter((c) => c === "/api/status").length;
    await vi.advanceTimersByTimeAsync(4100);
    expect(calls.filter((c) => c === "/api/status").length).toBeGreaterThanOrEqual(first + 2);
  });
});
