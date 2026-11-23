// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuilderGrant, builderStartPath, builderWords, formatDays, readBuilderResult } from "./builder.tsx";
import { FaucetPage } from "./FaucetPage.tsx";
import type { FaucetClient, FaucetInfo, Ticket, TicketResult } from "./faucet-client.ts";

afterEach(cleanup);

const ONE = "1000000000000000000", HUNDRED = (100n * 10n ** 18n).toString();
const FAUCET = "0xcd56aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac6b3";
const ADDRESS = "0x5A04de5c5ebd085f5e3b3ec791ab5cdc8e2b56f0";
const TICKET = "ab".repeat(12);
const coin = { symbol: "tROME", decimals: 18 };
const builder = { on: true, amount: HUNDRED, perAccountSeconds: 604800, minAccountAgeDays: 30, maxPerDay: 200 };
const info = (over: Partial<FaucetInfo> = {}): FaucetInfo => ({ on: true, address: FAUCET, balance: "999997000000000000000000", amount: ONE, perAddressSeconds: 86400, perIpSeconds: 600, maxPerHour: 5000, queue: 0, captcha: null, builder, ...over });
const view = (over: Partial<Ticket> = {}): TicketResult => ({ kind: "ticket", ticket: { ticket: TICKET, status: "queued", position: 1, to: ADDRESS.toLowerCase(), amount: HUNDRED, hash: null, state: null, block: null, reason: null, ...over } });

function client(i: FaucetInfo = info(), tickets: TicketResult[] = [view()]) {
  return {
    info: vi.fn(async () => i),
    request: vi.fn(async () => ({ kind: "problem", message: "no" }) as never),
    ticket: vi.fn(async (_id: string) => tickets[0]!),
  } satisfies FaucetClient;
}
function open(c: FaucetClient, at = "/faucet") {
  render(<MemoryRouter initialEntries={[at]}><FaucetPage client={c} coin={coin} pollMs={15} /></MemoryRouter>);
}

