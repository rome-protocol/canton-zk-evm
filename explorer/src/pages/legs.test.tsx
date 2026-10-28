// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LEGS_NOT_PUBLIC_THESE, LEGS_NOT_PUBLIC_THIS, LEGS_WHO_SEES } from "../copy.ts";
import { addr, blockSummary, fakeApi, hash, legListItem, page, renderApp, reply, route, update } from "../test-utils.tsx";

const TOKEN = (a: string) => reply({ address: a, standard: "ERC-20", name: "Test USD", symbol: "tUSD", decimals: 6, derived: true });
const LIST = [legListItem(1), legListItem(0, { kind: "payment", token: addr(0xb2), amount: "7" })];

async function openList(answer: (path: string) => ReturnType<typeof reply> = () => reply(page(LIST))) {
  const calls = fakeApi(route({ legs: (_id, path) => answer(path), tokens: TOKEN }));
  renderApp("/legs");
  await screen.findByRole("heading", { name: "Gateway legs" });
  await screen.findByRole("table");
  return calls;
}
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("the gateway legs page", () => {
  it("lists the legs newest first, each with its kind, block, transaction, token and account", async () => {
    const calls = await openList();
    expect(calls).toContain("/api/legs?limit=25");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent("deposit");
    expect(rows()[1]).toHaveTextContent("payment");
    expect(within(rows()[0]!).getByRole("link", { name: "21" })).toHaveAttribute("href", "/block/21");
    expect(within(rows()[0]!).getByRole("link", { name: "0xd1d1…d1d1" })).toHaveAttribute("href", `/tx/${hash(0xd1)}`);
    expect(within(rows()[0]!).getByRole("link", { name: "0xa1a1…a1a1" })).toHaveAttribute("href", `/address/${addr(0xa1)}`);
    expect(within(rows()[0]!).getByRole("link", { name: "0xe1e1…e1e1" })).toHaveAttribute("href", `/leg/${hash(0xe1)}`);
  });

  it("shows the amount with the token's decimals and symbol, and raw when the token cannot be read", async () => {
    await openList();
    await within(rows()[0]!).findByText("2.5");
    expect(rows()[0]).toHaveTextContent("2.5 tUSD");
    expect(within(rows()[0]!).getByRole("link", { name: "0xb1b1…b1b1" })).toHaveAttribute("href", `/token/${addr(0xb1)}`);
    expect(rows()[0]).toHaveTextContent("tUSD");
  });

  it("shows the raw amount, never a guess, when the token has no decimals", async () => {
    fakeApi(route({ legs: () => reply(page([legListItem(0)])), tokens: (a) => reply({ address: a, standard: "ERC-20", name: null, symbol: null, decimals: null, derived: true }) }));
    renderApp("/legs");
    await screen.findByRole("table");
    expect(rows()[0]).toHaveTextContent("2,500,000");
    expect(rows()[0]).not.toHaveTextContent("2.5");
  });

  it("shows the amount in whole tokens, with the exact value in its title, when the decimals are known but the symbol is not", async () => {
    fakeApi(route({ legs: () => reply(page([legListItem(0)])), tokens: (a) => reply({ address: a, standard: "ERC-20", name: null, symbol: null, decimals: 6, derived: true }) }));
    renderApp("/legs");
    await screen.findByRole("table");
    const amount = await within(rows()[0]!).findByText("2.5");
    expect(amount).toHaveAttribute("title", "2.5");
    expect(rows()[0]).not.toHaveTextContent("2,500,000");
  });

  it("shows a dash for a transaction the explorer has not stored", async () => {
    await openList(() => reply(page([legListItem(0, { txHash: null })])));
    expect(rows()[0]!.querySelectorAll("td")[3]).toHaveTextContent("—");
  });

  it("states that the Daml side is not public, in the words of a list of many blocks", async () => {
    await openList();
    expect(screen.getByRole("note")).toHaveTextContent(LEGS_NOT_PUBLIC_THESE);
    expect(screen.getByRole("tooltip")).toHaveTextContent(LEGS_WHO_SEES);
    expect(screen.getByRole("note")).not.toHaveTextContent("this block");
  });

  it("tells a lock and a release by their own tag next to the gateway's kind", async () => {
    await openList(() => reply(page([legListItem(1, { kind: "payment", twin: "lock", gateway: addr(0xb1) }), legListItem(0, { kind: "payment", twin: "release", gateway: addr(0xb1) })])));
    expect(rows()[0]).toHaveTextContent("paymentLock");
    expect(rows()[1]).toHaveTextContent("paymentRelease");
  });

  it("pages by the cursor the server gave", async () => {
    const calls = await openList((path) => reply(page([legListItem(1)], path.includes("before=") ? null : "21|1")));
    await userEvent.click(screen.getByRole("button", { name: "Older page" }));
    await screen.findByText("Page 2");
    expect(calls.some((c) => c.includes("before=21%7C1"))).toBe(true);
  });

  it("says there are no legs yet", async () => {
    fakeApi(route({ legs: () => reply(page([])) }));
    renderApp("/legs");
    expect(await screen.findByText("No legs yet.")).toBeInTheDocument();
  });

  it("says what could not be read, in the server's words", async () => {
    fakeApi(route({ legs: () => reply({ error: "The explorer cannot read the chain right now." }, 502) }));
    renderApp("/legs");
    expect(await screen.findByText("The explorer cannot read the chain right now.")).toBeInTheDocument();
  });
});

