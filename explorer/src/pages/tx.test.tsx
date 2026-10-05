// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiTx } from "../api.ts";
import { addr, fakeApi, hash, NOT_FOUND, renderApp, reply, route, status, tick, tx, update, waitingTx } from "../test-utils.tsx";

const H = hash(0xf6);

async function open(t: ApiTx = tx()) {
  const calls = fakeApi(route({ tx: () => reply(t) }));
  renderApp(`/tx/${t.hash}`);
  await screen.findByRole("heading", { name: "Transaction" });
  return calls;
}
/** The value beside a label in a list of facts. */
const row = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const chip = () => screen.getByRole("heading", { name: "Transaction" }).parentElement!.querySelector(".chip")!;

describe("the transaction page, for a final transaction", () => {
  it("says it is final, and shows its own hash in full with a button to copy it", async () => {
    const user = userEvent.setup();
    await open();
    expect(chip()).toHaveTextContent("Final");
    expect(chip()).toHaveClass("chip-final");
    const own = screen.getByText(H);
    expect(own).toBeInTheDocument();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(own.closest(".hl") as HTMLElement).getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith(H);
  });

  it("says how it ended and where it is final", async () => {
    await open();
    expect(row("Result")).toHaveTextContent("Success");
    expect(row("Result").firstElementChild).toHaveClass("fact-ok");
    expect(row("Block")).toHaveTextContent("3, final on Canton in update 1220 0303…0303");
    expect(within(row("Block")).getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
  });

  it("shows who sent it and who it went to, in full, and says when that is a token", async () => {
    await open();
    expect(within(row("From")).getByRole("link", { name: addr(0x5b) })).toHaveAttribute("href", `/address/${addr(0x5b)}`);
    expect(within(row("To")).getByRole("link", { name: addr(0xcb) })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(within(row("To")).getByText("TKA, a token")).toHaveClass("tag");
  });

  it("shows the ERC-20 transfer it made, decoded", async () => {
    await open();
    expect(row("Token moved")).toHaveTextContent("10 TKA from 0x5b5b…5b5b to 0x5a5a…5a5a");
    expect(within(row("Token moved")).getByRole("link", { name: "0x5a5a…5a5a" })).toHaveAttribute("href", `/address/${addr(0x5a)}`);
  });

  it("shows the value, the fee at its price, the gas, the nonce and the type", async () => {
    await open();
    expect(row("Value")).toHaveTextContent("0 tROME");
    expect(row("Fee")).toHaveTextContent("0.0000863 tROME at 1.67 gwei");
    expect(row("Gas used")).toHaveTextContent("51,698 of 100,000");
    expect(row("Nonce")).toHaveTextContent("1");
    expect(row("Type")).toHaveTextContent("2 (EIP-1559)");
  });

  it("shows a value in the chain's own coin", async () => {
    await open(tx({ value: "1500000000000000000", transfer: null, toToken: null }));
    expect(row("Value")).toHaveTextContent("1.5 tROME");
    expect(screen.queryByText("Token moved", { selector: "dt" })).toBeNull();
    expect(within(row("To")).getByRole("link")).toHaveAttribute("href", `/address/${addr(0xcb)}`);
    expect(screen.queryByText(/, a token/)).toBeNull();
  });

  it("clips a long input and shows all of it on request", async () => {
    const user = userEvent.setup();
    const t = tx();
    await open(t);
    const input = row("Input data");
    expect(input).toHaveTextContent(t.input.slice(0, 20));
    expect(input).not.toHaveTextContent(t.input);
    await user.click(within(input).getByRole("button", { name: "Show all" }));
    expect(within(row("Input data")).getByText(t.input)).toBeInTheDocument();
    await user.click(within(row("Input data")).getByRole("button", { name: "Show less" }));
    expect(row("Input data")).not.toHaveTextContent(t.input);
  });

  it("says when there is no input", async () => {
    await open(tx({ input: "0x", transfer: null, toToken: null }));
    expect(row("Input data")).toHaveTextContent("none");
  });

  it("shows each log with its address, its topics and its data, and names a Transfer", async () => {
    await open();
    expect(row("Logs")).toHaveTextContent("1");
    const log = within(screen.getByRole("group", { name: "Log 1" }));
    expect(log.getByText("Address", { selector: "dt" }).nextElementSibling).toHaveTextContent("0xcbcb…cbcb");
    expect(log.getByText("Address", { selector: "dt" }).nextElementSibling).toHaveTextContent("TKA");
    const topics = log.getByText("Topics", { selector: "dt" }).nextElementSibling!;
    expect(topics).toHaveTextContent("0 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef Transfer");
    expect(topics).toHaveTextContent("1 0x" + "0".repeat(24) + "5b".repeat(20));
    expect(topics).toHaveTextContent("2 0x" + "0".repeat(24) + "5a".repeat(20));
    expect(log.getByText("Data", { selector: "dt" }).nextElementSibling).toHaveTextContent(tx().logs[0]!.data);
  });

  it("does not say Transfer for a topic that is not one", async () => {
    const l = tx().logs[0]!;
    await open(tx({ logs: [{ ...l, topics: ["0x" + "12".repeat(32)] }] }));
    expect(screen.queryByText("Transfer")).toBeNull();
  });

  it("says when it created a contract", async () => {
    await open(tx({ to: null, transfer: null, toToken: null, created: addr(0xf5), logs: [], input: "0x6080" }));
    expect(row("To")).toHaveTextContent("none, this transaction created a contract");
    expect(within(row("Created contract")).getByRole("link", { name: addr(0xf5) })).toHaveAttribute("href", `/address/${addr(0xf5)}`);
  });

  it("is final and failed when it reverted", async () => {
    await open(tx({ success: false, logs: [] }));
    expect(chip()).toHaveTextContent("Final");
    expect(row("Result")).toHaveTextContent("Failed (reverted)");
    expect(row("Result").firstElementChild).toHaveClass("fact-bad");
    expect(screen.queryByText("Not final yet.", { exact: false })).toBeNull();
  });

  it("does not say a reverted token transfer moved anything, though the server still decodes it", async () => {
    await open(tx({ success: false, logs: [] }));
    expect(row("Token transfer")).toHaveTextContent("Tried to move 10 TKA from 0x5b5b…5b5b to 0x5a5a…5a5a. The transaction reverted, so nothing moved.");
    expect(screen.queryByText("Token moved", { selector: "dt" })).toBeNull();
    expect(screen.queryByText(/moved 10 TKA|Token moved/)).toBeNull();
  });

  it("names the types it knows", async () => {
    await open(tx({ type: 0 }));
    expect(row("Type")).toHaveTextContent("0 (legacy)");
  });

  it("does not look again, and does not say that it is not final yet", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls = await open();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("list", { name: "Where this transaction is" })).toBeNull();
    await tick(10_000);
    expect(calls.filter((c) => c.startsWith("/api/tx"))).toHaveLength(1);
  });
});

