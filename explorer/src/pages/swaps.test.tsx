// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { addr, block, blockDetail, blockSummary, fakeApi, hash, page, plainLeg, renderApp, reply, route, status, swapItem, swapLeg, tx, txDetail, update, updateDetail } from "../test-utils.tsx";

const TOKEN = (a: string) => reply({ address: a, standard: "ERC-20", name: "Test token A", symbol: "TKA", decimals: 18, derived: true });
const PAY = hash(0x6d);

async function openBlock(legs = [swapLeg()], more: Parameters<typeof route>[0] = {}, count = legs.length) {
  const b = block({ number: 16816, legs });
  const calls = fakeApi(route({
    block: () => reply(b), status: () => reply(status()), blockDetail: () => reply(blockDetail({ number: 16816, legsCount: count })), update: () => reply(updateDetail(16816)),
    swaps: () => reply(swapItem()), tokens: TOKEN, ...more,
  }));
  renderApp("/block/16816");
  await screen.findByRole("heading", { name: "Block #16816" });
  return calls;
}
const settled = () => within(screen.getByRole("region", { name: "Settled with this block" }));

describe("the block page: Settled with this block", () => {
  it("shows a swap as the two-sided card: the seller's amount on Canton, the buyer's token on Ostia, and the one Canton transaction that settled both", async () => {
    await openBlock();
    const s = settled();
    expect(await s.findByText("Seller gives")).toBeInTheDocument();
    expect(s.getByText("2.5")).toBeInTheDocument();
    expect(s.getByText("TKB")).toBeInTheDocument();
    expect(s.getByText("On Canton")).toBeInTheDocument();
    expect(s.getByText("Buyer gives")).toBeInTheDocument();
    expect(await s.findByText("2")).toBeInTheDocument();
    expect(s.getByText("TKA")).toBeInTheDocument();
    expect(s.getByText("On Ostia")).toBeInTheDocument();
    expect(s.getByText(/Settled together in one Canton transaction/)).toBeInTheDocument();
    expect(s.getByRole("link", { name: update(0xad).slice(0, 8) + "…" + update(0xad).slice(-4) })).toHaveAttribute("href", `/canton/${update(0xad)}`);
  });

  it("links the list of all swaps", async () => {
    await openBlock();
    expect(await settled().findByRole("link", { name: "All swaps" })).toHaveAttribute("href", "/swaps");
  });

  it("names the payer and the payee of the EVM side, and links the swap's own page", async () => {
    await openBlock();
    const s = settled();
    expect(await s.findByRole("link", { name: "0x0c0c…0c0c" })).toHaveAttribute("href", `/address/${addr(0x0c)}`);
    expect(s.getByRole("link", { name: "0xb0b0…b0b0" })).toHaveAttribute("href", `/address/${addr(0xb0)}`);
    expect(s.getByRole("link", { name: "Open swap" })).toHaveAttribute("href", `/swap/${PAY}`);
  });

  it("still shows the card from the leg when the swap itself cannot be read", async () => {
    await openBlock([swapLeg()], { swaps: () => reply({ error: "Not found." }, 404) });
    const s = settled();
    expect(await s.findByText("Seller gives")).toBeInTheDocument();
    expect(s.getByText("2.5")).toBeInTheDocument();
    expect(await s.findByText("2")).toBeInTheDocument();
    expect(s.getByRole("link", { name: "Open swap" })).toHaveAttribute("href", `/swap/${PAY}`);
  });

  it("shows every other leg as one compact line: a deposit, a plain payment, a claim and a withdrawal", async () => {
    const claim = plainLeg({ legIndex: 2, legId: hash(0x94), canton: { role: "funded-claim", amount: "25000000000", instrument: { admin: "a::1220", id: "TKB" }, settledUpdateId: update(0xf0), recipient: addr(0x0c) } });
    const out = plainLeg({ legIndex: 3, legId: hash(0x3e), kind: "withdrawal" });
    const pay = swapLeg({ legIndex: 4, legId: hash(0x7e), canton: null });
    await openBlock([plainLeg(), claim, out, pay]);
    const lines = settled().getAllByRole("listitem");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toHaveTextContent("Deposit");
    expect(lines[1]).toHaveTextContent("Claim");
    expect(lines[1]).toHaveTextContent("2.5 TKB");
    expect(lines[2]).toHaveTextContent("Withdrawal");
    expect(lines[3]).toHaveTextContent("Payment");
    expect(within(lines[0]!).getByRole("link", { name: "Leg 1" })).toHaveAttribute("href", `/leg/${hash(0x1e)}`);
    expect(settled().queryByText("Seller gives")).toBeNull();
  });

  it("has no panel for a block that recorded no legs", async () => {
    await openBlock([]);
    await screen.findByRole("region", { name: "Transactions" });
    expect(screen.queryByRole("region", { name: "Settled with this block" })).toBeNull();
  });

  it("says how many legs a block recorded when it recorded more than 50, and pages through them from the block's own route", async () => {
    const first = Array.from({ length: 50 }, (_, i) => plainLeg({ legIndex: i, legId: hash(0x10 + i) }));
    const calls = await openBlock(first, { blockLegs: () => reply(page([plainLeg({ legIndex: 50, legId: hash(0xaa) })])) }, 73);
    const s = settled();
    expect(s.getAllByRole("listitem")).toHaveLength(50);
    expect(await s.findByText(/73 legs in this block/)).toBeInTheDocument();
    await userEvent.click(s.getByRole("button", { name: "Page through all 73 legs" }));
    expect(await screen.findByRole("link", { name: "50" })).toHaveAttribute("href", `/leg/${hash(0xaa)}`);
    expect(calls.some((c) => c.startsWith("/api/blocks/16816/legs"))).toBe(true);
  });
});