describe("the offer", () => {
  it("is 'Building on Ostia? Get 100 tROME.' and a Sign in with GitHub button with GitHub's mark, linking to the start path for the address", () => {
    render(<BuilderGrant info={info()} address={ADDRESS} coin={coin} />);
    expect(document.querySelector(".builder-grant")).toHaveTextContent("Building on Ostia? Get 100 tROME.");
    const link = screen.getByRole("link", { name: "Sign in with GitHub" });
    expect(link).toHaveAttribute("href", `/api/faucet/github/start?address=${ADDRESS.toLowerCase()}`);
    expect(link).toHaveClass("gh-btn");
    const mark = link.querySelector("svg.gh-mark");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark!.querySelector("path")!.getAttribute("d")).toMatch(/^M8 0c4\.42 0 8 3\.58 8 8/);
    expect(link.querySelector("img")).toBeNull();
    expect(link).not.toHaveAttribute("target");
    expect(screen.queryByText("Enter your address first.")).toBeNull();
  });

  it("is nothing when it is off, absent, or the info is not read yet", () => {
    for (const i of [info({ builder: { ...builder, on: false } }), info({ builder: undefined }), info({ builder: { ...builder, amount: null } }), null]) {
      const { container } = render(<BuilderGrant info={i} address={ADDRESS} coin={coin} />);
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("waits for an address: the button is off until it is a whole address, and it says so", () => {
    for (const a of [null, "", "0x12", "hello"]) {
      const { unmount } = render(<BuilderGrant info={info()} address={a} coin={coin} />);
      expect(screen.queryByRole("link")).toBeNull();
      const off = screen.getByRole("button", { name: "Sign in with GitHub" });
      expect(off).toBeDisabled();
      expect(off.querySelector("svg.gh-mark")).not.toBeNull();
      expect(off).toHaveAccessibleDescription("Enter your address first.");
      expect(document.querySelector(".builder-grant")).toHaveTextContent("Enter your address first.");
      unmount();
    }
  });

  it("is on the Faucet page under the form, follows the typed address, and is gone when the grant is off", async () => {
    const user = userEvent.setup();
    open(client());
    expect(await screen.findByText(/Building on Ostia\?/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeDisabled();
    await user.type(screen.getByLabelText("Your address"), ADDRESS);
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute("href", builderStartPath(ADDRESS));
    cleanup();
    open(client(info({ builder: { ...builder, on: false } })));
    await screen.findByLabelText("Your address");
    expect(screen.queryByText(/Building on Ostia\?/)).toBeNull();
  });

  it("says the grant's rule among the limits, only when it is on", async () => {
    open(client());
    const limits = (await screen.findByRole("heading", { name: "The limits, in plain words" })).closest("section")!;
    expect(limits).toHaveTextContent("With a GitHub sign-in, an account at least 30 days old gets 100 tROME once every 7 days, for each account and for each address, and at most 200 a day for everyone together.");
    expect(limits).toHaveTextContent("kept as a hash, never by name");
    cleanup();
    open(client(info({ builder: undefined })));
    const plain = (await screen.findByRole("heading", { name: "The limits, in plain words" })).closest("section")!;
    expect(plain).not.toHaveTextContent("GitHub");
  });
});

describe("the page after GitHub sends the person back", () => {
  it("follows a queued grant like a request: the card says the builder amount and the address, and the browser's address is cleaned of the result", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    open(client(), `/faucet?builder=queued&ticket=${TICKET}`);
    expect(await screen.findByText("Signed in. Your builder grant of 100 tROME is queued.")).toBeInTheDocument();
    const card = (await screen.findByRole("region", { name: "Your request" }));
    await waitFor(() => expect(card).toHaveTextContent("100 tROME to 0x5a04…56f0"));
    expect(card).toHaveTextContent(`ticket ${TICKET}`);
    expect(replace).toHaveBeenCalledWith(null, "", "/faucet");
  });

  it.each([
    ["young&days=30", "That GitHub account is less than 30 days old, so it does not get a builder grant."],
    ["account&wait=86400", "This GitHub account was given a builder grant in the last 7 days. Try again in 24 h."],
    ["account&wait=604100", "This GitHub account was given a builder grant in the last 7 days. Try again in 7 days."],
    ["address&wait=3600", "This address was given a builder grant in the last 7 days. Try again in 1 h."],
    ["day", "Today's builder grants are all given out. Try again tomorrow."],
    ["ip&wait=600", "This connection asked for coins a moment ago. Try again in 10 min."],
    ["hour&wait=30", "The faucet has given out all it gives in an hour. Try again in 30 s."],
    ["queue", "The faucet's line is full, so this was turned away, not lost: nothing was taken from you. Try again later."],
    ["empty", "The faucet is empty right now, so nothing was sent."],
    ["state", "That sign-in ran out or was already used, so nothing was sent. Start it again."],
    ["denied", "You did not allow the sign-in on GitHub, so nothing was sent."],
    ["github", "GitHub could not be read just now, so nothing was sent. Try again in a moment."],
    ["busy&wait=5", "Many people are signing in at this moment. Try again in 5 s."],
    ["bad", "That is not an address. An address is 0x and 40 hex digits."],
    ["off", "The builder grant is off on this explorer."],
    ["origin", "That sign-in was started from another site, so nothing was sent. To get a builder grant, start it from this page."],
    ["problem", "The sign-in did not finish, and nothing was taken from you. Try again in a moment."],
  ])("says %s in plain words", async (query, words) => {
    open(client(), `/faucet?builder=${query}`);
    const alert = await screen.findByText(new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(alert.closest(".alert")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your request" })).toBeNull();
  });

  it("shows nothing for a result it does not know, or a ticket that is not one", async () => {
    open(client(), `/faucet?builder=<script>&ticket=zz`);
    await screen.findByLabelText("Your address");
    expect(document.querySelector(".alert")).toBeNull();
    cleanup();
    open(client(), "/faucet?builder=queued&ticket=nonsense");
    await screen.findByText("Signed in. Your builder grant of 100 tROME is queued.");
    expect(screen.queryByRole("region", { name: "Your request" })).toBeNull();
  });

  it("puts the words in the page as text, never as markup", async () => {
    open(client(), "/faucet?builder=young&days=9999");
    const text = await screen.findByText(/less than 9999 days old/);
    expect(within(text.closest(".alert") as HTMLElement).queryByRole("link")).toBeNull();
  });
});

describe("reading the result", () => {
  it("takes only the codes it knows, a 24-digit ticket, and whole numbers", () => {
    expect(readBuilderResult("?builder=queued&ticket=" + TICKET)).toEqual({ code: "queued", ticket: TICKET, wait: null, days: null });
    expect(readBuilderResult("?builder=account&wait=90&days=3")).toEqual({ code: "account", ticket: null, wait: 90, days: 3 });
    expect(readBuilderResult("?builder=account&wait=-1&days=x")).toEqual({ code: "account", ticket: null, wait: null, days: null });
    expect(readBuilderResult("?builder=nope")).toBeNull();
    expect(readBuilderResult("")).toBeNull();
  });

  it("words a period in days when it is whole days", () => {
    expect(formatDays(604800)).toBe("7 days");
    expect(formatDays(86400)).toBe("1 day");
    expect(formatDays(7200)).toBe("2 hours");
  });

  it("words the waits without the builder's settings too (the page has not read them yet)", () => {
    expect(builderWords({ code: "account", ticket: null, wait: null, days: null }, null, coin).text).toBe("This GitHub account was given a builder grant in the last few days. Try again later.");
  });
});
