// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Unanswered } from "../bridge/canton/accounts.ts";
import { AccountsError } from "../bridge/canton/accounts.ts";
import { PageError } from "../bridge/words.ts";
import { CHAIN, fakeWallet } from "../bridge/wallet/fake-wallet.ts";
import { linkWallet } from "../bridge/wallet/link.ts";
import { rememberWallet } from "../bridge/wallet/wallets.ts";
import { optInWords, useCantonWallet } from "./useCantonWallet.ts";

/** The hook that holds a connected Canton wallet, with the connection (the SDK) replaced by fakes: what is tested here is which connection the page keeps when several end at different times. */
const mocks = vi.hoisted(() => ({ choices: vi.fn(), connectWallet: vi.fn(), restoreWallet: vi.fn() }));
vi.mock("../bridge/wallet/connect.ts", () => ({ choices: mocks.choices, connectWallet: mocks.connectWallet, restoreWallet: mocks.restoreWallet }));

const LOOP = { wallets: ["loop" as const], gatewayUrl: null };
const disconnects = (w: ReturnType<typeof fakeWallet>) => w.requests.filter((r) => r.method === "disconnect").length;
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
afterEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe("a connection that ends late", () => {
  it("does not end a newer connection: the late approval of an earlier try only lets go of its own listeners", async () => {
    const older = fakeWallet(), newer = fakeWallet();
    const late = deferred<Awaited<ReturnType<typeof linkWallet>>>();
    mocks.choices.mockResolvedValue([{ id: "loop", name: "Loop" }]);
    mocks.connectWallet.mockReturnValueOnce(late.promise);
    mocks.connectWallet.mockImplementationOnce(async () => linkWallet(newer.provider, { name: "Loop" }));
    const { result } = renderHook(() => useCantonWallet(LOOP, CHAIN, "DevNet"));
    await act(async () => { await result.current.connect(); });            // the first try waits for the person's approval
    expect(result.current.state.s).toBe("working");
    act(() => result.current.reset());                                        // the person turns to another way, then connects again
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.state.s).toBe("ready"));
    const link = result.current.link;
    await act(async () => { late.resolve(await linkWallet(older.provider, { name: "Loop" })); await new Promise((r) => setTimeout(r, 20)); });   // the earlier approval comes late
    expect(result.current.state.s).toBe("ready");
    expect(result.current.link).toBe(link);
    expect(disconnects(older)).toBe(0);
    expect(disconnects(newer)).toBe(0);
    expect(link!.closed).toBe(false);
  });

  it("keeps the wallet when the page opens it twice (React's StrictMode runs the restore twice)", async () => {
    const w = fakeWallet();
    rememberWallet();
    mocks.restoreWallet.mockImplementation(async () => linkWallet(w.provider, { name: "Loop" }));
    const { result } = renderHook(() => useCantonWallet(LOOP, CHAIN, "DevNet"), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.state.s).toBe("ready"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mocks.restoreWallet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.state.s).toBe("ready");
    expect(result.current.link!.closed).toBe(false);
    expect(disconnects(w)).toBe(0);
  });
});

describe("Loop and the network", () => {
  it("does not look for wallets until the chain has said which network it is on, when Loop is listed", async () => {
    mocks.choices.mockResolvedValue([{ id: "loop", name: "Loop" }]);
    const { result, rerender } = renderHook(({ network }: { network: string | null }) => useCantonWallet(LOOP, CHAIN, network), { initialProps: { network: null as string | null } });
    await act(async () => { await result.current.connect(); });
    expect(result.current.state).toMatchObject({ s: "failed", message: "Ostia has not answered yet. Try again in a moment." });
    expect(mocks.choices).not.toHaveBeenCalled();
    expect(mocks.connectWallet).not.toHaveBeenCalled();
    rerender({ network: "DevNet" });
    mocks.connectWallet.mockImplementation(async () => linkWallet(fakeWallet().provider, { name: "Loop" }));
    await act(async () => { await result.current.connect(); });
    await waitFor(() => expect(result.current.state.s).toBe("ready"));
    expect(mocks.choices).toHaveBeenCalledWith(expect.objectContaining({ networkName: "DevNet" }));
  });
  it("does not open a remembered wallet before the network is known", async () => {
    rememberWallet();
    mocks.restoreWallet.mockImplementation(async () => linkWallet(fakeWallet().provider, { name: "Loop" }));
    const { result, rerender } = renderHook(({ network }: { network: string | null }) => useCantonWallet(LOOP, CHAIN, network), { initialProps: { network: null as string | null } });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mocks.restoreWallet).not.toHaveBeenCalled();
    rerender({ network: "DevNet" });
    await waitFor(() => expect(result.current.state.s).toBe("ready"));
    expect(mocks.restoreWallet).toHaveBeenCalledWith(expect.objectContaining({ networkName: "DevNet" }));
  });
  it("lets a build without Loop connect before the network is known", async () => {
    mocks.choices.mockResolvedValue([]);
    const { result } = renderHook(() => useCantonWallet({ wallets: ["extension"], gatewayUrl: null }, CHAIN, null));
    await act(async () => { await result.current.connect(); });
    expect(mocks.choices).toHaveBeenCalled();
  });
});

describe("the opt-in's words", () => {
  it("has its own sentence for the wallet when the acceptances do not show yet, with no word of the Bridge account's sign-in", () => {
    const words = optInWords(new PageError("acceptances_missing", "raw"), "Loop");
    expect(words).toBe("Your wallet's opt-in does not show yet. Press Opt in again in a moment.");
    expect(words).not.toMatch(/signing in/i);
  });
  it("does not promise that nothing is asked twice, and names the wallet", () => {
    const words = optInWords(new Unanswered(new AccountsError("unavailable", 0, "x"), Date.now()), "Loop");
    expect(words).toBe("Loop did not say whether it took this. Check again in a minute.");
    expect(optInWords(new Unanswered(new AccountsError("unavailable", 0, "x"), Date.now()), "Canton wallet")).toMatch(/^Your Canton wallet did not say/);
  });
});
