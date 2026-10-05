// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaucetPage } from "./FaucetPage.tsx";
import type { CoinResult, FaucetClient, FaucetInfo } from "./faucet-client.ts";

afterEach(cleanup);

const ONE = "1000000000000000000";
const FAUCET = "0xcd56aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac6b3";
const ADDRESS = "0x5a04de5c5ebd085f5e3b3ec791ab5cdc8e2b56f0";
const HASH = "0x59c5" + "0".repeat(56) + "48f7";
const info = (over: Partial<FaucetInfo> = {}): FaucetInfo => ({ on: true, address: FAUCET, balance: "999997000000000000000000", amount: ONE, perAddressSeconds: 86400, ...over });
const sent: CoinResult = { kind: "sent", hash: HASH, to: ADDRESS, amount: ONE };

/** A client that answers from what the test gives it. `request` may be a promise the test settles later. */
function fake(over: { info?: FaucetInfo | Error; request?: CoinResult | Promise<CoinResult> } = {}) {
  const client = {
    info: vi.fn(async () => { const i = over.info ?? info(); if (i instanceof Error) throw i; return i; }),
    request: vi.fn(async (_address: string) => over.request ?? sent),
  } satisfies FaucetClient;
  return client;
}

async function open(client: FaucetClient, coin: { symbol: string; decimals: number } = { symbol: "tROME", decimals: 18 }) {
  const user = userEvent.setup();
  render(<MemoryRouter><FaucetPage client={client} coin={coin} /></MemoryRouter>);
  return user;
}
const ask = async (user: ReturnType<typeof userEvent.setup>, address = ADDRESS) => {
  await user.type(await screen.findByLabelText("Your address"), address);
  await user.click(screen.getByRole("button", { name: /Request/ }));
};

