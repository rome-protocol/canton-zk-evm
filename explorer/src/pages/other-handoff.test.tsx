// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocks, setupBody, WETH } from "../bridge/other/fakes.ts";
import { parseSetup } from "../bridge/other/setup.ts";
import { status } from "../test-utils.tsx";
import { OtherChains } from "./OtherChains.tsx";

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const none = { in: null, out: null };
const list = (...items: unknown[]) => items;
const eth = { symbol: "ETH", name: "Ether (Rome)", decimals: 18, places: 9, ostia: WETH, times: { in: { minSeconds: 360, maxSeconds: 360 }, out: { minSeconds: 360, maxSeconds: 360 } } };
const sol = { symbol: "SOL", name: "Wrapped SOL (Rome)", decimals: 9, places: 9, ostia: "0x" + "a0".repeat(20), times: { in: { minSeconds: 240, maxSeconds: 240 }, out: { minSeconds: 570, maxSeconds: 570 } } };
const hadrian = (over: Record<string, unknown> = {}) => ({ id: "hadrian", name: "Hadrian", open: true, via: "solgate", available: true, solgate: "https://solgate.example", coin: "USDC", assets: list(eth, sol), times: none, ...over });
const solana = (over: Record<string, unknown> = {}) => ({ id: "solana-devnet", name: "Solana devnet", open: true, via: "solgate", available: true, solgate: "https://solgate.example", coin: null, assets: list(sol, eth), times: none, ...over });

function page(routes: { hadrian?: unknown; solana?: unknown }) {
  const body = setupBody();
  if (routes.hadrian) body.routes[1] = routes.hadrian;
  if (routes.solana) body.routes[2] = routes.solana;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => (input === "/api/status" ? json(status()) : input === "/api/agglayer/setup" ? json(body) : input === "/api/faucet" ? json({ on: false }) : json({ error: "Not found." }, 404))));
  const setup = parseSetup(body);
  if (!setup.on) throw new Error("the test's setup is off");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><OtherChains tabs={null} setup={setup} pollMs={60_000} /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); Object.defineProperty(navigator, "locks", { value: memoryLocks(), configurable: true }); window.scrollTo = () => {}; });
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "locks"); });

