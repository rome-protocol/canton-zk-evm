// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UpdateAroundItem, UpdateDetail, UpdateItem } from "../api.ts";
import { block, fakeApi, hash, NOT_FOUND, page, renderApp, reply, route, tx, update } from "../test-utils.tsx";

const SYNC = "da::1220" + "e8".repeat(32);
const item = (n: number, over: Partial<UpdateItem> = {}): UpdateItem => ({
  updateId: update(n), recordTime: `2026-10-04T01:37:${10 + n}.230583Z`, effectiveAt: null, participant: "reader-1", offset: 60 + n, synchronizer: SYNC, block: n, ...over,
});
const near = (n: number, over: Partial<UpdateAroundItem> = {}): UpdateAroundItem => ({ ...item(n), submittedTemplate: "Zk.Chain:ZkChain", submittedChoice: "Advance", txCount: n * 2, ...over });
const detail = (over: Partial<UpdateDetail> = {}): UpdateDetail => ({
  ...item(3), template: { packageId: "ccd743bc" + "ab".repeat(28), packageName: "zk-chain", module: "Zk.Chain", entity: "BlockRecord" }, contractId: "00be6996af" + "25".repeat(30), blockHash: hash(3),
  signatories: [{ role: "operator", party: "operator::1220" + "ab".repeat(32) }, { role: "confirmer", party: "confirmer::1220" + "cd".repeat(32) }],
  producerRecord: { template: "Zk.Chain:ZkChain", choice: "Advance", commandId: "advance-3-1", argumentBytes: 2080, trafficBytes: null }, ...over,
});
const NOW = Date.parse("2026-10-04T02:00:00Z");

describe("the Canton updates page", () => {
  const open = async (h: Parameters<typeof route>[0] = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const calls = fakeApi(route({ updates: () => reply(page([item(4), item(3)])), ...h }));
    renderApp("/canton");
    await screen.findByRole("table");
    return calls;
  };
  const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

  it("lists the updates newest first, with the reader's offset, the record time and the block each carries", async () => {
    await open();
    expect(rows()).toHaveLength(2);
    const r = within(rows()[0]!);
    expect(rows()[0]).toHaveTextContent("64");
    expect(rows()[0]).toHaveTextContent("2026-10-04T01:37:14.230583Z");
    expect(r.getByRole("link", { name: "12200404…0404" })).toHaveAttribute("href", `/canton/${update(4)}`);
    expect(r.getByRole("link", { name: "Block 4" })).toHaveAttribute("href", "/block/4");
  });

  it("says that the offsets are the reader's participant's, not the builder's completion offset", async () => {
    await open();
    expect(screen.getAllByText("on the reader's participant", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("not the builder's own completion offset", { exact: false })).toBeInTheDocument();
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
    expect(r.getByText("the three parts Verify checks; each can be copied as hex")).toBeInTheDocument();
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
    expect(t.getByText("ordered by record time and update id · offsets on the reader's participant")).toBeInTheDocument();
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