describe("the gateway leg page", () => {
  const ID = hash(0xe1);
  async function openLeg(over = {}, block = () => reply(blockSummary({ number: 21 }))) {
    const calls = fakeApi(route({ legs: () => reply(legListItem(1, over)), tokens: TOKEN, blockDetail: block }));
    renderApp(`/leg/${ID}`);
    await screen.findByRole("heading", { level: 1 });
    return calls;
  }
  const kv = (k: string) => screen.getByText(k, { selector: "dt" }).nextElementSibling as HTMLElement;

  it("shows what the EVM recorded: kind, id, position, token, account and the amount with decimals", async () => {
    const calls = await openLeg();
    expect(calls).toContain(`/api/legs/${ID}`);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gateway leg");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("deposit");
    expect(kv("Leg id")).toHaveTextContent(ID);
    expect(kv("Position")).toHaveTextContent("Leg 1, transaction 1, log 2");
    expect(await within(kv("Amount")).findByText("2.5")).toBeInTheDocument();
    expect(kv("Amount")).toHaveTextContent("2.5 tUSD");
    expect(within(kv("Token")).getByRole("link", { name: addr(0xb1) })).toHaveAttribute("href", `/token/${addr(0xb1)}`);
    expect(within(kv("Account")).getByRole("link", { name: addr(0xa1) })).toHaveAttribute("href", `/address/${addr(0xa1)}`);
  });

  it("names the Canton party a withdrawal paid, in full", async () => {
    const party = "alice::1220" + "ab".repeat(32);
    await openLeg({ kind: "withdrawal", party });
    expect(kv("Canton receiver")).toHaveTextContent(party);
  });

  it("has no Canton receiver on a deposit or a payment", async () => {
    await openLeg({ kind: "deposit", party: null });
    expect(screen.queryByText("Canton receiver", { selector: "dt" })).toBeNull();
  });

  it("shows the gateway of a leg a registered gateway wrote, and a lock or a release as such", async () => {
    await openLeg({ kind: "payment", twin: "lock", gateway: addr(0xb1) });
    expect(kv("Gateway")).toHaveTextContent(addr(0xb1).slice(0, 6));
    expect(kv("Twin")).toHaveTextContent("Lock");
    cleanup();
    await openLeg({ kind: "payment", twin: null, gateway: null });
    expect(screen.queryByText("Gateway", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Twin", { selector: "dt" })).toBeNull();
  });

  it("says a withdrawal's receiver is not recorded when the server has none", async () => {
    await openLeg({ kind: "withdrawal", party: null });
    expect(kv("Canton receiver")).toHaveTextContent("not recorded");
  });

  it("links the block, the transaction and the block's Canton update", async () => {
    await openLeg();
    expect(within(kv("Block")).getByRole("link", { name: "21" })).toHaveAttribute("href", "/block/21");
    expect(within(kv("Transaction")).getByRole("link")).toHaveAttribute("href", `/tx/${hash(0xd1)}`);
    const u = await within(kv("Canton update")).findByRole("link");
    expect(u).toHaveAttribute("href", `/canton/${update(3)}`);
  });

  it("says the update is not known when the block has no record, and still shows the leg", async () => {
    await openLeg({}, () => reply(blockSummary({ canton: null })));
    expect(await within(kv("Canton update")).findByText("not read yet")).toBeInTheDocument();
    expect(kv("Leg id")).toHaveTextContent(ID);
  });

  it("gives the privacy note and shows no Daml side", async () => {
    await openLeg();
    expect(screen.getByRole("note")).toHaveTextContent(LEGS_NOT_PUBLIC_THIS);
    expect(screen.getByRole("tooltip")).toHaveTextContent(LEGS_WHO_SEES);
    expect(screen.queryByText(/allocation|holding|settled/i, { selector: "dt" })).toBeNull();
  });

  it("is marked final, since a leg is read from a final block", async () => {
    await openLeg();
    expect(screen.getByText("Final")).toBeInTheDocument();
  });

  it("says no such leg when the id names none", async () => {
    fakeApi(route({ legs: () => reply({ error: "Not found. No gateway leg has that id." }, 404) }));
    renderApp(`/leg/${ID}`);
    expect(await screen.findByText("No gateway leg has that id.")).toBeInTheDocument();
  });
});
