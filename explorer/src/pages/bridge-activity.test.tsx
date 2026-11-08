// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { ApiTx } from "../api.ts";
import { entryOf, finished, remember } from "../bridge/activity.ts";
import { pairsOf } from "../bridge/tokens.ts";
import { depositIdOf, releaseIdOf, saveCheckpoint, type Checkpoint, type MoveState } from "../bridge/moves/state.ts";
import type { Session } from "../bridge/session.ts";
import { Activity, type ActivityProps } from "./Activity.tsx";
import { CC_ADMIN, config, FIELD, fakeEvm, finalTx, fakeSession, GATEWAY_PARTY, leg, ME, memoryStore, PARTY, TKA, VAULT, WCC, WTROME } from "./bridge-fakes.ts";
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
    const move = { state: { phase: "idle" } as MoveState, current: record.ref, subscribe: (f: (s: MoveState) => void) => { subs.add(f); return () => void subs.delete(f); } };
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
  it("shows the marks while the move waits for its block, and goes away when the move is final, paused or failed", async () => {
    const { session, set } = driven(ck({ input: redeem, stage: "sent", tx: TX }));
    render(<MemoryRouter><MoveBar session={session} pairs={pairs} chainName="Ostia" read={async () => answer({ status: "proving", block: IN_BLOCK, lifecycle: lifecycle("2026-11-07T10:00:07Z") })} pollMs={10} /></MemoryRouter>);
    await set({ phase: "proving", tx: TX });
    expect(await screen.findByRole("region", { name: "Move on its way" })).toHaveTextContent("3 TKA to Ostia");
    await waitFor(() => expect(marks()).toEqual(["Sent: done", "Proven: done", "Final: waiting"]));
    await set({ phase: "final", tx: TX, block: 42 });
    expect(screen.queryByRole("region", { name: "Move on its way" })).toBeNull();   // the card says it is final
    await set({ phase: "proving", tx: TX });
    expect(await screen.findByRole("region", { name: "Move on its way" })).toBeInTheDocument();
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
  it("does not read an approval as the move: a lock waiting on its approval shows no block and no Final", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "lock-1", input: { kind: "lock", asset: TKA, amount: "2", receiver: PARTY }, stage: "wallet", step: "approve", tx: TX }));
    const read = vi.fn(async () => answer({ status: "final", success: true, block: { ...IN_BLOCK, updateId: "1220abcd" } }));
    show({ store, read });
    const [row] = rows();
    expect(within(row!).getAllByRole("listitem").map((l) => l.getAttribute("aria-label"))).toEqual(["Sent: waiting", "Proven: waiting", "Final: waiting"]);
    expect(within(row!).queryByRole("link")).toBeNull();
    expect(within(row!).getByText("Your wallet was asked. Check it, then continue.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 40));
    expect(read).not.toHaveBeenCalled();
  });
  it("looks at a finished move once for its Canton update, and not again once it is written down", async () => {
    const store = memoryStore();
    remember(store, { ...entryOf(ck({ ref: "done-1", input: redeem, stage: "sent" })), tx: TX, block: 7 });
    const read = vi.fn(async () => answer({ status: "final", success: true, block: { number: 7, hash: null, updateId: "1220abcd" } }));
    show({ store, read });
    expect(await screen.findByRole("link", { name: "Canton update" })).toHaveAttribute("href", "/canton/1220abcd");
    cleanup();
    read.mockClear();
    show({ store, read });   // the tab opens again
    expect(screen.getByRole("link", { name: "Canton update" })).toHaveAttribute("href", "/canton/1220abcd");
    await new Promise((r) => setTimeout(r, 40));
    expect(read).not.toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: "Continue to Ostia" })).toBeEnabled();
  });
  it("asks the account service once when the list is shown, not on a timer", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ input: redeem, stage: "evm" }));
    const { session } = fakeSession({ store, legs: () => [] });
    show({ store, session });
    await screen.findByRole("button", { name: "Release on Ostia" });
    await new Promise((r) => setTimeout(r, 40));
    expect(session.open).toHaveBeenCalledTimes(1);
  });

  describe("a move that Canton has open and this browser has no record of (started on another device)", () => {
    const bare = (a: string) => a.slice(2);
    const request = (o: Record<string, unknown> = {}) => ({ contractId: "00aa", arguments: { holder: PARTY, [FIELD]: bare(TKA), amount: "3.0000000000", recipient: bare(ME), ref: "other-1", ...o } });
    const openWith = (redeems: unknown[], deposits: unknown[] = []) => ({ redeemRequests: redeems, depositRequests: deposits, twinAcceptance: null, withdrawalAcceptance: null }) as never;
    it("is listed with what it moves, says another browser started it, and carries on from its row: one release, asked of the wallet once", async () => {
      const store = memoryStore();
      const made = fakeSession({ store, legs: () => [], open: openWith([request()]), tx: () => finalTx([leg({ kind: "payment", legId: releaseIdOf(VAULT, "other-1") }, TKA)]) });
      show({ store, session: made.session });
      const row = (await screen.findByText("3 TKA to Ostia")).closest("li")!;
      expect(within(row).getByText("Started in another browser. Canton has it. Release it on Ostia.")).toBeInTheDocument();
      expect(within(row).queryByText(/UTC/)).toBeNull();   // its time is not known
      await userEvent.click(within(row).getByRole("button", { name: "Release on Ostia" }));
      await waitFor(() => expect(made.evm.calls.map((c) => c.name)).toEqual(["release"]));
      expect(made.evm.calls[0]!.args).toContain(ME);   // released to the recipient the request names
      await waitFor(() => expect(finished(store).map((e) => [e.ref, e.amount])).toEqual([["other-1", "3"]]));
      expect(await screen.findAllByRole("listitem").then((l) => l.filter((x) => x.classList.contains("act-row")))).toHaveLength(1);   // the record kept now is the row; the other-device row is gone
    });
    it("is not listed twice when this browser keeps its record, or has written it down as done", async () => {
      const store = memoryStore();
      saveCheckpoint(store, ck({ ref: "other-1", input: { ...redeem, amount: "3" }, to: ME, stage: "canton" }));
      remember(store, { ...entryOf(ck({ ref: "done-2", input: redeem, stage: "sent" })), tx: TX, block: 7 });
      const { session } = fakeSession({ store, legs: () => [], open: openWith([request(), request({ ref: "done-2" })]) });
      show({ store, session });
      await waitFor(() => expect(session.open).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(rows()).toHaveLength(2);
      expect(screen.queryByText(/another browser/)).toBeNull();
    });
    it("is a plain row without a button where this build does not move the token", async () => {
      const store = memoryStore();
      const { session } = fakeSession({ store, legs: () => [], open: openWith([request({ [FIELD]: "ee".repeat(20) })]) });
      show({ store, session });
      expect(await screen.findByText(/Started in another browser\. Canton has it/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Release|Continue/ })).toBeNull();
    });
    it("names the chain's own coin that comes back as its wrapped form", async () => {
      const store = memoryStore();
      const { session } = fakeSession({ store, legs: () => [], open: openWith([request({ [FIELD]: bare(WTROME) })]) });
      show({ store, session });
      expect(await screen.findByText("3 WtROME to Ostia")).toBeInTheDocument();
    });
    it("lists an open deposit with no amount, and claims it when its allocation is there", async () => {
      const store = memoryStore();
      const id = depositIdOf(PARTY, "dep-1").slice(2);
      const deposits = [{ contractId: "00bb", arguments: { depositor: PARTY, depositId: id, label: "dep-1", recipient: bare(ME) } }];
      const allocations = [{ contractId: "00cc", allocation: { settlement: { settlementRef: { id: "dep-1" } }, transferLegId: "l", transferLeg: { sender: PARTY, receiver: "g", amount: "5.0000000000", instrumentId: { admin: CC_ADMIN, id: "Amulet" } } }, holdingCids: [] }];
      const made = fakeSession({ store, legs: () => [], open: openWith([], deposits), allocations, tx: () => finalTx([leg({ kind: "deposit", legId: depositIdOf(PARTY, "dep-1") }, WCC)]) });
      show({ store, session: made.session });
      const row = (await screen.findByText("Tokens to Ostia")).closest("li")!;
      expect(within(row).getByText("Started in another browser. Canton has it. Claim it on Ostia.")).toBeInTheDocument();
      await userEvent.click(within(row).getByRole("button", { name: "Claim on Ostia" }));
      await waitFor(() => expect(made.evm.calls.map((c) => c.name)).toEqual(["claim"]));
      await waitFor(() => expect(finished(store).map((e) => [e.ref, e.amount])).toEqual([["dep-1", "5"]]));
    });
    it("says in plain words that a deposit cannot be finished here when its allocation is gone, and sends nothing", async () => {
      const store = memoryStore();
      const deposits = [{ contractId: "00bb", arguments: { depositor: PARTY, depositId: depositIdOf(PARTY, "dep-1").slice(2), label: "dep-1" } }];
      const made = fakeSession({ store, legs: () => [], open: openWith([], deposits) });
      show({ store, session: made.session });
      await userEvent.click(await screen.findByRole("button", { name: "Claim on Ostia" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This move cannot be finished here. Open the bridge in the browser that started it.");
      expect(made.evm.calls).toEqual([]);
      expect(made.session.kept()).toEqual([]);
    });
    it("is not shown for another account's request", async () => {
      const store = memoryStore();
      const { session } = fakeSession({ store, legs: () => [], open: openWith([request({ holder: "bob::1220" + "cd".repeat(32) })]) });
      show({ store, session });
      await waitFor(() => expect(session.open).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByText(/No moves yet/)).toBeInTheDocument();
    });
  });

  describe("looking at a transaction", () => {
    it("is one look for a transaction that the bar and a row of the list both show", async () => {
      const read = vi.fn(async () => answer({ status: "proving", block: IN_BLOCK, lifecycle: lifecycle(null) }));
      const hash = ("0x" + "cd".repeat(32)) as Hex;
      const store = memoryStore();
      saveCheckpoint(store, ck({ ref: "r9", input: redeem, to: ME, stage: "sent", tx: hash }));
      const session = { move: { state: { phase: "proving", tx: hash }, current: "r9", subscribe: () => () => {} }, kept: () => [ck({ ref: "r9", input: redeem, to: ME, stage: "sent", tx: hash })], open: async () => ({ redeemRequests: [], depositRequests: [], twinAcceptance: null, withdrawalAcceptance: null }), party: PARTY } as unknown as Session;
      render(<MemoryRouter><MoveBar session={session} pairs={pairs} chainName="Ostia" read={read} pollMs={20} /><Activity account={ME} session={session} store={store} pairs={pairs} chainName="Ostia" onConnect={vi.fn()} onOpenAccount={vi.fn()} read={read} pollMs={20} /></MemoryRouter>);
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(2));
      const hashes = read.mock.calls.map((c) => (c as unknown[])[0]);
      expect(new Set(hashes).size).toBe(1);
      // with two watchers on a 20 ms timer, 150 ms is about 8 looks of one poll, not 16
      const before = read.mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(read.mock.calls.length - before).toBeLessThanOrEqual(7);
    });
    it("stops looking at a transaction reported replaced, and says so in a plain sentence", async () => {
      const read = vi.fn(async () => answer({ status: "replaced" }));
      const store = memoryStore();
      remember(store, { ...entryOf(ck({ ref: "gone-1", input: redeem, stage: "sent" })), done: false, tx: ("0x" + "ef".repeat(32)) as Hex, block: null });
      saveCheckpoint(store, ck({ ref: "gone-2", input: redeem, to: ME, stage: "sent", tx: ("0x" + "ef".repeat(32)) as Hex, at: NOW + 1 }));
      show({ store, read });
      expect(await screen.findByText("This transaction was replaced, so it will not go through. Check your wallet.")).toBeInTheDocument();
      const calls = read.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(read.mock.calls.length).toBe(calls);
    });
    it("says a dropped transaction was dropped", async () => {
      const read = vi.fn(async () => answer({ status: "dropped" }));
      const store = memoryStore();
      saveCheckpoint(store, ck({ ref: "gone-3", input: redeem, to: ME, stage: "sent", tx: ("0x" + "ab".repeat(32)) as Hex }));
      show({ store, read });
      expect(await screen.findByText(/was dropped before it reached a block/)).toBeInTheDocument();
    });
    it("counts a block that is final on Canton but not yet indexed as Final", async () => {
      const read = vi.fn(async () => answer({ status: "unindexed", success: true, block: { number: 9, hash: null, updateId: "1220aa" } }));
      const store = memoryStore();
      saveCheckpoint(store, ck({ ref: "u-1", input: redeem, to: ME, stage: "sent", tx: ("0x" + "ab".repeat(32)) as Hex }));
      show({ store, read });
      expect(await screen.findByRole("listitem", { name: "Final: done" })).toBeInTheDocument();
      // an unindexed answer is not the last word: it is looked at again until the explorer indexes it
      const calls = read.mock.calls.length;
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(calls));
    });
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
  it("puts the wallet on Ostia before a row's move goes on, and sends nothing when it cannot", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "ref-1", input: redeem, to: ME, stage: "evm" }));
    const made = fakeSession({ store, legs: () => [] });
    const ensureChain = vi.fn(async () => "Your wallet is not on Ostia yet.");
    show({ store, session: made.session, ensureChain });
    await userEvent.click(await screen.findByRole("button", { name: "Release on Ostia" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your wallet is not on Ostia yet.");
    expect(made.evm.calls).toEqual([]);
  });
  it("says why connecting did not work, under its button", () => {
    show({ account: null, connectNote: "No wallet was found in this browser. Install MetaMask, then open this page again." });
    expect(screen.getByRole("alert")).toHaveTextContent("Install MetaMask");
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
  it("writes down the move that was continued, when two are kept and the older one is continued", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "X", input: redeem, to: ME, stage: "evm", at: NOW - 1000 }));
    saveCheckpoint(store, ck({ ref: "Y", input: { ...redeem, amount: "9" }, to: ME, stage: "evm", at: NOW }));
    const made = fakeSession({ store, legs: () => [], tx: () => finalTx([leg({ kind: "payment", legId: releaseIdOf(VAULT, "X") }, TKA)]) });
    expect(made.session.kept().map((c) => c.ref)).toEqual(["Y", "X"]);
    await made.move.resume("X");
    expect(made.move.current).toBe("X");
    await made.move.proceed();
    expect(made.move.state.phase).toBe("final");
    expect(finished(store).map((e) => [e.ref, e.amount, e.done, e.block])).toEqual([["X", "3", true, 42]]);
    expect(made.session.kept().map((c) => c.ref)).toEqual(["Y"]);   // the other move is still kept, and not written down as done
  });
  it("keeps writing a move down when its session is closed while it runs, and stops after", async () => {
    const store = memoryStore();
    saveCheckpoint(store, ck({ ref: "X", input: redeem, to: ME, stage: "evm" }));
    const made = fakeSession({ store, legs: () => [], tx: () => finalTx([leg({ kind: "payment", legId: releaseIdOf(VAULT, "X") }, TKA)]) });
    await made.move.resume("X");
    // the wallet's account changes while the move is running
    const off = made.move.subscribe((st) => { if (st.phase === "sending-evm") { off(); made.session.close(); } });
    await made.move.proceed();
    expect(finished(store).map((e) => [e.ref, e.block])).toEqual([["X", 42]]);
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
    await userEvent.click(await screen.findByRole("button", { name: "Continue to Canton" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined it in your wallet.");
    expect(screen.getByRole("alert").textContent).not.toMatch(/rejected|0x|Error/);
  });
});
