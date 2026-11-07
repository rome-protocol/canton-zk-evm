// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { ApiTx } from "../api.ts";
import { entryOf, remember } from "../bridge/activity.ts";
import { pairsOf } from "../bridge/tokens.ts";
import { depositIdOf, releaseIdOf, saveCheckpoint, type Checkpoint, type MoveState } from "../bridge/moves/state.ts";
import type { Session } from "../bridge/session.ts";
import { Activity, type ActivityProps } from "./Activity.tsx";
import { config, fakeEvm, fakeSession, GATEWAY_PARTY, leg, ME, memoryStore, PARTY, TKA, VAULT, WCC } from "./bridge-fakes.ts";
import { MoveBar } from "./MoveBar.tsx";

afterEach(cleanup);
const pairs = pairsOf(config, GATEWAY_PARTY);
const TX = ("0x" + "ab".repeat(32)) as Hex;
const NOW = Date.now();   // kept records older than 30 days are dropped, so the times are recent

const answer = (o: Record<string, unknown>) => ({ status: "waiting", success: null, lifecycle: null, block: null, legs: [], ...o }) as unknown as ApiTx;
const lifecycle = (proofEndedAt: string | null) => ({ state: "x", reason: null, acceptedAt: null, acceptedVia: null, includedAt: null, attempts: 1, leftOutReason: null, proofStartedAt: "2026-11-07T10:00:00Z", proofEndedAt, submittedAt: null, committedAt: null, finalAt: null, finalBlock: null, timeToFinalMs: null });
const IN_BLOCK = { number: 36512, hash: null, updateId: null };

const ck = (o: Partial<Checkpoint> & Pick<Checkpoint, "input" | "stage">): Checkpoint => ({ ref: "r1", account: ME, party: PARTY, vault: VAULT, at: NOW, ...o });
const redeem: Checkpoint["input"] = { kind: "redeem", asset: TKA, amount: "3" };
const deposit: Checkpoint["input"] = { kind: "deposit", asset: WCC, amount: "5" };

describe("the bar under the card", () => {
  /** A session whose move state the test drives: the bar reads the state and the kept record, as it does of the real one. */
  function driven(record: Checkpoint) {
    const subs = new Set<(s: MoveState) => void>();
    const move = { state: { phase: "idle" } as MoveState, subscribe: (f: (s: MoveState) => void) => { subs.add(f); return () => void subs.delete(f); } };
    const session = { move, kept: () => [record] } as unknown as Session;
    const set = (s: MoveState) => act(() => { move.state = s; subs.forEach((f) => f(s)); });
    return { session, set };
  }
  const marks = () => ["Sent", "Proven", "Final"].map((n) => screen.getByRole("listitem", { name: new RegExp(`^${n}:`) }).getAttribute("aria-label"));

  it("is not there until a move is on its way, shows Sent, Proven and Final as the explorer shows them, and names the block", async () => {
    let seen: ApiTx | null = null;
    const read = vi.fn(async () => seen);
    const { session, set } = driven(ck({ input: deposit, stage: "canton" }));
    render(<MemoryRouter><MoveBar session={session} pairs={pairs} chainName="Ostia" read={read} pollMs={10} /></MemoryRouter>);
    expect(screen.queryByRole("region", { name: "Move on its way" })).toBeNull();

    await set({ phase: "signing-canton" });
    const bar = await screen.findByRole("region", { name: "Move on its way" });
    expect(bar).toHaveTextContent("5 CC to Ostia");
    expect(bar).toHaveTextContent("Signing on Canton…");
    expect(marks()).toEqual(["Sent: waiting", "Proven: waiting", "Final: waiting"]);

    await set({ phase: "proving", tx: TX });
    await waitFor(() => expect(marks()).toEqual(["Sent: done", "Proven: waiting", "Final: waiting"]));   // sent: the explorer has not seen it yet
    expect(screen.queryByRole("link", { name: /block/ })).toBeNull();

    seen = answer({ status: "proving", block: IN_BLOCK, lifecycle: lifecycle(null) });
    await waitFor(() => expect(screen.getByRole("link", { name: "block 36512" })).toHaveAttribute("href", "/block/36512"));
    expect(marks()).toEqual(["Sent: done", "Proven: waiting", "Final: waiting"]);

    seen = answer({ status: "proving", block: IN_BLOCK, lifecycle: lifecycle("2026-11-07T10:00:07Z") });
    await waitFor(() => expect(marks()).toEqual(["Sent: done", "Proven: done", "Final: waiting"]));

    seen = answer({ status: "final", success: true, block: { ...IN_BLOCK, updateId: "u1" } });
    await waitFor(() => expect(marks()).toEqual(["Sent: done", "Proven: done", "Final: done"]));
    const calls = read.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(read.mock.calls.length).toBe(calls);   // it stops looking once the move is final
  });
  it("shows all three marks when the move ends, and goes away when a move is paused or failed", async () => {
    const { session, set } = driven(ck({ input: redeem, stage: "sent", tx: TX }));
    render(<MemoryRouter><MoveBar session={session} pairs={pairs} chainName="Ostia" read={async () => null} pollMs={10} /></MemoryRouter>);
    await set({ phase: "final", tx: TX, block: 42 });
    expect(await screen.findByRole("region", { name: "Move on its way" })).toHaveTextContent("3 TKA to Ostia");
    expect(marks()).toEqual(["Sent: done", "Proven: done", "Final: done"]);
    expect(screen.getByRole("link", { name: "block 42" })).toHaveAttribute("href", "/block/42");
    await set({ phase: "paused", note: "x" });
    expect(screen.queryByRole("region", { name: "Move on its way" })).toBeNull();
  });
  it("has nothing to show before the Canton account is open", () => {
    render(<MemoryRouter><MoveBar session={null} pairs={pairs} chainName="Ostia" read={async () => null} /></MemoryRouter>);
    expect(screen.queryByRole("region", { name: "Move on its way" })).toBeNull();
  });
});

