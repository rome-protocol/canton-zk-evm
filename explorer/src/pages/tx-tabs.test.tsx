// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiTx, InternalCall, TokenTransfer, TraceFrame, TxLog } from "../api.ts";
import { account, addr, fakeApi, hash, page, renderApp, reply, route, tokenAddress, tx, txDetail, waitingTx } from "../test-utils.tsx";

vi.mock("../verify/verifier.ts", async (orig) => ({ ...(await orig<typeof import("../verify/verifier.ts")>()), fetchVerifier: vi.fn(async () => ({ verify: () => "", bytes: 1 })) }));

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const H = hash(0xf6);
const log = (i: number, over: Partial<TxLog> = {}): TxLog => ({ logIndex: i, position: i, address: addr(0xcb), topics: [TRANSFER, "0x" + "0".repeat(24) + "5b".repeat(20)], data: "0x" + "0".repeat(63) + "1", decoded: null, ...over });
const call = (over: Partial<InternalCall> = {}): InternalCall => ({ traceAddress: [], callType: "call", from: addr(0x5b), to: addr(0xcb), value: "0", gas: 90000, gasUsed: 51000, selector: "0xa9059cbb", inputSize: 68, error: null, ...over });
const frame = (over: Partial<TraceFrame> = {}): TraceFrame => ({ traceAddress: [], type: "call", callType: "call", from: addr(0x5b), to: addr(0xcb), value: "0", gas: 90000, gasUsed: 51000, input: "0xa9059cbb", inputSize: 4, error: null, created: null, ...over });
const transfer = (over: Partial<TokenTransfer> = {}): TokenTransfer => ({ logIndex: 0, batchIndex: 0, token: addr(0xcb), from: addr(0x5b), to: addr(0x5a), amount: "10000000000000000000", tokenId: null, ...over });

type H = Parameters<typeof route>[0];
async function open(h: H = {}, t: ApiTx = tx(), tab = "") {
  const calls = fakeApi(route({ tx: () => reply(t), txDetail: () => reply(txDetail()), address: () => reply(tokenAddress()), ...h }));
  renderApp(`/tx/${t.hash}${tab}`);
  await screen.findByRole("heading", { name: "Transaction" });
  return calls;
}
const tab = (name: RegExp | string) => screen.getByRole("tab", { name });
const used = (calls: string[], part: string) => calls.filter((c) => c.includes(part));
afterEach(cleanup);

