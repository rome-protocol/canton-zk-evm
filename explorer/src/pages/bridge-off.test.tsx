// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addr, fakeApi, renderApp, reply, route, status } from "../test-utils.tsx";

/**
 * The Bridge page of a build without the Bridge account made from a wallet signature (VITE_BRIDGE_ACCOUNT unset: the default, and TestNet's build). No sign-in, no key, no kept-key store, no account service, no Canton Coin
 * faucet; the card and the sheet send a person to their own Canton wallet. The EVM side is as it was. The files of the account's code are mocked so that a load of any of them is seen.
 */
const mocks = vi.hoisted(() => {
  const m = { loaded: [] as string[], forget: vi.fn(async () => {}), gas: 5n * 10n ** 18n, requests: [] as string[], seenLoad: (_name: string) => (actual: object): object => actual };
  m.seenLoad = (name: string) => (actual: object) => { m.loaded.push(name); return actual; };
  return m;
});
vi.mock("../bridge/account.ts", async (original) => mocks.seenLoad("account.ts")(await original<object>()));
vi.mock("../bridge/send.ts", async (original) => mocks.seenLoad("send.ts")(await original<object>()));
vi.mock("../bridge/canton/key.ts", async (original) => mocks.seenLoad("key.ts")(await original<object>()));
vi.mock("../bridge/canton/keystore.ts", async (original) => mocks.seenLoad("keystore.ts")(await original<object>()));
vi.mock("../bridge/canton/topology.ts", async (original) => mocks.seenLoad("topology.ts")(await original<object>()));
vi.mock("../bridge/canton/accounts.ts", async (original) => mocks.seenLoad("accounts.ts")(await original<object>()));
vi.mock("../bridge/canton/sign.ts", async (original) => mocks.seenLoad("sign.ts")(await original<object>()));
vi.mock("../bridge/retired.ts", () => ({ forgetKeptKeys: mocks.forget, KEPT_KEYS_DB: "ostia-bridge-canton" }));
vi.mock("../bridge/wallet/connect.ts", () => ({ choices: vi.fn(async () => []), connectWallet: vi.fn(), restoreWallet: vi.fn(async () => null) }));
vi.mock("../bridge/evm/config.ts", () => ({
  loadBridgeConfig: async () => ({
    chain: { chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 } }, gateway: "0x" + "22".repeat(20), vault: "0x" + "33".repeat(20), vaults: ["0x" + "33".repeat(20)], registryUrl: "https://registry.example", wrapper: null,
    twins: [{ address: "0x" + "aa".repeat(20), symbol: "TKA", decimals: 18 }],
    wrapped: [{ address: "0x" + "bb".repeat(20), symbol: "wCC", decimals: 10, instrument: { admin: "DSO::1220" + "cd".repeat(32), id: "Amulet" } }],
  }),
}));
vi.mock("../bridge/evm/ostia.ts", () => ({ ostiaAdapter: () => ({ account: "0xe3", native: async () => mocks.gas, balanceOf: async () => 20n * 10n ** 18n }) }));

const DSO = "DSO::1220" + "cd".repeat(32), ME = addr(0xe3), ORIGIN = location.origin;
// No VITE_CANTON_PARTICIPANT and no VITE_PARTY_HINT: a build without the account has neither.
const env = { VITE_CHAIN_OPERATOR: "operator::1220" + "01".repeat(32), VITE_CHAIN_CONFIRMER: "confirmer::1220" + "02".repeat(32), VITE_CHAIN_GATEWAY: "gateway::1220" + "03".repeat(32), VITE_CHAIN_BUILDER: "builder::1220" + "04".repeat(32), VITE_CHAIN_ID: "770101", VITE_SITE_ORIGIN: ORIGIN };
const faucet = { on: true, address: addr(0xfa), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 21 };
const twins = { through: 3, registryService: null, vaults: [], twins: [], legs: [], canton: [{ token: addr(0xcc), symbol: "wCC", instrumentAdmin: DSO, instrumentId: "Amulet" }] };

function metamask() {
  const w = {
    on: vi.fn(), removeListener: vi.fn(),
    request: vi.fn(async ({ method }: { method: string }) => { mocks.requests.push(method); return method === "eth_requestAccounts" ? [ME] : method === "eth_chainId" ? "0x" + status().chainId.toString(16) : null; }),
  };
  Object.defineProperty(window, "ethereum", { value: w, configurable: true, writable: true });
}
let calls: string[] = [];
const setUp = (wallets?: string) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  if (wallets !== undefined) vi.stubEnv("VITE_CANTON_WALLETS", wallets);
  metamask();
  calls = fakeApi(route({ faucet: () => reply(faucet), twins: () => reply(twins) }));
};
beforeEach(() => { vi.stubGlobal("__BRIDGE_ACCOUNT__", false); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); mocks.loaded.length = 0; mocks.requests.length = 0; mocks.gas = 5n * 10n ** 18n; Reflect.deleteProperty(window, "ethereum"); });

