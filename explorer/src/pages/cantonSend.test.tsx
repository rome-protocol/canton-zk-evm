// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsError } from "../bridge/canton/accounts.ts";
import type { Incoming, Sender } from "../bridge/send.ts";
import type { Pair } from "../bridge/tokens.ts";
import { AccountPanel } from "./AccountPanel.tsx";

const id = (tag: string, n: number) => `${tag}::1220${n.toString(16).padStart(2, "0").repeat(32)}`;
const PARTY = id("bridge", 0xab), OTHER = id("bridge", 0xcd), DSO = id("DSO", 5);
const COIN: Pair = { key: "wrapped:cc", kind: "wrapped", native: false, wrapped: null, erc20: ("0x" + "c1".repeat(20)) as `0x${string}`, ostia: { symbol: "wCC", decimals: 10 }, canton: { symbol: "Canton Coin", admin: DSO, id: "Amulet", decimals: 10 } };
const TKA: Pair = { key: "twin:a", kind: "twin", native: false, wrapped: null, erc20: ("0x" + "aa".repeat(20)) as `0x${string}`, ostia: { symbol: "TKA", decimals: 6 }, canton: { symbol: "TKA", admin: id("gateway", 3), id: "erc20:" + "aa".repeat(20), decimals: 10 } };
const held = { [COIN.key]: 20n * 10n ** 10n, [TKA.key]: 0n };

afterEach(cleanup);
const offer = (n: number, amount = "5"): Incoming => ({ id: `offer${n}`, pair: COIN, amount, from: OTHER, until: null });

function fake(over: Partial<Sender> = {}) {
  const sender: Sender = {
    send: vi.fn(async () => ({ updateId: "1220" + "ee".repeat(32), waiting: true })),
    incoming: vi.fn(async () => [] as Incoming[]),
    accept: vi.fn(async () => {}),
    can: () => true,
    ...over,
  };
  return sender;
}
function show(sender: Sender, extra: { held?: Record<string, bigint | null>; onChanged?: () => void } = {}) {
  return render(<MemoryRouter><AccountPanel wallet={"0x" + "11".repeat(20)} party={PARTY} pairs={[COIN, TKA]} held={extra.held ?? held} chainName="Ostia" sender={sender} onChanged={extra.onChanged} /></MemoryRouter>);
}
const send = () => within(screen.getByRole("group", { name: "Send on Canton" }));

