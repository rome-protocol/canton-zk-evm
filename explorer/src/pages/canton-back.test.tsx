// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { decodeFunctionData, parseAbi } from "viem";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimData, eventLog, ME, memoryLocks, OSTIA_BRIDGE, OSTIA_ID, SEPOLIA_BRIDGE, SEPOLIA_ID, setupBody as agglayerSetup, stage } from "../bridge/other/fakes.ts";
import { parseSetup } from "../bridge/other/setup.ts";
import { addressBody, BOOK, cc, CC, forwarded, held, inFlow, INBOX, movesInBody, opened, PARTY, refunded, ROUTER, setupInBody } from "../bridge/route/fakes.ts";
import type { BackEvent } from "../bridge/route/setup.ts";
import { status } from "../test-utils.tsx";
import { OtherChains } from "./OtherChains.tsx";

const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const hex = (n: bigint | number) => "0x" + n.toString(16);
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const COPY = "0x" + "5e".repeat(20);
const SEND_HASH = "0x" + "70".repeat(32);
const proof = Array.from({ length: 32 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const ARGS = { smtProofLocalExitRoot: proof, smtProofRollupExitRoot: proof, globalIndex: "7", mainnetExitRoot: "0x" + "aa".repeat(32), rollupExitRoot: "0x" + "bb".repeat(32), originNetwork: 75, originTokenAddress: CC, destinationNetwork: 75, destinationAddress: INBOX, amount: cc(4.8).toString(), metadata: "0x" };

interface Sent { chainId: number; tx: any } // eslint-disable-line @typescript-eslint/no-explicit-any
const world = { route: setupInBody() as unknown, events: [] as BackEvent[], accepts: { [PARTY]: true } as Record<string, boolean> | null, address: addressBody() as unknown, intake: 200, stage: "sent", readyAt: minutes(-20), claimed: false, checkIn: true,
  connected: false, chain: OSTIA_ID, sent: [] as Sent[], posts: [] as unknown[], asked: [] as string[], balance: cc(10), hold: null as Promise<void> | null, tx: null as unknown };
const reset = () => Object.assign(world, { route: setupInBody(), events: [], accepts: { [PARTY]: true }, address: addressBody(), intake: 200, stage: "sent", readyAt: minutes(-20), claimed: false, checkIn: true, connected: false, chain: OSTIA_ID, sent: [], posts: [], asked: [], balance: cc(10), hold: null, tx: null });

beforeEach(() => {
  reset();
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { value: memoryLocks(), configurable: true });
  window.scrollTo = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: { body?: string }) => {
    world.asked.push(input);
    if (input === "/api/status") return json(200, status());
    if (input === "/api/agglayer/setup") return json(200, agglayerSetup({ assets: [{ symbol: "CC", name: "Canton Coin", decimals: 10, sepolia: COPY, ostia: CC }] }));
    if (input === "/api/canton-route/setup") return json(200, world.route);
    if (input.startsWith("/api/canton-route/moves")) return json(200, movesInBody(world.events, world.accepts));
    if (input === "/api/canton-route/address") { world.posts.push(JSON.parse(init!.body!)); return world.intake === 200 ? json(200, { asked: true }) : json(world.intake, { error: "no" }); }
    if (input.startsWith("/api/canton-route/address?")) {
      const q = new URL(input, "http://x").searchParams;
      const body = { ...(world.address as object), party: q.get("party"), refundAddress: q.get("refundAddress") };
      if (world.hold && q.get("party") === PARTY) await world.hold;   // a slow answer for the first account
      return json(200, body);
    }
    if (input.startsWith("/api/agglayer/deposit")) return json(200, { network: 0, count: 7, destinationNetwork: 75, ...stage(world.stage as never), readyAt: world.stage === "ready" || world.stage === "claimed" ? world.readyAt : null });
    if (input.startsWith("/api/agglayer/claim?network=75")) return json(200, { network: 75, count: 9, claimed: world.claimed, destinationNetwork: 0, chainId: SEPOLIA_ID, to: SEPOLIA_BRIDGE, l1InfoTreeIndex: 1, data: claimData(0, ME, cc(4.6), 9), args: null });
    if (input.startsWith("/api/agglayer/claim")) return json(200, { network: 0, count: 7, claimed: world.claimed, destinationNetwork: 75, chainId: OSTIA_ID, to: OSTIA_BRIDGE, l1InfoTreeIndex: 1, data: world.claimed ? null : claimData(75, INBOX, cc(4.8), 7), args: world.claimed ? null : ARGS });
    if (input.startsWith("/api/tx/")) return world.tx === null ? json(404, { error: "Not found." }) : json(200, world.tx);
    if (input === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
    if (input === "/rpc") {
      const call = JSON.parse(init!.body!) as { id: number; method: string; params: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const result = (r: unknown) => json(200, { jsonrpc: "2.0", id: call.id, result: r });
      if (call.method === "eth_blockNumber") return result("0x64");
      if (call.method === "eth_getBalance") return result(hex(5n * 10n ** 18n));
      if (call.method === "eth_call" && call.params[0].to === ROUTER) return result("0x" + "00".repeat(12) + "1b".repeat(20));
      if (call.method === "eth_call" && call.params[0].to === BOOK) return world.checkIn ? result("0x") : json(200, { jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted" } });
      return result(null);
    }
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
        case "eth_getTransactionCount": return "0x4";
        case "eth_call": return "0x" + world.balance.toString(16).padStart(64, "0");
        case "eth_estimateGas": return "0x30d40";
        case "eth_sendTransaction": world.sent.push({ chainId: world.chain, tx: params[0] }); return world.sent.length === 1 ? SEND_HASH : "0x" + (0x70 + world.sent.length).toString(16).repeat(32);
        case "eth_getTransactionReceipt": return params[0] === SEND_HASH ? { status: "0x1", logs: [eventLog({ bridge: SEPOLIA_BRIDGE, dest: 75, to: INBOX, amount: cc(4.8), count: 7 })] } : null;
        default: throw new Error(`the wallet was asked ${method}`);
      }
    }),
  } });
});
afterEach(() => { Reflect.deleteProperty(window, "ethereum"); Reflect.deleteProperty(navigator, "locks"); vi.unstubAllGlobals(); });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setup = parseSetup(agglayerSetup({ assets: [{ symbol: "CC", name: "Canton Coin", decimals: 10, sepolia: COPY, ostia: CC }] }));
  if (!setup.on) throw new Error("the test's setup is off");
  return render(<QueryClientProvider client={client}><MemoryRouter><OtherChains tabs={null} setup={setup} pollMs={40} /></MemoryRouter></QueryClientProvider>);
}
const openRoute = async () => { await userEvent.click(await screen.findByRole("button", { name: /Canton .* Ethereum Sepolia/ })); await screen.findByRole("region", { name: "Canton to Ethereum Sepolia" }); };
const connect = async () => { await userEvent.click((await screen.findAllByRole("button", { name: "Connect wallet" }))[0]!); };
const card = () => screen.findByRole("region", { name: "Ethereum Sepolia to Canton" });
const routerAbi = parseAbi([
  "struct ClaimArgs { bytes32[32] smtProofLocalExitRoot; bytes32[32] smtProofRollupExitRoot; uint256 globalIndex; bytes32 mainnetExitRoot; bytes32 rollupExitRoot; uint32 originNetwork; address originTokenAddress; uint32 destinationNetwork; address destinationAddress; uint256 amount; bytes metadata; }",
  "function claimAndWithdraw(ClaimArgs c, string party, uint32 refundNetwork, address refundAddress)", "function claimToInbox(ClaimArgs c, string party, uint32 refundNetwork, address refundAddress)",
  "function forward(string party, uint32 refundNetwork, address refundAddress, address token)", "function refund(string party, uint32 refundNetwork, address refundAddress, address token)",
]);
async function readyToSend(amount = "4.8") {
  world.address = addressBody({ opened: true, openedAt: minutes(-10), openTx: "0x" + "ab".repeat(32) });
  renderPage();
  await openRoute();
  await connect();
  const c = await card();
  await userEvent.type(within(c).getByLabelText("Canton account"), PARTY);
  await within(c).findByText("Takes transfers from Ostia: yes");
  if (amount) await userEvent.type(within(c).getByLabelText("Amount of CC"), amount);
  return c;
}

