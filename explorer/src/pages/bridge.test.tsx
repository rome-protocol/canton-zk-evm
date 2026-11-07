// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addr, fakeApi, renderApp, reply, route, status } from "../test-utils.tsx";

const mocks = vi.hoisted(() => ({ openAccount: vi.fn(), getTestCoin: vi.fn() }));
vi.mock("../bridge/account.ts", () => mocks);

const PARTY = "bridge::1220" + "ab".repeat(32), DSO = "DSO::1220" + "cd".repeat(32), ME = addr(0xe3), ORIGIN = "https://ostia.example";
const env = { VITE_CHAIN_OPERATOR: "operator::1220" + "01".repeat(32), VITE_CHAIN_CONFIRMER: "confirmer::1220" + "02".repeat(32), VITE_CHAIN_GATEWAY: "gateway::1220" + "03".repeat(32), VITE_CHAIN_BUILDER: "builder::1220" + "04".repeat(32), VITE_CHAIN_ID: "770101", VITE_CANTON_PARTICIPANT: "PAR::p::1220" + "05".repeat(32), VITE_SITE_ORIGIN: ORIGIN };
const faucet = { on: true, address: addr(0xfa), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 21 };
const twins = { through: 3, registryService: null, vaults: [], twins: [], legs: [], canton: [{ token: addr(0xcc), symbol: "wCC", instrumentAdmin: DSO, instrumentId: "Amulet" }] };

function wallet() {
  const w = { request: vi.fn(async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? [ME] : method === "eth_chainId" ? "0x" + status().chainId.toString(16) : null)) };
  Object.defineProperty(window, "ethereum", { value: w, configurable: true, writable: true });
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); Reflect.deleteProperty(window, "ethereum"); });
const setUp = () => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); wallet(); fakeApi(route({ faucet: () => reply(faucet), twins: () => reply(twins) })); };
const signIn = async () => {
  renderApp("/bridge");
  await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
  await userEvent.click(await screen.findByRole("button", { name: "Sign in MetaMask" }));
};

describe("the Bridge page", () => {
  it("is in the header, and says the bridge is not set up when the build has no settings", async () => {
    fakeApi(route({}));
    renderApp("/bridge");
    expect(await screen.findByText("The bridge is not set up on this site yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bridge" })).toHaveClass("active");
  });

  it("asks to connect, shows the site's origin beside the sign-in, and then shows the account as Ready with a short id", async () => {
    setUp();
    mocks.openAccount.mockResolvedValue({ party: PARTY });
    renderApp("/bridge");
    await userEvent.click(await screen.findByRole("button", { name: "Connect MetaMask" }));
    expect(await screen.findByText(ORIGIN)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in MetaMask" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(mocks.openAccount).toHaveBeenCalledWith(expect.anything(), ME, expect.objectContaining({ origin: ORIGIN, participant: env.VITE_CANTON_PARTICIPANT }), expect.any(Function));
    expect(screen.getByTitle(PARTY)).toHaveTextContent("bridge::1220abab…ababab");
    expect(screen.getByRole("button", { name: "Copy account id" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Get 1 tROME" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your Canton account" }).textContent).not.toMatch(/party|allocation|vault|external/i);   // no technical names on the screen
  });

  it("gets test Canton Coin from the Canton Coin registry the explorer lists, and hides the button when this site has no faucet for it", async () => {
    setUp();
    mocks.openAccount.mockResolvedValue({ party: PARTY });
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
    await userEvent.click(screen.getByRole("button", { name: "Sign in MetaMask" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
  });
});
