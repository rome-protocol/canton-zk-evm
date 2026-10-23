// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiTx, TokenTransfer } from "../api.ts";
import { addr, block, page, blockSummary, fakeApi, goneTx, hash, labelsOf, NOT_FOUND, renderApp, reply, route, status, tick, tokenLabel, tx, txDetail, update, updateDetail, waitingTx } from "../test-utils.tsx";
import type { TxLifecycle } from "../api.ts";

const verifierRun = vi.hoisted(() => ({ line: "" }));
vi.mock("../verify/verifier.ts", async (orig) => ({ ...(await orig<typeof import("../verify/verifier.ts")>()), fetchVerifier: vi.fn(async () => ({ verify: () => verifierRun.line, bytes: 1 })) }));

const H = hash(0xf6);

async function open(t: ApiTx = tx()) {
  const calls = fakeApi(route({ tx: () => reply(t) }));
  renderApp(`/tx/${t.hash}`);
  await screen.findByRole("heading", { name: "Transaction" });
  return calls;
}
/** The value beside a label in a list of facts. */
const row = (label: string) => {
  const own = screen.getAllByText(label, { selector: "dt" }).filter((d) => d.closest("section")?.matches('[aria-label="Transaction"], [aria-label="Input data"]'));
  expect(own).toHaveLength(1);
  return own[0]!.nextElementSibling as HTMLElement;
};
/** The value beside a label in a side card. */
const side = (card: string, label: string) => within(screen.getByRole("region", { name: card })).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const chip = () => screen.getByRole("heading", { name: "Transaction" }).parentElement!.querySelector(".chip")!;