describe("the transaction page: Canton side", () => {
  async function openTx(legs = [swapLeg()]) {
    const t = tx({ hash: hash(0x04), from: addr(0x0c), legs });
    fakeApi(route({ tx: () => reply(t), txDetail: () => reply(txDetail({ legs })), swaps: () => reply(swapItem()), tokens: TOKEN, blockDetail: () => reply(blockSummary()), update: () => reply(updateDetail()) }));
    renderApp(`/tx/${t.hash}`);
    await screen.findByRole("heading", { name: "Transaction" });
  }

  it("shows the same two-sided card when the transaction caused a swap's payment", async () => {
    await openTx();
    const s = within(await screen.findByRole("region", { name: "Canton side" }));
    expect(await s.findByText("Seller gives")).toBeInTheDocument();
    expect(s.getByText("2.5")).toBeInTheDocument();
    expect(s.getByText(/Settled together in one Canton transaction/)).toBeInTheDocument();
    expect(s.getByRole("link", { name: "Open swap" })).toHaveAttribute("href", `/swap/${PAY}`);
  });

  it("shows a compact line for a leg that is no swap", async () => {
    await openTx([plainLeg()]);
    const s = within(await screen.findByRole("region", { name: "Canton side" }));
    expect(s.getByRole("listitem")).toHaveTextContent("Deposit");
    expect(s.queryByText("Seller gives")).toBeNull();
  });

  it("has no panel for a transaction that caused no legs", async () => {
    await openTx([]);
    await screen.findByText("Overview");
    expect(screen.queryByRole("region", { name: "Canton side" })).toBeNull();
  });
});

