// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN, fakeWallet, WALLET_PARTY } from "../bridge/wallet/fake-wallet.ts";
import { linkWallet } from "../bridge/wallet/link.ts";
import { rememberWallet, wasConnected } from "../bridge/wallet/wallets.ts";
import { addr, fakeApi, renderApp, reply, route, status } from "../test-utils.tsx";

/**
 * The Bridge page with Canton wallets offered (VITE_CANTON_WALLETS) and with none. The wallet's connection (the SDK) is the fake wallet's: its own tests are in src/bridge/wallet. Everything of the page is
 * real: the sheet, the opt-in, the account panel, the card's words.
 */
const mocks = vi.hoisted(() => ({ choices: vi.fn(), connectWallet: vi.fn(), restoreWallet: vi.fn(), createSession: vi.fn(), openAccount: vi.fn(), reopenAccount: vi.fn(), closeAccount: vi.fn(), getTestCoin: vi.fn() }));
vi.mock("../bridge/wallet/connect.ts", () => ({ choices: mocks.choices, connectWallet: mocks.connectWallet, restoreWallet: mocks.restoreWallet }));
vi.mock("../bridge/account.ts", () => ({ openAccount: mocks.openAccount, reopenAccount: mocks.reopenAccount, closeAccount: mocks.closeAccount, getTestCoin: mocks.getTestCoin }));
vi.mock("../bridge/canton/keystore.ts", () => ({ browserKeyStore: () => ({ load: async () => null, save: async () => true, remove: async () => {} }) }));
vi.mock("../bridge/evm/config.ts", () => ({
  loadBridgeConfig: async () => ({
    chain: { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } }, gateway: "0x" + "22".repeat(20), vault: "0x" + "33".repeat(20), vaults: ["0x" + "33".repeat(20)], registryUrl: "https://registry.example", wrapper: null,
    twins: [{ address: "0x" + "aa".repeat(20), symbol: "TKA", decimals: 18 }],
    wrapped: [{ address: "0x" + "bb".repeat(20), symbol: "wCC", decimals: 10, instrument: { admin: "DSO::1220" + "cd".repeat(32), id: "Amulet" } }],
  }),
}));
vi.mock("../bridge/evm/ostia.ts", () => ({ ostiaAdapter: () => ({ account: "0xe3", native: async () => 5n * 10n ** 18n, balanceOf: async () => 20n * 10n ** 18n }) }));
vi.mock("../bridge/session.ts", () => ({
  createSession: (o: unknown) => {
    mocks.createSession(o);
    return { party: (o as { account: { party: string } }).account.party, evm: {}, move: { state: { phase: "idle" }, subscribe: () => () => {}, resume: async () => ({ phase: "idle" }), start: async () => ({ phase: "idle" }) }, cantonBalances: async (ins: unknown[]) => ins.map(() => 0n), kept: () => [], open: async () => ({ depositRequests: [], redeemRequests: [], twinAcceptance: null, withdrawalAcceptance: null }), close: () => {} };
  },
}));

const DSO = "DSO::1220" + "cd".repeat(32), ME = addr(0xe3), ORIGIN = location.origin;
const env = { VITE_CHAIN_OPERATOR: CHAIN.operator, VITE_CHAIN_CONFIRMER: CHAIN.confirmer, VITE_CHAIN_GATEWAY: CHAIN.gateway, VITE_CHAIN_BUILDER: CHAIN.builder, VITE_CHAIN_ID: "770101", VITE_CANTON_PARTICIPANT: "PAR::p::1220" + "05".repeat(32), VITE_SITE_ORIGIN: ORIGIN };
const faucet = { on: true, address: addr(0xfa), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 21 };
const twins = { through: 3, registryService: null, vaults: [], twins: [], legs: [], canton: [{ token: addr(0xcc), symbol: "wCC", instrumentAdmin: DSO, instrumentId: "Amulet" }] };