describe("the transaction page, for a final transaction", () => {
  it("says it is final, and shows its own hash in full with a button to copy it", async () => {
    const user = userEvent.setup();
    await open();
    expect(chip()).toHaveTextContent("Final on Canton");
    expect(chip()).toHaveClass("chip-final");
    const own = screen.getByText(H);
    expect(own).toBeInTheDocument();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(own.closest(".hl") as HTMLElement).getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith(H);
  });

  it("says how it ended and where it is final", async () => {
    await open();
    expect(row("Status")).toHaveTextContent("Success");
    expect(row("Status").firstElementChild).toHaveClass("fact-ok");
    expect(row("Block")).toHaveTextContent("3, final on Canton in update 12200303…0303");
    expect(within(row("Block")).getByRole("link", { name: "3" })).toHaveAttribute("href", "/block/3");
  });

  it("shows who sent it and who it went to, in full, and says when that is a token", async () => {
    await open();
    expect(within(row("From")).getByRole("link", { name: addr(0x5b) })).toHaveAttribute("href", `/address/${addr(0x5b)}`);
    expect(within(row("To")).getByRole("link", { name: addr(0xcb) })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(within(row("To")).getByText("TKA, a token")).toHaveClass("tag");
  });

  it("names the contract it went to, with a verified check, and still gives the address in full", async () => {
    const calls = fakeApi(route({ tx: () => reply(tx()), labels: labelsOf([tokenLabel()]) }));
    renderApp(`/tx/${H}`);
    await screen.findByRole("heading", { name: "Transaction" });
    await waitFor(() => expect(within(row("To")).getByRole("link", { name: "Test token A (TKA)" })).toHaveAttribute("href", `/token/${addr(0xcb)}`));
    expect(within(row("To")).getByRole("img", { name: "Verified" })).toBeInTheDocument();
    expect(within(row("To")).getByRole("link", { name: addr(0xcb) })).toHaveAttribute("href", `/token/${addr(0xcb)}`);
    expect(within(row("To")).queryByText("TKA, a token")).toBeNull();
    expect(calls.filter((c) => c.startsWith("/api/labels"))).toHaveLength(1);
  });

  it("shows the ERC-20 transfer it made, decoded", async () => {
    await open();
    expect(row("Token moved")).toHaveTextContent("10 TKA from 0x5b5b…5b5b to 0x5a5a…5a5a");
    expect(within(row("Token moved")).getByRole("link", { name: "0x5a5a…5a5a" })).toHaveAttribute("href", `/address/${addr(0x5a)}`);
  });

  it("shows the value, the fee, the gas price, the gas with its share used, the nonce and the type", async () => {
    await open();
    expect(row("Value")).toHaveTextContent("0 tROME");
    expect(row("Transaction fee")).toHaveTextContent("0.0000863356 tROME");
    expect(row("Gas price")).toHaveTextContent("1.67 gwei");
    expect(row("Gas used")).toHaveTextContent("51,698 of 100,000 (51.70%)");
    expect(row("Nonce and position")).toHaveTextContent("1");
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

  it("says when it created a contract", async () => {
    await open(tx({ to: null, transfer: null, toToken: null, created: addr(0xf5), logs: [], input: "0x6080" }));
    expect(row("To")).toHaveTextContent("none, this transaction created a contract");
    expect(within(row("Created contract")).getByRole("link", { name: addr(0xf5) })).toHaveAttribute("href", `/address/${addr(0xf5)}`);
  });

  it("is final and failed when it reverted", async () => {
    await open(tx({ success: false, logs: [] }));
    expect(chip()).toHaveTextContent("Final on Canton");
    expect(row("Status")).toHaveTextContent("Failed (reverted)");
    expect(row("Status").firstElementChild).toHaveClass("fact-bad");
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
    await tick(10_000);
    expect(calls.filter((c) => c.startsWith("/api/tx/"))).toHaveLength(1);
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
    expect(row("Status")).toHaveTextContent("Not run yet");
    expect(row("Block")).toHaveTextContent("None yet");
    expect(row("Token to move")).toHaveTextContent("10 TKA to 0x5a5a…5a5a");
    expect(row("Value")).toHaveTextContent("0 tROME");
    expect(row("Transaction fee")).toHaveTextContent("Known once a block holds it");
    expect(row("Gas limit")).toHaveTextContent("100,000");
    expect(row("Nonce and position")).toHaveTextContent("1");
    expect(row("Type")).toHaveTextContent("2 (EIP-1559)");
    expect(screen.queryByText("Gas used", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Logs", { selector: "dt" })).toBeNull();
  });

  it("shows the way to final with its steps not reached left open, above the facts", async () => {
    await open(waitingTx());
    const way = screen.getByRole("region", { name: "The way to final" });
    expect(way.compareDocumentPosition(screen.getByRole("region", { name: "Transaction" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const steps = within(way).getAllByRole("listitem");
    expect(steps.map((x) => x.querySelector(".how-n")!.textContent)).toEqual(["Accepted", "In a block", "Proof done", "Final on Canton"]);
    expect(steps[0]).toHaveClass("got");
    expect(steps.slice(1).every((x) => x.classList.contains("none"))).toBe(true);
    expect(steps[0]!.querySelector(".how-dot svg")).not.toBeNull();
    expect(steps.slice(1).every((x) => x.querySelector(".how-dot svg") === null)).toBe(true);
  });

  it("says a transaction in a block that Canton holds and the indexer has not read is final but not indexed, and keeps looking", async () => {
    await open(tx({ status: "unindexed", block: { number: 4, hash: hash(4), updateId: null } }));
    expect(screen.getByRole("status")).toHaveTextContent("Final on Canton, not indexed yet.");
    expect(screen.getByRole("status")).not.toHaveTextContent("Not final yet");
    const steps = within(screen.getByRole("region", { name: "The way to final" })).getAllByRole("listitem");
    expect(steps[1]).toHaveClass("got");
    expect(steps[2]).toHaveClass("got");
    expect(steps[3]).toHaveClass("got");
  });

  it("does not say in any card that a not-yet-indexed transaction is not final: the Canton card, the proof card and Verify say the explorer has not read the record", async () => {
    await openFinal(tx({ status: "unindexed", block: { number: 4, hash: hash(4), updateId: null }, lifecycle: journal() }), { blockDetail: () => reply(blockSummary({ status: "unindexed", number: 4, hash: hash(4), canton: null })) });
    const canton = screen.getByRole("region", { name: "Canton record" }), proof = screen.getByRole("region", { name: "The proof" });
    for (const card of [canton, proof]) {
      expect(card).toHaveTextContent("Final on Canton, not indexed yet");
      expect(card).toHaveTextContent("the record is shown once the explorer reads it");
      expect(card).not.toHaveTextContent("Not on Canton yet");
      expect(card).not.toHaveTextContent("being proven");
    }
    expect(await within(proof).findByText("opens once the explorer has read the record")).toBeInTheDocument();
    expect(proof).not.toHaveTextContent("opens once the block is final on Canton");
    expect(within(proof).getByRole("button", { name: /Verify block 4/ })).toBeDisabled();
  });

  it("looks again every two seconds, and follows the transaction to Final with no reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let answer: ApiTx = waitingTx();
    const calls = fakeApi(route({ tx: () => reply(answer) }));
    renderApp(`/tx/${H}`);
    await screen.findByRole("heading", { name: "Transaction" });
    expect(chip()).toHaveTextContent("Waiting");
    const asked = () => calls.filter((c) => c.startsWith("/api/tx/")).length;
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
    expect(row("Status")).toHaveTextContent("Success");
    answer = tx({ block: { number: 4, hash: hash(4), updateId: update(4) } });
    await tick();
    expect(chip()).toHaveTextContent("Final on Canton");
    expect(screen.queryByRole("status")).toBeNull();
    expect(row("Block")).toHaveTextContent("4, final on Canton in update 12200404…0404");
    const seen = asked();
    await tick(10_000);
    expect(asked()).toBe(seen);
  });

  it("says Not found when the transaction goes away, as one does when its block is refused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let gone = false;
    fakeApi(route({ tx: () => (gone ? reply({ error: NOT_FOUND }, 404) : reply(waitingTx())) }));
    renderApp(`/tx/${H}`);
    await waitFor(() => expect(chip()).toHaveTextContent("Waiting"));
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
    expect(calls.filter((c) => c.startsWith("/api/tx/"))).toHaveLength(1);
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
    expect(row("Transaction fee")).not.toHaveTextContent("tROME");
    expect(screen.queryByText(/tROME/)).toBeNull();
    named();
    await waitFor(() => expect(row("Value")).toHaveTextContent("2 TST"));
    expect(row("Transaction fee")).toHaveTextContent("3 TST");
    expect(calls).toContain("/api/status");
  });

  it("uses the coin the server names, not one of its own", async () => {
    fakeApi(route({ tx: () => reply(tx({ value: "2000000" })), status: () => reply(status({ coin: { symbol: "TST", decimals: 6 } })) }));
    renderApp(`/tx/${H}`);
    await screen.findByRole("heading", { name: "Transaction" });
    await waitFor(() => expect(row("Value")).toHaveTextContent("2 TST"));
  });
});

describe("the stage, in plain words", () => {
  const stage = () => document.querySelector(".stage") as HTMLElement;

  it("says each state in its own words, and marks the page with the state", async () => {
    const cases: Array<[ApiTx, string, string]> = [
      [waitingTx({ state: "pending" }), "pending", "Waiting to go into a block"],
      [tx({ status: "proving", state: "proving", block: { number: 4, hash: hash(4), updateId: null } }), "proving", "In a block that is being proven"],
      [tx({ status: "unindexed", block: { number: 4, hash: hash(4), updateId: null } }), "unindexed", "Final on Canton in block 4, which the explorer has not indexed yet"],
            [goneTx({ status: "replaced", state: "replaced", reason: "Another transaction from the same sender took nonce 7." }), "replaced", "Replaced by another transaction with the same nonce"],
      [goneTx({ status: "dropped", state: "dropped", reason: "The chain refused it 5 times in a row: insufficient funds." }), "dropped", "Dropped: The chain refused it 5 times in a row: insufficient funds."],
    ];
    for (const [t, state, words] of cases) {
      await open(t);
      expect(stage()).toHaveTextContent(words);
      expect(stage()).toHaveAttribute("data-state", state);
      expect(stage()).toHaveClass(`s-${state}`);
      cleanup();
    }
  });

  it("does not repeat in a green line under the title that a final transaction is final: the chip says it", async () => {
    await open(tx({ state: "final" }));
    expect(chip()).toHaveTextContent("Final on Canton");
    expect(stage()).toBeNull();
    expect(screen.queryByText("Final on Canton in block 3")).toBeNull();
  });

  it("keeps one polite live region in the page whatever the state, so a change to final is announced, with words only for the ear once it is final", async () => {
    await open(waitingTx({ state: "pending" }));
    expect(document.querySelectorAll("[aria-live=polite]")).toHaveLength(1);
    expect(document.querySelector("[aria-live=polite] .stage")).toHaveTextContent("Waiting to go into a block");
    cleanup();
    await open(tx({ state: "final" }));
    const live = document.querySelectorAll("[aria-live=polite]");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent("This transaction is now final on Canton.");
    expect(live[0]!.querySelector(".sr-only")).not.toBeNull();
  });

  it("says nothing under the title for a final one with no block, and a dropped one without a reason", async () => {
    await open(tx({ state: "final", block: null }));
    expect(stage()).toBeNull();
    cleanup();
    await open(goneTx({ reason: null }));
    expect(stage()).toHaveTextContent("Dropped: no reason was given");
  });
});

describe("a transaction the explorer accepted that reth no longer holds", () => {
  it("shows who sent it and its nonce, and no fact it cannot know", async () => {
    await open(goneTx({ status: "waiting", state: "pending", reason: "It had gone missing, so it was sent to the chain again (send 2)." }));
    expect(chip()).toHaveTextContent("Waiting");
    expect(within(row("From")).getByRole("link", { name: addr(0x5b) })).toHaveAttribute("href", `/address/${addr(0x5b)}`);
    expect(row("Nonce")).toHaveTextContent("7");
    expect(row("Note")).toHaveTextContent("sent to the chain again (send 2)");
    expect(screen.queryByText("Gas used", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Value", { selector: "dt" })).toBeNull();
  });

  it("does not repeat a dropped transaction's reason as a note", async () => {
    await open(goneTx());
    expect(screen.queryByText("Note", { selector: "dt" })).toBeNull();
    expect(chip()).toHaveTextContent("Dropped");
    expect(chip()).toHaveClass("chip-dropped");
  });
});

describe("looking again until the transaction is settled", () => {
  async function asksAfter(first: ApiTx): Promise<{ before: number; after: number }> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls = fakeApi(route({ tx: () => reply(first) }));
    renderApp(`/tx/${first.hash}`);
    await screen.findByRole("heading", { name: "Transaction" });
    const asked = () => calls.filter((c) => c.startsWith("/api/tx/")).length;
    await tick();
    const before = asked();
    await tick(10_000);
    const after = asked();
    cleanup();
    vi.useRealTimers();
    return { before, after };
  }

  it("keeps looking while it is pending, proving or not indexed yet", async () => {
    for (const t of [tx({ status: "unindexed", block: { number: 4, hash: hash(4), updateId: null } }), waitingTx(), goneTx({ status: "waiting", state: "pending", reason: null }), tx({ status: "proving", state: "proving", block: { number: 4, hash: hash(4), updateId: null } })]) {
      const { before, after } = await asksAfter(t);
      expect(after).toBeGreaterThan(before);
    }
  });

  it("stops looking when it is final, replaced or dropped", async () => {
    for (const t of [tx(), goneTx({ status: "replaced", state: "replaced" }), goneTx()]) {
      const { before, after } = await asksAfter(t);
      expect(after).toBe(before);
    }
  });
});

const journal = (over: Partial<TxLifecycle> = {}): TxLifecycle => ({
  state: "final", reason: null, acceptedAt: "2026-10-04T01:37:14.500Z", acceptedVia: "rpc", includedAt: "2026-10-04T01:37:16.000Z", attempts: 1, leftOutReason: null,
  proofStartedAt: "2026-10-04T01:37:16.400Z", proofEndedAt: "2026-10-04T01:37:23.000Z", submittedAt: "2026-10-04T01:37:23.050Z", committedAt: "2026-10-04T01:37:23.412Z", finalAt: "2026-10-04T01:37:23.412Z", finalBlock: 3, timeToFinalMs: 8912, ...over,
});

/** The final transaction with everything its page reads: its block and the block's record, the update, and the stage 2 detail. */
async function openFinal(t: ApiTx = tx({ lifecycle: journal() }), over: Parameters<typeof route>[0] = {}) {
  const calls = fakeApi(route({ tx: () => reply(t), blockDetail: () => reply(blockSummary()), update: () => reply(updateDetail()), txDetail: () => reply(txDetail()), ...over }));
  renderApp(`/tx/${t.hash}`);
  await screen.findByRole("heading", { name: "Transaction" });
  return calls;
}
const way = () => within(screen.getByRole("region", { name: "The way to final" }));
const steps = () => way().getAllByRole("listitem").map((x) => x.textContent);

describe("the block's answers, kept by one cache for every page", () => {
  it("opens the block page from a transaction page and shows the block, though the transaction page has read the block's summary", async () => {
    const user = userEvent.setup();
    await openFinal(undefined, { block: () => reply(block()) });
    await waitFor(() => expect(row("Time")).toHaveTextContent("04 Oct 2026, 01:37:16 UTC"));
    await user.click(within(row("Block")).getByRole("link", { name: "3" }));
    expect(await screen.findByRole("heading", { name: "Block #3" })).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong|cannot read/i)).toBeNull();
  });
});

describe("the order of the overview, as on the screen", () => {
  it("reads Status, Stage, Block, Time, From, To, the token, Value, Transaction fee, Gas price, Gas, Fees, Burnt fees, then Nonce and position and Type", async () => {
    await openFinal(undefined, { txDetail: () => reply(txDetail({ index: 2 })) });
    await waitFor(() => expect(row("Fees")).toHaveTextContent("Base"));
    const labels = within(screen.getByRole("region", { name: "Transaction" })).getAllByText(/./, { selector: "dt" }).map((d) => d.textContent);
    const at = (l: string) => labels.indexOf(l);
    const order = ["Status", "Stage", "Block", "Time", "From", "To", "Token moved", "Value", "Transaction fee", "Gas price", "Gas used", "Fees", "Burnt fees", "Nonce and position", "Type"];
    expect(order.map(at).every((i) => i >= 0)).toBe(true);
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
  });
});

describe("the way to final", () => {
  it("shows each step with its time, the seconds between them and where each time comes from", async () => {
    await openFinal();
    await waitFor(() => expect(way().getByText("position 0 of 1")).toBeInTheDocument());
    expect(steps()).toEqual([
      "Accepted01:37:14.500by Ostia's RPC",
      "+1.50 sIn block 301:37:16.000position 0 of 1",
      "+7.00 sProof done01:37:23.000ZisK, 1,344 bytes",
      "+0.41 sFinal on Canton01:37:23.412000Canton record time",
    ]);
    expect(way().getByText(/Final/, { selector: "span" })).toHaveTextContent("Final 8.91 s after Ostia accepted it.");
    expect(way().getByText("8.91 s")).toHaveClass("num");
  });

  it("marks each reached step with a check circle, keeps where a time comes from as its title, and draws no source tag", async () => {
    await openFinal();
    await waitFor(() => expect(way().getByText("position 0 of 1")).toBeInTheDocument());
    const items = way().getAllByRole("listitem");
    for (const li of items) expect(li.querySelector(".how-dot svg")).not.toBeNull();
    expect(items[3]).toHaveClass("last");
    expect(items[0]!.querySelector(".how-t")).toHaveAttribute("title", "producer log");
    expect(items[3]!.querySelector(".how-t")).toHaveAttribute("title", "Canton record time");
    expect(document.querySelector(".way .how-src")).toBeNull();
  });

  it("adds the median time to final of the last hour, and says it was not refused or left out of any earlier block when the journal shows no earlier attempt", async () => {
    const calls = await openFinal(undefined, { stats: (p) => (p.includes("/summary") ? reply({ timeToFinal: { median: 8.5, p95: 8.9, samples: 12, capped: false } }) : reply({}, 404)) });
    await waitFor(() => expect(way().getByText(/The median for the last hour is 8\.5 s\./)).toBeInTheDocument());
    expect(calls.some((c) => c.startsWith("/api/stats/summary?window=1h"))).toBe(true);
    expect(way().getByText("Not refused or left out of any earlier block.")).toBeInTheDocument();
  });

  it("says no median when the hour has no final transaction or the stats cannot be read, and never says 'not refused' for a transaction that was", async () => {
    await openFinal(undefined, { stats: () => reply({ timeToFinal: null }) });
    await waitFor(() => expect(way().getByText(/after Ostia accepted it/)).toBeInTheDocument());
    expect(way().queryByText(/median/i)).toBeNull();
    cleanup();
    await openFinal(tx({ lifecycle: journal({ attempts: 3 }) }), { stats: () => reply({ error: "down" }, 503) });
    await waitFor(() => expect(way().getByText(/It took 3 attempts\./)).toBeInTheDocument());
    expect(way().queryByText(/median/i)).toBeNull();
    expect(way().queryByText(/Not refused/)).toBeNull();
  });

  it("says nothing of 'not refused' when the journal counts no attempt at all: that is no evidence", async () => {
    await openFinal(tx({ lifecycle: journal({ attempts: 0 }) }));
    await waitFor(() => expect(way().getByText(/after Ostia accepted it/)).toBeInTheDocument());
    expect(way().queryByText(/Not refused/)).toBeNull();
  });

  it("says when the producer's journal has no row, shows a dash for each time it would hold, and still gives Canton's record time", async () => {
    await openFinal(tx());
    await waitFor(() => expect(way().getByText("Canton record time")).toBeInTheDocument());
    expect(way().getByText(/no row for this transaction/)).toBeInTheDocument();
    expect(way().getAllByText("—")).toHaveLength(3);
    expect(way().queryByText(/after Ostia accepted it/)).toBeNull();
    expect(way().queryByText(/\+\d/)).toBeNull();
  });

  it("gives no time to final unless the journal does, and shows the attempts and why it was left out only when there are some", async () => {
    await openFinal(tx({ lifecycle: journal({ timeToFinalMs: null }) }));
    expect(way().queryByText(/after Ostia accepted it/)).toBeNull();
    expect(way().queryByText(/attempts/)).toBeNull();
    cleanup();
    await openFinal(tx({ lifecycle: journal({ attempts: 2, leftOutReason: "the block was full" }) }));
    expect(way().getByText(/It took 2 attempts\./)).toBeInTheDocument();
    expect(way().getByText(/Left out of an earlier block: the block was full\./)).toBeInTheDocument();
    expect(way().queryByText(/not refused/i)).toBeNull();
  });

  it("leaves the steps a transaction has not reached open, and names no block it is not in", async () => {
    await openFinal(tx({ status: "proving", block: { number: 4, hash: hash(4), updateId: null }, lifecycle: journal({ state: "proving", proofEndedAt: null, finalAt: null, timeToFinalMs: null }) }), { blockDetail: () => reply(blockSummary({ status: "proving", number: 4, canton: null })) });
    const li = way().getAllByRole("listitem");
    expect(li.map((x) => x.className)).toEqual(["got", "got", "none", "none"]);
    expect(li[1]).toHaveTextContent("In block 4");
    expect(li[3]).toHaveTextContent("—");
    expect(li[3]).toHaveTextContent("not reached yet");
    expect(way().queryByText(/after Ostia accepted it/)).toBeNull();
  });
});

describe("the Canton record and the proof of the transaction's block", () => {
  it("shows the update, its time, the synchronizer, the reader's offset, the template and the command id from the producer log, and links to the record and the block", async () => {
    await openFinal();
    await waitFor(() => expect(side("Canton record", "Offset")).toHaveTextContent("52"));
    expect(side("Canton record", "Update id")).toHaveTextContent("12200303…0303");
    expect(side("Canton record", "Record time")).toHaveTextContent("2026-10-04T01:37:23.412Z");
    expect(side("Canton record", "Synchronizer")).toHaveTextContent("da::1220");
    expect(side("Canton record", "Offset")).toHaveTextContent("reader's participant");
    expect(side("Canton record", "Template")).toHaveTextContent("Zk.Chain:ZkChain · Advance producer log");
    expect(side("Canton record", "Command id")).toHaveTextContent("cmd-1 producer log");
    expect(within(side("Canton record", "Block")).getByRole("link", { name: "Block 3" })).toHaveAttribute("href", "/block/3");
    const card = within(screen.getByRole("region", { name: "Canton record" }));
    expect(card.getByRole("link", { name: /Open the Canton record/ })).toHaveAttribute("href", `/canton/${update(3)}`);
    expect(card.getByRole("link", { name: /Open block 3/ })).toHaveAttribute("href", "/block/3");
  });

  it("says the template and the command id are not in the producer log when the update's route has none", async () => {
    await openFinal(undefined, { update: () => reply(updateDetail(3, { producerRecord: null })) });
    await waitFor(() => expect(side("Canton record", "Offset")).toHaveTextContent("52"));
    expect(side("Canton record", "Template")).toHaveTextContent("not in the producer's log");
    expect(side("Canton record", "Command id")).toHaveTextContent("not in the producer's log");
  });

  it("shows the proof's facts, read from its bytes, with the pins", async () => {
    await openFinal();
    await screen.findByText("Program key");
    const proof = within(screen.getByRole("region", { name: "The proof" }));
    expect(proof.getAllByText(/ours|ZisK 1\.3\.1|this block/).length).toBeGreaterThanOrEqual(3);
    expect(proof.getByText("1,344 bytes")).toBeInTheDocument();
  });

  it("says a block that is not on Canton yet has no record and no proof, and greys Verify", async () => {
    await openFinal(tx({ status: "proving", block: { number: 4, hash: hash(4), updateId: null }, lifecycle: null }), { blockDetail: () => reply(blockSummary({ status: "proving", number: 4, canton: null })) });
    expect(await screen.findByText("Not on Canton yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verify block 4 in your browser/ })).toBeDisabled();
  });
});

describe("Verify, on the transaction page", () => {
  const record = { number: 3, hash: hash(3), contractId: "00cc", header: "22".repeat(8), txs: "33".repeat(8), proof: "11".repeat(8) };
  const ok = (h: string) => `ok ${"cd".repeat(32)} ${"cd".repeat(32)} ${h.slice(2)} ${"0".repeat(64)} 3 ${"1".repeat(64)} 1700000000 30000000 21000 1`;
  const recordCalls = (calls: string[]) => calls.filter((c) => c === "/api/blocks/3/record");

  it("reads the block's record only when it is pressed, and once", async () => {
    verifierRun.line = ok(hash(3));
    const user = userEvent.setup();
    const calls = await openFinal(undefined, { blockRecord: () => reply(record) });
    const button = await screen.findByRole("button", { name: "Verify block 3 in your browser" });
    await screen.findByText("Program key");
    expect(recordCalls(calls)).toHaveLength(0);
    // The page reads the block's summary, never the old route that carries the record's hex.
    expect(calls.filter((c) => c.startsWith("/api/block/"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("/api/blocks/3") && c !== "/api/blocks/3")).toEqual([]);
    await user.click(button);
    expect(await screen.findByText(/Passed\./)).toBeInTheDocument();
    expect(recordCalls(calls)).toHaveLength(1);
  });

  it("fails with the check's own reason", async () => {
    verifierRun.line = "no the proof does not verify";
    const user = userEvent.setup();
    await openFinal(undefined, { blockRecord: () => reply(record) });
    await user.click(await screen.findByRole("button", { name: "Verify block 3 in your browser" }));
    expect(await screen.findByText(/Failed: the proof does not verify\./)).toBeInTheDocument();
  });

  it("fails when the proof is for another block", async () => {
    verifierRun.line = ok(hash(9));
    const user = userEvent.setup();
    await openFinal(undefined, { blockRecord: () => reply(record) });
    await user.click(await screen.findByRole("button", { name: "Verify block 3 in your browser" }));
    expect(await screen.findByText(/not for this block/)).toBeInTheDocument();
  });

  it("says when the record cannot be read", async () => {
    const user = userEvent.setup();
    await openFinal(undefined, { blockRecord: () => reply({ error: "boom" }, 500) });
    await user.click(await screen.findByRole("button", { name: "Verify block 3 in your browser" }));
    expect(await screen.findByText(/Could not run the check here: boom/)).toBeInTheDocument();
  });
});

describe("the internal calls row, and the stage 2 gap", () => {
  it("shows the count of internal calls once the block is derived", async () => {
    await openFinal(undefined, { txDetail: () => reply(txDetail({ callCount: 4 })) });
    await waitFor(() => expect(row("Calls made")).toHaveTextContent("4"));
  });

  it("says not derived yet for a final transaction whose block is not derived, and gives no count", async () => {
    await openFinal(undefined, { txDetail: () => reply(txDetail({ derived: false, callCount: null })) });
    await waitFor(() => expect(row("Calls made")).toHaveTextContent("not derived yet"));
  });

  it("has no row for a transaction that is not final", async () => {
    await open(waitingTx());
    expect(screen.queryByText("Calls made", { selector: "dt" })).toBeNull();
  });
});

describe("the facts the block and the detail add to the overview", () => {
  it("shows the time of its block, the stage, the final head, the gas price, the fees, the burnt fees and its position", async () => {
    await openFinal(undefined, { txDetail: () => reply(txDetail({ index: 2 })) });
    await waitFor(() => expect(row("Time")).toHaveTextContent("04 Oct 2026, 01:37:16 UTC"));
    expect(row("Stage")).toHaveTextContent(/^Final on Canton · final .* ago · nothing to confirm beyond final$/);
    expect(row("Block")).toHaveTextContent("final head is 3");
    expect(row("Gas price")).toHaveTextContent("1.67 gwei");
    await waitFor(() => expect(row("Fees")).toHaveTextContent("Base 0.67 gwei · Max 2 gwei · Max priority 1 gwei"));
    // 0.67 gwei x 51,698 gas
    expect(row("Burnt fees")).toHaveTextContent("0.0000346376 tROME");
    expect(row("Nonce and position")).toHaveTextContent("1 · position 2 in block 3");
  });

  it("gives only the base fee for a legacy transaction, which signed no caps, and says the position is unknown rather than guessing it", async () => {
    await openFinal(undefined, { txDetail: () => reply(txDetail({ index: null, maxFeePerGas: null, maxPriorityFeePerGas: null })) });
    await waitFor(() => expect(row("Fees")).toHaveTextContent("Base 0.67 gwei"));
    expect(row("Fees")).not.toHaveTextContent("Max");
    expect(row("Nonce and position")).not.toHaveTextContent("position 0");
  });

  it("says reading, then cannot be read, while the block's time is not there; and shows none of these for a transaction in no block", async () => {
    await openFinal(undefined, { blockDetail: () => reply({ error: "boom" }, 500) });
    await waitFor(() => expect(row("Time")).toHaveTextContent("cannot be read right now"));
    cleanup();
    await open(waitingTx());
    for (const l of ["Time", "Gas price", "Fees", "Burnt fees"]) expect(screen.queryByText(l, { selector: "dt" })).toBeNull();
  });
});

describe("the footer of the way to final", () => {
  it("is not drawn when none of its lines has anything to say", async () => {
    // Final, no time to final, no median for the hour, no attempt on record: nothing to put in it.
    await openFinal(tx({ lifecycle: journal({ timeToFinalMs: null, attempts: 0 }) }), { stats: () => reply({ timeToFinal: null }) });
    await waitFor(() => expect(way().getByText("Canton record time")).toBeInTheDocument());
    expect(document.querySelector(".way-foot")).toBeNull();
  });
});

describe("the Token transfers row of the overview", () => {
  const xfer = (i: number, over: Partial<TokenTransfer> = {}): TokenTransfer => ({ logIndex: i, batchIndex: 0, methodId: null, creation: false, timestamp: 1700000000, token: addr(0xcb), standard: "ERC-20", from: addr(0x5b), to: addr(0x60 + i), amount: "10000000000000000000", tokenId: null, ...over });
  const usd = tokenLabel({ address: addr(0xcb), name: "Test USD", symbol: "tUSD", decimals: 18 });

  it("lists the transfers of a final transaction by name with their amounts, the first few, and points to the list below for the rest", async () => {
    const items = Array.from({ length: 7 }, (_, i) => xfer(i));
    const calls = await openFinal(tx({ transfer: null, lifecycle: journal() }), { labels: labelsOf([usd]), txTransfers: () => reply({ ...page(items), derived: true }) });
    await waitFor(() => expect(row("Token transfers")).toHaveTextContent("10"));
    const r = row("Token transfers");
    expect(r.querySelectorAll(".xfer-line")).toHaveLength(5);
    await waitFor(() => expect(r).toHaveTextContent("tUSD"));
    expect(r).toHaveTextContent("and 2 more in the Token transfers list below");
    expect(calls.filter((c) => c.includes("/token-transfers"))).toHaveLength(1);
  });

  it("reads each transfer as a sentence: From X to Y for N Token (SYM)", async () => {
    await openFinal(tx({ transfer: null, lifecycle: journal() }), { labels: labelsOf([usd]), txTransfers: () => reply({ ...page([xfer(1)]), derived: true }) });
    await waitFor(() => expect(row("Token transfers")).toHaveTextContent("tUSD"));
    const line = row("Token transfers").querySelector(".xfer-line")!;
    expect(line.textContent).toMatch(/^From \S+ to \S+ for [\d.,]+ .*Test USD \(tUSD\)/);
    expect(line.textContent).not.toContain("→");
    expect([...line.querySelectorAll(".muted")].map((x) => x.textContent)).toEqual(["From", "to", "for"]);
  });

  it("gives no number when the transfers run past the first page, since the page cannot count what it has not read", async () => {
    const items = Array.from({ length: 25 }, (_, i) => xfer(i));
    await openFinal(tx({ transfer: null, lifecycle: journal() }), { labels: labelsOf([usd]), txTransfers: () => reply({ ...page(items, "cursor-2"), derived: true }) });
    await waitFor(() => expect(row("Token transfers").querySelectorAll(".xfer-line")).toHaveLength(5));
    const r = row("Token transfers");
    expect(r).toHaveTextContent("and more in the Token transfers list below");
    expect(r).not.toHaveTextContent(/and \d+ more/);
  });

  it("falls back to the one transfer /api/tx decoded where the list holds none", async () => {
    await openFinal(tx({ lifecycle: journal() }), { txTransfers: () => reply({ ...page([]), derived: true }) });
    await waitFor(() => expect(row("Token moved")).toHaveTextContent("10 TKA"));
  });
});
