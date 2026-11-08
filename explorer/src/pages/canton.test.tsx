// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UpdateAroundItem, UpdateDetail, UpdateRow } from "../api.ts";
import { block, cantonStats, fakeApi, hash, NOT_FOUND, page, renderApp, reply, plainLeg, route, rowFields, tx, txItem, update, updateView } from "../test-utils.tsx";

const SYNC = "da::1220" + "e8".repeat(32);
const item = (n: number, over: Partial<UpdateRow> = {}): UpdateRow => ({
  updateId: update(n), recordTime: `2026-10-04T01:37:${10 + n}.230583Z`, effectiveAt: null, participant: "reader-1", offset: 60 + n, synchronizer: SYNC, block: n, txCount: n % 3, ...rowFields(), ...over,
});
const near = (n: number, over: Partial<UpdateAroundItem> = {}): UpdateAroundItem => ({ ...item(n), submittedTemplate: "Zk.Chain:ZkChain", submittedChoice: "Advance", txCount: n * 2, ...over });
const detail = (over: Partial<UpdateDetail> = {}): UpdateDetail => ({
  ...item(3), template: { packageId: "ccd743bc" + "ab".repeat(28), packageName: "zk-chain", module: "Zk.Chain", entity: "BlockRecord" }, contractId: "00be6996af" + "25".repeat(30), blockHash: hash(3),
  signatories: [{ role: "operator", party: "operator::1220" + "ab".repeat(32) }, { role: "confirmer", party: "confirmer::1220" + "cd".repeat(32) }],
  producerRecord: { template: "Zk.Chain:ZkChain", choice: "Advance", commandId: "advance-3-1", argumentBytes: 2080, trafficBytes: null }, view: updateView(), ...over,
});
const NOW = Date.parse("2026-10-04T02:00:00Z");