let wallet: ReturnType<typeof fakeWallet>;
const connectsTo = (name = "Loop") => {
  wallet = fakeWallet();
  mocks.choices.mockResolvedValue([{ id: "loop", name }]);
  mocks.connectWallet.mockImplementation(async () => linkWallet(wallet.provider, { name }));
  mocks.restoreWallet.mockImplementation(async () => linkWallet(wallet.provider, { name }));
};
const metamask = () => {
  const w = { on: vi.fn(), removeListener: vi.fn(), request: vi.fn(async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? [ME] : method === "eth_chainId" ? "0x" + status().chainId.toString(16) : null)) };
  Object.defineProperty(window, "ethereum", { value: w, configurable: true, writable: true });
};
const setUp = (wallets: string | null = "loop") => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  if (wallets !== null) vi.stubEnv("VITE_CANTON_WALLETS", wallets);
  metamask();
  fakeApi(route({ faucet: () => reply(faucet), twins: () => reply(twins) }));
};
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); localStorage.clear(); Reflect.deleteProperty(window, "ethereum"); });
const openSheet = async () => {
  renderApp("/bridge");
  await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
  await userEvent.click(await screen.findByRole("button", { name: "Open my Canton account" }));
};
const sheet = () => screen.getByRole("region", { name: "Your Canton account" });