describe("Ethereum Sepolia to Canton, in the card", () => {
  it("is not there when the server has no way back, and not before it opens", async () => {
    for (const route of [setupInBody({ route: "closed" }), { ...(setupInBody() as object), in: undefined }]) {
      reset(); world.route = route;
      const { unmount } = renderPage();
      await openRoute();
      await new Promise((r) => setTimeout(r, 100));
      expect(screen.queryByRole("region", { name: "Ethereum Sepolia to Canton" })).toBeNull();
      unmount();
    }
  });
  it("says it is not available right now, with nothing lost, when the way back stopped or the bridge cannot be used", async () => {
    world.route = setupInBody({ route: "stopped" });
    renderPage();
    await openRoute();
    expect(within(await card()).getByText("Sending to Canton is not available right now. Nothing is lost.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Canton account")).toBeNull();
  });
  it("asks the wallet to connect first, then keeps the way back as the wallet's own address, which cannot be changed", async () => {
    renderPage();
    await openRoute();
    expect(within(await card()).getByText(/Connect your wallet to send to Canton/)).toBeInTheDocument();
    await connect();
    expect(await within(await card()).findByText(/The way back is this address on Ethereum Sepolia/)).toHaveTextContent("0xe3e3…e3e3");
  });
});

describe("setting up the account's Ostia address", () => {
  it("asks once for an address that is not open, shows the wait with its marks and no address, and shows the address when a final block opened it", async () => {
    world.address = addressBody();
    renderPage();
    await openRoute();
    await connect();
    const c = await card();
    await userEvent.type(within(c).getByLabelText("Canton account"), PARTY);
    expect(await within(c).findByText("Setting up this Canton account's Ostia address")).toBeInTheDocument();
    await waitFor(() => expect(world.posts).toEqual([{ party: PARTY, refundNetwork: 0, refundAddress: ME }]));
    expect(within(c).getByLabelText("Sent: waiting")).toBeInTheDocument();   // no transaction of the opening in a block yet
    world.address = addressBody({ openTx: "0x" + "ab".repeat(32) });
    expect(await within(c).findByLabelText("Sent: done")).toBeInTheDocument();
    expect(within(c).getByLabelText("Final: waiting")).toBeInTheDocument();
    expect(c.textContent).not.toContain("0x1b1b");
    expect(within(c).queryByRole("button", { name: "Send to Canton" })).toBeNull();
    world.address = addressBody({ opened: true, openedAt: minutes(0) });
    expect(await within(c).findByText("Takes transfers from Ostia: yes")).toBeInTheDocument();
    expect(within(c).getByText("0x1b1b…1b1b")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 150));
    expect(world.posts).toHaveLength(1);
  });
  it("carries on waiting after a reload without asking again", async () => {
    world.address = addressBody();
    localStorage.setItem(`ostia-in-asked:${PARTY}:${ME}`, String(Date.now() - 60_000));
    renderPage();
    await openRoute();
    await connect();
    await userEvent.type(within(await card()).getByLabelText("Canton account"), PARTY);
    expect(await screen.findByText("Setting up this Canton account's Ostia address")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 150));
    expect(world.posts).toEqual([]);
  });
  it("asks again, on a later visit, when an old ask has no opening after the set time", async () => {
    world.address = addressBody();
    localStorage.setItem(`ostia-in-asked:${PARTY}:${ME}`, String(Date.now() - 2_000_000));
    renderPage();
    await openRoute();
    await connect();
    await userEvent.type(within(await card()).getByLabelText("Canton account"), PARTY);
    expect(await screen.findByText("Setting up this Canton account's Ostia address")).toBeInTheDocument();
    await waitFor(() => expect(world.posts).toHaveLength(1));
  });
  it("never shows a late answer about the account that was typed before, for the one typed now", async () => {
    const BOB = "bob::1220" + "ab".repeat(16);
    world.address = addressBody({ opened: true, openedAt: minutes(-10) });
    renderPage();
    await openRoute();
    await connect();
    const c = await card();
    const field = within(c).getByLabelText("Canton account");
    await userEvent.type(field, PARTY);
    await within(c).findByText("Takes transfers from Ostia: yes");
    let release!: () => void;
    world.hold = new Promise<void>((r) => { release = r; });
    await new Promise((r) => setTimeout(r, 100));   // a look at the first account is now waiting on the server
    world.address = addressBody();
    await userEvent.clear(field);
    await userEvent.type(field, BOB);
    expect(await within(c).findByText("Setting up this Canton account's Ostia address")).toBeInTheDocument();
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(within(c).queryByText("Takes transfers from Ostia: yes")).toBeNull();
    expect(within(c).queryByText("0x1b1b…1b1b")).toBeNull();
    expect(within(c).getByText("Setting up this Canton account's Ostia address")).toBeInTheDocument();
  });
  it("says not available when the intake does not take the ask, and that the account takes no transfers when it has no acceptance", async () => {
    world.intake = 503;
    renderPage();
    await openRoute();
    await connect();
    await userEvent.type(within(await card()).getByLabelText("Canton account"), PARTY);
    expect(await screen.findByText("Sending to Canton is not available right now. Nothing is lost.")).toBeInTheDocument();
  });
  it("says the account does not take transfers from Ostia yet, shows no address and asks for none", async () => {
    world.address = addressBody({ accepts: false });
    renderPage();
    await openRoute();
    await connect();
    await userEvent.type(within(await card()).getByLabelText("Canton account"), PARTY);
    expect(await screen.findByText("This Canton account does not take transfers from Ostia yet. It accepts them once, in its Canton wallet.")).toBeInTheDocument();
    expect(world.posts).toEqual([]);
  });
  it("shows no address when the one the page works out itself is not the one the server named", async () => {
    world.address = addressBody({ opened: true, inbox: "0x" + "22".repeat(20) });
    renderPage();
    await openRoute();
    await connect();
    await userEvent.type(within(await card()).getByLabelText("Canton account"), PARTY);
    expect(await screen.findByText("Sending to Canton is not available right now. Nothing is lost.")).toBeInTheDocument();
    expect(screen.queryByText("0x2222…2222")).toBeNull();
  });
});

