// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME, memoryLocks, OSTIA_BRIDGE, OSTIA_ID, SEPOLIA_BRIDGE, SEPOLIA_ID, setupBody as agglayerSetup, stage } from "../bridge/other/fakes.ts";
import { parseSetup } from "../bridge/other/setup.ts";
import { cc, claimBody, movesBody, requested, setupBody, taken } from "../bridge/route/fakes.ts";
import type { Move } from "../bridge/route/setup.ts";
import { status } from "../test-utils.tsx";
import { OtherChains } from "./OtherChains.tsx";
import { RouteForm } from "./RouteForm.tsx";
import { asset, on } from "../bridge/route/fakes.ts";

const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const hex = (n: bigint | number) => "0x" + n.toString(16);
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

/** The explorer's API and the person's wallet, as the switches a test turns. */
const world = { route: setupBody() as unknown, moves: [] as Move[], requestsRead: true, stage: "ready", readyAt: minutes(-20), claimed: false, connected: false, chain: OSTIA_ID, sent: [] as { chainId: number; tx: any }[], asked: [] as string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const reset = () => Object.assign(world, { route: setupBody(), moves: [], requestsRead: true, stage: "ready", readyAt: minutes(-20), claimed: false, connected: false, chain: OSTIA_ID, sent: [], asked: [] });

beforeEach(() => {
  reset();
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { value: memoryLocks(), configurable: true });
  window.scrollTo = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    world.asked.push(input);
    if (input === "/api/status") return json(200, status());
    if (input === "/api/agglayer/setup") return json(200, agglayerSetup());
    if (input === "/api/canton-route/setup") return world.route === null ? json(404, { error: "Not found." }) : json(200, world.route);
    if (input.startsWith("/api/canton-route/moves")) return json(200, movesBody(world.moves, world.requestsRead));
    if (input.startsWith("/api/agglayer/deposit")) return json(200, { network: 75, count: 7, destinationNetwork: 0, ...stage(world.stage as never), readyAt: world.stage === "ready" || world.stage === "claimed" ? world.readyAt : null });
    if (input.startsWith("/api/agglayer/claim")) return json(200, claimBody({ claimed: world.claimed, data: world.claimed ? null : claimBody().data }));
    if (input === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
    if (input.startsWith("/api/tx/")) return json(404, { error: "Not found." });
    return json(404, { error: "Not found." });
  }));
  Object.defineProperty(window, "ethereum", { configurable: true, writable: true, value: {
    on: vi.fn(), removeListener: vi.fn(),
    request: vi.fn(async ({ method, params = [] }: { method: string; params?: any[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (method) {
        case "eth_requestAccounts": world.connected = true; return [ME];
        case "eth_accounts": return world.connected ? [ME] : [];
        case "eth_chainId": return hex(world.chain);
        case "wallet_switchEthereumChain": world.chain = Number(BigInt(params[0].chainId)); return null;
        case "eth_estimateGas": return "0x30d40";
        case "eth_sendTransaction": world.sent.push({ chainId: world.chain, tx: params[0] }); return "0x" + "77".repeat(32);
        default: throw new Error(`the wallet was asked ${method}`);
      }
    }),
  } });
});
afterEach(() => { Reflect.deleteProperty(window, "ethereum"); Reflect.deleteProperty(navigator, "locks"); vi.unstubAllGlobals(); });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setup = parseSetup(agglayerSetup());
  if (!setup.on) throw new Error("the test's setup is off");
  return render(<QueryClientProvider client={client}><MemoryRouter><OtherChains tabs={null} setup={setup} pollMs={40} /></MemoryRouter></QueryClientProvider>);
}
const openRoute = async () => { await userEvent.click(await screen.findByRole("button", { name: /Canton .* Ethereum Sepolia/ })); await screen.findByRole("region", { name: "Canton to Ethereum Sepolia" }); };
const connect = async () => { await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" })); };

describe("Canton in the route list", () => {
  it("is not there when the server has no such route, or it is off, so the tab is as it was", async () => {
    for (const route of [null, { on: false }, { on: true }]) {
      reset(); world.route = route;
      const { unmount } = renderPage();
      await screen.findByRole("region", { name: "Route" });
      await waitFor(() => expect(world.asked).toContain("/api/canton-route/setup"));
      expect(screen.queryByText(/Canton/)).toBeNull();
      unmount();
    }
  });
  it("is a row of the list, after the Ostia row, with the routes it is built on", async () => {
    renderPage();
    const list = await screen.findByRole("region", { name: "Route" });
    const row = await within(list).findByRole("button", { name: /Canton .* Ethereum Sepolia/ });
    expect(row).toHaveTextContent("via Ostia");
    const names = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(names.findIndex((t) => t?.includes("Canton"))).toBeGreaterThan(names.findIndex((t) => t?.includes("via AggLayer")));
  });
  it("reads Not yet open, and cannot be picked, until the route has opened", async () => {
    world.route = setupBody({ route: "closed", assets: [] });
    renderPage();
    const list = await screen.findByRole("region", { name: "Route" });
    await waitFor(() => expect(within(list).getAllByText("Not yet open").length).toBeGreaterThan(2));
    expect(within(list).queryByRole("button", { name: /Canton/ })).toBeNull();
  });
});

describe("the Move tab of the Canton route", () => {
  it("says where the cap stands and the smallest amount, and where a move starts, with no form before a Canton wallet can connect", async () => {
    world.route = setupBody({}, { lockRoom: cc(2.5) });
    renderPage();
    await openRoute();
    expect(await screen.findByText("Up to 10 CC of Canton Coin can be on AggLayer chains at once for now. 7.5 CC is out, so you can send up to 2.5 CC.")).toBeInTheDocument();
    expect(screen.getByText("The smallest amount for this route is 1 CC.")).toBeInTheDocument();
    expect(screen.getByText(/A move from Canton starts in your Canton wallet/)).toBeInTheDocument();
    expect(screen.getByText(/rests on the coin Rome holds on Canton/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to Ethereum Sepolia" })).toBeNull();
  });
  it("says the cap is reached, with the way out", async () => {
    world.route = setupBody({}, { lockRoom: 0n });
    renderPage();
    await openRoute();
    expect(await screen.findByText("Up to 10 CC of Canton Coin can be on AggLayer chains at once for now, and that is reached. You can send again when some comes back to Canton.")).toBeInTheDocument();
  });
  it("shows no cap and no room line when no cap is set, even with some coin out", async () => {
    const max = 2n ** 256n - 1n;
    world.route = setupBody({}, { lockCap: max, lockRoom: max - cc(1.3) });
    renderPage();
    await openRoute();
    expect(await screen.findByText("The smallest amount for this route is 1 CC.")).toBeInTheDocument();
    expect(screen.queryByText(/can be on AggLayer chains at once/)).toBeNull();
    expect(screen.queryByText(/is out, so you can send up to/)).toBeNull();
  });
  it("says Canton to Ethereum Sepolia is not available right now, and that nothing is lost, when the route stopped or the bridge cannot be used", async () => {
    for (const over of [{ route: "stopped" as const, assets: [] }, { available: false }]) {
      reset(); world.route = setupBody(over);
      const { unmount } = renderPage();
      await openRoute();
      expect(await screen.findByText("Canton to Ethereum Sepolia is not available right now. Nothing is lost.")).toBeInTheDocument();
      expect(screen.queryByText(/smallest amount/)).toBeNull();
      unmount();
    }
  });
  it("asks the wallet to connect before it shows anyone's moves, and then finds the moves by the wallet's address", async () => {
    world.moves = [taken()];
    renderPage();
    await openRoute();
    expect(screen.getByText(/Connect your wallet to see the moves sent to it/)).toBeInTheDocument();
    expect(world.asked.some((a) => a.startsWith("/api/canton-route/moves"))).toBe(false);
    await connect();
    await waitFor(() => expect(world.asked).toContain(`/api/canton-route/moves?evm=${encodeURIComponent(ME)}`));
    expect(await screen.findByRole("listitem", { name: "Sending 5 CC to Ethereum Sepolia" })).toBeInTheDocument();
  });
});

describe("the moves of the wallet", () => {
  async function shown(moves: Move[]) {
    world.moves = moves;
    renderPage();
    await openRoute();
    await connect();
  }
  it("shows the four steps of a move Ostia took, through Ostia with its block, until the bridge says it is ready", async () => {
    world.stage = "sent";
    await shown([taken()]);
    const row = await screen.findByRole("listitem", { name: "Sending 5 CC to Ethereum Sepolia" });
    for (const label of ["Sent from Canton: done", "Through Ostia: done", "Confirmed on Ethereum Sepolia: now", "Arrived: waiting"]) expect(within(row).getByLabelText(label)).toBeInTheDocument();
    expect(within(row).getByText("block 88,214")).toBeInTheDocument();
    expect(within(row).getByText("You can leave this page. This move stays in Activity.")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Claim/ })).toBeNull();
  });
  it("is found again after a reload: a new page reads the same moves from the server", async () => {
    world.stage = "sent";
    world.moves = [taken()];
    const first = renderPage();
    await openRoute();
    await connect();
    await screen.findByRole("listitem", { name: "Sending 5 CC to Ethereum Sepolia" });
    first.unmount();
    renderPage();   // the wallet is still connected, and nothing is kept in the browser: the server's answer alone brings the move back
    await openRoute();
    expect(await screen.findByRole("listitem", { name: "Sending 5 CC to Ethereum Sepolia" })).toBeInTheDocument();
  });
  it("says Not taken yet, with the real end, for a request Ostia has not taken within the set time", async () => {
    await shown([requested({ at: minutes(-20), settleBefore: "2026-11-22T23:40:00.000Z" })]);
    expect(await screen.findByText("Not taken yet. If it is not taken by 23:40 UTC, your 5 CC is free again in your Canton account.")).toBeInTheDocument();
  });
  it("says Not moved, with the coin free again, once the end has passed, and offers no button before the page can start a move", async () => {
    await shown([requested({ at: minutes(-300), settleBefore: minutes(-60) })]);
    expect(await screen.findByText("Not moved. Your 5 CC is free again in your Canton account.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("listitem", { name: "Sending 5 CC to Ethereum Sepolia" })).toBeInTheDocument();
  });
  it("offers the person's own claim after the set time, counts it under Claim, and signs it on Ethereum Sepolia in the person's wallet", async () => {
    await shown([taken()]);
    const button = await screen.findByRole("button", { name: "Claim on Ethereum Sepolia" });
    expect(screen.getByText("Ready to claim on Ethereum Sepolia. You can claim it now with your wallet.")).toBeInTheDocument();
    expect(screen.getByText("Your wallet switches to Ethereum Sepolia. Its fee is paid in Sepolia ETH.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Claim/ })).toHaveTextContent("1");
    await userEvent.click(button);
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(world.sent[0]).toMatchObject({ chainId: SEPOLIA_ID, tx: { from: ME, to: SEPOLIA_BRIDGE, value: "0x0" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Claim on Ethereum Sepolia" })).toBeNull());
    expect(await screen.findByText("Claiming…")).toBeInTheDocument();
    expect(OSTIA_BRIDGE).not.toBe(SEPOLIA_BRIDGE);
  });
  it("offers no claim of its own before the set time", async () => {
    world.readyAt = minutes(-1);
    await shown([taken()]);
    await screen.findByRole("listitem", { name: "Sending 5 CC to Ethereum Sepolia" });
    await waitFor(() => expect(world.asked.some((a) => a.startsWith("/api/agglayer/deposit"))).toBe(true));
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.queryByRole("button", { name: "Claim on Ethereum Sepolia" })).toBeNull();
  });
  it("shows Arrived with what the wallet got once the bridge says it was paid out, and nothing left to claim", async () => {
    world.stage = "claimed"; world.claimed = true;
    await shown([taken({ at: new Date().toISOString() })]);
    expect(await screen.findByRole("listitem", { name: "Arrived. 4.8 CC is in your wallet on Ethereum Sepolia." })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Claim" }));
    expect(await screen.findByText("Nothing is ready to claim.")).toBeInTheDocument();
  });
  it("signs nothing, and says why in words, when the claim the bridge hands over is not this move's", async () => {
    await shown([taken({ send: cc(4.9) })]);
    await userEvent.click(await screen.findByRole("button", { name: "Claim on Ethereum Sepolia" }));
    expect(await screen.findByText(/not this move's, so nothing was signed/)).toBeInTheDocument();
    expect(world.sent).toHaveLength(0);
  });
});

describe("the form that starts a move on Canton", () => {
  const send = vi.fn(async () => undefined);
  const form = () => render(<RouteForm setup={on({ time: { minSeconds: 480, maxSeconds: 960 } })} asset={asset()} account={ME} onSend={send} />);
  it("shows the fee before anything is signed, and what the person gets, from the amount", async () => {
    form();
    await userEvent.type(screen.getByLabelText("Amount of CC"), "5");
    expect(screen.getByText("Fee 0.2000000000 CC, taken from the amount. It covers the cost on Ostia and the claim on Ethereum Sepolia.")).toBeInTheDocument();
    expect(screen.getByText("You get 4.8000000000 CC on Ethereum Sepolia")).toBeInTheDocument();
    expect(screen.getByText("Time about 8 to 16 minutes")).toBeInTheDocument();
    expect(screen.getByText(`${ME}`, { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Through Ostia")).toBeInTheDocument();
  });
  it("sends with the fee shown as the label's maxFee, to the wallet's address, and not for an amount the book would refuse", async () => {
    send.mockClear();
    form();
    const button = screen.getByRole("button", { name: "Send to Ethereum Sepolia" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Amount of CC"), "0.5");
    expect(screen.getByText("The smallest amount for this route is 1 CC.")).toBeInTheDocument();
    expect(button).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Amount of CC"));
    await userEvent.type(screen.getByLabelText("Amount of CC"), "5");
    await userEvent.click(button);
    expect(send).toHaveBeenCalledWith({ asset: asset(), amount: cc(5), address: ME, maxFee: cc(0.2) });
  });
  it("refuses the zero address and an address that is not one", async () => {
    form();
    await userEvent.type(screen.getByLabelText("Amount of CC"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    const field = screen.getByLabelText("Address on Ethereum Sepolia");
    await userEvent.clear(field);
    await userEvent.type(field, "0x" + "0".repeat(40));
    expect(screen.getByText(/zero address cannot take a move/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to Ethereum Sepolia" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "0x12");
    expect(screen.getByText(/Type an address on Ethereum Sepolia/)).toBeInTheDocument();
  });
});