describe("a transaction that reth holds in its pool, reached by its hash", () => {
  it("says Waiting, and that it is not final yet, in plain words", async () => {
    await open(waitingTx());
    expect(chip()).toHaveTextContent("Waiting");
    expect(chip()).toHaveClass("chip-waiting");
    expect(screen.getByRole("status")).toHaveTextContent("Not final yet. It becomes final when its block is proven and committed on Canton. It is in reth's pool, and no block holds it yet. This page looks again every 2 s.");
  });

  it("shows what reth knows, and says what it does not know yet", async () => {
    await open(waitingTx());
    expect(row("Result")).toHaveTextContent("Not run yet");
    expect(row("Block")).toHaveTextContent("None yet");
    expect(row("Token to move")).toHaveTextContent("10 TKA to 0x5a5a…5a5a");
    expect(row("Value")).toHaveTextContent("0 tROME");
    expect(row("Fee")).toHaveTextContent("Known once a block holds it");
    expect(row("Gas limit")).toHaveTextContent("100,000");
    expect(row("Nonce")).toHaveTextContent("1");
    expect(row("Type")).toHaveTextContent("2 (EIP-1559)");
    expect(screen.queryByText("Gas used", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Logs", { selector: "dt" })).toBeNull();
  });

  it("shows where it is on the way to Final, below the facts", async () => {
    await open(waitingTx());
    const strip = screen.getByRole("list", { name: "Where this transaction is" });
    expect(screen.getByRole("region", { name: "Transaction" }).compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const steps = within(screen.getByRole("list", { name: "Where this transaction is" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Waiting", "Being proven", "Final"]);
    expect(steps[0]).toHaveAttribute("aria-current", "step");
    expect(steps[1]).not.toHaveAttribute("aria-current");
  });

  it("looks again every two seconds, and follows the transaction to Final with no reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let answer: ApiTx = waitingTx();
    const calls = fakeApi(route({ tx: () => reply(answer) }));
    renderApp(`/tx/${H}`);
    await screen.findByRole("heading", { name: "Transaction" });
    expect(chip()).toHaveTextContent("Waiting");
    const asked = () => calls.filter((c) => c.startsWith("/api/tx")).length;
    expect(asked()).toBe(1);
    await tick();
    expect(asked()).toBe(2);
    answer = tx({ status: "proving", block: { number: 4, hash: hash(4), updateId: null }, gasUsed: 34598 });
    await tick();
    expect(chip()).toHaveTextContent("Being proven");
    expect(chip()).toHaveClass("chip-proving");
    expect(screen.getByRole("status")).toHaveTextContent("Not final yet. It becomes final when its block is proven and committed on Canton. Its block is being proven. This page looks again every 2 s.");
    expect(row("Block")).toHaveTextContent("4, not on Canton yet");
    expect(within(row("Block")).getByRole("link", { name: "4" })).toHaveAttribute("href", "/block/4");
    expect(row("Gas used")).toHaveTextContent("34,598 of 100,000");
    expect(row("Result")).toHaveTextContent("Success");
    answer = tx({ block: { number: 4, hash: hash(4), updateId: update(4) } });
    await tick();
    expect(chip()).toHaveTextContent("Final");
    expect(screen.queryByRole("status")).toBeNull();
    expect(row("Block")).toHaveTextContent("4, final on Canton in update 1220 0404…0404");
    const seen = asked();
    await tick(10_000);
    expect(asked()).toBe(seen);
  });

  it("says Not found when the transaction goes away, as one does when its block is refused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let gone = false;
    fakeApi(route({ tx: () => (gone ? reply({ error: NOT_FOUND }, 404) : reply(waitingTx())) }));
    renderApp(`/tx/${H}`);
    await screen.findByText("Waiting", { selector: ".chip" });
    gone = true;
    await tick();
    expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });
});

describe("a transaction that cannot be shown", () => {
  it("says Not found, in the server's words, and does not ask again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls = fakeApi(route({ tx: () => reply({ error: NOT_FOUND }, 404) }));
    renderApp(`/tx/${H}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText(NOT_FOUND.replace("Not found. ", ""))).toBeInTheDocument();
    await tick(10_000);
    expect(calls.filter((c) => c.startsWith("/api/tx"))).toHaveLength(1);
  });

  it("says when the address is not a hash", async () => {
    fakeApi(route({ tx: () => reply({ error: "A transaction is named by its 0x hash." }, 400) }));
    renderApp("/tx/abc");
    expect(await screen.findByText("A transaction is named by its 0x hash.")).toBeInTheDocument();
  });

  it("says it cannot read the chain, and tries again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let healthy = false;
    fakeApi(route({ tx: () => (healthy ? reply(tx()) : reply({ error: "The explorer cannot read the chain right now." }, 502)) }));
    renderApp(`/tx/${H}`);
    expect(await screen.findByRole("heading", { name: "Cannot read the chain" })).toBeInTheDocument();
    healthy = true;
    await tick();
    expect(screen.getByRole("heading", { name: "Transaction" })).toBeInTheDocument();
  });

  it("shows no amount in a coin until the server has named it", async () => {
    let named: () => void = () => {};
    const slow = new Promise<void>((r) => { named = r; });
    const calls = fakeApi(route({ tx: () => reply(tx({ value: "2000000", fee: "3000000" })), status: () => reply(status({ coin: { symbol: "TST", decimals: 6 } })) }));
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => { if (String(input) === "/api/status") await slow; return answer(input, init); });
    renderApp(`/tx/${H}`);
    await screen.findByRole("heading", { name: "Transaction" });
    expect(row("Value")).toHaveTextContent("…");
    expect(row("Fee")).not.toHaveTextContent("tROME");
    expect(screen.queryByText(/tROME/)).toBeNull();
    named();
    await waitFor(() => expect(row("Value")).toHaveTextContent("2 TST"));
    expect(row("Fee")).toHaveTextContent("3 TST");
    expect(calls).toContain("/api/status");
  });

  it("uses the coin the server names, not one of its own", async () => {
    fakeApi(route({ tx: () => reply(tx({ value: "2000000" })), status: () => reply(status({ coin: { symbol: "TST", decimals: 6 } })) }));
    renderApp(`/tx/${H}`);
    await screen.findByRole("heading", { name: "Transaction" });
    await waitFor(() => expect(row("Value")).toHaveTextContent("2 TST"));
  });
});
