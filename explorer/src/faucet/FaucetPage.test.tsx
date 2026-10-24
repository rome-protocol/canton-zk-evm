// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaucetPage } from "./FaucetPage.tsx";
import type { CoinResult, FaucetClient, FaucetInfo, RecentSend, Ticket, TicketResult, TxTimes } from "./faucet-client.ts";

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
  it("shows what the faucet gives and how often, with the limits in plain words", async () => {
    await open(fake());
    expect(await screen.findByRole("heading", { level: 1, name: "Faucet" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Get test tROME" })).toBeInTheDocument();
    expect(screen.getByText("tROME is this chain's test coin. It has no value.")).toBeInTheDocument();
    expect(document.querySelector(".lead")).toHaveTextContent("The faucet sends 1 tROME to an address, once a day.");
    expect(screen.getByLabelText("Your address")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Request 1 tROME" })).toBeEnabled();
    expect(screen.getByText("Blocks are made only while the chain's builder runs.")).toBeInTheDocument();
    const limits = screen.getByRole("heading", { name: "The limits, in plain words" }).closest("section")!;
    expect(limits).toHaveTextContent("Each request sends 1 tROME.");
    expect(limits).toHaveTextContent("One request per address every 24 hours.");
    expect(limits).toHaveTextContent("One request per network address every 10 minutes.");
    expect(limits).toHaveTextContent("At most 5,000 requests an hour for everyone together.");
    expect(limits).toHaveTextContent("The coins count only when the block holding them is final on Canton");
  });

  it("names the chain under the title when it is given", async () => {
    render(<MemoryRouter><FaucetPage client={fake()} coin={{ symbol: "tROME", decimals: 18 }} chain={{ name: "Ostia DevNet", id: 770101 }} pollMs={FAST} /></MemoryRouter>);
    expect(await screen.findByText("Ostia DevNet · chain 770101")).toBeInTheDocument();
  });

  it("says the faucet's facts as the server serves them, and says where a number is not served", async () => {
    await open(fake({ info: info({ balanceBlock: 21, queue: 0, beingProven: 1, sentToday: 1005, finalToday: 1004 }) }));
    const card = (await screen.findByRole("heading", { name: "The faucet" })).closest("section")!;
    const link = within(card).getByRole("link", { name: "0xcd56…c6b3" });
    expect(link).toHaveAttribute("href", `/address/${FAUCET}`);
    expect(card).toHaveTextContent("Balance999,997 tROME · as of block 21");
    expect(card).toHaveTextContent("Queue now0 waiting · 1 being proven");
    expect(card).toHaveTextContent("Sent today1,005 · all final but 1");
  });

  it("does not make up a number the server does not serve", async () => {
    await open(fake({ info: info({ sentToday: null, finalToday: null, beingProven: null, balanceBlock: null }) }));
    const card = (await screen.findByRole("heading", { name: "The faucet" })).closest("section")!;
    expect(card).toHaveTextContent("as of the newest block, which may not be final");
    expect(card).toHaveTextContent("being proven: not counted");
    expect(card).toHaveTextContent("Sent todaynot counted");
  });

  it("says all final when every payout of the day is final", async () => {
    await open(fake({ info: info({ sentToday: 12, finalToday: 12 }) }));
    expect((await screen.findByRole("heading", { name: "The faucet" })).closest("section")).toHaveTextContent("12 · all final");
  });

  it("says what a plain transfer costs from the newest block's base fee, and nothing when it is not read", async () => {
    const client = { ...fake(), baseFee: vi.fn(async () => "67300000") };
    await open(client);
    await waitFor(() => expect(document.querySelector(".lead")).toHaveTextContent("a plain transfer costs about 0.0000014 tROME."));
    cleanup();
    await open({ ...fake(), baseFee: vi.fn(async () => null) });
    await screen.findByLabelText("Your address");
    expect(document.querySelector(".lead")).not.toHaveTextContent("costs about");
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
    expect(document.querySelector(".lead")).toHaveTextContent("sends 0.5 TST to an address, once every 1 hour.");
    expect(screen.getByRole("heading", { name: "The limits, in plain words" }).closest("section")).toHaveTextContent("One request per address every 1 hour.");
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
    expect(await screen.findByRole("status")).toHaveTextContent("You are number 3 in line.");
  });

  it("follows the request, in plain words, from the line to final on Canton, with a link to the transaction", async () => {
    // The test moves the ticket by hand, so no state is gone before it is looked at.
    let now: TicketResult = view({ position: 1 });
    const client = fake();
    client.ticket.mockImplementation(async () => now);
    const user = await open(client);
    await ask(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No one is ahead of you."));
    now = view({ status: "sent", position: null, hash: HASH, state: "pending" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("is in the pool, waiting for the next block."));
    expect(within(screen.getByRole("status")).getByRole("link", { name: "0x59c5…48f7" })).toHaveAttribute("href", `/tx/${HASH}`);
    expect(screen.queryByText(/tROME is final on Canton/)).not.toBeInTheDocument();
    now = view({ status: "sent", position: null, hash: HASH, state: "proving" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("It is not final until Canton has committed it."));
    now = view({ status: "final", position: null, hash: HASH, state: null, block: 42 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 tROME is final on Canton in block 42."));
    expect(screen.getByRole("status")).toHaveTextContent("Proven in block 42");
  });

  it("never says final while the explorer says sent, however long it is asked", async () => {
    const client = fake({ tickets: [view({ status: "sent", position: null, hash: HASH, state: "proving" })] });
    const user = await open(client);
    await ask(user);
    await waitFor(() => expect(client.ticket.mock.calls.length).toBeGreaterThan(4));
    expect(screen.queryByText(/tROME is final on Canton/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("It is not final until Canton has committed it.");
  });

  it("says so, and never failed or final, when the explorer stopped following a transfer that the chain may still take", async () => {
    const user = await open(fake({ tickets: [view({ status: "sent", position: null, hash: HASH, state: "dropped" })] }));
    await ask(user);
    const note = await screen.findByText("Sent, not followed");
    expect(note.closest("[role=status]")).toHaveTextContent("The explorer stopped following it, and the chain may still take it.");
    expect(screen.queryByText(/tROME is final on Canton/)).not.toBeInTheDocument();
    expect(screen.queryByText(/were not sent/)).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Not sent"));
    const steps = screen.getByRole("status");
    expect(steps).toHaveTextContent("The transfer was replaced. Nothing was taken from you, and you may ask again.");
    expect(screen.queryByText(/tROME is final on Canton/)).not.toBeInTheDocument();
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

const send = (n: number, over: Partial<RecentSend> = {}): RecentSend => ({ hash: `0x${String(n).padStart(2, "0")}${"a".repeat(60)}${"b".repeat(2)}`, to: `0x${String(n).padStart(2, "0")}${"c".repeat(38)}`, block: 20 - n, timestamp: Math.floor(Date.now() / 1000) - 60 * n, ...over });
const withRecent = (rows: RecentSend[] | null) => ({ ...fake(), recent: vi.fn(async (_faucet: string, _limit: number) => rows) });

describe("recent sends", () => {
  it("lists the faucet's final payouts with the block and how long ago, and asks for the faucet's own address", async () => {
    const client = withRecent([send(1), send(2)]);
    await open(client);
    const card = (await screen.findByRole("heading", { name: "Recent sends" })).closest("section")!;
    await waitFor(() => expect(within(card).getAllByRole("row")).toHaveLength(3));
    expect(client.recent).toHaveBeenCalledWith(FAUCET, 6);
    const first = within(card).getAllByRole("row")[1]!;
    expect(first).toHaveTextContent("1 min ago");
    expect(within(first).getByRole("link", { name: "19" })).toHaveAttribute("href", "/block/19");
    expect(first).toHaveTextContent("Final");
    expect(card).toHaveTextContent("Final payouts only");
  });

  it("says so when there is no payout, and when the payouts cannot be read", async () => {
    await open(withRecent([]));
    expect(await screen.findByText("No final payout yet.")).toBeInTheDocument();
    cleanup();
    await open(withRecent(null));
    expect(await screen.findByText("The faucet's payouts cannot be read just now.")).toBeInTheDocument();
  });

  it("shows the request being followed, not final, above the final ones, and never as final", async () => {
    const client = { ...withRecent([send(1)]), ticket: vi.fn(async (): Promise<TicketResult> => view({ status: "sent", position: null, hash: HASH, state: "proving", block: 22 })) };
    const user = await open(client);
    await ask(user);
    const card = (await screen.findByRole("heading", { name: "Recent sends" })).closest("section")!;
    await waitFor(() => expect(within(card).getAllByRole("row")).toHaveLength(3));
    const mine = within(card).getAllByRole("row")[1]!;
    expect(mine).toHaveTextContent("0x59c5…48f7");
    expect(mine).toHaveTextContent("Being proven");
    expect(mine).not.toHaveTextContent("Final");
  });

  it("does not list the same transaction twice", async () => {
    const client = { ...withRecent([send(1, { hash: HASH })]), ticket: vi.fn(async (): Promise<TicketResult> => view({ status: "sent", position: null, hash: HASH, state: "pending" })) };
    const user = await open(client);
    await ask(user);
    const card = (await screen.findByRole("heading", { name: "Recent sends" })).closest("section")!;
    await waitFor(() => expect(within(card).getAllByRole("row")).toHaveLength(2));
  });

  it("says the faucet has nothing to list when it is off", async () => {
    await open({ ...fake({ info: info({ on: false, address: null, balance: null }) }), recent: vi.fn(async () => [send(1)]) });
    expect(await screen.findByText("The faucet is off, so it has sent nothing from this explorer.")).toBeInTheDocument();
  });
});

describe("your request", () => {
  it("shows the four steps, the ticket and the amount, and when this address may ask again", async () => {
    const user = await open(fake());
    await ask(user);
    const card = (await screen.findByRole("region", { name: "Your request" }));
    expect(card).toHaveTextContent("ticket t1 · 1 tROME to 0x5a04…56f0");
    expect(within(card).getAllByRole("listitem").map((li) => li.querySelector("b")?.textContent)).toEqual(["Queued", "Sent", "Being proven", "Final on Canton"]);
    expect(card).toHaveTextContent("This card updates by itself.");
    expect(screen.getByText(/Taken\. You can ask again for this address after \d+ \w+, \d\d:\d\d UTC\./)).toBeInTheDocument();
  });

  it("marks only the steps the explorer has confirmed", async () => {
    const client = fake({ tickets: [view({ status: "sent", position: null, hash: HASH, state: "proving", block: 22 })] });
    const user = await open(client);
    await ask(user);
    await waitFor(() => expect(screen.getByText("Being proven in block 22")).toBeInTheDocument());
    const items = within(screen.getByRole("status")).getAllByRole("listitem");
    expect(items.map((li) => li.className)).toEqual(["step step-done", "step step-done", "step step-active", "step step-todo"]);
  });

  it("cuts a very long reason from the server", async () => {
    const user = await open(fake({ tickets: [view({ status: "failed", position: null, reason: "x".repeat(5000) })] }));
    await ask(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Not sent"));
    expect(screen.getByRole("status").textContent!.length).toBeLessThan(1200);
  });
});

describe("the times of a request", () => {
  const times = (over: Partial<TxTimes> = {}): TxTimes => ({ nonce: 1004, acceptedAt: "2026-10-23T17:57:31.428Z", proofStartedAt: "2026-10-23T17:57:31.832Z", finalAt: null, ...over });
  const withTimes = (t: Ticket["status"], state: string | null, tx: TxTimes | null, usual: { lowMs: number; highMs: number } | null = { lowMs: 7000, highMs: 7700 }, over: Partial<Ticket> = {}, commitMs: number | null = 600) => {
    const client = fake({ tickets: [view({ status: t, position: null, hash: HASH, state, block: 22, ...over })] });
    return Object.assign(client, { txTimes: vi.fn(async (_h: string) => tx), usualProof: vi.fn(async () => usual), usualCommitMs: vi.fn(async () => commitMs) });
  };
  const step = (name: string) => within(screen.getByRole("status")).getAllByRole("listitem").find((li) => li.querySelector("b")?.textContent?.startsWith(name))!;

  it("puts the pool time and the nonce on Sent, and the proof's start on Being proven", async () => {
    const user = await open(withTimes("sent", "proving", times()));
    await ask(user);
    await waitFor(() => expect(step("Sent")).toHaveTextContent("17:57:31.428"));
    expect(step("Sent")).toHaveTextContent("nonce 1004");
    expect(step("Being proven")).toHaveTextContent("17:57:31.832");
    expect(step("Final on Canton")).not.toHaveTextContent("17:57:31");
  });

  it("says how long a proof usually takes, with a bar drawn from when the proof began, while it is being proven", async () => {
    const started = new Date(Date.now() - 4200).toISOString();
    const user = await open(withTimes("sent", "proving", times({ proofStartedAt: started })));
    await ask(user);
    await waitFor(() => expect(step("Being proven")).toHaveTextContent("A proof usually takes 7.0–7.7 s"));
    expect(step("Being proven")).toHaveTextContent(/\d\.\d s so far/);
    const bar = within(step("Being proven")).getByRole("progressbar");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(40);
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(100);
    expect(step("Final on Canton")).toHaveTextContent(/about \d\d:\d\d:\d\d/);
  });

  it("puts on Final on Canton the proof's start, plus the usual proof, plus the usual Canton commit, and says the commit clause", async () => {
    const user = await open(withTimes("sent", "proving", times({ proofStartedAt: "2026-10-23T17:57:31.000Z" }), { lowMs: 7000, highMs: 8000 }, {}, 5400));
    await ask(user);
    await waitFor(() => expect(step("Being proven")).toHaveTextContent("Then Canton commits in about 5.4 s."));
    // 17:57:31 + 7.5 s + 5.4 s = 17:57:43.9, drawn to the second
    expect(step("Final on Canton")).toHaveTextContent("about 17:57:43");
  });

  it("shows no 'about' time and no commit clause when the usual Canton commit is not known, and none when the usual proof is not known", async () => {
    let user = await open(withTimes("sent", "proving", times(), { lowMs: 7000, highMs: 7700 }, {}, null));
    await ask(user);
    await waitFor(() => expect(step("Being proven")).toHaveTextContent("A proof usually takes 7.0–7.7 s"));
    expect(step("Being proven")).not.toHaveTextContent("Canton commits in about");
    expect(screen.queryByText(/about \d\d:/)).not.toBeInTheDocument();
    cleanup();
    user = await open(withTimes("sent", "proving", times(), null, {}, 600));
    await ask(user);
    await waitFor(() => expect(step("Being proven")).toHaveTextContent("Then Canton commits in about 0.6 s."));
    expect(screen.queryByText(/about \d\d:/)).not.toBeInTheDocument();
  });

  it("shows no usual time, no bar and no 'about' when too few blocks have a proof time", async () => {
    const user = await open(withTimes("sent", "proving", times(), null));
    await ask(user);
    await waitFor(() => expect(step("Sent")).toHaveTextContent("nonce 1004"));
    expect(screen.queryByText(/usually takes/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/about \d\d:/)).not.toBeInTheDocument();
  });

  it("shows no time and no nonce where the transaction route does not serve them", async () => {
    const user = await open(withTimes("sent", "pending", times({ nonce: null, acceptedAt: null, proofStartedAt: null })));
    await ask(user);
    await waitFor(() => expect(step("Sent")).toHaveTextContent("is in the pool"));
    expect(step("Sent")).not.toHaveTextContent("nonce");
    for (const name of ["Queued", "Sent", "Being proven", "Final on Canton"]) expect(step(name)).not.toHaveTextContent(/\d\d:\d\d:\d\d/);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("keeps the steps as they are when the transaction cannot be read at all", async () => {
    const user = await open(withTimes("sent", "proving", null));
    await ask(user);
    await waitFor(() => expect(screen.getByText("Being proven in block 22")).toBeInTheDocument());
    expect(screen.queryByText(/nonce/)).not.toBeInTheDocument();
  });

  it("puts the final time on Final on Canton as a fact, not 'about', and no bar", async () => {
    const user = await open(withTimes("final", null, times({ finalAt: "2026-10-23T17:57:39.101Z" })));
    await ask(user);
    await waitFor(() => expect(step("Final on Canton")).toHaveTextContent("17:57:39.101"));
    expect(step("Final on Canton")).not.toHaveTextContent("about");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("does not ask for times before the transfer has a hash", async () => {
    const client = withTimes("queued", null, times(), undefined, { hash: null });
    const user = await open(client);
    await ask(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Queued"));
    expect(client.txTimes).not.toHaveBeenCalled();
  });
});