describe("the Canton updates page", () => {
  const open = async (h: Parameters<typeof route>[0] = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const calls = fakeApi(route({ updates: () => reply(page([item(4), item(3)])), cantonStats: () => reply(cantonStats()), ...h }));
    renderApp("/canton");
    await screen.findByRole("table");
    return calls;
  };
  const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

  it("lists the updates newest first, with the reader's offset, the record time and the block each carries", async () => {
    await open();
    expect(rows()).toHaveLength(2);
    const r = within(rows()[0]!);
    expect(rows()[0]).toHaveTextContent("2026-10-04T01:37:14.230583Z");
    expect(r.getByRole("link", { name: "12200404…0404" })).toHaveAttribute("href", `/canton/${update(4)}`);
    expect(r.getByRole("link", { name: "Block 4" })).toHaveAttribute("href", "/block/4");
  });

  it("names the page so the link is obvious, says what an update carries, and shows the block, the number of EVM transactions and the record time of each", async () => {
    await open({ updates: () => reply(page([item(4, { txCount: 7 }), item(3, { block: null, txCount: null })])) });
    expect(screen.getByRole("heading", { name: "Linked to Canton" })).toBeInTheDocument();
    expect(screen.getByText("carries one block and all of its EVM transactions", { exact: false })).toBeInTheDocument();
    expect(rows()[0]).toHaveTextContent(/Block 4\s*7 EVM transactions/);
    expect(rows()[0]).toHaveTextContent("2026-10-04T01:37:14");
    expect(rows()[1]).toHaveTextContent(/none\s*—/);
  });

  it("names the count for a phone with the right singular and plural: 1 EVM transaction, 0 and 2 EVM transactions", async () => {
    await open({ updates: () => reply(page([item(5, { txCount: 2 }), item(4, { txCount: 1 }), item(3, { txCount: 0 })])) });
    expect(within(rows()[0]!).getByText("EVM transactions", { exact: false }).textContent).toBe(" EVM transactions");
    expect(within(rows()[1]!).getByText("EVM transaction", { exact: false }).textContent).toBe(" EVM transaction");
    expect(rows()[1]).not.toHaveTextContent("EVM transactions");
    expect(within(rows()[2]!).getByText("EVM transactions", { exact: false })).toBeInTheDocument();
  });

  it("says where the offsets are, and keeps the page note to the one explanation", async () => {
    await open();
    expect(screen.getByText(/The offset and the synchronizer of an update are on its page/)).toBeInTheDocument();
    expect(screen.queryByText(/builder's own completion offset/)).toBeNull();
    expect(screen.getByText(/^Each Canton update carries one block and all of its EVM transactions; the external call inside it checks the block's proof\.$/)).toBeInTheDocument();
  });

  it("pages by the server's cursor", async () => {
    const user = userEvent.setup();
    const calls = await open({ updates: (path) => reply(path.includes("before=u1") ? page([item(1)]) : page([item(4), item(3)], "u1")) });
    await user.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(calls).toContain("/api/canton/updates?limit=25&before=u1");
    expect(rows()).toHaveLength(1);
  });
});

describe("one Canton update", () => {
  it("lists the EVM transactions it settled, each linked to its page", async () => {
    const calls = await open({ updateTxs: () => reply(page([txItem(3), txItem(4)])) });
    const t = within(await screen.findByRole("region", { name: "EVM transactions in this update" }));
    await t.findAllByRole("link", { name: /^0x/ });
    expect(calls).toContain(`/api/canton/updates/${update(3)}/transactions?limit=25`);
    expect(t.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(expect.arrayContaining([`/tx/${txItem(3).hash}`, `/tx/${txItem(4).hash}`]));
    expect(t.getAllByRole("row")).toHaveLength(3);
  });

  it("says the update carries no block, without asking for transactions or suggesting an outage", async () => {
    const calls = await open({ update: () => reply(detail({ block: null, txCount: null })), updateTxs: () => ({ status: 404, body: {} }) });
    expect(await screen.findByText("This update carries no block.")).toBeInTheDocument();
    expect(calls.some((c) => c.includes("/transactions"))).toBe(false);
    expect(screen.queryByText(/cannot read the transactions/)).toBeNull();
  });

  it("says so when the update settled no transactions", async () => {
    await open({ updateTxs: () => reply(page([])) });
    expect(await screen.findByText("This update settled no EVM transactions.")).toBeInTheDocument();
  });

  const open = async (h: Parameters<typeof route>[0] = {}, id = update(3)) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const calls = fakeApi(route({ update: () => reply(detail()), around: () => reply({ items: [near(4), near(3), near(2)] }), ...h }));
    renderApp(`/canton/${id}`);
    await screen.findByRole("heading", { name: "Canton update" });
    return calls;
  };
  const side = (name: string) => within(screen.getByRole("region", { name }));
  const row = (scope: ReturnType<typeof within>, label: string) => scope.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;

  it("shows the update as the reader party sees it: id, record time, synchronizer, offset, the block record it created and who signed it", async () => {
    const calls = await open();
    expect(calls).toContain(`/api/canton/updates/${update(3)}`);
    const c = side("On Canton");
    expect(row(c, "Update id")).toHaveTextContent(update(3));
    expect(row(c, "Record time")).toHaveTextContent("2026-10-04T01:37:13.230583Z");
    expect(row(c, "Record time")).toHaveTextContent("22 min 47 s ago");
    expect(row(c, "Synchronizer id")).toHaveTextContent(SYNC);
    expect(row(c, "Offset")).toHaveTextContent("63");
    expect(row(c, "Offset")).toHaveTextContent("on the reader's participant");
    expect(row(c, "Created")).toHaveTextContent("Zk.Chain:BlockRecord · contract 00be69…2525");
    expect(row(c, "Created")).toHaveTextContent("package ccd743bc…abab");
    expect(row(c, "Signed by")).toHaveTextContent("the chain's operator");
    expect(row(c, "Signed by")).toHaveTextContent("operator::1220" + "ab".repeat(32));
    expect(row(c, "Signed by")).toHaveTextContent("the chain's confirmer");
  });

  it("labels the template, the choice and the command id as the producer log's, and leaves their words out when the log does not hold the update", async () => {
    await open();
    const c = side("On Canton");
    expect(row(c, "Template")).toHaveTextContent("Zk.Chain:ZkChain");
    expect(within(row(c, "Template")).getByText("producer log")).toHaveClass("tag");
    expect(row(c, "Choice")).toHaveTextContent("Advance · exercised on the chain's head contract");
    expect(within(row(c, "Choice")).getByText("producer log")).toHaveClass("tag");
    expect(row(c, "Command id")).toHaveTextContent("advance-3-1");
    expect(within(row(c, "Command id")).getByText("producer log")).toHaveClass("tag");
    expect(row(c, "Carried")).toHaveTextContent("2,080 bytes in the argument");
    expect(within(row(c, "Carried")).getByText("2,080")).toHaveClass("num");
  });

  it("says the template and the choice are not in the producer's log when the log does not hold the update, and shows no command id", async () => {
    await open({ update: () => reply(detail({ producerRecord: null })) });
    const c = side("On Canton");
    expect(row(c, "Template")).toHaveTextContent("not in the producer's log");
    expect(row(c, "Choice")).toHaveTextContent("not in the producer's log");
    expect(screen.queryByText("Command id")).toBeNull();
  });

  it("heads the page with Final on Canton, the block the record is of, the update id to copy, and the neighbouring blocks", async () => {
    await open();
    expect(screen.getByText("Final on Canton")).toHaveClass("chip-final");
    expect(screen.getByText("the record of block 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open block 3" })).toHaveAttribute("href", "/block/3");
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.getByRole("link", { name: "block 2" })).toHaveAttribute("href", "/block/2");
    expect(row(side("On the EVM"), "Block hash")).toHaveTextContent(hash(3));
  });

  it("draws the next block's link only when that block is final, so the newest final update has none", async () => {
    await open();
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(nav.queryByRole("link", { name: "block 4" })).toBeNull();
  });

  it("links the next block when it is final", async () => {
    await open({ update: () => reply(detail({ ...item(2), blockHash: hash(2) })) }, update(2));
    const nav = within(screen.getByRole("navigation", { name: "Neighbouring blocks" }));
    expect(await nav.findByRole("link", { name: "block 3" })).toHaveAttribute("href", "/block/3");
  });

  it("joins the two sides with the one block, the one Canton transaction and the block's hash", async () => {
    await open();
    const mid = within(screen.getByRole("group", { name: "The block and its Canton transaction" }));
    expect(mid.getByText("one block, one Canton transaction")).toBeInTheDocument();
    expect(mid.getByRole("link", { name: hash(3).slice(0, 6) + "…" + hash(3).slice(-4) })).toHaveAttribute("href", `/block/${hash(3)}`);
  });

  it("fills the EVM side from the block: parent, time, transactions, gas, state root, proof and hashes", async () => {
    await open({ block: () => reply(block()), tx: () => reply(tx({ value: "100000000000000000" })) });
    const e = side("On the EVM");
    await vi.waitFor(() => expect(row(e, "Transactions")).toHaveTextContent("1"));
    expect(row(e, "Block")).toHaveTextContent("3 Final");
    expect(row(e, "Parent")).toHaveTextContent(`Block 2 · ${hash(2).slice(0, 6)}`);
    expect(row(e, "Block time")).toHaveTextContent("01:37:16 UTC");
    expect(row(e, "Block time")).toHaveTextContent("made 7.4 s before the record time");
    expect(row(e, "Gas used")).toHaveTextContent("51,698 of 30,000,000");
    expect(row(e, "State root")).toHaveTextContent(hash(0x10).slice(0, 6));
    expect(row(e, "Hashes")).toHaveTextContent("reth, the record and the record's header give the same hash");
    expect(within(screen.getByRole("main")).queryByText("Base fee")).toBeNull();
  });

  it("summarises the block's transaction: its hash, what it carried and from whom to whom", async () => {
    await open({ block: () => reply(block()), tx: () => reply(tx({ value: "100000000000000000" })) });
    await side("On the EVM").findByText("Transactions");
    const t = row(side("On the EVM"), "Transactions");
    await vi.waitFor(() => expect(t).toHaveTextContent("0.1 tROME"));
    expect(within(t).getByRole("link", { name: hash(0xf6).slice(0, 10) + "…" + hash(0xf6).slice(-6) })).toHaveAttribute("href", `/tx/${hash(0xf6)}`);
    expect(t).toHaveTextContent(/0\.1 tROME, 0x[0-9a-f]{4}…[0-9a-f]{4} to 0x[0-9a-f]{4}…[0-9a-f]{4}/);
  });

  it("counts the rest when the block holds more than the one transaction summarised", async () => {
    const b = block({ txCount: 3 });
    await open({ block: () => reply(b), tx: () => reply(tx({ value: "0" })) });
    await vi.waitFor(() => expect(row(side("On the EVM"), "Transactions")).toHaveTextContent("3 · "));
    expect(row(side("On the EVM"), "Transactions")).toHaveTextContent("and 2 more");
  });

  it("says the transaction's value cannot be read right now when its route fails, and keeps the hash and the parties", async () => {
    await open({ block: () => reply(block()), tx: () => reply({ error: "down" }, 503) });
    await side("On the EVM").findByText("Transactions");
    const t = row(side("On the EVM"), "Transactions");
    await vi.waitFor(() => expect(t).toHaveTextContent("cannot be read right now"));
    expect(t).toHaveTextContent(hash(0xf6).slice(0, 6));
  });

  it("says a block of no transactions has none", async () => {
    await open({ block: () => reply(block({ txCount: 0, transactions: [] })) });
    await vi.waitFor(() => expect(row(side("On the EVM"), "Transactions")).toHaveTextContent("0"));
    expect(row(side("On the EVM"), "Transactions")).not.toHaveTextContent("cannot be read");
  });

  it("gives the proof's size and each fact read from it: ours, ZisK 1.3.1, this block", async () => {
    await open({ block: () => reply(block()) });
    await within(screen.getByRole("region", { name: "On the EVM" })).findByText("ours");
    const p = row(side("On the EVM"), "Proof");
    expect(p).toHaveTextContent("1,344 bytes");
    for (const w of ["ours", "ZisK 1.3.1", "this block"]) expect(p).toHaveTextContent(w);
  });

  it("names the fact that does not match the pin, and says when the proof's facts cannot be read", async () => {
    const b = block();
    const bad = { ...b, canton: { ...b.canton!, proof: { ...b.canton!.proof!, programVK: { value: "0xaa", ok: false } } } };
    await open({ block: () => reply(bad) });
    expect(await within(await screen.findByRole("region", { name: "On the EVM" })).findByText("program key is not ours")).toBeInTheDocument();
  });

  it("says the proof's facts cannot be read when the proof is not the size it should be", async () => {
    const b = block();
    await open({ block: () => reply({ ...b, canton: { ...b.canton!, proof: null, proofBytes: 12 } }) });
    expect(await within(screen.getByRole("region", { name: "On the EVM" })).findByText("its facts cannot be read")).toBeInTheDocument();
  });

  it("says the block cannot be read when the block route fails, and keeps the rows it has", async () => {
    await open({ block: () => reply({ error: "down" }, 503) });
    expect(await within(screen.getByRole("region", { name: "On the EVM" })).findByText("The block cannot be read right now.")).toBeInTheDocument();
    expect(row(side("On the EVM"), "Block hash")).toHaveTextContent(hash(3));
  });

  it("shows what the record holds: the three parts in proportion with their sizes, each to copy, and Verify as the main action", async () => {
    await open({ block: () => reply(block()) });
    const r = within(await screen.findByRole("region", { name: "What the record holds" }));
    expect(r.getByText("The three parts Verify checks; each can be copied as hex.")).toBeInTheDocument();
    expect(r.getByText("header 612 B")).toBeInTheDocument();
    expect(r.getByText("proof 1,344 B")).toBeInTheDocument();
    expect(r.getByText("header 612 bytes")).toBeInTheDocument();
    expect(r.getByText("transactions 181 bytes")).toBeInTheDocument();
    expect(r.getByText("proof 1,344 bytes")).toBeInTheDocument();
    expect(r.getByText(/2,137 bytes in all, carried hex-encoded in the Advance argument/)).toBeInTheDocument();
    for (const part of ["header", "transactions", "proof"]) expect(r.getByRole("button", { name: `Copy the ${part}` })).toHaveTextContent(part);
    expect(r.getByRole("link", { name: "Verify in your browser" })).toHaveAttribute("href", "/block/3");
  });

  it("states what the reader party sees and what it does not, in its own box", async () => {
    await open();
    const box = within(screen.getByRole("note", { name: "What the reader party sees" }));
    expect(box.getByText("What the reader party sees, and what it does not.")).toBeInTheDocument();
    expect(box.getByText(/Any Daml legs settled in the same Canton transaction are seen only by their parties/)).toBeInTheDocument();
    expect(box.getByText(/no other party id is shown/)).toBeInTheDocument();
    expect(box.getByText(/Canton's public scan does not list Ostia's activity; this page is read through the chain's own reader party/)).toBeInTheDocument();
  });

  it("shows the update ids around this one as plain hashes, with no copy or expand button", async () => {
    await open();
    const t = within(await screen.findByRole("region", { name: "Canton updates around this one" }));
    expect(t.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(t.queryByRole("button", { name: /full/i })).toBeNull();
  });

  it("lists the Canton updates around this one by the route's own window, marks this one, and leads to all of them", async () => {
    const calls = await open();
    const t = within(await screen.findByRole("region", { name: "Canton updates around this one" }));
    expect(calls).toContain(`/api/canton/updates/${update(3)}/around`);
    expect(t.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Offset", "Update id", "Record time", "Template · choice producer log", "EVM block", "Transactions"]);
    expect(within(t.getAllByRole("columnheader")[3]!).getByText("producer log")).toHaveClass("tag");
    const rows = t.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(rows[0]).toHaveTextContent("64");
    expect(rows[0]).toHaveTextContent("Zk.Chain:ZkChain · Advance");
    expect(rows[0]).toHaveTextContent("8");
    expect(within(rows[0]!).getByRole("link", { name: "12200404…0404" })).toHaveAttribute("href", `/canton/${update(4)}`);
    expect(within(rows[1]!).getByRole("link", { name: "12200303…0303" })).toHaveAttribute("href", `/canton/${update(3)}`);
    expect(within(rows[0]!).getByRole("link", { name: "Block 4" })).toHaveAttribute("href", "/block/4");
    expect(t.getByText("Ordered by record time and update id; offsets are on the reader's participant.")).toBeInTheDocument();
    expect(t.getByRole("link", { name: "All Canton updates" })).toHaveAttribute("href", "/canton");
  });

  it("says an update's template and choice are not in the producer's log when the route has none for it", async () => {
    await open({ around: () => reply({ items: [near(3, { submittedTemplate: null, submittedChoice: null }), near(2)] }) });
    const rows = within(await screen.findByRole("region", { name: "Canton updates around this one" })).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("not in the producer's log");
    expect(rows[1]).toHaveTextContent("Zk.Chain:ZkChain · Advance");
  });

  it("says which offsets the list skips, between which blocks, only where one participant's offsets are not consecutive", async () => {
    await open({ around: () => reply({ items: [near(5, { offset: 72, block: 19 }), near(4, { offset: 71, block: 18 }), near(3, { offset: 70, block: 17 }), near(2, { offset: 69, block: 16 }), near(1, { offset: 61, block: 15 })] }) });
    const t = within(await screen.findByRole("region", { name: "Canton updates around this one" }));
    expect(t.getByText("Offsets 62 to 68 belong to other updates on the reader's participant, between blocks 15 and 16. They carry no block, so they are not listed.")).toBeInTheDocument();
  });

  it("says nothing of skipped offsets when the offsets run on, or the participants differ", async () => {
    await open({ around: () => reply({ items: [near(5, { offset: 72 }), near(4, { offset: 71 }), near(3, { offset: 40, participant: "reader-0" })] }) });
    const t = within(await screen.findByRole("region", { name: "Canton updates around this one" }));
    expect(t.queryByText(/belong to other updates/)).toBeNull();
  });

  it("says the list cannot be read right now when the route fails, and keeps the rest of the page", async () => {
    await open({ around: () => reply({ error: "down" }, 503) });
    expect(await screen.findByText("The explorer cannot read the updates around this one right now.")).toBeInTheDocument();
    expect(row(side("On Canton"), "Update id")).toHaveTextContent(update(3));
  });

  it("says Not found with the server's words for an update it does not hold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fakeApi(route({ update: () => reply({ error: NOT_FOUND }, 404) }));
    renderApp(`/canton/${update(9)}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });
});
const NONE = { total: 0, deposit: 0, withdrawal: 0, payment: 0, lock: 0, release: 0 };

describe("the Linked to Canton view: header, rows, tabs and sort", () => {
  const open = async (h: Parameters<typeof route>[0] = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const calls = fakeApi(route({ updates: () => reply(page([item(4), item(3)])), cantonStats: () => reply(cantonStats()), ...h }));
    renderApp("/canton");
    await screen.findByRole("table");
    return calls;
  };
  const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
  const figures = () => within(screen.getByRole("region", { name: "Figures of the Canton commits" }));
  const tile = (name: string) => figures().getByText(name, { selector: ".stat-k", exact: false }).closest(".stat") as HTMLElement;

  it("shows the header figures from the stats route: blocks, success rate, settlement time with its window, refused and retried, and legs by kind", async () => {
    const calls = await open();
    await figures().findByText("120");
    expect(calls).toContain("/api/canton/stats?window=24h");
    expect(tile("Blocks committed")).toHaveTextContent("since 2026-09-20");
    expect(tile("Success rate")).toHaveTextContent("93.7%");
    expect(tile("Success rate")).toHaveTextContent("120 of 128 commit attempts");
    expect(tile("Settlement time")).toHaveTextContent("9.4 s");
    expect(tile("Settlement time")).toHaveTextContent("p95 14.3 s");
    expect(tile("Settlement time")).toHaveTextContent("average over 40 blocks, the last 24 hours");
    expect(tile("Refused or retried")).toHaveTextContent("5 refused");
    expect(tile("Refused or retried")).toHaveTextContent("3 blocks committed after a retry");
    expect(tile("Refused or retried")).toHaveTextContent("3 failed or unanswered");
    expect(tile("Legs settled")).toHaveTextContent("54");
    for (const w of ["12 deposits", "30 payments", "4 withdrawals", "6 locks", "2 releases"]) expect(tile("Legs settled")).toHaveTextContent(w);
  });

  it("gives the definition of the success rate on hover, and reads the 7-day window when it is picked", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} });
    const calls = await open({ cantonStats: (path) => reply(cantonStats(path.includes("7d") ? { settlement: { ...cantonStats().settlement, window: "7d", blocks: 300 } } : {})) });
    await figures().findByText("120");
    await user.hover(within(tile("Success rate")).getByRole("button", { name: "About Success rate" }));
    expect(await screen.findByText(/Blocks committed over commit attempts submitted to Canton, counted from 2026-09-21/)).toBeInTheDocument();
    await user.click(figures().getByRole("button", { name: "7 days" }));
    await vi.waitFor(() => expect(calls).toContain("/api/canton/stats?window=7d"));
    await vi.waitFor(() => expect(tile("Settlement time")).toHaveTextContent("average over 300 blocks, the last 7 days"));
  });

  it("leaves a figure out where nothing holds it: no rate with no attempt, no time with no timed block", async () => {
    await open({ cantonStats: () => reply(cantonStats({ successRate: null, attempts: { submitted: 0, committed: 0, refused: 0, other: 0, since: null }, settlement: { ...cantonStats().settlement, blocks: 0, averageSeconds: null, p95Seconds: null } })) });
    await figures().findByText("120");
    expect(tile("Success rate")).toHaveTextContent("—");
    expect(tile("Success rate")).toHaveTextContent("no commit attempt in the producer's log");
    expect(tile("Settlement time")).toHaveTextContent("no timed block in the last 24 hours");
    expect(within(tile("Settlement time")).queryByText(/^p95 /)).toBeNull();
  });

  it("says the figures cannot be read when the stats route fails, and still lists the updates", async () => {
    await open({ cantonStats: () => reply({ error: "down" }, 503) });
    expect(await screen.findByText("The explorer cannot read the figures right now.")).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
  });

  it("has a column for each of: update, block, EVM transactions, status, choice, legs, settlement time and record time", async () => {
    await open();
    const heads = within(screen.getByRole("table")).getAllByRole("columnheader").map((c) => c.textContent ?? "");
    expect(heads).toHaveLength(8);
    for (const [i, w] of ["Canton update", "EVM block", "EVM transactions", "Status", "Choice", "Legs", "Settlement time", "Record time"].entries()) expect(heads[i]).toContain(w);
  });

  it("shows a block committed on its first attempt, its choice as ZkChain then Advance, its legs by kind linked to the update, and its settlement time from the proof start", async () => {
    await open({ updates: () => reply(page([item(4, { legs: { ...NONE, total: 3, deposit: 2, payment: 1 } })])) });
    const r = within(rows()[0]!);
    expect(r.getByText("First attempt")).toHaveClass("chip");
    expect(rows()[0]).toHaveTextContent("ZkChain → Advance");
    expect(r.getByRole("link", { name: "2 deposits, 1 payment" })).toHaveAttribute("href", `/canton/${update(4)}#legs`);
    expect(rows()[0]).toHaveTextContent("9.4 s from proof start");
  });

  it("shows a block committed after retries with the number of attempts, and a settlement time from the block's time where the log does not hold the block", async () => {
    await open({ updates: () => reply(page([item(4, { status: "retried", attempts: 3 }), item(3, { status: null, attempts: null, submittedTemplate: null, submittedChoice: null, settleFrom: "blockTime", settleSeconds: 12 })])) });
    expect(within(rows()[0]!).getByText("After 3 attempts")).toHaveClass("chip-building");
    expect(rows()[1]).toHaveTextContent("12.0 s from block time");
    expect(rows()[1]).toHaveTextContent("not in the producer's log");
    expect(within(rows()[1]!).queryByText("First attempt")).toBeNull();
    expect(rows()[1]).not.toHaveTextContent("Advance");
  });

  it("says none for a block with no legs, not indexed yet for one whose legs are not, and leaves the settlement time out where it is null", async () => {
    await open({ updates: () => reply(page([item(4, { legs: NONE }), item(3, { legs: null, settleSeconds: null, settleFrom: null })])) });
    expect(rows()[0]).toHaveTextContent("none");
    expect(rows()[1]).toHaveTextContent("not indexed yet");
    expect(rows()[1]).not.toHaveTextContent("from proof start");
    expect(within(rows()[1]!).queryAllByRole("link", { name: /^\d+ (deposit|payment|withdrawal|lock|release)/ })).toHaveLength(0);
  });

  it("explains the settlement time in the footnote, and the choice's name once in its column help", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} });
    await open();
    expect(screen.getByText(/runs from the start of the block's proof to Canton's record time/)).toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "About the choice" }));
    expect(await screen.findByText(/exercising the choice Advance on the chain's ZkChain contract/)).toBeInTheDocument();
  });

  it("filters by the tabs, asking the server for each and naming the empty list", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} });
    const calls = await open({ updates: (path) => reply(page(path.includes("filter=retried") ? [] : [item(4), item(3)])) });
    const tabs = within(screen.getByRole("group", { name: "Show blocks" }));
    expect(tabs.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "First attempt", "Retried", "With legs"]);
    expect(tabs.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await user.click(tabs.getByRole("button", { name: "Retried" }));
    expect(await screen.findByText("No block in the producer's log needed a retry.")).toBeInTheDocument();
    expect(calls).toContain("/api/canton/updates?limit=25&filter=retried");
    await user.click(tabs.getByRole("button", { name: "With legs" }));
    await vi.waitFor(() => expect(calls).toContain("/api/canton/updates?limit=25&filter=legs"));
    await user.click(tabs.getByRole("button", { name: "First attempt" }));
    await vi.waitFor(() => expect(calls).toContain("/api/canton/updates?limit=25&filter=first"));
  });

  it("sorts newest or oldest first, pages oldest first by after, and points the CSV at the filter and the order", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} });
    const calls = await open({ updates: (path) => reply(path.includes("after=u9") ? page([item(5)]) : path.includes("order=asc") ? page([item(1), item(2)], "u9") : page([item(4), item(3)])) });
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", "/api/canton/updates?format=csv&filter=all&order=desc");
    await user.click(within(screen.getByRole("group", { name: "Order" })).getByRole("button", { name: "Oldest" }));
    await vi.waitFor(() => expect(calls).toContain("/api/canton/updates?limit=25&order=asc"));
    await screen.findByText("Oldest first, by record time");
    expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", "/api/canton/updates?format=csv&filter=all&order=asc");
    await user.click(screen.getByRole("button", { name: "Newer page" }));
    await vi.waitFor(() => expect(calls).toContain("/api/canton/updates?limit=25&after=u9&order=asc"));
    await user.click(within(screen.getByRole("group", { name: "Show blocks" })).getByRole("button", { name: "Retried" }));
    await vi.waitFor(() => expect(screen.getByRole("link", { name: "CSV" })).toHaveAttribute("href", "/api/canton/updates?format=csv&filter=retried&order=asc"));
  });

  it("keeps every field on a 360 px screen: the rows stack as cards with each column placed, and the tiles, the timeline and the attempts wrap", () => {
    const css = readFileSync(join(import.meta.dirname, "canton.css"), "utf8");
    for (const k of ["k-u", "k-b", "k-n", "k-st", "k-c", "k-l", "k-s", "k-t"]) expect(css).toContain(`.stk-linked .${k} {`);
    expect(css).not.toMatch(/\.stk-linked \.k-s[^}]*display: none/);
    const phone = css;
    expect(phone).toContain('grid-template-areas: "u u" "b n" "st s" "c c" "l l" "t t"');
    expect(css).toMatch(/\.canton-stats \.stat-wide \{ grid-column: span 2; \}/);
    expect(css).toMatch(/\.legs-kinds \{ display: flex; flex-wrap: wrap;/);
    expect(css).toMatch(/\.tl li \{ display: flex; flex-wrap: wrap;/);
    expect(css).toMatch(/\.att-r \{ margin: 4px 0 0; overflow-wrap: anywhere;/);
  });
});