describe("the send", () => {
  it("shows the fee before signing, what the account gets, what Canton can pay out today, the way back and the smallest amount", async () => {
    const c = await readyToSend("4.8");
    expect(within(c).getByText("Fee 0.1000000000 CC, taken from the amount. It covers the cost on Ostia.")).toBeInTheDocument();
    expect(within(c).getByText("The account gets 4.7000000000 CC")).toBeInTheDocument();
    expect(within(c).getByText("Send with an ordinary bridge send only: a bridge-and-call send to this address loses the token.")).toBeInTheDocument();
    expect(within(c).getByText("Canton can pay out 6.2 CC more today. That renews at 14:05 UTC.")).toBeInTheDocument();
    expect(within(c).getByText("If Canton cannot pay it within 3 days, you can send it back to 0xe3e3…e3e3 on Ethereum Sepolia, less a 0.2 CC fee.")).toBeInTheDocument();
    expect(within(c).getByText(/Bring your own Sepolia ETH/)).toBeInTheDocument();
    await userEvent.clear(within(c).getByLabelText("Amount of CC"));
    await userEvent.type(within(c).getByLabelText("Amount of CC"), "0.1");
    expect(within(c).getByText("Send more than 0.1 CC; 0.1 CC or less is all fee.")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Send to Canton" })).toBeDisabled();
  });
  it("says a coin sent now is held when Canton cannot pay it today", async () => {
    world.route = setupInBody({ payout: { paused: false, pausedUntil: null, assets: { [CC]: { left: 0n, renewsAt: "2026-11-22T14:05:00.000Z" } } } });
    const c = await readyToSend("4.8");
    expect(within(c).getByText("Canton can pay out 0 CC more today. A coin sent now is held on Ostia. Canton can pay out again from 14:05 UTC; after 3 days it can go back.")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Send to Canton" })).toBeEnabled();
  });
  it("refuses more than the wallet holds, and says what it holds", async () => {
    world.chain = SEPOLIA_ID;
    const c = await readyToSend("");
    await userEvent.type(within(c).getByLabelText("Amount of CC"), "11");
    expect(await within(c).findByText("You hold 10 CC on Ethereum Sepolia.")).toBeInTheDocument();
  });
  it("sends an ordinary bridge send from the wallet to the account's Ostia address, on Ethereum Sepolia, and shows the move in its steps", async () => {
    const c = await readyToSend("4.8");
    await userEvent.click(within(c).getByRole("button", { name: "Send to Canton" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(world.sent[0]).toMatchObject({ chainId: SEPOLIA_ID, tx: { from: ME, to: SEPOLIA_BRIDGE, value: "0x0" } });
    expect(world.sent[0]!.tx.data.toLowerCase()).toContain(INBOX.slice(2));
    const row = await screen.findByRole("listitem", { name: "Sending 4.8 CC to Canton" });
    for (const label of ["Sent from Ethereum Sepolia: done", "Ready on Ostia: now", "Through Ostia to Canton: waiting", "Arrived in the Canton account: waiting"]) expect(await within(row).findByLabelText(label)).toBeInTheDocument();
    expect(within(row).getByText("You can leave this page. This move stays in Activity.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Activity/ })).toHaveTextContent("1");
  });
});

describe("the person's own claim on Ostia", () => {
  async function sent() {
    const c = await readyToSend("4.8");
    await userEvent.click(within(c).getByRole("button", { name: "Send to Canton" }));
    await screen.findByRole("listitem", { name: "Sending 4.8 CC to Canton" });
  }
  it("is not offered before Ostia has the deposit, and is offered after the set time with the fee and the cost on Ostia said", async () => {
    await sent();
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByRole("button", { name: "Claim on Ostia" })).toBeNull();
    world.stage = "ready";
    const button = await screen.findByRole("button", { name: "Claim on Ostia" });
    expect(screen.getByText("Ready on Ostia. You can claim it now with any EVM wallet.")).toBeInTheDocument();
    expect(screen.getByText("The 0.1 CC fee is still taken from the amount.")).toBeInTheDocument();
    expect(screen.getByText("Your wallet signs on Ostia (a little tROME).")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Claim/ })).toHaveTextContent("1");
    expect(button).toBeEnabled();
  });
  it("signs claim-and-pay on Ostia when Canton can pay and the router would take it, and shows Claiming with its marks", async () => {
    await sent();
    world.stage = "ready";
    await userEvent.click(await screen.findByRole("button", { name: "Claim on Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(2));
    expect(world.sent[1]).toMatchObject({ chainId: OSTIA_ID, tx: { from: ME, to: ROUTER } });
    const d = decodeFunctionData({ abi: routerAbi, data: world.sent[1]!.tx.data });
    expect(d.functionName).toBe("claimAndWithdraw");
    expect((d.args as unknown as unknown[]).slice(1).map((x) => (typeof x === "string" ? x.toLowerCase() : x))).toEqual([PARTY.toLowerCase(), 0, ME]);
    expect(await screen.findByText("Claiming…", { selector: "p" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Claim on Ostia" })).toBeNull());
  });
  it("signs the claim that only holds when Canton cannot pay, and says so under the button", async () => {
    world.accepts = { [PARTY]: false };
    await sent();
    world.stage = "ready";
    await screen.findByText("Canton cannot pay this account right now. Claiming holds it on Ostia, and you can send it back 3 days after that.");
    await userEvent.click(screen.getByRole("button", { name: "Claim on Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(2));
    expect(decodeFunctionData({ abi: routerAbi, data: world.sent[1]!.tx.data }).functionName).toBe("claimToInbox");
  });
  it("signs nothing, and says why in words, when the claim the bridge hands over is not this send's", async () => {
    await sent();
    world.stage = "ready";
    const orig = fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = orig.getMockImplementation()! as (i: string, o?: unknown) => Promise<Response>;
    orig.mockImplementation(async (input: string, init?: unknown) => (input.startsWith("/api/agglayer/claim") ? json(200, { network: 0, count: 7, claimed: false, destinationNetwork: 75, chainId: OSTIA_ID, to: OSTIA_BRIDGE, l1InfoTreeIndex: 1, data: "0x", args: { ...ARGS, destinationAddress: ME } }) : inner(input, init)));
    await userEvent.click(await screen.findByRole("button", { name: "Claim on Ostia" }));
    expect(await screen.findByText(/not this send's, so nothing was signed/)).toBeInTheDocument();
    expect(world.sent).toHaveLength(1);
  });
  it("offers none of its own while OSTIA_CLAIM_OSTIA is off", async () => {
    world.route = setupInBody({ claimOstia: null });
    await sent();
    world.stage = "ready";
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole("button", { name: "Claim on Ostia" })).toBeNull();
  });
});

describe("a coin held on Ostia, paid on, or sent back", () => {
  async function open() {
    renderPage();
    await openRoute();
    await connect();
  }
  it("shows a coin Canton could not pay as held, with the reason and the day it can go back, found by the wallet's way back", async () => {
    world.events = [held({ at: minutes(-30), refundAt: minutes(60 * 24 * 3 - 30) }), opened()];
    world.route = setupInBody({ payout: { paused: false, pausedUntil: null, assets: { [CC]: { left: 0n, renewsAt: "2026-11-22T14:05:00.000Z" } } } });
    await open();
    const row = await screen.findByRole("listitem", { name: "4.8 CC is held on Ostia for Canton account alice::1220…9f9f" });
    expect(within(row).getByText(/^Canton cannot pay this account right now: today's limit is reached\. Canton can pay out again from 14:05 UTC\. From \w{3} \d+ \w{3} \d\d:\d\d UTC you can send it back\.$/)).toBeInTheDocument();
    expect(within(row).getByLabelText("Held on Ostia: now")).toBeInTheDocument();
    expect(world.asked).toContain(`/api/canton-route/moves?evm=${encodeURIComponent(ME)}`);
  });
  it("offers Send on to Canton once Canton can pay again and the set time has passed, and signs forward on Ostia", async () => {
    world.events = [held({ at: minutes(-30), refundAt: minutes(60 * 24 * 3 - 30) }), opened()];
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Send on to Canton" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(world.sent[0]).toMatchObject({ chainId: OSTIA_ID, tx: { to: ROUTER } });
    expect(decodeFunctionData({ abi: routerAbi, data: world.sent[0]!.tx.data }).functionName).toBe("forward");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send on to Canton" })).toBeNull());
    expect(screen.getByText("Sending on to Canton…")).toBeInTheDocument();
  });
  it("offers Send back from the end of the wait, with the way back and the fee, and signs refund on Ostia", async () => {
    world.events = [held({ at: minutes(-60 * 24 * 3 - 30), refundAt: minutes(-30) }), opened()];
    await open();
    const button = await screen.findByRole("button", { name: "Send back to Ethereum Sepolia" });
    expect(screen.getByText(/^Goes back to 0xe3e3…e3e3\. The 0\.2 CC fee is still taken from the amount\.$/)).toBeInTheDocument();
    expect(screen.getByText(/^Held on Ostia since \w{3} \d+ \w{3} \d\d:\d\d UTC\. It can go back now\.$/)).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(decodeFunctionData({ abi: routerAbi, data: world.sent[0]!.tx.data }).functionName).toBe("refund");
  });
  it.each([
    ["waits in the pool", { status: "waiting", state: "pending", block: null }, true],
    ["was replaced", { status: "replaced", state: "replaced", block: null }, true],
    ["is in a block", { status: "proving", state: "proving", block: { number: 5, hash: "0x" + "bb".repeat(32), updateId: null } }, false],
  ])("a Send on to Canton that %s past the set time: the left-out line shows only when it is in no block", async (_name, tx, leftOut) => {
    world.route = setupInBody({ claimOstia: { afterSeconds: 600, leftOutSeconds: 1 } });
    world.events = [held({ at: minutes(-30), refundAt: minutes(60 * 24 * 3 - 30) }), opened()];
    world.tx = tx;
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Send on to Canton" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    await screen.findByText("Sending on to Canton…");
    if (leftOut) {
      expect(await screen.findByText(/^Canton did not pay this out\. It is still held on Ostia\./, undefined, { timeout: 3000 })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Send on to Canton" })).toBeEnabled();
    } else {
      await new Promise((r) => setTimeout(r, 1500));
      expect(screen.queryByText(/^Canton did not pay this out/)).toBeNull();
      expect(screen.getByText("Sending on to Canton…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send on to Canton" })).toBeNull();
    }
  });
  it.each([
    ["the coin's asset is stopped", { route: "stopped" as const }, { open: false }],
    ["both directions are off", { route: "stopped" as const }, {}],
  ])("still offers Send back for a held coin past the set time when %s", async (_name, flow, asset) => {
    world.route = { ...(setupInBody(flow, asset) as object), route: "stopped" };
    world.events = [held({ at: minutes(-60 * 24 * 3 - 30), refundAt: minutes(-30) }), opened()];
    await open();
    const button = await screen.findByRole("button", { name: "Send back to Ethereum Sepolia" });
    await userEvent.click(button);
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(decodeFunctionData({ abi: routerAbi, data: world.sent[0]!.tx.data }).functionName).toBe("refund");
  });
  it("shows Arrived for a coin Canton paid, and a send back with its steps and the claim on Ethereum Sepolia when it is ready", async () => {
    world.events = [refunded({ at: minutes(-30) }), forwarded({ at: minutes(-60 * 24) }), opened()];
    world.stage = "ready";
    await open();
    await userEvent.click(await screen.findByRole("tab", { name: /Activity/ }));
    expect(await screen.findByRole("listitem", { name: "Arrived. 4.7 CC is in Canton account alice::1220…9f9f." })).toBeInTheDocument();
    const back = await screen.findByRole("listitem", { name: /^Sent back\. 4\.6 CC goes back to 0xe3e3…e3e3 on Ethereum Sepolia\.$/ });
    for (const label of ["Sent back from Ostia: done", "Confirmed on Ethereum Sepolia: done", "Arrived back: waiting"]) expect(within(back).getByLabelText(label)).toBeInTheDocument();
    await userEvent.click(await within(back).findByRole("button", { name: "Claim on Ethereum Sepolia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(world.sent[0]).toMatchObject({ chainId: SEPOLIA_ID, tx: { to: SEPOLIA_BRIDGE } });
    expect(world.asked.some((a) => a.startsWith("/api/agglayer/deposit?network=75&count=9"))).toBe(true);
  });
  it("shows two sends held on one clock as one row, the sends listed under it, with one Send on to Canton and one Send back", async () => {
    const mine = (id: string, count: number, minutesAgo: number) => ({ id, account: ME, at: Date.now() - minutesAgo * 60_000, route: "canton-in", dir: "in", symbol: "CC", decimals: 10, native: false, amount: cc(4.8).toString(),
      send: { chainId: SEPOLIA_ID, to: COPY, data: "0x", value: "0", nonce: 1, tx: SEND_HASH }, count, claim: null, receiver: INBOX, party: PARTY });
    for (const t of [mine("s1", 7, 60 * 24 * 3 + 90), mine("s2", 8, 60 * 24 * 3 + 80)]) localStorage.setItem(`agglayer-transfer:${t.id}`, JSON.stringify(t));
    localStorage.setItem("agglayer-transfers", JSON.stringify(["s1", "s2"]));
    world.stage = "claimed";
    world.events = [held({ at: minutes(-60 * 24 * 3 - 30), refundAt: minutes(-30), balance: cc(9.6) }), opened()];
    await open();
    const row = await screen.findByRole("listitem", { name: "9.6 CC is held on Ostia for Canton account alice::1220…9f9f" });
    expect(within(row).getAllByRole("button", { name: "Send back to Ethereum Sepolia" })).toHaveLength(1);
    expect(within(screen.getByRole("list", { name: "The sends held together" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByRole("listitem", { name: /is held on Ostia/ })).toHaveLength(1);
  });
  it("is found again after a reload: a new page reads the same rows from the server", async () => {
    world.events = [held({ at: minutes(-30), refundAt: minutes(60 * 24 * 3 - 30) }), opened()];
    const first = renderPage();
    await openRoute();
    await connect();
    await screen.findByRole("listitem", { name: /is held on Ostia for Canton account/ });
    first.unmount();
    renderPage();
    await openRoute();
    expect(await screen.findByRole("listitem", { name: /is held on Ostia for Canton account/ })).toBeInTheDocument();
  });
  it("never says pending, Receive, gas, other chains or inbox anywhere on the card or the rows", async () => {
    world.events = [held({ at: minutes(-60 * 24 * 3 - 30), refundAt: minutes(-30) }), forwarded({ at: minutes(-5000) }), opened()];
    await open();
    await screen.findByRole("button", { name: "Send back to Ethereum Sepolia" });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/pending|receive|\bgas\b|other chains|inbox|relayer/i);
  });
});