describe("the routes through Solgate", () => {
  it("lists an open Hadrian and an open Solana devnet as routes via Solgate, and none of them as not yet open", async () => {
    page({ hadrian: hadrian(), solana: solana() });
    const items = within(await screen.findByRole("region", { name: "Route" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/Ostia.*Ethereum Sepolia.*via AggLayer/);
    expect(items[1]).toHaveTextContent(/Ostia.*Hadrian.*via Solgate/);
    expect(items[2]).toHaveTextContent(/Ostia.*Solana devnet.*via Solgate/);
    expect(screen.queryByText("Not yet open")).toBeNull();
    expect(within(items[0]!).getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a route that is not open as not yet open while the other is open, and the Ethereum Sepolia card stays until a route through Solgate is picked", async () => {
    page({ solana: solana() });
    const items = within(await screen.findByRole("region", { name: "Route" })).getAllByRole("listitem");
    expect(within(items[1]!).getByText("Not yet open")).toBeInTheDocument();
    expect(items[2]).toHaveTextContent("via Solgate");
    expect(screen.getByRole("region", { name: "Move tokens over the AggLayer Bridge" })).toBeInTheDocument();
  });

  it("opens the Hadrian card with its steps, the tokens it offers, their measured times and the link to Solgate, in place of the move card", async () => {
    page({ hadrian: hadrian(), solana: solana() });
    await userEvent.click(await screen.findByRole("button", { name: /Hadrian/ }));
    const card = await screen.findByRole("region", { name: "Ostia and Hadrian through Solgate" });
    expect(screen.queryByRole("region", { name: "Move tokens over the AggLayer Bridge" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "AggLayer Bridge" })).toBeNull();
    expect(within(card).getByText("Every step to Hadrian is in Solgate.")).toBeInTheDocument();
    const steps = within(card).getAllByRole("listitem").slice(0, 3);
    expect(steps[0]).toHaveTextContent("Send from your Ostia wallet (your EVM wallet, a little tROME)");
    expect(steps[1]).toHaveTextContent("Wait until it is ready to claim");
    expect(steps[2]).toHaveTextContent("Claim on Hadrian (your EVM wallet, a little USDC)");
    expect(card).toHaveTextContent("You can move ETH, SOL.");
    expect(card).toHaveTextContent("ETH: about 6 minutes from Ostia, about 6 minutes to Ostia");
    expect(card).toHaveTextContent("SOL: about 10 minutes from Ostia, about 4 minutes to Ostia");
    expect(card).toHaveTextContent("Ostia cannot send out more ETH than came in.");
    expect(card).not.toHaveTextContent(/decimal places/);   // Hadrian's end is an EVM wallet: nothing is dropped there
    const open = within(card).getByRole("link", { name: "Open Solgate" });
    expect(open).toHaveAttribute("href", "https://solgate.example/");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(card).getByRole("link", { name: "Already sent? Go to Claim" })).toHaveAttribute("href", "https://solgate.example/?tab=claim");
    expect(screen.getByRole("button", { name: /Hadrian/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Ethereum Sepolia/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the Solana card: the claim in a Solana wallet paid in SOL, the places dropped on the way, and no Solana wallet connected by this page", async () => {
    page({ solana: solana() });
    await userEvent.click(await screen.findByRole("button", { name: /Solana devnet/ }));
    const card = await screen.findByRole("region", { name: "Ostia and Solana devnet through Solgate" });
    expect(within(card).getByText("Every step to Solana is in Solgate.")).toBeInTheDocument();
    expect(card).toHaveTextContent("Claim in your Solana wallet (your Solana wallet, a little SOL)");
    expect(card).toHaveTextContent("ETH has 18 decimal places on Ostia and 9 on Solana. The places past 9 are dropped on the way.");
    expect(card).toHaveTextContent("On Solana it is Solgate's copy, under Solgate's terms.");
    expect(within(card).queryByRole("button", { name: /connect/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
  });

  it("goes back to the Ethereum Sepolia card when that route is picked again", async () => {
    page({ hadrian: hadrian() });
    await userEvent.click(await screen.findByRole("button", { name: /Hadrian/ }));
    await screen.findByRole("region", { name: "Ostia and Hadrian through Solgate" });
    await userEvent.click(screen.getByRole("button", { name: /Ethereum Sepolia/ }));
    expect(await screen.findByRole("region", { name: "Move tokens over the AggLayer Bridge" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ostia and Hadrian through Solgate" })).toBeNull();
  });

  it("says the route is not available right now, with no link to open, while the server says so, and when it offers no token", async () => {
    page({ hadrian: hadrian({ available: false }), solana: solana({ assets: list(), available: false }) });
    await userEvent.click(await screen.findByRole("button", { name: /Hadrian/ }));
    let card = await screen.findByRole("region", { name: "Ostia and Hadrian through Solgate" });
    expect(within(card).getByText("Hadrian is not available right now. Nothing is lost.")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Not available right now" })).toBeDisabled();
    expect(within(card).queryByRole("link", { name: "Open Solgate" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Solana devnet/ }));
    card = await screen.findByRole("region", { name: "Ostia and Solana devnet through Solgate" });
    expect(card).toHaveTextContent("No token is offered on this route yet.");
  });

  it("shows no time before one is set, and never the words the page does not use", async () => {
    page({ hadrian: hadrian({ assets: [{ ...eth, times: none }, { ...sol, times: none }] }), solana: solana() });
    await userEvent.click(await screen.findByRole("button", { name: /Hadrian/ }));
    const card = await screen.findByRole("region", { name: "Ostia and Hadrian through Solgate" });
    expect(card).not.toHaveTextContent(/Time until it is ready to claim|minute/);
    for (const name of [/Hadrian/, /Solana devnet/]) {
      await userEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true"));
      expect(document.body.textContent).not.toMatch(/receiv|pending|\bgas\b|other chains|certificate|exit root/i);
    }
  });
});