describe("one Canton update: its timeline, attempts, proof check and legs", () => {
  const open = async (h: Parameters<typeof route>[0] = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const calls = fakeApi(route({ update: () => reply(detail()), around: () => reply({ items: [near(3)] }), ...h }));
    renderApp(`/canton/${update(3)}`);
    await screen.findByRole("heading", { name: "Canton update" });
    return calls;
  };
  const sec = (name: string) => screen.getByRole("region", { name });

  it("draws the five steps of the block's way to Canton in order, each with its time, the time since the one before and where it comes from", async () => {
    await open();
    const steps = within(sec("Timeline")).getAllByRole("listitem");
    expect(steps.map((l) => l.querySelector(".tl-k")!.textContent)).toEqual(["Block built", "Proof started", "Proof done", "Submitted to Canton", "Committed on Canton"]);
    expect(steps[0]).toHaveTextContent("01:37:10.200 UTC");
    expect(steps[1]).toHaveTextContent("+0.20 s");
    expect(steps[2]).toHaveTextContent("+9.60 s");
    expect(steps[3]).toHaveTextContent("+0.10 s");
    expect(steps[4]).toHaveTextContent("01:37:23.412 UTC");
    expect(steps[4]).toHaveTextContent("+3.31 s");
    expect(within(steps[0]!).getByText("producer log")).toHaveClass("tag");
    expect(within(steps[4]!).getByText("Canton record time")).toHaveClass("tag");
    expect(sec("Timeline")).toHaveTextContent("9.4 s from proof start to the record time");
    expect(within(sec("Timeline")).queryByText(/producer's log does not hold this block/)).toBeNull();
  });

  it("draws only the steps it has when the producer's log does not hold the block, and says so", async () => {
    await open({ update: () => reply(detail({ status: null, attempts: null, settleFrom: "blockTime", settleSeconds: 7, view: updateView({ attempts: [], timeline: [{ step: "built", at: "2026-10-04T01:37:16.000Z", source: "block" }, { step: "committed", at: "2026-10-04T01:37:23.412Z", source: "canton" }] }) })) });
    const steps = within(sec("Timeline")).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(within(steps[0]!).getByText("block timestamp")).toHaveClass("tag");
    expect(sec("Timeline")).toHaveTextContent("7.0 s from block time to the record time");
    expect(sec("Timeline")).toHaveTextContent("The producer's log does not hold this block");
    expect(sec("Commit attempts")).toHaveTextContent("its attempts are not known");
  });

  it("says the block committed on its first attempt, with the proof time and when it was submitted and answered", async () => {
    await open();
    const a = sec("Commit attempts");
    expect(a).toHaveTextContent("Committed on the first attempt.");
    expect(within(a).getAllByRole("listitem")).toHaveLength(1);
    expect(a).toHaveTextContent("Attempt 1");
    expect(within(a).getByText("Committed")).toHaveClass("chip-final");
    expect(a).toHaveTextContent("Proof took 9.60 s");
    expect(a).toHaveTextContent("submitted 01:37:20.100 UTC");
    expect(a).toHaveTextContent("answered 01:37:23.500 UTC (3.40 s later)");
  });

  it("lists every attempt with its outcome and the reason where one was recorded", async () => {
    const base = updateView().attempts[0]!;
    await open({ update: () => reply(detail({ status: "retried", attempts: 3, view: updateView({ attempts: [
      { ...base, number: 1, outcome: "refused", reason: "proof does not match the block", committed: false },
      { ...base, number: 2, outcome: "unknown", reason: null, committed: false, answeredAt: null },
      { ...base, number: 3 },
    ] }) })) });
    const a = sec("Commit attempts");
    expect(a).toHaveTextContent("Committed on attempt 3, after 2 attempts that did not commit.");
    const items = within(a).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Refused")).toHaveClass("chip-dropped");
    expect(items[0]).toHaveTextContent("proof does not match the block");
    expect(within(items[1]!).getByText("No answer")).toBeInTheDocument();
    expect(items[1]).not.toHaveTextContent("answered");
    expect(within(items[2]!).getByText("Committed")).toHaveClass("chip-final");
  });

  it("says plainly that the committed update is the evidence of the confirmers' check, and what is not visible, with the explorer's own comparison beside it", async () => {
    await open();
    const c = sec("Proof check");
    expect(c).toHaveTextContent("The committed update is the evidence of that check");
    expect(c).toHaveTextContent("Canton records it only if 1 confirmer accepted it");
    expect(c).toHaveTextContent("Their own check time and result are not visible to the reader party; only the commit is.");
    expect(c).toHaveTextContent("program and ZisK release are the pinned ones");
    expect(c).toHaveTextContent("names this block's hash");
  });

  it("names a comparison that failed", async () => {
    await open({ update: () => reply(detail({ view: updateView({ proofCheck: { evidence: "committed update", confirmers: 0, matchesPins: false, matchesBlock: false } }) })) });
    expect(sec("Proof check")).toHaveTextContent("program or ZisK release is not the pinned one");
    expect(sec("Proof check")).toHaveTextContent("does not name this block's hash");
    expect(sec("Proof check")).toHaveTextContent("only if the confirmers accepted it");
  });

  it("says no comparison was made when the explorer has none", async () => {
    await open({ update: () => reply(detail({ view: updateView({ proofCheck: { evidence: "committed update", confirmers: 1, matchesPins: null, matchesBlock: null } }) })) });
    expect(sec("Proof check")).toHaveTextContent("not made for this block");
  });

  it("lists the legs of the block by kind, each linked to its own page, from the block's legs route", async () => {
    const calls = await open({
      update: () => reply(detail({ legs: { ...NONE, total: 2, deposit: 1, payment: 1 } })),
      blockLegs: () => reply(page([plainLeg(), plainLeg({ kind: "payment", legId: hash(0x1f), legIndex: 2 })])),
    });
    const l = sec("Legs settled in this block");
    await within(l).findAllByRole("link");
    expect(l).toHaveTextContent("1 deposit, 1 payment");
    expect(calls).toContain("/api/blocks/3/legs?limit=25");
    expect(within(l).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([`/leg/${hash(0x1e)}`, `/leg/${hash(0x1f)}`]);
    expect(within(l).getAllByRole("listitem").map((i) => i.querySelector(".tag")!.textContent)).toEqual(["Deposit", "Payment"]);
  });

  it("says the block settled no legs without asking for them", async () => {
    const calls = await open({ update: () => reply(detail({ legs: NONE })) });
    expect(sec("Legs settled in this block")).toHaveTextContent("This block settled no legs.");
    expect(calls.some((c) => c.includes("/legs"))).toBe(false);
  });

  it("says the legs are not indexed yet where the list has none", async () => {
    const calls = await open({ update: () => reply(detail({ legs: null })) });
    expect(sec("Legs settled in this block")).toHaveTextContent("The explorer has not indexed this block's legs yet.");
    expect(calls.some((c) => c.includes("/legs"))).toBe(false);
  });
});
