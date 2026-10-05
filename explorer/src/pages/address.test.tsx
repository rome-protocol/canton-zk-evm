// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiAddress } from "../api.ts";
import { account, addr, fakeApi, hash, NOT_FOUND, renderApp, reply, route, status, tick, tokenAddress } from "../test-utils.tsx";

async function open(a: ApiAddress = account(), path = `/address/${a.address}`, title = "Address") {
  const calls = fakeApi(route({ address: () => reply(a) }));
  renderApp(path);
  await screen.findByRole("heading", { name: title });
  return calls;
}
const row = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const kind = () => screen.getByRole("heading", { level: 1 }).parentElement!.querySelector(".chip-kind")!;

describe("the address page, for an account", () => {
  it("says it is an account, and shows the address in full with a button to copy it", async () => {
    const user = userEvent.setup();
    await open();
    expect(kind()).toHaveTextContent("Account");
    const own = screen.getByText(addr(0x5b));
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(own.closest(".hl") as HTMLElement).getByRole("button", { name: "Copy" }));
    expect(write).toHaveBeenCalledWith(addr(0x5b));
  });

  it("shows the balance in the chain's coin and the number of transactions it has sent, from reth's newest block", async () => {
    await open();
    expect(row("Balance")).toHaveTextContent("9.99791 tROME");
    expect(row("Balance").firstElementChild).toHaveAttribute("title", "9.99791 tROME");
    expect(row("Transactions sent")).toHaveTextContent("3");
    expect(screen.getByText("Both come from reth's newest block, which may still be being proven.")).toBeInTheDocument();
  });

  it("says 0 for an empty account", async () => {
    await open(account({ balance: "0", nonce: 0 }));
    expect(row("Balance")).toHaveTextContent("0 tROME");
    expect(row("Transactions sent")).toHaveTextContent("0");
  });

  it("names the coin the server names", async () => {
    fakeApi(route({ address: () => reply(account()), status: () => reply(status({ coin: { symbol: "TST", decimals: 6 } })) }));
    renderApp(`/address/${addr(0x5b)}`);
    await screen.findByRole("heading", { name: "Address" });
    await waitFor(() => expect(row("Balance")).toHaveTextContent("9,997,910,000,000 TST"));
  });

  it("shows no balance in a coin until the server has named it", async () => {
    let named: () => void = () => {};
    const slow = new Promise<void>((r) => { named = r; });
    fakeApi(route({ address: () => reply(account()), status: () => reply(status({ coin: { symbol: "TST", decimals: 6 } })) }));
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => { if (String(input) === "/api/status") await slow; return answer(input, init); });
    renderApp(`/address/${addr(0x5b)}`);
    await screen.findByRole("heading", { name: "Address" });
    expect(row("Balance")).toHaveTextContent("…");
    expect(screen.queryByText(/tROME/)).toBeNull();
    named();
    await waitFor(() => expect(row("Balance")).toHaveTextContent("TST"));
  });

  it("asks for the address it was given, and no more than that", async () => {
    const calls = await open();
    expect(calls.filter((c) => c.startsWith("/api/address"))).toEqual([`/api/address/${addr(0x5b)}`]);
  });
});

describe("the address page, for a contract", () => {
  const contract = (over: Partial<ApiAddress> = {}) => account({ address: addr(0xf5), kind: "contract", nonce: 1, createdBy: null, ...over });

  it("says it is a contract, and leaves out the count of transactions sent", async () => {
    await open(contract());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Address");
    expect(kind()).toHaveTextContent("Contract");
    expect(row("Balance")).toHaveTextContent("9.99791 tROME");
    expect(screen.queryByText("Transactions sent", { selector: "dt" })).toBeNull();
    expect(screen.getByText("The balance comes from reth's newest block, which may still be being proven.")).toBeInTheDocument();
  });

  it("names the transaction and the block that created it, when the index knows them", async () => {
    await open(contract({ createdBy: { txHash: hash(0xf5), block: 2 } }));
    expect(row("Created by")).toHaveTextContent("0xf5f5…f5f5 in block 2");
    expect(within(row("Created by")).getByRole("link", { name: "0xf5f5…f5f5" })).toHaveAttribute("href", `/tx/${hash(0xf5)}`);
    expect(within(row("Created by")).getByRole("link", { name: "block 2" })).toHaveAttribute("href", "/block/2");
  });

  it("says nothing of its creation when it is not known", async () => {
    await open(contract());
    expect(screen.queryByText("Created by", { selector: "dt" })).toBeNull();
  });
});

describe("the address page, for a token", () => {
  it("is named by the token's own name, and says it is a token", async () => {
    await open(tokenAddress(), `/token/${addr(0xcb)}`, "Test token A (TKA)");
    expect(kind()).toHaveTextContent("Token");
    expect(screen.getByText(addr(0xcb))).toBeInTheDocument();
  });

  it("shows its name, symbol and decimals, who created it and its balance, and no count of transactions sent", async () => {
    await open(tokenAddress(), `/token/${addr(0xcb)}`, "Test token A (TKA)");
    expect(row("Name")).toHaveTextContent("Test token A");
    expect(row("Symbol")).toHaveTextContent("TKA");
    expect(row("Decimals")).toHaveTextContent("18");
    expect(row("Created by")).toHaveTextContent("0xf5f5…f5f5 in block 2");
    expect(row("Balance")).toHaveTextContent("0 tROME");
    expect(screen.queryByText("Transactions sent", { selector: "dt" })).toBeNull();
    expect(screen.getByText("The balance comes from reth's newest block, which may still be being proven.")).toBeInTheDocument();
  });

  it("opens the same page from /address/ and from /token/", async () => {
    await open(tokenAddress(), `/address/${addr(0xcb)}`, "Test token A (TKA)");
    expect(kind()).toHaveTextContent("Token");
  });
});

describe("an address that cannot be shown", () => {
  it("says what an address is when the one in the link is not", async () => {
    fakeApi(route({ address: () => reply({ error: "An address is 0x and 40 hex digits." }, 400) }));
    renderApp("/address/0x5b2e");
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("An address is 0x and 40 hex digits.")).toBeInTheDocument();
  });

  it("says Not found in the server's words", async () => {
    fakeApi(route({ address: () => reply({ error: NOT_FOUND }, 404) }));
    renderApp(`/token/${addr(1)}`);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });

  it("says it cannot read the chain, and tries again by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let healthy = false;
    fakeApi(route({ address: () => (healthy ? reply(account()) : reply({ error: "The explorer cannot read the chain right now." }, 502)) }));
    renderApp(`/address/${addr(0x5b)}`);
    expect(await screen.findByRole("heading", { name: "Cannot read the chain" })).toBeInTheDocument();
    healthy = true;
    await tick();
    expect(screen.getByRole("heading", { name: "Address" })).toBeInTheDocument();
  });
});
