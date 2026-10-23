// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiTx, InternalCall, TokenTransfer, TraceFrame, TxLog } from "../api.ts";
import { account, addr, contractSource, fakeApi, hash, labelsOf, page, renderApp, reply, route, tokenAddress, tokenLabel, tx, txDetail, waitingTx } from "../test-utils.tsx";

vi.mock("../verify/verifier.ts", async (orig) => ({ ...(await orig<typeof import("../verify/verifier.ts")>()), fetchVerifier: vi.fn(async () => ({ verify: () => "", bytes: 1 })) }));

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const H = hash(0xf6);
const log = (i: number, over: Partial<TxLog> = {}): TxLog => ({ logIndex: i, position: i, address: addr(0xcb), topics: [TRANSFER, "0x" + "0".repeat(24) + "5b".repeat(20)], data: "0x" + "0".repeat(63) + "1", decoded: null, ...over });
const call = (over: Partial<InternalCall> = {}): InternalCall => ({ traceAddress: [], callType: "call", from: addr(0x5b), to: addr(0xcb), value: "0", gas: 90000, gasUsed: 51000, selector: "0xa9059cbb", inputSize: 68, error: null, ...over });
const frame = (over: Partial<TraceFrame> = {}): TraceFrame => ({ traceAddress: [], type: "call", callType: "call", from: addr(0x5b), to: addr(0xcb), value: "0", gas: 90000, gasUsed: 51000, input: "0xa9059cbb", inputSize: 4, error: null, created: null, ...over });
const transfer = (over: Partial<TokenTransfer> = {}): TokenTransfer => ({ logIndex: 0, batchIndex: 0, methodId: null, creation: false, timestamp: 1700000000, token: addr(0xcb), standard: "ERC-20", from: addr(0x5b), to: addr(0x5a), amount: "10000000000000000000", tokenId: null, ...over });

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
  it("opens on Overview, counts the logs, counts the calls under the top level on the internal calls tab, and keeps the tab in the address", async () => {
    const user = userEvent.setup();
    await open({ txDetail: () => reply(txDetail({ callCount: 3 })), txLogs: () => reply(page([log(0)])) });
    await waitFor(() => expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Overview", "Logs1", "Internal calls3", "Call tree", "Raw"]));
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
    expect(one.getByText("Data", { selector: "dt" }).nextElementSibling).toHaveTextContent("amount 42");
    expect(one.getByText("Name", { selector: "dt" }).nextElementSibling).toHaveTextContent("Swap (uint256 amount)");
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

describe("the Logs tab, decoded", () => {
  const T = addr(0xcb), FROM = addr(0x5b), TO = addr(0x5a);
  const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
  const amount = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  const transferLog = (i: number, n: bigint, over: Partial<TxLog> = {}) => log(i, { address: T, topics: [TRANSFER, pad(FROM), pad(TO)], data: amount(n), ...over });
  const usd = tokenLabel({ address: T, name: "Test USD", symbol: "tUSD", decimals: 18 });
  const named = (extra: Parameters<typeof route>[0] = {}) => ({ labels: labelsOf([usd]), ...extra });

  it("reads a Transfer with the standard interface: the event with its parameters, each topic by its argument, and the value in whole units after its raw digits", async () => {
    await open(named({ txLogs: () => reply(page([transferLog(0, 5000n * 10n ** 18n)])) }), tx(), "?tab=logs");
    const one = within(await screen.findByRole("group", { name: "Log 0" }));
    expect(await one.findByText("Test USD (tUSD)")).toBeInTheDocument();
    expect(one.getByText("Name", { selector: "dt" }).nextElementSibling).toHaveTextContent("Transfer (index_topic_1 address from, index_topic_2 address to, uint256 value)");
    const topics = one.getByText("Topics", { selector: "dt" }).nextElementSibling!;
    expect(topics).toHaveTextContent("0 " + TRANSFER);
    expect(topics).toHaveTextContent(`1 from ${FROM}`);
    expect(topics).toHaveTextContent(`2 to ${TO}`);
    expect(one.getByText("Data", { selector: "dt" }).nextElementSibling).toHaveTextContent("value 5000000000000000000000 = 5,000 tUSD");
    expect(screen.getByText("1 log, 1 with the standard token interface")).toBeInTheDocument();
  });

  it("says the verified ABI of the one contract that emitted every log, and switches to the raw topics and data with Hex", async () => {
    const user = userEvent.setup();
    const abi = [{ type: "event", name: "Transfer", anonymous: false, inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] }];
    await open(named({ txLogs: () => reply(page([transferLog(0, 10n ** 18n), transferLog(1, 2n * 10n ** 18n)])), contracts: (_a, sub) => (sub === "source" ? reply(contractSource(0xcb, { abi })) : reply({ error: "none" }, 404)) }), tx(), "?tab=logs");
    expect(await screen.findByText("2 logs, decoded with the verified ABI of Test USD (tUSD)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decoded" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Hex" }));
    const one = within(screen.getByRole("group", { name: "Log 0" }));
    const topics = one.getByText("Topics", { selector: "dt" }).nextElementSibling!;
    expect(topics).toHaveTextContent("1 " + pad(FROM));
    expect(one.getByText("Data", { selector: "dt" }).nextElementSibling).toHaveTextContent(amount(10n ** 18n));
    expect(one.queryByText(/= 1 tUSD/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Decoded" }));
    expect(one.getByText("Data", { selector: "dt" }).nextElementSibling).toHaveTextContent("= 1 tUSD");
  });

  it("shows no switch and no value chip where nothing is decoded, and no whole units where the token's decimals are not known", async () => {
    await open({ txLogs: () => reply(page([log(0)])) }, tx(), "?tab=logs");
    await screen.findByRole("group", { name: "Log 0" });
    expect(screen.queryByRole("button", { name: "Hex" })).toBeNull();
    cleanup();
    await open({ labels: labelsOf([tokenLabel({ address: T, decimals: null })]), txLogs: () => reply(page([transferLog(0, 7n)])) }, tx(), "?tab=logs");
    const one = within(await screen.findByRole("group", { name: "Log 0" }));
    expect(one.getByText("Data", { selector: "dt" }).nextElementSibling).toHaveTextContent("value 7");
    expect(one.getByText("Data", { selector: "dt" }).nextElementSibling).not.toHaveTextContent("=");
  });

  it("asks the names of every address of the page in one request", async () => {
    const calls = await open(named({ txLogs: () => reply(page([transferLog(0, 1n), transferLog(1, 2n)])) }), tx(), "?tab=logs");
    await screen.findByRole("group", { name: "Log 1" });
    await screen.findAllByText("Test USD (tUSD)");
    expect(used(calls, "/api/labels")).toHaveLength(1);
  });
});

describe("the Logs tab reads sources sparingly", () => {
  it("reads the source of a verified emitter, and none for an unverified one", async () => {
    const ok = tokenLabel({ address: addr(0x81), name: "Ok", symbol: null, kind: "contract", standard: null, decimals: null, verified: true });
    const no = tokenLabel({ address: addr(0x82), name: "No", symbol: null, kind: "contract", standard: null, decimals: null, verified: false });
    const calls = await open({ labels: labelsOf([ok, no]), txLogs: () => reply(page([log(0, { address: ok.address }), log(1, { address: no.address })])), contracts: () => reply(contractSource(0x81, { verified: false, abi: null })) }, tx(), "?tab=logs");
    await waitFor(() => expect(used(calls, `/api/contracts/${ok.address}/source`)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(used(calls, `/api/contracts/${no.address}/source`)).toHaveLength(0);
  });
});

describe("the Internal calls tab", () => {
  const T = addr(0xcb), DISPERSE = addr(0xd1), SENDER = addr(0x5b), TO = addr(0x5a);
  const usd = tokenLabel({ address: T, name: "Test USD", symbol: "tUSD", decimals: 18 });
  const disperse = tokenLabel({ address: DISPERSE, name: "Disperse", symbol: null, kind: "contract", standard: null, decimals: null });
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  const transferFrom = "0x23b872dd" + "0".repeat(24) + SENDER.slice(2) + "0".repeat(24) + DISPERSE.slice(2) + word(5000n * 10n ** 18n);
  const trace = (over: Partial<TraceFrame>[] = []) => ({ frames: [
    frame({ from: SENDER, to: DISPERSE, input: "0xc73a2d60", inputSize: 4, gasUsed: 109042 }),
    frame({ traceAddress: [0], from: DISPERSE, to: T, input: transferFrom, inputSize: 100, gasUsed: 31211 }),
    frame({ traceAddress: [1], from: DISPERSE, to: T, input: transferFrom, inputSize: 100, gasUsed: 25464, value: "2000000000000000000" }),
    ...over.map((o) => frame(o)),
  ], truncated: false });
  const labels = labelsOf([usd, disperse]);

  it("lists every call of the trace: the top level, then call 1 to n, with type, from, to, the function decoded, value, gas and result", async () => {
    await open({ labels, txDetail: () => reply(txDetail({ callCount: 2 })), txTrace: () => reply(trace()), contracts: (_a, sub) => (sub === "source" ? reply(contractSource(0xcb, { verified: false, abi: null })) : reply({ error: "none" }, 404)) }, tx(), "?tab=internal");
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("top level");
    expect(rows[1]).toHaveTextContent("CALL");
    expect(rows[1]).toHaveTextContent("109,042");
    expect(rows[1]).toHaveTextContent("true");
    expect(rows[2]).toHaveTextContent("call 1");
    expect(rows[3]).toHaveTextContent("call 2");
    await waitFor(() => expect(rows[2]).toHaveTextContent("Test USD (tUSD)"));
    expect(rows[2]).toHaveTextContent("Disperse");
    await waitFor(() => expect(rows[2]).toHaveTextContent(`transferFrom(from ${SENDER.slice(0, 8)}…${SENDER.slice(-4)}, to Disperse, value 5,000 tUSD)`));
    expect(rows[1]).toHaveTextContent("0xc73a2d60");
    expect(screen.getByText(/2 internal calls under the top-level call/)).toHaveTextContent("traced by reth after block 3 was final");
  });

  it("counts the calls under the top level on the tab, and gives no count where the block is not derived", async () => {
    await open({ txDetail: () => reply(txDetail({ callCount: 4 })) });
    await waitFor(() => expect(tab(/^Internal calls/)).toHaveTextContent("Internal calls4"));
  });

  it("keeps only the calls that moved coin with the switch, naming how many, and says when none did", async () => {
    const user = userEvent.setup();
    await open({ labels, txTrace: () => reply(trace()) }, tx(), "?tab=internal");
    await screen.findAllByRole("row");
    expect(screen.getByRole("button", { name: "Only those moving tROME (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Only those moving tROME (1)" }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("call 2");
    expect(screen.queryByText(/None of these calls moved/)).toBeNull();
    cleanup();
    await open({ txTrace: () => reply({ frames: [frame()], truncated: false }) }, tx(), "?tab=internal");
    await screen.findAllByRole("row");
    expect(screen.getByRole("button", { name: "Only those moving tROME (0)" })).toBeInTheDocument();
    expect(screen.getByText(/None of these calls moved tROME\. The token moves are on the Token transfers list/)).toBeInTheDocument();
    expect(screen.queryByText(/address pages/)).toBeNull();
    expect(screen.getByText(/No call under the top-level call/)).toBeInTheDocument();
  });

  it("says 'parent call failed' for a call under a failed call, and counts no coin it moved", async () => {
    const user = userEvent.setup();
    await open({ labels, txTrace: () => reply({ frames: [
      frame({ from: SENDER, to: DISPERSE }),
      frame({ traceAddress: [0], from: DISPERSE, to: T, value: "1000000000000000000", error: "execution reverted" }),
      frame({ traceAddress: [0, 0], from: T, to: TO, value: "2000000000000000000" }),
      frame({ traceAddress: [1], from: DISPERSE, to: TO, value: "3000000000000000000" }),
    ], truncated: false }) }, tx(), "?tab=internal");
    const rows = await screen.findAllByRole("row");
    expect(rows[1]).toHaveTextContent("true");
    expect(rows[2]).toHaveTextContent("execution reverted");
    expect(rows[3]).toHaveTextContent("parent call failed");
    expect(rows[3]).not.toHaveTextContent("true");
    expect(rows[4]).toHaveTextContent("true");
    expect(screen.getByRole("button", { name: "Only those moving tROME (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Only those moving tROME (1)" }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("call 3");
  });

  it("shows every call of a reverted transaction as failed and counts none as moving coin", async () => {
    await open({ labels, txTrace: () => reply({ frames: [
      frame({ from: SENDER, to: DISPERSE, error: "execution reverted" }),
      frame({ traceAddress: [0], from: DISPERSE, to: TO, value: "1000000000000000000" }),
    ], truncated: false }) }, tx({ success: false }), "?tab=internal");
    const rows = await screen.findAllByRole("row");
    expect(rows[2]).toHaveTextContent("parent call failed");
    expect(rows[2]).not.toHaveTextContent("true");
    expect(screen.getByRole("button", { name: "Only those moving tROME (0)" })).toBeInTheDocument();
    cleanup();
    // The transaction failed and its top frame carries no error of its own: nothing it did took effect.
    await open({ labels, txTrace: () => reply({ frames: [frame({ from: SENDER, to: DISPERSE }), frame({ traceAddress: [0], from: DISPERSE, to: TO, value: "1000000000000000000" })], truncated: false }) }, tx({ success: false }), "?tab=internal");
    const again = await screen.findAllByRole("row");
    expect(again[1]).toHaveTextContent("parent call failed");
    expect(screen.getByRole("button", { name: "Only those moving tROME (0)" })).toBeInTheDocument();
  });

  it("does not count a delegatecall or a staticcall that carries its caller's value, and shows no value for it", async () => {
    await open({ labels, txTrace: () => reply({ frames: [
      frame({ from: SENDER, to: DISPERSE, value: "1000000000000000000" }),
      frame({ traceAddress: [0], callType: "delegatecall", from: DISPERSE, to: T, value: "1000000000000000000" }),
      frame({ traceAddress: [1], callType: "staticcall", from: DISPERSE, to: T, value: "1000000000000000000" }),
    ], truncated: false }) }, tx(), "?tab=internal");
    const rows = await screen.findAllByRole("row");
    expect(screen.getByRole("button", { name: "Only those moving tROME (1)" })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("1 tROME");
    expect(rows[2]).toHaveTextContent("DELEGATECALL");
    expect(rows[2]).not.toHaveTextContent("tROME");
    expect(rows[3]).not.toHaveTextContent("tROME");
  });

  it("counts a self-destruct that sent its balance as moving coin, shows its value, and gives the closing note no room", async () => {
    const user = userEvent.setup();
    await open({ labels, txTrace: () => reply({ frames: [
      frame({ from: SENDER, to: DISPERSE }),
      frame({ traceAddress: [0], type: "suicide", callType: "", from: DISPERSE, to: TO, value: "5000000000000000000", input: "0x", inputSize: 0 }),
    ], truncated: false }) }, tx(), "?tab=internal");
    const rows = await screen.findAllByRole("row");
    expect(rows[2]).toHaveTextContent("SUICIDE");
    expect(rows[2]).toHaveTextContent("5 tROME");
    expect(screen.getByRole("button", { name: "Only those moving tROME (1)" })).toBeInTheDocument();
    expect(screen.queryByText(/None of these calls moved/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Only those moving tROME (1)" }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    cleanup();
    // One that sent nothing, or sat under a failed call, counts for nothing.
    await open({ labels, txTrace: () => reply({ frames: [
      frame({ from: SENDER, to: DISPERSE }),
      frame({ traceAddress: [0], from: DISPERSE, to: T, error: "execution reverted" }),
      frame({ traceAddress: [0, 0], type: "suicide", callType: "", from: T, to: TO, value: "5000000000000000000", input: "0x", inputSize: 0 }),
    ], truncated: false }) }, tx(), "?tab=internal");
    const failed = await screen.findAllByRole("row");
    expect(failed[3]).toHaveTextContent("parent call failed");
    expect(failed[3]).not.toHaveTextContent("tROME");
    expect(screen.getByRole("button", { name: "Only those moving tROME (0)" })).toBeInTheDocument();
  });

  it("keeps a token's name and symbol inside <bdi>, so a right-to-left mark in one cannot turn the amount around", async () => {
    const evil = tokenLabel({ address: T, name: "Evil\u202e", symbol: "tUS\u202eD", decimals: 18 });
    const dest = tokenLabel({ address: DISPERSE, name: "Dis\u202eperse", symbol: null, kind: "contract", standard: null, decimals: null });
    await open({ labels: labelsOf([evil, dest]), txTrace: () => reply(trace()) }, tx(), "?tab=internal");
    const rows = await screen.findAllByRole("row");
    await waitFor(() => expect(rows[2]!.querySelector("bdi")).not.toBeNull());
    const cell = rows[2]!.querySelector(".mono.wrap")!;
    const bdis = [...cell.querySelectorAll("bdi")];
    expect(bdis.map((b) => b.textContent)).toContain("tUS\u202eD");
    expect(bdis.map((b) => b.textContent)).toContain("Dis\u202eperse");
    for (const b of bdis) expect(b.textContent).not.toMatch(/5,000/);
    expect(cell.textContent).toContain("value 5,000 ");
  });

  it("reads the source of a bounded number of verified contracts, and none for an unverified one", async () => {
    const verified = Array.from({ length: 40 }, (_, i) => tokenLabel({ address: addr(0x80 + i), name: `V${i}`, symbol: null, kind: "contract", standard: null, decimals: null, verified: true }));
    const unverified = Array.from({ length: 5 }, (_, i) => tokenLabel({ address: addr(0xc0 + i), name: `U${i}`, symbol: null, kind: "contract", standard: null, decimals: null, verified: false }));
    const frames = [frame({ from: SENDER, to: verified[0]!.address }), ...[...verified, ...unverified].map((l, i) => frame({ traceAddress: [i], from: SENDER, to: l.address }))];
    const calls = await open({ labels: labelsOf([...verified, ...unverified]), txTrace: () => reply({ frames, truncated: false }), contracts: (_a, sub) => (sub === "source" ? reply(contractSource(0x80, { verified: false, abi: null })) : reply({ error: "none" }, 404)) }, tx(), "?tab=internal");
    await screen.findAllByRole("row");
    await waitFor(() => expect(used(calls, "/source").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    const asked = used(calls, "/source");
    expect(asked.length).toBeLessThanOrEqual(20);
    for (let i = 0; i < 5; i++) expect(asked.some((c) => c.includes(addr(0xc0 + i)))).toBe(false);
  });

  it("shows the calls fifty at a time, with a button for fifty more, and decodes only the rows it shows", async () => {
    const user = userEvent.setup();
    const frames = Array.from({ length: 120 }, (_, i) => frame({ traceAddress: i === 0 ? [] : [i - 1], from: SENDER, to: DISPERSE }));
    await open({ labels, txTrace: () => reply({ frames, truncated: false }) }, tx(), "?tab=internal");
    expect(await screen.findAllByRole("row")).toHaveLength(51);
    await user.click(screen.getByRole("button", { name: /Show 50 more/ }));
    expect(screen.getAllByRole("row")).toHaveLength(101);
    await user.click(screen.getByRole("button", { name: /Show 20 more/ }));
    expect(screen.getAllByRole("row")).toHaveLength(121);
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  });

  it("shows a creation's function as 'create', not the first bytes of its init code", async () => {
    await open({ txTrace: () => reply({ frames: [frame({ input: "0x60806040" + "00".repeat(20), inputSize: 24, to: null, created: addr(0xc7), type: "create", callType: "create" })], truncated: false }) }, tx(), "?tab=internal");
    const row = (await screen.findAllByRole("row"))[1]!;
    expect(row).toHaveTextContent("create");
    expect(row).not.toHaveTextContent("0x60806040");
  });

  it("shows a failed call's reason, a creation's new address, and a call without a selector as none", async () => {
    await open({ txTrace: () => reply({ frames: [frame({ input: "0x", inputSize: 0, to: null, created: addr(0xc7), type: "create", callType: "create", error: "out of gas", gasUsed: null })], truncated: false }) }, tx(), "?tab=internal");
    const row = (await screen.findAllByRole("row"))[1]!;
    expect(row).toHaveTextContent("CREATE");
    expect(row).toHaveTextContent("out of gas");
    expect(row).toHaveTextContent("not given");
    expect(row).toHaveTextContent("none");
  });

  it("names only the function where the input was served cut short, and says when the trace shows the first calls only", async () => {
    await open({ txTrace: () => reply({ frames: [frame({ input: "0xa9059cbb" + "00".repeat(8), inputSize: 4000 })], truncated: true }) }, tx(), "?tab=internal");
    const row = (await screen.findAllByRole("row"))[1]!;
    expect(row).toHaveTextContent("transfer(…)");
    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 1 calls");
  });

  it("counts the calls of the whole transaction in the heading when the trace served only the first ones", async () => {
    await open({ txDetail: () => reply(txDetail({ callCount: 7000 })), txTrace: () => reply({ frames: [frame(), frame({ traceAddress: [0] })], truncated: true }) }, tx(), "?tab=internal");
    await screen.findAllByRole("row");
    await waitFor(() => expect(screen.getByText(/internal calls under the top-level call/)).toHaveTextContent("7,000 internal calls"));
    expect(screen.getByRole("button", { name: /Only those moving tROME \(0 or more\)/ })).toBeInTheDocument();
  });

  it("says the server's words when the trace cannot be read", async () => {
    await open({ txTrace: () => reply({ error: "the trace is too big to serve" }, 502) }, tx(), "?tab=internal");
    expect(await screen.findByRole("alert")).toHaveTextContent("the trace is too big to serve");
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
  it("lists each transfer with names and the amount in whole units, and says in its header how many and where they were read from", async () => {
    const calls = await open({ txTransfers: () => reply({ items: [transfer(), transfer({ logIndex: 1, from: addr(0x5a), to: addr(0x5b), amount: "2500000000000000000" })], next: null, derived: true }), labels: labelsOf([tokenLabel(), tokenLabel({ address: addr(0x5a), name: "Disperse", symbol: null, kind: "contract", decimals: null })]) });
    const region = await screen.findByRole("region", { name: "Token transfers" });
    const card = within(region);
    expect(card.getByRole("heading", { name: "Token transfers" })).toBeInTheDocument();
    expect(region).toHaveTextContent("2 ERC-20 transfers, read from the logs");
    await waitFor(() => expect(card.getAllByRole("link", { name: "Test token A (TKA)" })).toHaveLength(2));
    const rows = card.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("0x5b5b5b…5b5b");
    expect(within(rows[1]!).getByRole("link", { name: "Disperse" })).toHaveAttribute("href", `/contract/${addr(0x5a)}`);
    expect(within(rows[1]!).getByText("10")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("2.5")).toBeInTheDocument();
    expect(card.getAllByRole("img", { name: "Verified" }).length).toBeGreaterThan(0);
    // One request for the names of the whole card (both new addresses together; the token is already known from the To row), not one per row; and none to the address route.
    expect(used(calls, "/api/labels").filter((c) => c.includes(addr(0x5b)))).toEqual([`/api/labels?addresses=${addr(0x5b)},${addr(0x5a)}`]);
    expect(used(calls, "/api/address/")).toHaveLength(0);
  });

  it("says one transfer in the singular, and 'token transfers' where a row moves an NFT", async () => {
    await open({ txTransfers: () => reply({ items: [transfer()], next: null, derived: true }), labels: labelsOf([tokenLabel()]) });
    expect(await screen.findByRole("region", { name: "Token transfers" })).toHaveTextContent("1 ERC-20 transfer, read from the logs");
    cleanup();
    await open({ txTransfers: () => reply({ items: [transfer({ amount: null, tokenId: "3" })], next: null, derived: true }), labels: labelsOf([tokenLabel({ standard: "ERC-721", decimals: null })]) });
    expect(await screen.findByRole("region", { name: "Token transfers" })).toHaveTextContent("1 token transfer, read from the logs");
  });

  it("shows the token id where an NFT transfer has no amount, and the count with the id beside an amount", async () => {
    await open({ txTransfers: () => reply({ items: [transfer({ amount: null, tokenId: "3" }), transfer({ logIndex: 1, amount: "5", tokenId: "7" })], next: null, derived: true }), labels: labelsOf([tokenLabel({ standard: "ERC-1155", decimals: null })]) });
    const card = within(await screen.findByRole("region", { name: "Token transfers" }));
    await waitFor(() => expect(card.getAllByRole("row")[1]).toHaveTextContent("TKA #3"));
    expect(card.getAllByRole("row")[2]).toHaveTextContent("5 × TKA #7");
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
    await open({ txTransfers: () => reply({ items: [transfer()], next: null, derived: true }), labels: labelsOf([tokenLabel({ decimals: null })]) });
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
    expect(await card.findByText(/verified interface is not held/)).toBeInTheDocument();
  });
});