describe("the Activity list", () => {
  function show(over: Partial<ActivityProps> = {}) {
    const props: ActivityProps = { account: ME, session: null, store: memoryStore(), pairs, chainName: "Ostia", onConnect: vi.fn(), onOpenAccount: vi.fn(), read: async () => null, pollMs: 10, ...over };
    render(<MemoryRouter><Activity {...props} /></MemoryRouter>);
    return props;
  }
  const rows = () => screen.getAllByRole("listitem").filter((li) => li.classList.contains("act-row"));

  it("asks to connect without a wallet, and says so when there are no moves", async () => {
    const props = show({ account: null });
    await userEvent.click(screen.getByRole("button", { name: "Connect MetaMask" }));
    expect(props.onConnect).toHaveBeenCalled();
    cleanup();
    show();
    expect(screen.getByText(/No moves yet/)).toBeInTheDocument();
  });
  it("has one row per move: when, what moved, its marks, and links to its block on Ostia and its update on Canton", async () => {
    const store = memoryStore();
    remember(store, { ...entryOf(ck({ ref: "done-1", input: { kind: "lock", asset: TKA, amount: "1.5", receiver: PARTY }, stage: "sent", at: Date.UTC(2026, 10, 7, 9, 30, 15) })), tx: TX, block: 36512 });
    saveCheckpoint(store, ck({ ref: "open-1", input: deposit, stage: "start", at: NOW }));
    show({ store, read: async () => answer({ status: "final", success: true, block: { ...IN_BLOCK, updateId: "1220abcd" } }) });
    const [open, done] = rows();
    expect(within(open!).getByText("5 CC to Ostia")).toBeInTheDocument();
    expect(within(open!).getByText("Saved. Not signed on Canton yet.")).toBeInTheDocument();
    expect(within(open!).getByRole("listitem", { name: "Final: waiting" })).toBeInTheDocument();
    expect(within(done!).getByText("1.5 TKA to Canton")).toBeInTheDocument();
    expect(within(done!).getByText("07 Nov 2026, 09:30:15 UTC")).toBeInTheDocument();
    expect(within(done!).getAllByRole("listitem").map((l) => l.getAttribute("aria-label"))).toEqual(["Sent: done", "Proven: done", "Final: done"]);
    expect(within(done!).getByRole("link", { name: "Ostia block 36512" })).toHaveAttribute("href", "/block/36512");
    expect(await within(done!).findByRole("link", { name: "Canton update" })).toHaveAttribute("href", "/canton/1220abcd");
    expect(within(open!).queryByRole("link")).toBeNull();
  });
  it("shows no other account's moves", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "theirs", account: ("0x" + "9".repeat(40)) as Hex, input: redeem, stage: "evm" }));
    show({ store });
    expect(screen.getByText(/No moves yet/)).toBeInTheDocument();
  });
  it("shows a kept move that needs the Canton account, and asks to open it instead of continuing", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ input: redeem, stage: "evm" }));
    const props = show({ store });
    await userEvent.click(screen.getByRole("button", { name: "Open my Canton account to continue" }));
    expect(props.onOpenAccount).toHaveBeenCalled();
  });

  it("is rebuilt on load from the kept records and what Canton says is open: the account service's list moves a move on", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "d1", input: deposit, stage: "canton" }));
    saveCheckpoint(store, ck({ ref: "s1", input: { kind: "lock", asset: TKA, amount: "2", receiver: PARTY }, stage: "start", at: NOW - 1000 }));
    // the record says it is only waiting for Canton; the service lists the deposit's request as open
    const open = { depositRequests: [{ contractId: "00", arguments: { depositId: depositIdOf(PARTY, "d1") } }], redeemRequests: [], twinAcceptance: null, withdrawalAcceptance: null };
    const { session } = fakeSession({ store, legs: () => [], open });
    show({ store, session });
    expect(await screen.findByText("Canton has it. Claim it on Ostia.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim on Ostia" })).toBeEnabled();
    expect(screen.getByText("Saved. Your wallet has not been asked yet.")).toBeInTheDocument();
    expect(session.open).toHaveBeenCalledTimes(1);
  });
  it("shows only what the record says when Canton's list does not have the request", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ input: redeem, stage: "canton" }));
    const { session } = fakeSession({ store, legs: () => [] });
    show({ store, session });
    expect(await screen.findByText("Signed on Canton. Waiting for Canton to show it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
  it("does not ask the account service when no move waits for Canton", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ input: redeem, stage: "evm" }));
    const { session } = fakeSession({ store, legs: () => [] });
    show({ store, session });
    await screen.findByRole("button", { name: "Release on Ostia" });
    expect(session.open).not.toHaveBeenCalled();
  });

  it("continues an unfinished move from its row: the release is asked of the wallet once, and the row becomes a finished one with its block", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "ref-1", input: redeem, to: ME, stage: "evm" }));
    const made = fakeSession({ store, legs: (ref) => [leg({ kind: "payment", legId: releaseIdOf(VAULT, ref) }, TKA)] });
    show({ store, session: made.session, read: async () => answer({ status: "final", success: true, block: { number: 42, hash: null, updateId: "1220ee" } }) });
    await userEvent.click(await screen.findByRole("button", { name: "Release on Ostia" }));
    expect(await screen.findByRole("link", { name: "Ostia block 42" })).toHaveAttribute("href", "/block/42");
    expect(made.evm.calls.map((c) => c.name)).toEqual(["release"]);
    expect(screen.queryByRole("button", { name: /Release on Ostia|Continue/ })).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getAllByRole("listitem").map((l) => l.getAttribute("aria-label"))).toEqual(["Sent: done", "Proven: done", "Final: done"]);
  });
  it("continues one move at a time: while one runs, no other row can be continued", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "a", input: redeem, to: ME, stage: "evm", at: NOW }));
    saveCheckpoint(store, ck({ ref: "b", input: { ...redeem, amount: "4" }, to: ME, stage: "evm", at: NOW - 1000 }));
    const made = fakeSession({ store, legs: () => [], evm: fakeEvm() });
    let release: (h: Hex) => void = () => {};
    vi.spyOn(made.evm.evm, "release").mockImplementation(() => new Promise<Hex>((r) => { release = r; }));
    show({ store, session: made.session });
    const buttons = () => screen.getAllByRole("button", { name: "Release on Ostia" });
    expect(buttons()).toHaveLength(2);
    await userEvent.click(buttons()[1]!);   // the older one
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Release on Ostia" }).every((b) => b.hasAttribute("disabled"))).toBe(true));
    expect(made.evm.evm.release).toHaveBeenCalledTimes(1);
    await act(async () => { release(TX); });
  });
  it("says a refusal in plain words and keeps the move", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ input: redeem, to: ME, stage: "evm" }));
    const made = fakeSession({ store, legs: () => [] });
    vi.spyOn(made.evm.evm, "release").mockRejectedValue(Object.assign(new Error("x"), { shortMessage: "User rejected the request.", code: 4001 }));
    show({ store, session: made.session });
    await userEvent.click(await screen.findByRole("button", { name: "Release on Ostia" }));
    expect(await screen.findByText("You declined it in your wallet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release on Ostia" })).toBeEnabled();
    expect(rows()).toHaveLength(1);
  });
  it("says what stopped a move in plain words even when nothing of it is kept", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ input: { kind: "lock", asset: TKA, amount: "1", receiver: PARTY }, stage: "start" }));
    const made = fakeSession({ store, legs: () => [] });
    vi.spyOn(made.evm.evm, "approve").mockRejectedValue(Object.assign(new Error("x"), { shortMessage: "User rejected the request.", code: 4001 }));
    show({ store, session: made.session });
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined it in your wallet.");
    expect(screen.getByRole("alert").textContent).not.toMatch(/rejected|0x|Error/);
  });
});
