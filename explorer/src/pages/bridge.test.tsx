// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addr, fakeApi, renderApp, reply, route, status } from "../test-utils.tsx";

const mocks = vi.hoisted(() => ({ openAccount: vi.fn(), getTestCoin: vi.fn(), gas: 5n * 10n ** 18n }));
const closed = vi.fn();
const opened = () => ({ party: PARTY, close: closed });
vi.mock("../bridge/account.ts", () => mocks);
// The chain's tokens and the move's machinery are the card's own tests (bridge-card.test.tsx): here they are fixed answers.
vi.mock("../bridge/evm/config.ts", () => ({
  loadBridgeConfig: async () => ({
    chain: { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } }, gateway: "0x" + "22".repeat(20), vault: "0x" + "33".repeat(20), vaults: ["0x" + "33".repeat(20)], registryUrl: "https://registry.example", wrapper: null,
    twins: [{ address: "0x" + "aa".repeat(20), symbol: "TKA", decimals: 18 }], wrapped: [],
  }),
}));
vi.mock("../bridge/evm/ostia.ts", () => ({ ostiaAdapter: () => ({ account: "0xe3", native: async () => mocks.gas, balanceOf: async () => 20n * 10n ** 18n }) }));
vi.mock("../bridge/session.ts", () => ({
  createSession: () => ({ party: "bridge", evm: {}, move: { state: { phase: "idle" }, subscribe: () => () => {}, resume: async () => ({ phase: "idle" }), start: async () => ({ phase: "idle" }) }, cantonBalance: async () => 0n, kept: () => [], open: async () => ({ depositRequests: [], redeemRequests: [], twinAcceptance: null, withdrawalAcceptance: null }), close: () => {} }),
}));

const PARTY = "bridge::1220" + "ab".repeat(32), DSO = "DSO::1220" + "cd".repeat(32), ME = addr(0xe3), ORIGIN = location.origin;   // the page signs only on the address it is set up for: the test page's own
const env = { VITE_CHAIN_OPERATOR: "operator::1220" + "01".repeat(32), VITE_CHAIN_CONFIRMER: "confirmer::1220" + "02".repeat(32), VITE_CHAIN_GATEWAY: "gateway::1220" + "03".repeat(32), VITE_CHAIN_BUILDER: "builder::1220" + "04".repeat(32), VITE_CHAIN_ID: "770101", VITE_CANTON_PARTICIPANT: "PAR::p::1220" + "05".repeat(32), VITE_SITE_ORIGIN: ORIGIN };
const faucet = { on: true, address: addr(0xfa), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 21 };
const twins = { through: 3, registryService: null, vaults: [], twins: [], legs: [], canton: [{ token: addr(0xcc), symbol: "wCC", instrumentAdmin: DSO, instrumentId: "Amulet" }] };

const handlers: Record<string, (v: unknown) => void> = {};
function wallet() {
  const w = { on: vi.fn((event: string, fn: (v: unknown) => void) => { handlers[event] = fn; }), removeListener: vi.fn(), request: vi.fn(async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? [ME] : method === "eth_chainId" ? "0x" + status().chainId.toString(16) : null)) };
  Object.defineProperty(window, "ethereum", { value: w, configurable: true, writable: true });
}
afterEach(() => { mocks.gas = 5n * 10n ** 18n; vi.unstubAllEnvs(); vi.clearAllMocks(); Reflect.deleteProperty(window, "ethereum"); });
const setUp = () => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); wallet(); fakeApi(route({ faucet: () => reply(faucet), twins: () => reply(twins) })); };
/** The faucet takes a request (the fake answers every POST to it with a place in the line) and keeps count of them. */
const faucetAccepts = () => {
  const base = globalThis.fetch;
  const asked = { n: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/api/faucet" && init?.method === "POST") { asked.n++; return new Response(JSON.stringify({ ticket: "t1", position: 1, to: ME, amount: faucet.amount }), { status: 202, headers: { "content-type": "application/json" } }); }
    return base(input as never);
  }));
  return asked;
};
const openSheet = async () => userEvent.click(await screen.findByRole("button", { name: "Open my Canton account" }));
const signIn = async () => {
  renderApp("/bridge");
  await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
  await openSheet();
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with MetaMask" }));
};