describe("the form", () => {
  it("shows what the faucet gives, how often, and its own address and balance", async () => {
    await open(fake());
    expect(await screen.findByRole("heading", { level: 1, name: "Faucet" })).toBeInTheDocument();
    expect(screen.getByText("tROME is this chain's test coin. It has no value. The faucet sends 1 tROME to an address, once a day.")).toBeInTheDocument();
    expect(screen.getByLabelText("Your address")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Request 1 tROME" })).toBeEnabled();
    expect(screen.getByText("Coins arrive with the next proven block. Blocks are made only while the chain's builder runs.")).toBeInTheDocument();
    expect(screen.getByText("One request per address per 24 hours.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "0xcd56…c6b3" });
    expect(link).toHaveAttribute("href", `/address/${FAUCET}`);
    expect(link.closest("li")).toHaveTextContent("holds 999,997 tROME.");
  });

  it("says it is looking while the faucet's information is on its way", async () => {
    const client = fake();
    client.info.mockReturnValue(new Promise(() => {}));
    await open(client);
    expect(screen.getByText("Looking up the faucet…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your address")).not.toBeInTheDocument();
  });

  it("follows the coin's name and amount from the server, not from fixed text", async () => {
    await open(fake({ info: info({ amount: "500000000000000000", perAddressSeconds: 3600 }) }), { symbol: "TST", decimals: 18 });
    expect(await screen.findByRole("button", { name: "Request 0.5 TST" })).toBeInTheDocument();
    expect(screen.getByText(/sends 0.5 TST to an address, once every 1 hour\./)).toBeInTheDocument();
    expect(screen.getByText("One request per address per 1 hour.")).toBeInTheDocument();
  });

  it("explains itself when the faucet's information cannot be read", async () => {
    await open(fake({ info: new Error("The explorer cannot read the chain.") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The explorer cannot read the chain.");
    expect(screen.queryByLabelText("Your address")).not.toBeInTheDocument();
  });
});

describe("when the faucet is off", () => {
  it("says so and offers no form", async () => {
    await open(fake({ info: info({ on: false, address: null, balance: null }) }));
    const alert = await screen.findByText("The faucet is off.");
    expect(alert.closest(".alert")).toHaveTextContent("It runs only when the explorer is given the faucet's key.");
    expect(screen.queryByLabelText("Your address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/holds/)).not.toBeInTheDocument();
  });
});

describe("a request that works", () => {
  it("sends the address typed, links the transaction, and says it is waiting", async () => {
    const client = fake();
    const user = await open(client);
    await ask(user, `  ${ADDRESS}  `);
    expect(client.request).toHaveBeenCalledExactlyOnceWith(ADDRESS);
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Sent 1 tROME.");
    expect(within(status).getByRole("link", { name: "0x59c5…48f7" })).toHaveAttribute("href", `/tx/${HASH}`);
    expect(within(status).getByText("Waiting")).toBeInTheDocument();
    expect(status).toHaveTextContent("It arrives with the next proven block. Its page moves from Waiting to Being proven to Final.");
  });

  it("does not offer the same address again until the address is changed", async () => {
    const user = await open(fake());
    await ask(user);
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: /Request/ })).toBeDisabled();
    await user.type(screen.getByLabelText("Your address"), "0");
    expect(screen.getByRole("button", { name: /Request/ })).toBeEnabled();
  });

  it("reads the faucet's balance again after a send", async () => {
    const client = fake();
    const user = await open(client);
    await ask(user);
    await screen.findByRole("status");
    await waitFor(() => expect(client.info).toHaveBeenCalledTimes(2));
  });

  it("copies the whole transaction hash", async () => {
    const user = await open(fake());
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await ask(user);
    await user.click(await screen.findByRole("button", { name: "Copy transaction hash" }));
    expect(write).toHaveBeenCalledWith(HASH);
  });

  it("sends from the keyboard too", async () => {
    const client = fake();
    const user = await open(client);
    await user.type(await screen.findByLabelText("Your address"), `${ADDRESS}{Enter}`);
    expect(client.request).toHaveBeenCalledOnce();
  });
});

describe("a send under way", () => {
  it("holds the button, with its own words, until the answer comes", async () => {
    let finish!: (r: CoinResult) => void;
    const client = fake({ request: new Promise<CoinResult>((ok) => { finish = ok; }) });
    const user = await open(client);
    await ask(user);
    const button = screen.getByRole("button", { name: "Sending…" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(client.request).toHaveBeenCalledOnce();
    finish(sent);
    expect(await screen.findByRole("status")).toHaveTextContent("Sent 1 tROME.");
  });
});

describe("the faucet turns a request away", () => {
  it("says an address has had its coin, and for how long to wait", async () => {
    const user = await open(fake({ request: { kind: "limit", waitSeconds: 23 * 3600 + 41 * 60 } }));
    await ask(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This address was sent tROME in the last 24 hours. Try again in 23 h 41 min.");
    expect(screen.getByRole("button", { name: /Request/ })).toBeEnabled();
  });

  it("does not make up a wait the answer did not give", async () => {
    const user = await open(fake({ request: { kind: "limit", waitSeconds: null } }));
    await ask(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("This address was sent tROME in the last 24 hours. Try again later.");
  });

  it("says another request is being sent, and lets the button back when the wait is over", async () => {
    const user = await open(fake({ request: { kind: "busy", waitSeconds: 1 } }));
    await ask(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Another request is being sent. Try again in 1 s.");
    expect(screen.getByRole("button", { name: /Request/ })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: /Request/ })).toBeEnabled(), { timeout: 2500 });
  });
});

describe("a request that fails", () => {
  it("catches something that is not an address before asking the server", async () => {
    const client = fake();
    const user = await open(client);
    await ask(user, "0x5b2e91c");
    expect(await screen.findByRole("alert")).toHaveTextContent("That is not an address. An address is 0x and 40 hex digits.");
    expect(client.request).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Your address")).toHaveAttribute("aria-invalid", "true");
  });

  it("shows the server's own words for an empty faucet or an unreachable chain", async () => {
    const user = await open(fake({ request: { kind: "problem", message: "The faucet is empty." } }));
    await ask(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("The faucet is empty.");
  });

  it("clears the last answer when a new request starts", async () => {
    const client = fake();
    client.request.mockResolvedValueOnce({ kind: "problem", message: "The faucet is empty." });
    const user = await open(client);
    await ask(user);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: /Request/ }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