describe("the tabs of the transaction page", () => {
  it("opens on Overview, counts the logs, gives the internal calls tab no count (its list is only the calls that moved value), and keeps the tab in the address", async () => {
    const user = userEvent.setup();
    await open({ txDetail: () => reply(txDetail({ callCount: 3 })), txLogs: () => reply(page([log(0)])) });
    await waitFor(() => expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Overview", "Logs1", "Internal calls", "Call tree", "Raw"]));
    expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
    await user.click(tab(/^Logs/));
    expect(tab(/^Logs/)).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("group", { name: "Log 0" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Canton record" })).toBeNull();
  });

  it("opens the tab the address names, and falls back to Overview for one it does not have", async () => {
    await open({ txLogs: () => reply(page([log(0)])) }, tx(), "?tab=logs");
    expect(tab(/^Logs/)).toHaveAttribute("aria-selected", "true");
    cleanup();
    await open({}, tx(), "?tab=nonsense");
    expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
  });

  it("gives a transaction that is still being proven only Overview and Logs, and one waiting no tabs", async () => {
    await open({}, tx({ status: "proving", state: "proving" }));
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Overview", "Logs1"]);
    cleanup();
    await open({}, waitingTx());
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("has the internal calls tab even when the block is not derived yet", async () => {
    await open({ txDetail: () => reply(txDetail({ derived: false, callCount: null })) });
    expect(screen.getByRole("tab", { name: "Internal calls" })).toBeInTheDocument();
  });
});

describe("the Logs tab", () => {
  it("shows each log raw with its address, its topics and its data, names a Transfer by its first topic, and says decoding needs a verified interface", async () => {
    await open({ txLogs: () => reply(page([log(0), log(1, { topics: ["0x" + "12".repeat(32)] })])) }, tx(), "?tab=logs");
    const one = within(await screen.findByRole("group", { name: "Log 0" }));
    expect(one.getByText("Address", { selector: "dt" }).nextElementSibling).toHaveTextContent("0xcbcb…cbcb");
    expect(one.getByText("Address", { selector: "dt" }).nextElementSibling).toHaveTextContent("TKA");
    expect(one.getByText("Name", { selector: "dt" }).nextElementSibling).toHaveTextContent("Transfer");
    expect(one.getByText("Topics", { selector: "dt" }).nextElementSibling).toHaveTextContent("0 " + TRANSFER);
    expect(one.getByText("Data", { selector: "dt" }).nextElementSibling).toHaveTextContent("0x" + "0".repeat(63) + "1");
    const two = within(screen.getByRole("group", { name: "Log 1" }));
    expect(two.getByText("Name", { selector: "dt" }).nextElementSibling).toHaveTextContent("not decoded");
    expect(two.queryByText("Transfer")).toBeNull();
    expect(screen.getByText(/needs a verified interface/)).toBeInTheDocument();
  });

  it("uses the server's decoded name and arguments when there are some, and then does not say that nothing is decoded", async () => {
    const decoded = { name: "Swap", signature: "Swap(uint256)", args: [{ name: "amount", type: "uint256", value: "42" }] };
    await open({ txLogs: () => reply(page([log(0, { topics: ["0x" + "12".repeat(32)], decoded })])) }, tx(), "?tab=logs");
    const one = within(await screen.findByRole("group", { name: "Log 0" }));
    expect(one.getByText("Swap")).toBeInTheDocument();
    expect(one.getByText("Arguments", { selector: "dt" }).nextElementSibling).toHaveTextContent("uint256 amount = 42");
    expect(screen.queryByText(/needs a verified interface/)).toBeNull();
  });

  it("says nothing is decoded only when a log on the page is not", async () => {
    const decoded = { name: "Swap", signature: "Swap()", args: [] };
    await open({ txLogs: () => reply(page([log(0, { decoded }), log(1)])) }, tx(), "?tab=logs");
    await screen.findByRole("group", { name: "Log 1" });
    expect(screen.getByText(/needs a verified interface/)).toBeInTheDocument();
  });

  it("numbers the logs from 0 by their place among the transaction's own, not by the block's log index, and the same way before the transaction is final", async () => {
    await open({ txLogs: () => reply(page([log(5, { position: 0 }), log(6, { position: 1 })])) }, tx(), "?tab=logs");
    expect(await screen.findByRole("group", { name: "Log 0" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Log 1" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Log 5" })).toBeNull();
    cleanup();
    const seen = tx({ status: "proving", state: "proving", logs: [{ address: addr(0xcb), topics: [], data: "0x" }, { address: addr(0xcb), topics: [], data: "0x" }] });
    await open({}, seen, "?tab=logs");
    expect(await screen.findByRole("group", { name: "Log 0" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Log 1" })).toBeInTheDocument();
  });

  it("pages by the cursor of the page before", async () => {
    const user = userEvent.setup();
    const calls = await open({ txLogs: (_h, p) => reply(p.includes("after=c1") ? page([log(1)]) : page([log(0)], "c1")) }, tx(), "?tab=logs");
    await screen.findByRole("group", { name: "Log 0" });
    await user.click(screen.getByRole("button", { name: "Older page" }));
    expect(await screen.findByRole("group", { name: "Log 1" })).toBeInTheDocument();
    expect(used(calls, "/logs?").some((c) => c.includes("after=c1"))).toBe(true);
  });

  it("shows the logs /api/tx gave for a transaction that is not final, and does not ask the logs route", async () => {
    const calls = await open({}, tx({ status: "proving", state: "proving" }), "?tab=logs");
    expect(await screen.findByRole("group", { name: "Log 0" })).toBeInTheDocument();
    expect(used(calls, "/logs")).toHaveLength(0);
  });

  it("says when there are none", async () => {
    await open({ txLogs: () => reply(page([])) }, tx(), "?tab=logs");
    expect(await screen.findByText("This transaction emitted no logs.")).toBeInTheDocument();
  });
});

describe("the Internal calls tab", () => {
  it("lists the calls that moved value, and says the list is only those and the rest are in Call tree", async () => {
    await open({ txInternal: () => reply({ items: [call({ value: "1000000000000000000" }), call({ traceAddress: [0, 1], callType: "delegatecall", selector: null, gasUsed: null, error: "out of gas" })], next: null, derived: true }) }, tx(), "?tab=internal");
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("top level");
    expect(rows[1]).toHaveTextContent("0xa9059cbb");
    expect(rows[1]).toHaveTextContent("true");
    expect(rows[2]).toHaveTextContent("call 0-1");
    expect(rows[2]).toHaveTextContent("delegatecall");
    expect(rows[2]).toHaveTextContent("none");
    expect(rows[2]).toHaveTextContent("out of gas");
    expect(screen.getByText(/only the calls that moved value/)).toHaveTextContent("Every call is in Call tree");
  });

  it("says not derived yet in the gap, and shows no rows", async () => {
    await open({ txInternal: () => reply({ items: [], next: null, derived: false }) }, tx(), "?tab=internal");
    expect(await screen.findByText("not derived yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("the Call tree and Raw tabs", () => {
  it("reads neither the trace nor the receipt until their tab is open", async () => {
    const user = userEvent.setup();
    const calls = await open({ txTrace: () => reply({ frames: [frame()], truncated: false }), txRaw: () => reply({ status: "0x1", type: "0x2" }) });
    expect(used(calls, "/trace")).toHaveLength(0);
    expect(used(calls, "raw=1")).toHaveLength(0);
    await user.click(tab("Call tree"));
    await screen.findByRole("region", { name: "Call tree" });
    expect(used(calls, "/trace")).toHaveLength(1);
    expect(used(calls, "raw=1")).toHaveLength(0);
    await user.click(tab("Raw"));
    expect(await screen.findByText(/"status": "0x1"/)).toBeInTheDocument();
    expect(used(calls, "raw=1")).toHaveLength(1);
  });

  it("indents each call by its depth", async () => {
    await open({ txTrace: () => reply({ frames: [frame(), frame({ traceAddress: [0] }), frame({ traceAddress: [0, 0], error: "reverted" })], truncated: false }) }, tx(), "?tab=tree");
    const rows = within(await screen.findByRole("region", { name: "Call tree" })).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-depth"))).toEqual(["0", "1", "2"]);
    expect(rows[2]).toHaveStyle({ paddingLeft: "40px" });
    expect(rows[2]).toHaveTextContent("reverted");
  });

  it("says the trace is too big to serve in the server's own words", async () => {
    await open({ txTrace: () => reply({ error: "the trace is too big to serve" }, 502) }, tx(), "?tab=tree");
    expect(await screen.findByRole("alert")).toHaveTextContent("the trace is too big to serve");
  });

  it("says when it shows only the first calls", async () => {
    await open({ txTrace: () => reply({ frames: Array.from({ length: 1000 }, (_, i) => frame({ traceAddress: [i] })), truncated: true }) }, tx(), "?tab=tree");
    expect(await screen.findByRole("status")).toHaveTextContent("Showing the first 1,000 calls");
  });
});

describe("the token transfers and the input on Overview", () => {
  it("lists each transfer with the token's symbol and amount in whole units", async () => {
    await open({ txTransfers: () => reply({ items: [transfer()], next: null, derived: true }) });
    const card = within(await screen.findByRole("region", { name: "Token transfers" }));
    const row = (await card.findAllByRole("row"))[1]!;
    expect(row).toHaveTextContent("0x5b5b…5b5b");
    expect(row).toHaveTextContent("0x5a5a…5a5a");
    expect(row).toHaveTextContent("10 TKA");
  });

  it("shows the token id where an NFT transfer has no amount, and no id beside an amount", async () => {
    await open({ txTransfers: () => reply({ items: [transfer({ amount: null, tokenId: "3" }), transfer({ logIndex: 1, amount: "5", tokenId: "7" })], next: null, derived: true }), address: () => reply(tokenAddress()) });
    const card = within(await screen.findByRole("region", { name: "Token transfers" }));
    await waitFor(() => expect(card.getAllByRole("row")[1]).toHaveTextContent("TKA #3"));
    expect(card.getAllByRole("row")[1]).not.toHaveTextContent("id 3");
    expect(card.getAllByRole("row")[2]).toHaveTextContent("id 7");
  });

  it("puts both cards full width after the facts and the side cards, so a phone reads Overview, Canton record, The proof, Token transfers, Input", async () => {
    await open({ txTransfers: () => reply({ items: [transfer()], next: null, derived: true }) });
    const transfers = await screen.findByRole("region", { name: "Token transfers" }), input = screen.getByRole("region", { name: "Input data" });
    const grid = document.querySelector(".tx-grid")!;
    for (const card of [transfers, input]) {
      expect(grid.contains(card)).toBe(false);
      expect(grid.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("falls back to the raw amount when the token cannot be read", async () => {
    await open({ txTransfers: () => reply({ items: [transfer()], next: null, derived: true }), address: () => reply(account()) });
    const card = within(await screen.findByRole("region", { name: "Token transfers" }));
    expect(await card.findByText("10000000000000000000")).toBeInTheDocument();
  });

  it("says not derived yet in the gap", async () => {
    await open({ txTransfers: () => reply({ items: [], next: null, derived: false }) });
    const card = within(await screen.findByRole("region", { name: "Token transfers" }));
    expect(card.getByText("not derived yet")).toBeInTheDocument();
  });

  it("shows no token transfers card for a transaction that is not final", async () => {
    await open({}, tx({ status: "proving", state: "proving" }));
    expect(screen.queryByRole("region", { name: "Token transfers" })).toBeNull();
  });

  it("keeps the raw input with its method id and says there is no decode", async () => {
    await open();
    const card = within(screen.getByRole("region", { name: "Input data" }));
    expect(card.getByText("Method id", { selector: "dt" }).nextElementSibling).toHaveTextContent("0xa9059cbb");
    expect(card.getByText(/verified interface is not held/)).toBeInTheDocument();
  });
});
