// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { depositIdOf, lockIdOf, releaseIdOf, saveCheckpoint } from "../bridge/moves/state.ts";
import { TAKE_BACK_LABEL } from "../bridge/card.ts";
import { config, fakeCanton, fakeEvm, fakeSession, GATEWAY_PARTY, leg, ME, PARTY, TKA, VAULT, WCC, WTROME, memoryStore } from "./bridge-fakes.ts";
import { MoveCard, type MoveCardProps } from "./MoveCard.tsx";

afterEach(cleanup);

type Made = ReturnType<typeof fakeSession>;
function show(over: Partial<MoveCardProps> = {}, made?: Made) {
  const m = made ?? fakeSession({ legs: () => [] });
  const props: MoveCardProps = {
    config, configState: "ready", gateway: GATEWAY_PARTY, account: ME, evm: m.evm.evm, session: m.session, chainName: "Ostia", onConnect: vi.fn(), connectNote: null, onOpenAccount: vi.fn(),
    ensureChain: async () => null, faucet: { label: "Get 1 tROME", busy: false, onGet: vi.fn() }, accountOpen: (over.session === undefined ? m.session : over.session) !== null, ...over,
  };
  render(<MemoryRouter><MoveCard {...props} /></MemoryRouter>);
  return { props, made: m };
}
const type = async (text: string, label = "Amount to move") => userEvent.type(screen.getByRole("textbox", { name: label }), text);
const choose = async (field: "From" | "To", name: RegExp) => {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${field} token`) }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name }));
};
const tka = () => choose("From", /^TKA on Ostia$/);
const press = (name: string | RegExp) => userEvent.click(screen.getByRole("button", { name }));
const done = () => screen.findByText(/Done\. It is final in/);

describe("the button walks the steps", () => {
  it("asks to connect, then to open the Canton account, then for an amount, then moves", async () => {
    const m = fakeSession({ legs: () => [] });
    const first = show({ account: null, evm: null, session: null }, m);
    await press("Connect MetaMask");
    expect(first.props.onConnect).toHaveBeenCalledTimes(1);
    cleanup();
    const second = show({ session: null }, m);
    await press("Open my Canton account");
    expect(second.props.onOpenAccount).toHaveBeenCalledTimes(1);
    cleanup();
    show({}, m);
    expect(screen.getByRole("button", { name: "Enter an amount" })).toBeDisabled();
    await type("5");
    expect(await screen.findByRole("button", { name: "Move to Canton" })).toBeEnabled();
    await press("Swap direction");
    expect(screen.getByRole("button", { name: "Move to Ostia" })).toBeInTheDocument();
  });
  it("says a connect problem in words, and an amount the bridge will not take", async () => {
    show({ connectNote: "No wallet was found in this browser. Install MetaMask, then open this page again." });
    expect(screen.getByRole("alert")).toHaveTextContent("No wallet was found in this browser. Install MetaMask, then open this page again.");
    await type("1.00000000001");
    expect(screen.getByRole("status")).toHaveTextContent("use at most 10 decimals");
    expect(screen.getByRole("button", { name: "Enter an amount" })).toBeDisabled();
  });
  it("takes a comma as the decimal point (a keypad set to a comma-decimal language has no point), and refuses thousands separators", async () => {
    show();
    await type("1,5");
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveValue("1.5");
    expect(await screen.findByRole("button", { name: "Move to Canton" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveAttribute("inputmode", "decimal");
    await userEvent.clear(screen.getByRole("textbox", { name: "Amount to move" }));
    await type("1.5");
    expect(await screen.findByRole("button", { name: "Move to Canton" })).toBeEnabled();
    for (const bad of ["1,000,5", "1,000.5", "1.000,5"]) {
      await userEvent.clear(screen.getByRole("textbox", { name: "Amount to move" }));
      await type(bad);
      expect(screen.getByRole("button", { name: "Enter an amount" })).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("Type an amount such as 12 or 12.5.");
    }
  });
  it("starts the move with the amount as a point-decimal, when it was typed with a comma", async () => {
    const { made } = show();
    await type("1,5");
    await press("Move to Canton");
    await waitFor(() => expect(made.store.map.get("bridge-move:ref-1")).toBeDefined());
    expect(JSON.parse(made.store.map.get("bridge-move:ref-1")!).input.amount).toBe("1.5");
  });
  it("says the bridge is not available, on the button too, when its setup failed and the Canton account is open", () => {
    show({ config: null, configState: "failed", evm: null, session: null, accountOpen: true });
    expect(screen.getByText("The bridge is not available on this chain yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not available here" })).toBeDisabled();
  });
  it("says it is getting ready, not 'Open my Canton account', after sign-in while the move's machinery is built", () => {
    show({ session: null, accountOpen: true });
    expect(screen.getByRole("button", { name: "Getting ready…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open my Canton account" })).toBeNull();
  });
  it("shows the balance with a Max that fills the amount, and refuses more than the balance", async () => {
    show();
    await tka();
    expect(await screen.findAllByText("20")).toHaveLength(2);   // TKA on Ostia: the fake account holds 20, and the Canton side shows its own 20
    await press("Max");
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveValue("20");
    expect(screen.getByRole("textbox", { name: "Amount you get" })).toHaveValue("20");
    await userEvent.type(screen.getByRole("textbox", { name: "Amount to move" }), "1");
    expect(screen.getByRole("button", { name: "Not enough TKA" })).toBeDisabled();
  });
  it("shows a balance with at most six decimals, cut down, while Max fills in the exact amount", async () => {
    show({}, fakeSession({ legs: () => [], evm: fakeEvm({ balance: 1999999999999999999n }) }));
    await tka();
    expect(await screen.findByText("1.999999")).toBeInTheDocument();
    await press("Max");
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveValue("1.9999999999");
  });
  it("offers the faucet inline only when the account holds nothing for fees", async () => {
    const { props } = show({}, fakeSession({ legs: () => [], evm: fakeEvm({ native: 0n }) }));
    await userEvent.click(await screen.findByRole("button", { name: "Get 1 tROME" }));
    expect(props.faucet!.onGet).toHaveBeenCalled();
    cleanup();
    show();
    await screen.findByText("119.99");   // tROME: what is wrapped, and the coin less a reserve for fees
    expect(screen.queryByRole("button", { name: "Get 1 tROME" })).toBeNull();
  });
  it("puts the wallet on Ostia before a move, and does not start one when it cannot", async () => {
    const { made } = show({ ensureChain: async () => "Your wallet is not on Ostia yet." });
    await tka();
    await type("1");
    await press("Move to Canton");
    expect(await screen.findByRole("alert")).toHaveTextContent("Your wallet is not on Ostia yet.");
    expect(made.evm.calls).toEqual([]);
  });
});

describe("the four moves on the card", () => {
  it("TKA, Ostia to Canton: approve, then pay in (2 pop-ups); the same token lands on Canton", async () => {
    const m = fakeSession({ legs: (ref) => [leg({ kind: "payment", legId: lockIdOf(PARTY, ref) }, TKA)] });
    show({}, m);
    await tka();
    expect(screen.getByText(/About 2 min · 2 MetaMask pop-ups/)).toBeInTheDocument();
    await type("1.5");
    await press("Move to Canton");
    await done();
    expect(m.evm.calls.map((c) => c.name)).toEqual(["approve", "pay"]);
    expect(m.evm.calls[1]!.args[2]).toBe(TKA);
    expect(screen.getByRole("link", { name: "block 42" })).toHaveAttribute("href", "/block/42");
  });
  it("tROME, Ostia to Canton: wrap first, then approve and pay in (3 pop-ups)", async () => {
    const m = fakeSession({ evm: fakeEvm({ balance: 0n, native: 10n ** 20n }), legs: (ref) => [leg({ kind: "payment", legId: lockIdOf(PARTY, ref) }, WTROME)] });
    show({}, m);
    await choose("From", /^tROME on Ostia$/);
    expect(screen.getByText(/About 2 min · 3 MetaMask pop-ups/)).toBeInTheDocument();
    await type("2");
    await press("Move to Canton");
    await done();
    expect(m.evm.calls.map((c) => c.name)).toEqual(["wrap", "approve", "pay"]);
  });
  it("TKA back, Canton to Ostia: the page signs the redeem on Canton, then the release is one pop-up", async () => {
    const m = fakeSession({ legs: (ref) => [leg({ kind: "payment", legId: releaseIdOf(VAULT, ref) }, TKA)] });
    show({}, m);
    await tka();
    await press("Swap direction");
    expect(screen.getByText(/About 1 min · 1 MetaMask pop-up$/)).toBeInTheDocument();
    await type("3");
    await press("Move to Ostia");
    await done();
    expect(m.canton.calls).toEqual(["signRedeem", "waitRedeem"]);
    expect(m.evm.calls.map((c) => c.name)).toEqual(["release"]);
  });
  it("Canton Coin, Canton to Ostia: the page signs the deposit on Canton, then one claim; the wrapped token lands on Ostia", async () => {
    const m = fakeSession({ legs: (ref) => [leg({ kind: "deposit", legId: depositIdOf(PARTY, ref) }, WCC)] });
    show({}, m);
    await choose("From", /^Canton Coin on Canton$/);
    expect(screen.getByRole("button", { name: /^To token wCC on Ostia$/ })).toBeInTheDocument();
    await type("5");
    await press("Move to Ostia");
    await done();
    expect(m.canton.calls).toEqual(["allocateDeposit", "signDeposit", "waitDeposit"]);
    expect(m.evm.calls.map((c) => c.name)).toEqual(["claim"]);
  });
  it("the wrapped token back, Ostia to Canton: one withdraw", async () => {
    const m = fakeSession({ legs: () => [leg({ kind: "withdrawal", amount: (5n * 10n ** 10n).toString() }, WCC)] });
    show({}, m);
    await choose("From", /^wCC on Ostia$/);
    await type("5");
    await press("Move to Canton");
    await done();
    expect(m.evm.calls.map((c) => c.name)).toEqual(["withdraw"]);
    expect(m.canton.calls).toEqual([]);
  });
  it("shows what happened in plain words when a move stops, and keeps it to continue", async () => {
    const m = fakeSession({ legs: () => [], evm: fakeEvm({ balance: 10n ** 21n }) });
    vi.spyOn(m.evm.evm, "approve").mockRejectedValue(Object.assign(new Error("x"), { shortMessage: "User rejected the request.", code: 4001 }));
    show({}, m);
    await tka();
    await type("1");
    await press("Move to Canton");
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined it in your wallet.");
    expect(screen.getByRole("alert").textContent).not.toMatch(/rejected|0x|Error/);
  });
  it("picks up a move kept in the browser, shows what it is, and continues it", async () => {
    const store = memoryStore();
    saveCheckpoint(store, { input: { kind: "redeem", asset: TKA, amount: "3" }, ref: "ref-1", account: ME, party: PARTY, vault: VAULT, to: ME, stage: "evm", at: Date.now() });
    const m = fakeSession({ store, legs: (ref) => [leg({ kind: "payment", legId: releaseIdOf(VAULT, ref) }, TKA)] });
    show({}, m);
    expect(await screen.findByRole("button", { name: "Release on Ostia" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Canton has it. Continue to release it on Ostia.");
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveValue("3");
    expect(screen.getByRole("button", { name: /^From token TKA on Canton$/ })).toBeInTheDocument();
    await press("Release on Ostia");
    await done();
    expect(m.evm.calls.map((c) => c.name)).toEqual(["release"]);
  });
});

describe("the card with nothing to move", () => {
  it("says there are no tokens when the bridge is set up but lists none, and not that it is still looking", () => {
    show({ config: { ...config, twins: [], wrapped: [] } });
    expect(screen.getByText("There are no tokens to move here yet.")).toBeInTheDocument();
    expect(screen.queryByText("Looking up the tokens…")).toBeNull();
  });
});

describe("giving a move up", () => {
  const kept = (stage: "start" | "evm") => {
    const store = memoryStore();
    saveCheckpoint(store, { input: { kind: "redeem", asset: TKA, amount: "3" }, ref: "ref-1", account: ME, party: PARTY, vault: VAULT, to: ME, stage, at: Date.now() });
    return fakeSession({ store, legs: () => [] });
  };
  it("asks first when part of the move may be done, keeps it on Keep it, and gives it up on Give it up", async () => {
    const m = kept("evm");
    show({}, m);
    await screen.findByRole("button", { name: "Release on Ostia" });
    await press("Give this move up");
    expect(screen.getByText(/this page cannot finish it/)).toBeInTheDocument();
    expect(m.session.kept()).toHaveLength(1);
    await press("Keep it");
    expect(screen.queryByText(/this page cannot finish it/)).toBeNull();
    expect(m.session.kept()).toHaveLength(1);
    await press("Give this move up");
    await press("Give it up");
    await waitFor(() => expect(m.session.kept()).toHaveLength(0));
  });
});

describe("taking a deposit back", () => {
  const kept = (stage: "canton" | "sent", deadline: number | null, refuse?: number) => {
    const store = memoryStore();
    saveCheckpoint(store, { input: { kind: "deposit", asset: WCC, amount: "3" }, ref: "ref-1", account: ME, party: PARTY, vault: VAULT, stage, at: Date.now(), ...(stage === "sent" ? { tx: ("0x" + "09".repeat(32)) as `0x${string}` } : {}) });
    const canton = fakeCanton();
    canton.deadline = deadline;
    if (refuse !== undefined) canton.recoverDeposit = async () => { throw Object.assign(new Error("not on the list"), { status: refuse }); };
    return fakeSession({ store, canton, legs: () => [], tx: () => ({ status: "proving", legs: [] }) as never });
  };
  it("is offered for a kept deposit past its time to settle, and takes the tokens back and clears the move", async () => {
    const m = kept("canton", Date.now() - 5 * 60_000);
    show({}, m);
    await userEvent.click(await screen.findByRole("button", { name: TAKE_BACK_LABEL }));
    await waitFor(() => expect(m.session.kept()).toHaveLength(0));
    expect(m.canton.calls.filter((c) => c === "recoverDeposit")).toHaveLength(1);
  });
  it("is not offered while the deposit can still settle", async () => {
    const early = kept("canton", Date.now() + 60 * 60_000);
    show({}, early);
    await screen.findByRole("button", { name: /Continue|Claim/ });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: TAKE_BACK_LABEL })).toBeNull();
  });
  it("asks a second time before giving up a deposit whose take-back Canton refuses, and then leaves the tokens locked", async () => {
    const m = kept("canton", Date.now() - 5 * 60_000, 403);
    show({}, m);
    await screen.findByRole("button", { name: TAKE_BACK_LABEL });
    await press("Give this move up");
    await press("Give it up");
    expect(await screen.findByText(/they stay locked on Canton/)).toBeInTheDocument();
    expect(m.session.kept()).toHaveLength(1);
    await press("Give it up, leave the tokens locked");
    await waitFor(() => expect(m.session.kept()).toHaveLength(0));
  });
  it("is offered for a claim that was sent and is still not final once the time to settle has passed", async () => {
    const m = kept("sent", Date.now() - 5 * 60_000);
    show({}, m);
    await userEvent.click(await screen.findByRole("button", { name: TAKE_BACK_LABEL }));
    await waitFor(() => expect(m.session.kept()).toHaveLength(0));
  });
});

describe("the folded steps line", () => {
  it("opens to the steps and says who signs each", async () => {
    show();
    await tka();
    const steps = screen.getByText(/About 2 min/).closest("details")!;
    expect(steps).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText(/About 2 min/));
    expect(steps).toHaveAttribute("open");
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Approve TKA MetaMask pop-up", "Pay TKA in MetaMask pop-up", "Canton shows it in your account Automatic"]);
    await press("Swap direction");
    expect(steps.textContent).toMatch(/Sign the move back on Canton Signed by this page with your Canton account/);
    expect(steps.textContent).toMatch(/1 in MetaMask, 1 by your Canton account\./);
  });
});

describe("the token picker", () => {
  it("has one list in two groups, only the tokens this build supports, and picks a token from either group", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /^From token/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog.querySelector('[aria-label="On Ostia"]') as HTMLElement).getAllByRole("listitem").map((l) => l.querySelector(".pick")!.textContent)).toEqual(["tROMEon Ostia", "TKAon Ostia", "wCCon Ostia"]);
    expect(within(dialog.querySelector('[aria-label="On Canton"]') as HTMLElement).getAllByRole("listitem").map((l) => l.querySelector(".pick")!.textContent)).toEqual(["tROMEon Canton", "TKAon Canton", "Canton Coinon Canton"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Canton Coin on Canton" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^From token Canton Coin on Canton$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^To token wCC on Ostia$/ })).toBeInTheDocument();
  });
  it("picking a token in To makes it the destination", async () => {
    show();
    await choose("To", /^wCC on Ostia$/);
    expect(screen.getByRole("button", { name: /^From token Canton Coin on Canton$/ })).toBeInTheDocument();
  });
  it("searches by name and by address, and says when nothing matches", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /^From token/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tokens" }), "cc");
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem").map((l) => l.querySelector(".pick")!.textContent)).toEqual(["wCCon Ostia", "Canton Coinon Canton"]);
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "coin");
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem").map((l) => l.querySelector(".pick")!.textContent)).toEqual(["Canton Coinon Canton"]);
    expect(screen.queryByRole("button", { name: "TKA on Ostia" })).toBeNull();
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), TKA.slice(0, 12));
    expect(screen.getAllByRole("button", { name: /^TKA/ })).toHaveLength(1);
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("No token matches.")).toBeInTheDocument();
  });
  it("shows a token's facts behind its i: address or id, decimals, and what it is a twin of", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /^From token/ }));
    const onOstia = screen.getByRole("region", { name: "On Ostia" });
    const facts = (b: HTMLElement) => document.getElementById(b.getAttribute("aria-describedby")!)!.textContent;
    const wcc = within(onOstia).getByRole("button", { name: "About wCC on Ostia" });
    await userEvent.click(wcc);
    expect(facts(wcc)).toBe(`Address${WCC}Decimals10Twin ofCanton Coin on Canton (wrapped here)`);
    const canton = screen.getByRole("region", { name: "On Canton" });
    const cc = within(canton).getByRole("button", { name: "About Canton Coin on Canton" });
    await userEvent.click(cc);
    expect(facts(cc)).toBe("Token idAmuletDecimals10Twin ofwCC on Ostia (its wrapped form)");
  });
  it("closes with Escape or Close without changing the choice", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /^From token/ }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /^From token/ }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^From token tROME on Ostia$/ })).toBeInTheDocument();
  });
});

describe("the card on a phone", () => {
  it("keeps a long amount whole: the field holds all of it, wraps it, and shrinks its type", async () => {
    show();
    await tka();
    const long = "123456789.1234567890";
    await type(long);
    const field = screen.getByRole("textbox", { name: "Amount to move" });
    expect(field).toHaveValue(long);   // every digit is in the field
    expect(field.parentElement!.getAttribute("data-value")).toBe(`${long} `);   // and in the copy that gives the field its height
    expect(field.parentElement).toHaveClass("amt-m");
    expect(screen.getByRole("textbox", { name: "Amount you get" })).toHaveValue(long);
  });
  it("is drawn by rules that wrap an amount, give it its own line on a phone, and never cut it", () => {
    const css = readFileSync(join(import.meta.dirname, "bridge.css"), "utf8");
    expect(css).not.toMatch(/text-overflow|\.\.\.|…/);
    expect(css).toMatch(/\.bridge-page \.amt textarea[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^}]*\.bridge-page \.amt \{ flex: 1 1 100%/);
    expect(css).not.toMatch(/\.amt[^{]*\{[^}]*overflow: hidden[^}]*max-height|\.amt[^{]*\{[^}]*(?<!-)height: \d/);
  });
});

describe("what the card does around a move", () => {
  const kept = () => {
    const store = memoryStore();
    saveCheckpoint(store, { input: { kind: "redeem", asset: TKA, amount: "3" }, ref: "ref-1", account: ME, party: PARTY, vault: VAULT, to: ME, stage: "evm", at: Date.now() });
    return fakeSession({ store, legs: (ref) => [leg({ kind: "payment", legId: releaseIdOf(VAULT, ref) }, TKA)] });
  };
  it("puts the wallet on Ostia before it continues a kept move, and sends nothing when it cannot", async () => {
    const m = kept();
    const ensureChain = vi.fn(async () => "Your wallet is not on Ostia yet.");
    show({ ensureChain }, m);
    await userEvent.click(await screen.findByRole("button", { name: "Release on Ostia" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your wallet is not on Ostia yet.");
    expect(ensureChain).toHaveBeenCalledTimes(1);
    expect(m.evm.calls).toEqual([]);
  });
  it("does not take a second press while the wallet is being put on Ostia", async () => {
    let go: (why: null) => void = () => {};
    const ensureChain = vi.fn(() => new Promise<null>((r) => { go = r; }));
    const m = fakeSession({ legs: (ref) => [leg({ kind: "payment", legId: lockIdOf(PARTY, ref) }, TKA)] });
    show({ ensureChain }, m);
    await tka();
    await type("1");
    await press("Move to Canton");
    expect(screen.getByRole("button", { name: "Move to Canton" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveAttribute("readonly");
    await press("Move to Canton");
    expect(ensureChain).toHaveBeenCalledTimes(1);
    go(null);
    await done();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("fills in Max as an amount the button takes, for a token that has fewer than ten decimals", async () => {
    const six = { ...config, twins: [{ address: TKA, symbol: "TKA", decimals: 6 }, ...config.twins.slice(1)] };
    show({ config: six }, fakeSession({ legs: () => [], cantonBalance: 123456789012n }));
    await choose("From", /^TKA on Canton$/);
    await screen.findByText("12.345678");   // Canton holds ten decimals: the balance shows six, cut down
    await press("Max");
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveValue("12.345678");
    expect(await screen.findByRole("button", { name: "Move to Ostia" })).toBeEnabled();
  });
  it("says the chain's own coin comes back wrapped", async () => {
    show();
    await press("Swap direction");
    expect(screen.getByText("Release WtROME on Ostia")).toBeInTheDocument();
  });
  it("names what arrives when the chain's own coin comes back from Canton: WtROME on the To side, and only the wrapped balance there", async () => {
    show();
    await press("Swap direction");
    expect(screen.getByRole("button", { name: "To token WtROME on Ostia" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "From token tROME on Canton" })).toBeInTheDocument();
    const balance = (side: "from" | "to") => document.querySelector(`.side.${side} .bal .num`)!.textContent;
    await waitFor(() => expect(balance("to")).toBe("20"));   // the fake wallet holds 20 of the wrapped form, and the same 20 as gas: only the wrapped 20 is the To balance
  });
  it("drops the balance of the old token when the token changes, until the new one is read", async () => {
    const e = fakeEvm();
    const real = e.evm.balanceOf;
    e.evm.balanceOf = (t, h) => (t === WTROME ? new Promise(() => {}) : real(t, h));
    show({}, fakeSession({ legs: () => [], evm: e }));
    await tka();
    expect(await screen.findAllByText("20")).toHaveLength(2);
    await choose("From", /^tROME on Ostia$/);
    expect(screen.queryAllByText("20")).toHaveLength(0);
  });
});