describe("the Bridge page without Canton wallets in the build", () => {
  it("is the Bridge as it was: the sign-in with MetaMask, no connect button, and none of the wallet code asked for", async () => {
    setUp(null);
    await openSheet();
    expect(await screen.findByRole("button", { name: "Sign in with MetaMask" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect your Canton wallet" })).toBeNull();
    expect(screen.queryByText(/Use a Bridge account from MetaMask|Have a Canton wallet/)).toBeNull();
    expect(mocks.choices).not.toHaveBeenCalled();
    expect(mocks.restoreWallet).not.toHaveBeenCalled();
  });
  it("is the same with the switch empty or naming only things that are not wallets", async () => {
    setUp("");
    await openSheet();
    expect(await screen.findByRole("button", { name: "Sign in with MetaMask" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect your Canton wallet" })).toBeNull();
  });
});

describe("the Bridge page with Canton wallets in the build", () => {
  it("offers to connect a Canton wallet first, and the Bridge account from MetaMask as the other way (and back)", async () => {
    setUp();
    connectsTo();
    await openSheet();
    expect(await screen.findByRole("button", { name: "Connect your Canton wallet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with MetaMask" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Use a Bridge account from MetaMask" }));
    expect(await screen.findByRole("button", { name: "Sign in with MetaMask" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect your Canton wallet" }));
    await screen.findByText("Connected");
  });

  it("connects the wallet, shows its short address and name, asks to opt in once, and then the moves are made for the wallet's account", async () => {
    setUp();
    connectsTo("Loop");
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getAllByTitle(WALLET_PARTY)[0]).toHaveTextContent("alice::1220a1a1a1…a1a1a1");
    expect(sheet()).toHaveTextContent("Loop");
    expect(sheet()).toHaveTextContent("Opt in once: Ostia tokens and withdrawals. You approve two steps in Loop.");
    expect(mocks.createSession).not.toHaveBeenCalled();   // not before the opt-in
    expect(screen.getByRole("button", { name: "Opt in with your wallet" })).toBeInTheDocument();   // the card says what is next
    await userEvent.click(screen.getByRole("button", { name: "Opt in" }));
    expect(await screen.findByText("Each Canton step of a move opens in Loop for you to approve.")).toBeInTheDocument();
    expect(wallet.commands().map((c) => c.CreateCommand.templateId)).toEqual(["#ostia-twin:Twin.Twin:TwinAcceptance", "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"]);
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    expect(mocks.createSession.mock.calls[0]![0].account).toMatchObject({ party: WALLET_PARTY, chain: expect.objectContaining({ gateway: CHAIN.gateway }) });
    expect(screen.queryByRole("button", { name: "Opt in" })).toBeNull();
    // The moves' steps say where each is approved.
    await userEvent.click(screen.getByText(/MetaMask pop-up/, { selector: "summary span" }));
    expect(screen.getAllByText("Approve in Loop").length).toBeGreaterThan(0);
  });

  it("says that sending and accepting are done in the wallet, that the page's faucet is for Bridge accounts, and shows no send form", async () => {
    setUp();
    connectsTo("Loop");
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    await screen.findByText("Connected");
    expect(screen.getByRole("region", { name: "Your addresses" })).toHaveTextContent("Sending and accepting are done in Loop itself.");
    expect(screen.queryByText("Send on Canton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get test Canton Coin" })).toBeNull();
    expect(sheet()).toHaveTextContent("The Canton Coin faucet on this page is for Bridge accounts only. Get test Canton Coin in Loop.");
  });

  it("uses no technical name on the screen", async () => {
    setUp();
    connectsTo("Loop");
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    await screen.findByText("Connected");
    await userEvent.click(screen.getByRole("button", { name: "Opt in" }));
    await screen.findByText(/Each Canton step/);
    expect(document.body.textContent).not.toMatch(/CIP|prepareExecute|ledger api|party|allocation|DAR|package/i);
  });

  it("lists the wallets to choose from when the browser has several, and connects the one picked", async () => {
    setUp("loop,extension");
    connectsTo("Loop");
    mocks.choices.mockResolvedValue([{ id: "loop", name: "Loop" }, { id: "browser:ext:fake", name: "Fake Wallet" }]);
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    await userEvent.click(await screen.findByRole("button", { name: "Fake Wallet" }));
    expect(mocks.connectWallet).toHaveBeenCalledWith(expect.objectContaining({ wallets: ["loop", "extension"] }), "browser:ext:fake");
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("says in words that no wallet was found", async () => {
    setUp("extension");
    mocks.choices.mockResolvedValue([]);
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No Canton wallet was found in this browser.");
  });

  it("says in words when the person declines in the wallet, and lets them try again", async () => {
    setUp();
    connectsTo();
    mocks.connectWallet.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: 4001 }));
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined it in your wallet.");
    await userEvent.click(screen.getByRole("button", { name: "Connect your Canton wallet" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("says in words when the wallet will not take the opt-in, and lets them try again; what the wallet made is not asked for twice", async () => {
    setUp();
    connectsTo();
    wallet = fakeWallet({ refuse: (c: any) => (c.CreateCommand.templateId.endsWith("TwinAcceptance") ? -32003 : undefined) });
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    await userEvent.click(await screen.findByRole("button", { name: "Opt in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Canton did not take this. Your wallet may not support Ostia's tokens yet. Nothing was changed.");
    expect(screen.getByRole("button", { name: "Opt in" })).toBeEnabled();
  });

  it("goes back to the choice when the wallet is disconnected here, and forgets it", async () => {
    setUp();
    connectsTo();
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    await screen.findByText("Connected");
    expect(wasConnected()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect your Canton wallet" })).toBeInTheDocument();
    expect(wasConnected()).toBe(false);
    expect(wallet.requests.some((r) => r.method === "disconnect")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the wallet disconnects or changes its account by itself, and offers to connect again", async () => {
    setUp();
    connectsTo();
    await openSheet();
    await userEvent.click(await screen.findByRole("button", { name: "Connect your Canton wallet" }));
    await screen.findByText("Connected");
    wallet.emit("statusChanged", { connection: { isConnected: false } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your Canton wallet was disconnected or changed its account. Connect it again.");
    expect(screen.getByRole("button", { name: "Connect your Canton wallet" })).toBeInTheDocument();
    expect(wasConnected()).toBe(false);
  });

  it("opens the wallet this browser had connected, with no click, after a reload", async () => {
    setUp();
    connectsTo();
    rememberWallet();
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(mocks.restoreWallet).toHaveBeenCalledTimes(1);
    expect(mocks.connectWallet).not.toHaveBeenCalled();
  });

  it("forgets a wallet that cannot be opened again, and leaves the choice as it was", async () => {
    setUp();
    connectsTo();
    mocks.restoreWallet.mockResolvedValue(null);
    rememberWallet();
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    await waitFor(() => expect(wasConnected()).toBe(false));
    await userEvent.click(await screen.findByRole("button", { name: "Open my Canton account" }));
    expect(await screen.findByRole("button", { name: "Connect your Canton wallet" })).toBeInTheDocument();
  });
});