describe("the swaps page", () => {
  const open = async (answer: (path: string) => ReturnType<typeof reply> = () => reply(page([swapItem(), swapItem({ payId: hash(0x6e), status: "settled", claim: null, payment: { ...swapItem().payment, block: 16900 } })]))) => {
    const calls = fakeApi(route({ swaps: (_id, path) => answer(path), status: () => reply(status()) }));
    renderApp("/swaps");
    await screen.findByRole("heading", { name: "Swaps" });
    await screen.findByRole("table");
    return calls;
  };
  const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

  it("lists the swaps newest first: the status, the two sides, the payment block and the time", async () => {
    const calls = await open();
    expect(calls).toContain("/api/swaps?limit=25");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent("Claimed");
    expect(rows()[0]).toHaveTextContent("2.5 TKB");
    expect(rows()[0]).toHaveTextContent("2 TKA");
    expect(rows()[0]).toHaveTextContent("27 Oct 2026, 15:56:00 UTC");
    expect(within(rows()[0]!).getByRole("link", { name: "16816" })).toHaveAttribute("href", "/block/16816");
    expect(rows()[1]).toHaveTextContent("Settled");
    expect(within(rows()[0]!).getByRole("link", { name: /Open the swap/ })).toHaveAttribute("href", `/swap/${PAY}`);
  });

  it("pages with the cursor the server gives", async () => {
    const calls = await open((path) => reply(page([swapItem()], path.includes("before=") ? null : "16816:0")));
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    expect(calls.some((c) => c.includes("/api/swaps?limit=25&before=16816%3A0"))).toBe(true);
  });

  it("says so when there is no swap", async () => {
    fakeApi(route({ swaps: () => reply(page([])), status: () => reply(status()) }));
    renderApp("/swaps");
    expect(await screen.findByText("No swaps yet.")).toBeInTheDocument();
  });

  it("is linked from the Linked to Canton page", async () => {
    fakeApi(route({ status: () => reply(status()), updates: () => reply(page([])) }));
    renderApp("/canton");
    await screen.findByRole("heading", { name: "Linked to Canton" });
    expect(screen.getAllByRole("link", { name: /^Swaps$/ }).some((a) => a.getAttribute("href") === "/swaps")).toBe(true);
  });
});

describe("the swap page", () => {
  const open = async (s = swapItem(), more: Parameters<typeof route>[0] = {}) => {
    const calls = fakeApi(route({ swaps: () => reply(s), status: () => reply(status()), ...more }));
    renderApp(`/swap/${s.payId}`);
    await screen.findByRole("heading", { name: /for/ });
    return calls;
  };
  const journey = () => within(screen.getByRole("region", { name: "Journey" }));

  it("shows the title, the status and the two-sided card with its link to the Swaps list", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "2.5 TKB for 2 TKA" })).toBeInTheDocument();
    expect(screen.getByText("Claimed")).toBeInTheDocument();
    expect(screen.getByText("Seller gives")).toBeInTheDocument();
    expect(screen.getByText("Buyer gives")).toBeInTheDocument();
    expect(screen.getByText(/Settled together in one Canton transaction/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Swaps" }).some((a) => a.getAttribute("href") === "/swaps")).toBe(true);
  });

  it("tells the journey: the offer, the payment and the claim, each with its Canton update, block and transaction", async () => {
    await open();
    const steps = journey().getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent("Offer");
    expect(within(steps[0]!).getByRole("link", { name: update(0x85).slice(0, 8) + "…" + update(0x85).slice(-4) })).toHaveAttribute("href", `/canton/${update(0x85)}`);
    expect(steps[1]).toHaveTextContent("Payment");
    expect(within(steps[1]!).getByRole("link", { name: "Block 16,816" })).toHaveAttribute("href", "/block/16816");
    expect(within(steps[1]!).getByRole("link", { name: "0x0404…0404" })).toHaveAttribute("href", `/tx/${hash(0x04)}`);
    expect(steps[2]).toHaveTextContent("Claim");
    expect(within(steps[2]!).getByRole("link", { name: "Block 16,823" })).toHaveAttribute("href", "/block/16823");
    expect(within(steps[2]!).getByRole("link", { name: "0x3737…3737" })).toHaveAttribute("href", `/tx/${hash(0x37)}`);
  });

  it("shows the claim as waiting for a swap that is paid and not yet claimed", async () => {
    await open(swapItem({ status: "settled", claim: null }));
    expect(screen.getByText("Settled")).toBeInTheDocument();
    const steps = journey().getAllByRole("listitem");
    expect(steps[2]).toHaveTextContent("Claim");
    expect(steps[2]).toHaveTextContent("Waiting");
    expect(within(steps[2]!).queryByRole("link")).toBeNull();
  });

  it("shows plain words: no template or package names", async () => {
    await open();
    expect(document.body.textContent).not.toMatch(/Zk\.|package|template|Daml/i);
  });

  it("says so for a swap that does not exist", async () => {
    fakeApi(route({ swaps: () => reply({ error: "Not found. No swap has this id." }, 404), status: () => reply(status()) }));
    renderApp(`/swap/${hash(0x99)}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });
});