describe("the Bridge page", () => {
  it("is in the header, and says the bridge is not set up when the build has no settings", async () => {
    fakeApi(route({}));
    renderApp("/bridge");
    expect(await screen.findByText("The bridge is not set up on this site yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bridge" })).toHaveClass("active");
  });

  it("has a Move tab and an Activity tab: Activity lists the account's moves, and the card is still there when the tab changes back", async () => {
    setUp();
    renderApp("/bridge");
    expect(await screen.findByRole("tab", { name: "Move" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByRole("region", { name: "Activity" })).toHaveTextContent("Connect MetaMask to see your moves.");
    expect(screen.queryByRole("region", { name: "Move tokens" })).toBeNull();   // the card is hidden, not gone
    await userEvent.click(screen.getByRole("tab", { name: "Move" }));
    expect(screen.getByRole("region", { name: "Move tokens" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();
  });

  it("asks to connect, shows the site's origin beside the sign-in, and then shows the account as Ready with a short id", async () => {
    setUp();
    mocks.openAccount.mockResolvedValue(opened());
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    await openSheet();
    expect(await screen.findByText(ORIGIN)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with MetaMask" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(mocks.openAccount).toHaveBeenCalledWith(expect.anything(), ME, expect.objectContaining({ origin: ORIGIN, participant: env.VITE_CANTON_PARTICIPANT }), expect.any(Function), undefined, expect.any(Function));
    expect(screen.getByTitle(PARTY)).toHaveTextContent("bridge::1220abab…ababab");
    expect(screen.getByRole("button", { name: "Copy account id" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Get 1 tROME" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your Canton account" }).textContent).not.toMatch(/party|allocation|vault|external/i);   // no technical names on the screen
  });

  it("gets test Canton Coin from the Canton Coin registry the explorer lists, and hides the button when this site has no faucet for it", async () => {
    setUp();
    mocks.openAccount.mockResolvedValue(opened());
    mocks.getTestCoin.mockResolvedValueOnce("done").mockResolvedValueOnce("off");
    await signIn();
    await userEvent.click(await screen.findByRole("button", { name: "Get test Canton Coin" }));
    expect(await screen.findByText("Test Canton Coin is in your account.")).toBeInTheDocument();
    expect(mocks.getTestCoin).toHaveBeenCalledWith(expect.objectContaining({ party: PARTY }), DSO);
    await userEvent.click(screen.getByRole("button", { name: "Get test Canton Coin" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Get test Canton Coin" })).toBeNull());
  });

  it("says in words when the person declines the signature, and lets them try again", async () => {
    setUp();
    mocks.openAccount.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: 4001 })).mockResolvedValue({ party: PARTY });
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined it in your wallet.");
    await userEvent.click(screen.getByRole("button", { name: "Sign in with MetaMask" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
  });

  it("says in plain words when the browser has no wallet, without naming a standard", async () => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    fakeApi(route({ faucet: () => reply(faucet), twins: () => reply(twins) }));
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No wallet was found in this browser. Install MetaMask, then open this page again.");
    expect(alert.textContent).not.toMatch(/EIP|ERC/);
  });

  it("shows the page's own origin beside the sign-in", async () => {
    setUp();
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    await openSheet();
    expect(await screen.findByText(location.origin)).toBeInTheDocument();
  });

  it("refuses to sign when the page is not on the address it is set up for, and says so in plain words", async () => {
    setUp();
    vi.stubEnv("VITE_SITE_ORIGIN", "https://ostia.example");   // the page is at the test page's address, not this one
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`This page is open at ${location.origin}, but this bridge is set up for https://ostia.example. Signing is turned off here.`);
    expect(screen.getByRole("button", { name: "Sign in with MetaMask" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with MetaMask" }));
    expect(mocks.openAccount).not.toHaveBeenCalled();
  });

  it("says each failure in plain words: a known case in its own sentence, anything else in one general sentence", async () => {
    setUp();
    mocks.openAccount
      .mockRejectedValueOnce(Object.assign(new Error("account says no"), { name: "AccountsError", kind: "conflict", status: 409, code: "waiting_for_signature" }))
      .mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'x') at accounts.ts:41"))
      .mockResolvedValue(opened());
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent("A step for your account from a moment ago is still open. Try again in 10 minutes.");
    await userEvent.click(screen.getByRole("button", { name: "Sign in with MetaMask" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Nothing was lost. Try again in a moment."));
    expect(screen.getByRole("alert").textContent).not.toMatch(/TypeError|Cannot read|accounts\.ts|waiting_for_signature/);
  });

  it("takes test tROME first when the wallet holds none: the card offers the faucet before the account, and the walk goes on once the wallet holds some", async () => {
    setUp();
    mocks.gas = 0n;
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    expect(await screen.findByRole("button", { name: "Get test tROME" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open my Canton account" })).toBeNull();
    mocks.gas = 3n * 10n ** 18n;
    await userEvent.click(screen.getByRole("button", { name: "Get test tROME" }));   // the faucet asks again for the balance
    await openSheet();
    expect(await screen.findByRole("button", { name: "Sign in with MetaMask" })).toBeInTheDocument();
    expect(screen.queryByText(/Get test tROME first/)).toBeNull();
  });

  it("with no tROME the account sheet says to get it first, and asks the faucet in place of the sign-in", async () => {
    setUp();
    vi.stubEnv("VITE_SITE_ORIGIN", "https://ostia.example");   // a page at another address shows the sheet at once, with no press on the card
    mocks.gas = 0n;
    const asked = faucetAccepts();
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    const sheet = await screen.findByRole("region", { name: "Your Canton account" });
    expect(await within(sheet).findByText("Get test tROME first. Every move on Ostia needs a little for fees.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Sign in with MetaMask" })).toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: "Get test tROME" }));
    expect(await screen.findByText("1 tROME is on its way to your wallet.")).toBeInTheDocument();
    expect(asked.n).toBe(1);
    expect(mocks.openAccount).not.toHaveBeenCalled();
  });

  it("tells the person to get test tROME when the wallet will not let the page sign (4100, 4900, 4901), and keeps the sentence for another refusal", async () => {
    setUp();
    mocks.openAccount
      .mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { code: 4100 }))
      .mockRejectedValueOnce(Object.assign(new Error("Disconnected"), { code: 4900 }))
      .mockRejectedValueOnce(Object.assign(new Error("Chain disconnected"), { code: 4901 }))
      .mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }))
      .mockResolvedValue(opened());
    await signIn();
    const said = "Your wallet did not let this page sign. Get test tROME first and make sure MetaMask is on the Ostia network, then sign in again.";
    for (let i = 0; i < 3; i++) {
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(said));
      expect(mocks.openAccount).toHaveBeenCalledTimes(i + 1);
      await userEvent.click(screen.getByRole("button", { name: "Sign in with MetaMask" }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined it in your wallet.");
  });

  it("shows a failure of the test coin in plain words too", async () => {
    setUp();
    mocks.openAccount.mockResolvedValue(opened());
    mocks.getTestCoin.mockRejectedValue(Object.assign(new Error("raw"), { name: "AccountsError", kind: "unavailable", status: 503 }));
    await signIn();
    await userEvent.click(await screen.findByRole("button", { name: "Get test Canton Coin" }));
    expect(await screen.findByText("The bridge is busy or restarting. Try again in a moment.")).toBeInTheDocument();
  });

  it("lets the old account go when the wallet switches account, and shows nothing of it", async () => {
    setUp();
    mocks.openAccount.mockResolvedValue(opened());
    await signIn();
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    act(() => handlers.accountsChanged!([addr(0xe4)]));
    await waitFor(() => expect(screen.queryByText("Ready")).toBeNull());
    expect(closed).toHaveBeenCalledTimes(1);   // its key is dropped and nothing more is done for it
    await openSheet();   // another wallet account is another Canton account: its sheet starts closed
    expect(screen.getByRole("button", { name: "Sign in with MetaMask" })).toBeEnabled();
  });

  it("does not show Copied for another account after the wallet switches", async () => {
    setUp();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
    mocks.openAccount.mockResolvedValue(opened());
    await signIn();
    await userEvent.click(await screen.findByRole("button", { name: "Copy account id" }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    act(() => handlers.accountsChanged!([addr(0xe4)]));
    await waitFor(() => expect(screen.queryByText("Ready")).toBeNull());
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with MetaMask" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy account id" })).toHaveTextContent("Copy");
  });

  it("ignores an account that finishes opening after the wallet has switched to another", async () => {
    setUp();
    let finish!: (account: unknown) => void;
    mocks.openAccount.mockImplementation(() => new Promise((done) => { finish = done; }));
    await signIn();
    await waitFor(() => expect(mocks.openAccount).toHaveBeenCalled());
    act(() => handlers.accountsChanged!([addr(0xe4)]));
    await act(async () => { finish(opened()); });
    expect(screen.queryByText("Ready")).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
