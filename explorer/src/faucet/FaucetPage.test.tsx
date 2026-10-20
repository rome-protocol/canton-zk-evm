// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaucetPage } from "./FaucetPage.tsx";
import type { CoinResult, FaucetClient, FaucetInfo, Ticket, TicketResult } from "./faucet-client.ts";

afterEach(cleanup);

const ONE = "1000000000000000000";
const FAUCET = "0xcd56aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac6b3";
const ADDRESS = "0x5a04de5c5ebd085f5e3b3ec791ab5cdc8e2b56f0";
const HASH = "0x59c5" + "0".repeat(56) + "48f7";
const info = (over: Partial<FaucetInfo> = {}): FaucetInfo => ({ on: true, address: FAUCET, balance: "999997000000000000000000", amount: ONE, perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 5000, queue: 0, captcha: null, ...over });
const queued: CoinResult = { kind: "queued", ticket: "t1", position: 3, to: ADDRESS, amount: ONE };
const view = (over: Partial<Ticket> = {}): TicketResult => ({ kind: "ticket", ticket: { ticket: "t1", status: "queued", position: 3, to: ADDRESS, amount: ONE, hash: null, state: null, block: null, reason: null, ...over } });
const FAST = 15;

/** A client that answers from what the test gives it. `request` may be a promise the test settles later. */
function fake(over: { info?: FaucetInfo | Error; request?: CoinResult | Promise<CoinResult>; tickets?: TicketResult[] } = {}) {
  const steps = [...(over.tickets ?? [view()])];
  const client = {
    ticket: vi.fn(async (_id: string): Promise<TicketResult> => (steps.length > 1 ? steps.shift()! : steps[0]!)),
    info: vi.fn(async () => { const i = over.info ?? info(); if (i instanceof Error) throw i; return i; }),
    request: vi.fn(async (_address: string, _token?: string) => over.request ?? queued),
  } satisfies FaucetClient;
  return client;
}