const toCard = async () => {
  renderApp("/bridge");
  await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
  return screen.findByRole("region", { name: "Move tokens" });
};
const sheet = () => screen.getByRole("region", { name: "Your Canton account" });

describe("the Bridge page without the Bridge account", () => {
  it("loads with no participant and no party hint in the build, and shows the Move and Activity tabs", async () => {
    setUp();
    renderApp("/bridge");
    expect(await screen.findByRole("tab", { name: "Move" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();
    expect(screen.queryByText("The bridge is not set up on this site yet.")).toBeNull();
    expect(screen.getByText(/Move tokens between Ostia and Canton/)).toBeInTheDocument();
  });

  it("sends the person to their own Canton wallet: the card says so, and the sheet has a disabled connect button tagged Coming soon, and nothing else to sign in with", async () => {
    setUp();
    const card = await toCard();
    expect(within(card).queryByRole("button", { name: "Open my Canton account" })).toBeNull();
    await userEvent.click(await within(card).findByRole("button", { name: "Connect your Canton wallet" }));
    const s = sheet();
    expect(s).toHaveTextContent("Use the Canton wallet you already have. It shows each Canton step of a move and you approve it there.");
    const connect = within(s).getByRole("button", { name: /Connect your Canton wallet/ });
    expect(connect).toBeDisabled();
    expect(connect).toHaveTextContent("Coming soon");
    for (const gone of [/Sign in with your wallet/, /Sign one message/, /You are on/, /Get test Canton Coin/, /Use a Bridge account/, /No Canton wallet\?/, /No recovery/, /Have a Canton wallet/, /faucet on this page/]) expect(s.textContent).not.toMatch(gone);
    expect(screen.queryByRole("button", { name: /Sign in with your wallet|Get test Canton Coin|Remove my Canton key/ })).toBeNull();
  });

  it("shows the account panel with the wallet on Ostia and an account on Canton that is not connected, and no key words", async () => {
    setUp();
    await toCard();
    const panel = await screen.findByRole("region", { name: "Your addresses" });
    expect(panel).toHaveTextContent("Your wallet on Ostia");
    expect(panel).toHaveTextContent("Your account on Canton");
    expect(panel).toHaveTextContent("Not connected");
    expect(panel.textContent).not.toMatch(/Not opened yet|key|Remove/);
  });

  it("never asks the wallet to sign, never asks the account service, and never loads the account's code, whatever is clicked", async () => {
    setUp();
    const card = await toCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Connect your Canton wallet" }));
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await userEvent.click(screen.getByRole("tab", { name: "Move" }));
    await new Promise((r) => setTimeout(r, 100));   // whatever the page was going to ask has been asked
    expect(calls.length).toBeGreaterThan(0);
    expect(mocks.requests.filter((m) => /sign/i.test(m))).toEqual([]);
    expect(calls.filter((c) => c.includes("/accounts"))).toEqual([]);
    expect(mocks.loaded).toEqual([]);
  });

  it("deletes the kept-key store an earlier build made, once per visit", async () => {
    setUp();
    renderApp("/bridge");
    await screen.findByRole("tab", { name: "Move" });
    await waitFor(() => expect(mocks.forget).toHaveBeenCalledTimes(1));
  });

  it("still has the EVM side: the wallet connects and gets test tROME from the explorer's faucet", async () => {
    setUp();
    mocks.gas = 0n;
    const asked = { n: 0 };
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/faucet" && init?.method === "POST") { asked.n++; return new Response(JSON.stringify({ ticket: "t1", position: 1, to: ME, amount: faucet.amount }), { status: 202, headers: { "content-type": "application/json" } }); }
      return base(input as never);
    }));
    const card = await toCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Get test tROME" }));
    await waitFor(() => expect(asked.n).toBe(1));
    expect(mocks.requests.filter((m) => /sign/i.test(m))).toEqual([]);
  });

  it("with Canton wallets in the build, the connect button works and there is still no Bridge account to turn to", async () => {
    setUp("extension");
    const card = await toCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Connect your Canton wallet" }));
    const connect = within(sheet()).getByRole("button", { name: "Connect your Canton wallet" });
    expect(connect).toBeEnabled();
    expect(sheet().textContent).not.toMatch(/Coming soon|Bridge account|Sign in/);
  });
});

describe("the same page in a build with the Bridge account", () => {
  it("keeps today's words, and does not delete the key store", async () => {
    vi.stubGlobal("__BRIDGE_ACCOUNT__", true);
    for (const [k, v] of Object.entries({ ...env, VITE_CANTON_PARTICIPANT: "PAR::p::1220" + "05".repeat(32) })) vi.stubEnv(k, v);
    metamask();
    fakeApi(route({ faucet: () => reply(faucet), twins: () => reply(twins) }));
    const card = await toCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Open my Canton account" }));
    expect(await screen.findByRole("button", { name: "Sign in with your wallet" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Your addresses" })).toHaveTextContent("Not opened yet");
    expect(mocks.forget).not.toHaveBeenCalled();
  });
});