describe("Send on Canton", () => {
  it("offers only the tokens the account holds on Canton, and says so when there are none", () => {
    show(fake());
    expect(within(send().getByRole("combobox", { name: "Token" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["Canton Coin"]);   // TKA is held in none
    cleanup();
    show(fake(), { held: { [COIN.key]: 0n, [TKA.key]: null } });
    expect(send().getByText(/Nothing to send yet/)).toBeInTheDocument();
    expect(send().queryByRole("button", { name: "Review" })).toBeNull();
    cleanup();
    show(fake({ can: () => false }));
    expect(send().getByText(/Nothing to send yet/)).toBeInTheDocument();   // a token this page cannot sign for is not offered
  });

  it("checks the amount and the address as they are typed, and keeps Review off until both are good", async () => {
    const user = userEvent.setup();
    show(fake());
    const review = send().getByRole("button", { name: "Review" });
    expect(review).toBeDisabled();
    await user.type(send().getByRole("textbox", { name: "Amount" }), "21");
    expect(send().getByRole("alert")).toHaveTextContent("You do not hold that much on Canton.");
    await user.clear(send().getByRole("textbox", { name: "Amount" }));
    await user.type(send().getByRole("textbox", { name: "Amount" }), "1.5x");
    expect(send().getByRole("alert")).toHaveTextContent("Type an amount such as 12 or 12.5.");
    await user.clear(send().getByRole("textbox", { name: "Amount" }));
    await user.type(send().getByRole("textbox", { name: "Amount" }), "5");
    expect(send().queryByRole("alert")).toBeNull();
    expect(review).toBeDisabled();   // no receiver yet
    const to = send().getByRole("textbox", { name: "Receiver's Canton address" });
    await user.type(to, "bridge");
    expect(send().getByRole("alert")).toHaveTextContent(/not a Canton address/);
    expect(review).toBeDisabled();
    await user.clear(to);
    await user.type(to, PARTY);
    expect(send().getByRole("alert")).toHaveTextContent(/your own address/);
    expect(review).toBeDisabled();
    await user.clear(to);
    await user.type(to, OTHER);
    expect(send().queryByRole("alert")).toBeNull();
    expect(review).toBeEnabled();
    expect(send().queryByRole("status")).toBeNull();   // nothing to confirm until Review
  });

  it("shows the line to confirm, sends only after Send, and says it is waiting for the receiver to accept, with the Canton update", async () => {
    const user = userEvent.setup();
    const sender = fake();
    const changed = vi.fn();
    show(sender, { onChanged: changed });
    await user.type(send().getByRole("textbox", { name: "Amount" }), ".50");
    await user.type(send().getByRole("textbox", { name: "Receiver's Canton address" }), OTHER);
    await user.click(send().getByRole("button", { name: "Review" }));
    expect(send().getByRole("status")).toHaveTextContent("Send 0.5 Canton Coin to bridge::1220…cdcd on Canton");
    expect(sender.send).not.toHaveBeenCalled();
    await user.click(send().getByRole("button", { name: "Back" }));   // back to the form: nothing was sent
    expect(sender.send).not.toHaveBeenCalled();
    await user.click(send().getByRole("button", { name: "Review" }));
    await user.click(send().getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send().getByText("Sent; waiting for the receiver to accept.")).toBeInTheDocument());
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(COIN, "0.50", OTHER);
    expect(send().getByRole("link", { name: "Canton update" })).toHaveAttribute("href", `/canton/${"1220" + "ee".repeat(32)}`);
    expect(changed).toHaveBeenCalled();
    expect(send().getByRole("textbox", { name: "Amount" })).toHaveValue("");   // the form is clear for the next one
  });

  it("says it is done when the receiver did not have to accept", async () => {
    const user = userEvent.setup();
    show(fake({ send: vi.fn(async () => ({ updateId: "1220" + "ee".repeat(32), waiting: false })) }));
    await user.type(send().getByRole("textbox", { name: "Amount" }), "5");
    await user.type(send().getByRole("textbox", { name: "Receiver's Canton address" }), OTHER);
    await user.click(send().getByRole("button", { name: "Review" }));
    await user.click(send().getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send().getByText("Sent. It is in their account.")).toBeInTheDocument());
    expect(send().queryByText(/waiting/)).toBeNull();
  });

  it("shows a refusal in plain words, never a code", async () => {
    const user = userEvent.setup();
    show(fake({ send: vi.fn(async () => { throw new AccountsError("refused", 422, "x", undefined, "INVALID_ARGUMENT"); }) }));
    await user.type(send().getByRole("textbox", { name: "Amount" }), "5");
    await user.type(send().getByRole("textbox", { name: "Receiver's Canton address" }), OTHER);
    await user.click(send().getByRole("button", { name: "Review" }));
    await user.click(send().getByRole("button", { name: "Send" }));
    const alert = await send().findByRole("alert");
    expect(alert).toHaveTextContent("Canton did not take this transfer. The receiver may not be set up for this token yet. Nothing was sent.");
    expect(alert.textContent).not.toMatch(/INVALID|422|party|instruction|preapproval/i);
    expect(send().queryByText(/Sent/)).toBeNull();
  });
});

describe("Incoming", () => {
  const incoming = () => within(screen.getByRole("group", { name: "Incoming" }));

  it("says when nothing is waiting, and lists each offer with Accept", async () => {
    show(fake());
    expect(await incoming().findByText("No transfers are waiting for you.")).toBeInTheDocument();
    cleanup();
    show(fake({ incoming: vi.fn(async () => [offer(1), offer(2, "0.25")]) }));
    const rows = await incoming().findAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["5 Canton Coin from bridge::1220…cdcdAccept", "0.25 Canton Coin from bridge::1220…cdcdAccept"]);
  });

  it("accepts one: the balance is read again, the offer goes and the page says it is in the account", async () => {
    const user = userEvent.setup();
    const sender = fake({ incoming: vi.fn(async () => [offer(1), offer(2, "0.25")]) });
    const changed = vi.fn();
    show(sender, { onChanged: changed });
    const [first] = await incoming().findAllByRole("button", { name: "Accept" });
    await user.click(first!);
    await waitFor(() => expect(incoming().getByText("5 Canton Coin is in your account.")).toBeInTheDocument());
    expect(sender.accept).toHaveBeenCalledOnce();
    expect(sender.accept).toHaveBeenCalledWith(expect.objectContaining({ id: "offer1" }));
    expect(changed).toHaveBeenCalledOnce();
    expect(incoming().getAllByRole("listitem")).toHaveLength(1);
    expect(incoming().getByText(/0.25 Canton Coin/)).toBeInTheDocument();
  });

  it("keeps the offer and says why in plain words when the accept fails", async () => {
    const user = userEvent.setup();
    show(fake({ incoming: vi.fn(async () => [offer(1)]), accept: vi.fn(async () => { throw new AccountsError("unavailable", 502, "x"); }) }));
    await user.click(await incoming().findByRole("button", { name: "Accept" }));
    expect(await incoming().findByRole("alert")).toHaveTextContent("The bridge is busy or restarting. Try again in a moment.");
    expect(incoming().getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("looks again when asked, and says when it cannot look", async () => {
    const user = userEvent.setup();
    const look = vi.fn().mockRejectedValueOnce(new AccountsError("network", 0, "x")).mockResolvedValueOnce([offer(1)]);
    show(fake({ incoming: look }));
    expect(await incoming().findByRole("alert")).toHaveTextContent("Could not look for transfers just now.");
    await user.click(incoming().getByRole("button", { name: "Check again" }));
    expect(await incoming().findByText(/5 Canton Coin/)).toBeInTheDocument();
    expect(look).toHaveBeenCalledTimes(2);
  });

  it("uses no technical names", async () => {
    show(fake({ incoming: vi.fn(async () => [offer(1)]) }));
    await incoming().findByRole("button", { name: "Accept" });
    expect(screen.getByRole("region", { name: "Your addresses" }).textContent).not.toMatch(/party|instruction|preapproval|allocation|holding/i);
  });
});