async function open(client: FaucetClient, coin: { symbol: string; decimals: number } = { symbol: "tROME", decimals: 18 }) {
  const user = userEvent.setup();
  render(<MemoryRouter><FaucetPage client={client} coin={coin} pollMs={FAST} /></MemoryRouter>);
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
    expect(screen.getByText(/The coins count only when the block holding them is final on Canton/)).toBeInTheDocument();
    expect(screen.getByText("Blocks are made only while the chain's builder runs.")).toBeInTheDocument();
    expect(screen.getByText("One request per address per 24 hours, and one per connection every 10 minutes.")).toBeInTheDocument();
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
    expect(screen.getByText("One request per address per 1 hour, and one per connection every 10 minutes.")).toBeInTheDocument();
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

describe("a request that is taken", () => {
  it("sends the address typed, and says the request is taken and where it stands in line", async () => {
    const client = fake();
    const user = await open(client);
    await ask(user, `  ${ADDRESS}  `);
    expect(client.request).toHaveBeenCalledExactlyOnceWith(ADDRESS, undefined);
    expect(await screen.findByRole("status")).toHaveTextContent("Your request is taken. You are number 3 in line.");
  });

  it("follows the request, in plain words, from the line to final on Canton, with a link to the transaction", async () => {
    // The test moves the ticket by hand, so no state is gone before it is looked at.
    let now: TicketResult = view({ position: 1 });
    const client = fake();
    client.ticket.mockImplementation(async () => now);
    const user = await open(client);
    await ask(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You are number 1 in line."));
    now = view({ status: "sent", position: null, hash: HASH, state: "pending" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent, waiting to be proven."));
    expect(within(screen.getByRole("status")).getByRole("link", { name: "0x59c5…48f7" })).toHaveAttribute("href", `/tx/${HASH}`);
    expect(screen.queryByText(/tROME is final on Canton/)).not.toBeInTheDocument();
    now = view({ status: "sent", position: null, hash: HASH, state: "proving" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent, and being proven."));
    expect(screen.getByRole("status")).toHaveTextContent("Not final yet");
    now = view({ status: "final", position: null, hash: HASH, state: null, block: 42 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 tROME is final on Canton. Transaction"));
    expect(screen.getByRole("status")).toHaveTextContent("In block 42.");
  });

  it("never says final while the explorer says sent, however long it is asked", async () => {
    const client = fake({ tickets: [view({ status: "sent", position: null, hash: HASH, state: "proving" })] });
    const user = await open(client);
    await ask(user);
    await waitFor(() => expect(client.ticket.mock.calls.length).toBeGreaterThan(4));
    expect(screen.queryByText(/tROME is final on Canton/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Not final yet");
  });

  it("stops asking once the request is final", async () => {
    const client = fake({ tickets: [view({ status: "final", position: null, hash: HASH, block: 7 })] });
    const user = await open(client);
    await ask(user);
    await screen.findByText(/tROME is final on Canton/);
    const calls = client.ticket.mock.calls.length;
    await new Promise((ok) => setTimeout(ok, FAST * 6));
    expect(client.ticket.mock.calls.length).toBe(calls);
    await waitFor(() => expect(client.info).toHaveBeenCalledTimes(2)); // the balance moved: read again
  });

  it("says a failed request was not sent, with the reason, and lets the address ask again", async () => {
    const user = await open(fake({ tickets: [view({ status: "failed", position: null, reason: "The transfer was replaced." })] }));
    await ask(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The coins were not sent. The transfer was replaced. Nothing was taken from you, and you may ask again.");
    await waitFor(() => expect(screen.getByRole("button", { name: /Request/ })).toBeEnabled());
  });

  it("says so, and keeps asking, when the explorer cannot be reached while it follows a request", async () => {
    let now: TicketResult = { kind: "unreachable" };
    const client = fake();
    client.ticket.mockImplementation(async () => now);
    const user = await open(client);
    await ask(user);
    await screen.findByText(/The explorer cannot be reached just now\. This page keeps asking\./);
    now = view({ status: "final", position: null, hash: HASH, block: 9 });
    await screen.findByText(/tROME is final on Canton/);
    expect(screen.queryByText(/This page keeps asking/)).not.toBeInTheDocument();
  });

  it("says the explorer no longer knows a request it has no ticket for, and stops asking", async () => {
    const client = fake({ tickets: [{ kind: "unknown" }] });
    const user = await open(client);
    await ask(user);
    expect(await screen.findByText("The explorer no longer knows this request.")).toBeInTheDocument();
    expect(client.ticket).toHaveBeenCalledOnce();
  });

  it("does not offer the same address again until the address is changed", async () => {
    const user = await open(fake());
    await ask(user);
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: /Request/ })).toBeDisabled();
    await user.type(screen.getByLabelText("Your address"), "0");
    expect(screen.getByRole("button", { name: /Request/ })).toBeEnabled();
  });

  it("copies the whole transaction hash", async () => {
    const user = await open(fake({ tickets: [view({ status: "sent", position: null, hash: HASH, state: "pending" })] }));
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

describe("a request on its way", () => {
  it("holds the button, with its own words, until the answer comes", async () => {
    let finish!: (r: CoinResult) => void;
    const client = fake({ request: new Promise<CoinResult>((ok) => { finish = ok; }) });
    const user = await open(client);
    await ask(user);
    const button = screen.getByRole("button", { name: "Sending…" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(client.request).toHaveBeenCalledOnce();
    finish(queued);
    expect(await screen.findByRole("status")).toHaveTextContent("You are number 3 in line.");
  });
});

describe("the human check", () => {
  const captcha = { siteKey: "site-key-1", scriptUrl: "https://check.example/api.js", widgetClass: "human-check" };

  it("is not on the page when the faucet does not ask for it", async () => {
    await open(fake());
    await screen.findByLabelText("Your address");
    expect(document.querySelector(".human-check")).toBeNull();
  });

  it("loads the faucet's script once, puts its widget in the form with the faucet's key, and sends the token it produced", async () => {
    const client = fake({ info: info({ captcha }) });
    const user = await open(client);
    await screen.findByLabelText("Your address");
    expect(document.querySelectorAll(`script[src="${captcha.scriptUrl}"]`)).toHaveLength(1);
    const widget = document.querySelector(".human-check")!;
    expect(widget).toHaveAttribute("data-sitekey", "site-key-1");
    const field = Object.assign(document.createElement("input"), { name: "some-response", value: "token-9" });
    widget.appendChild(field);
    await ask(user);
    expect(client.request).toHaveBeenCalledExactlyOnceWith(ADDRESS, "token-9");
  });

  it("draws the widget again when the page is left and come back to, and after a request has used the token", async () => {
    const client = fake({ info: info({ captcha }) });
    const first = render(<MemoryRouter><FaucetPage client={client} coin={{ symbol: "tROME", decimals: 18 }} pollMs={FAST} /></MemoryRouter>);
    await screen.findByLabelText("Your address");
    const scripts = () => Array.from(document.scripts).filter((s) => s.getAttribute("src") === captcha.scriptUrl);
    const firstScript = scripts()[0];
    expect(scripts()).toHaveLength(1);
    const firstWidget = document.querySelector(".human-check");
    // Leaving the page and coming back runs the script again, into the new form.
    first.unmount();
    const user = await open(client);
    await screen.findByLabelText("Your address");
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]).not.toBe(firstScript);
    // A request uses up the token: the widget is a new one, and the script runs again to draw it.
    const before = scripts()[0], widget = document.querySelector(".human-check");
    expect(widget).not.toBe(firstWidget);
    await ask(user);
    await screen.findByRole("status");
    expect(document.querySelector(".human-check")).not.toBe(widget);
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]).not.toBe(before);
  });

  it("shows the faucet's words when the check is not passed", async () => {
    const user = await open(fake({ info: info({ captcha }), request: { kind: "captcha", message: "Complete the human check first." } }));
    await ask(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Complete the human check first.");
  });
});

describe("the faucet turns a request away", () => {
  it("says an address has had its coin, and for how long to wait", async () => {
    const message = "This address was given coins in the last 24 hours. Try again later.";
    const user = await open(fake({ request: { kind: "limit", which: "address", waitSeconds: 23 * 3600 + 41 * 60, message } }));
    await ask(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`${message} Try again in 23 h 41 min.`);
    expect(screen.getByRole("button", { name: /Request/ })).toBeEnabled();
  });

  it("does not make up a wait the answer did not give", async () => {
    const user = await open(fake({ request: { kind: "limit", which: "ip", waitSeconds: null, message: "This connection asked for coins in the last 10 minutes." } }));
    await ask(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("This connection asked for coins in the last 10 minutes. Try again later.");
  });

  it("says the line is full, turned away not lost, and lets the button back when the wait is over", async () => {
    const user = await open(fake({ request: { kind: "full", waitSeconds: 1, message: "The faucet's line is full, so this request was turned away, not lost." } }));
    await ask(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("The faucet's line is full, so this request was turned away, not lost. Try again in 1 s.");
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
