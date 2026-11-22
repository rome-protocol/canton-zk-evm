// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimData, eventLog, ME, memoryLocks, OSTIA_BRIDGE, OSTIA_ID, row, SEPOLIA_BRIDGE, SEPOLIA_ID, setupBody, stage, TOPIC, WETH } from "../bridge/other/fakes.ts";
import { OtherChains } from "./OtherChains.tsx";
import { renderApp, status } from "../test-utils.tsx";
import { parseSetup } from "../bridge/other/setup.ts";

const AMOUNT = 2_000_000_000_000_000n;   // 0.002
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The explorer's API and RPC, and the person's wallet, as one set of switches a test turns. */
const world = {
  setup: setupBody() as unknown, stage: "unknown" as string, count: 7, claimed: false,
  chain: SEPOLIA_ID, connected: false, nonce: { [SEPOLIA_ID]: 4, [OSTIA_ID]: 7 } as Record<number, number>,
  sent: [] as { chainId: number; tx: any; hash: string }[], receipts: new Map<string, unknown>(), next: [] as string[],
  coin: 5n * 10n ** 18n, weth: 3n * 10n ** 15n, eth: 5n * 10n ** 18n, switches: [] as number[], asked: [] as string[], faucetPosts: 0, hold: null as Promise<void> | null,
};
const reset = () => Object.assign(world, { setup: setupBody(), stage: "unknown", count: 7, claimed: false, chain: SEPOLIA_ID, connected: false, nonce: { [SEPOLIA_ID]: 4, [OSTIA_ID]: 7 }, sent: [], receipts: new Map(), next: [], coin: 5n * 10n ** 18n, weth: 3n * 10n ** 15n, eth: 5n * 10n ** 18n, switches: [], asked: [], faucetPosts: 0, hold: null });
const hex = (n: bigint | number) => "0x" + n.toString(16);

function wireFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    world.asked.push(input);
    if (input === "/api/status") return json(200, status());
    if (input === "/api/agglayer/setup") return world.setup === null ? json(404, { error: "Not found." }) : json(200, world.setup);
    if (input === "/api/faucet" && init?.method === "POST") { world.faucetPosts++; return json(202, { ticket: "t", position: 1, to: ME, amount: "1000000000000000000" }); }
    if (input === "/api/faucet") return json(200, { on: true, address: "0x" + "fa".repeat(20), balance: "1000000000000000000", amount: "1000000000000000000", perAddressSeconds: 86400, queue: 0, balanceBlock: 1 });
    if (input.startsWith("/api/agglayer/deposit")) return json(200, { network: 0, count: world.count, destinationNetwork: 75, ...stage(world.stage as never) });
    if (input.startsWith("/api/agglayer/claim")) {
      const out = input.includes("network=75");
      return json(200, { network: out ? 75 : 0, count: world.count, claimed: world.claimed, destinationNetwork: out ? 0 : 75, chainId: out ? SEPOLIA_ID : OSTIA_ID, to: out ? SEPOLIA_BRIDGE : OSTIA_BRIDGE, l1InfoTreeIndex: 1, data: world.claimed ? null : claimData(out ? 0 : 75, ME, AMOUNT, world.count), args: null });
    }
    if (input.startsWith("/api/tx/")) return json(404, { error: "Not found." });
    if (input === "/rpc") {
      const call = JSON.parse(String(init!.body));
      const result = (() => {
        switch (call.method) {
          case "eth_getBalance": return hex(world.coin);
          case "eth_call": return "0x" + world.weth.toString(16).padStart(64, "0");
          case "eth_estimateGas": return "0x30d40";
          case "eth_getTransactionReceipt": return world.receipts.get(call.params[0]) ?? null;
          default: throw new Error(`the explorer's RPC was asked ${call.method}`);
        }
      })();
      return json(200, { jsonrpc: "2.0", id: call.id, result });
    }
    return json(404, { error: "Not found." });
  }));
}

function wireWallet() {
  const w = {
    on: vi.fn(), removeListener: vi.fn(),
    request: vi.fn(async ({ method, params = [] }: { method: string; params?: any[] }) => {
      switch (method) {
        case "eth_requestAccounts": world.connected = true; return [ME];
        case "eth_accounts": return world.connected ? [ME] : [];
        case "eth_chainId": return hex(world.chain);
        case "wallet_switchEthereumChain": world.chain = Number(BigInt(params[0].chainId)); world.switches.push(world.chain); return null;
        case "eth_getBalance": return hex(world.eth);
        case "eth_getTransactionCount": return hex(world.nonce[world.chain]! + (params[1] === "pending" ? world.sent.filter((s) => s.chainId === world.chain).length : 0));
        case "eth_estimateGas": return "0x30d40";
        case "eth_sendTransaction": {
          const how = world.next.shift() ?? "ok";
          if (world.hold) await world.hold;   // the pop-up is open, and the person has not answered
          if (how === "refuse") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          const hash = "0x" + (0x2000 + world.sent.length).toString(16).padStart(64, "0");
          if (how === "silent") throw new Error("The request timed out.");
          world.sent.push({ chainId: world.chain, tx: params[0], hash });
          return hash;
        }
        case "eth_getTransactionReceipt": return world.receipts.get(params[0]) ?? null;
        case "eth_getTransactionByHash": return null;
        default: throw new Error(`the wallet was asked ${method}`);
      }
    }),
  };
  Object.defineProperty(window, "ethereum", { value: w, configurable: true, writable: true });
  return w;
}

beforeEach(() => {
  reset();
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { value: memoryLocks(), configurable: true });
  wireFetch();
  window.scrollTo = () => {};
});
afterEach(() => { Reflect.deleteProperty(window, "ethereum"); Reflect.deleteProperty(navigator, "locks"); });

function renderPage(over: { pollMs?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setup = parseSetup(world.setup);
  if (!setup.on) throw new Error("the test's setup is off");
  return render(<QueryClientProvider client={client}><MemoryRouter><OtherChains tabs={null} setup={setup} pollMs={over.pollMs ?? 40} /></MemoryRouter></QueryClientProvider>);
}
const connect = async () => { await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" })); await screen.findByRole("button", { name: "Enter an amount" }); };
const type = async (text: string) => userEvent.type(await screen.findByRole("textbox", { name: "Amount to move" }), text);
const sentTo = (bridge: string) => world.sent.filter((s) => s.tx.to.toLowerCase() === bridge.toLowerCase());
/** The send in the wallet is in a block, with its deposit number. */
const mined = (index: number, bridge: string, dest: number) => world.receipts.set(world.sent[index]!.hash, { status: "0x1", logs: [eventLog({ bridge, dest, amount: AMOUNT, count: world.count })] });

describe("the Bridge page and its Other chains tab", () => {
  it("is the Canton page alone, with no tab, when the server says the AggLayer bridge is off", async () => {
    world.setup = { on: false };
    renderApp("/bridge");
    expect(await screen.findByText("The bridge is not set up on this site yet.")).toBeInTheDocument();
    await waitFor(() => expect(world.asked).toContain("/api/agglayer/setup"));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole("tab", { name: "Other chains" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Bridge pages" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Bridge" })).toBeInTheDocument();
  });
  it("is the same when the server does not have the routes at all, and when the answer is not the documented one", async () => {
    for (const setup of [null, { error: "x" }, { on: true }, "yes"]) {
      reset(); world.setup = setup;
      const { unmount } = renderApp("/bridge");
      await screen.findByText("The bridge is not set up on this site yet.");
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      expect(screen.queryByRole("tab", { name: "Other chains" })).toBeNull();
      unmount();
    }
  });
  it("shows the tab next to Canton when the server says it is on, and opens the other page in it", async () => {
    renderApp("/bridge");
    const tab = await screen.findByRole("tab", { name: "Other chains" });
    expect(screen.getByRole("tab", { name: "Canton" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("The bridge is not set up on this site yet.")).toBeVisible();   // the Canton page, as it was
    await userEvent.click(tab);
    expect(await screen.findByRole("region", { name: "Route" })).toBeInTheDocument();
    expect(screen.getByText("The bridge is not set up on this site yet.")).not.toBeVisible();   // the Canton page is hidden, not gone
    expect(screen.getAllByRole("heading", { level: 1, name: "Bridge" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Other chains" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Canton" }));
    expect(await screen.findByText("The bridge is not set up on this site yet.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Route" })).toBeNull();
  });
  it("opens at the tab's own address, without showing the Canton page first", async () => {
    renderApp("/bridge?tab=other-chains");
    expect(await screen.findByRole("region", { name: "Route" })).toBeInTheDocument();
    expect(screen.queryByText("The bridge is not set up on this site yet.")).not.toBeVisible();
  });
  it("shows the Canton page for the tab's address when the tab does not exist", async () => {
    world.setup = { on: false };
    renderApp("/bridge?tab=other-chains");
    expect(await screen.findByText("The bridge is not set up on this site yet.")).toBeVisible();
  });
});

describe("the routes", () => {
  it("lists Ethereum Sepolia as open, Hadrian and Solana devnet as not yet open, with no date and no reason, and no other chain", async () => {
    renderPage();
    const list = await screen.findByRole("region", { name: "Route" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/Ostia.*Ethereum Sepolia.*via AggLayer/);
    expect(items[1]).toHaveTextContent(/Ostia.*Hadrian/);
    expect(items[2]).toHaveTextContent(/Ostia.*Solana devnet/);
    expect(within(items[0]!).getByRole("button", { name: /Ethereum Sepolia/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(items[1]!).getByText("Not yet open")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Not yet open")).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button")).toBeNull();
    expect(list.textContent).not.toMatch(/Katana|X Layer|Solgate|soon|202\d|because/i);
  });
  it("says a route that cannot be used right now is not available, and offers no send", async () => {
    world.setup = setupBody({ available: false });
    renderPage();
    await connect().catch(() => {});
    expect(await screen.findByText("Ethereum Sepolia is not available right now. Nothing is lost.")).toBeInTheDocument();
  });
  it("shows no time until a measured one is set, and then the measured range for the direction", async () => {
    const { unmount } = renderPage();
    await screen.findByRole("textbox", { name: "Amount to move" });
    expect(screen.queryByText(/^Time /)).toBeNull();
    unmount();
    world.setup = setupBody({ times: { in: { minSeconds: 240, maxSeconds: 420 }, out: { minSeconds: 480, maxSeconds: 960 } } });
    renderPage();
    expect(await screen.findByText("Time about 4 to 7 minutes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Swap direction" }));
    expect(screen.getByText("Time about 8 to 16 minutes")).toBeInTheDocument();
  });
  it("says what the trust is where ETH is moved, and that these are test tokens", async () => {
    renderPage();
    await screen.findByRole("textbox", { name: "Amount to move" });
    expect(screen.getByText(/ETH you send to Ostia stays locked on Ethereum Sepolia, and Ostia cannot send out more of it than came in\. While it is on Ostia as WETH, it rests on Rome's keys for the bridge\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Limits" })).toHaveAttribute("href", "https://docs.rome.builders/canton-zk-evm/trust-model");
    expect(screen.getByText("Test tokens only. Ostia has not been independently audited.")).toBeInTheDocument();
  });
});

describe("Ethereum Sepolia to Ostia", () => {
  it("says to bring Sepolia ETH before the pop-up, and sends one deposit with the amount as its value, from the wallet on Sepolia", async () => {
    wireWallet();
    world.chain = OSTIA_ID;
    renderPage();
    expect(await screen.findByText(/Bring your own Sepolia ETH/)).toBeInTheDocument();
    await connect();
    await type("0.002");
    expect(screen.getByRole("textbox", { name: "Amount you get" })).toHaveValue("0.002");
    expect(screen.getByRole("button", { name: "Send to Ostia" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(world.switches).toEqual([SEPOLIA_ID]);
    expect(world.sent[0]!.tx).toMatchObject({ from: ME, to: SEPOLIA_BRIDGE, value: hex(AMOUNT) });
    expect(await screen.findByRole("listitem", { name: "Sending 0.002 ETH to Ostia" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Sent on Ethereum Sepolia: now" })).toBeInTheDocument();
    expect(screen.getByText("You can leave this page. This transfer stays in Activity.")).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Amount to move" })).toHaveValue("");
  });
  it("walks the steps with the words of the design, then the person claims on Ostia, and it arrives", async () => {
    wireWallet();
    renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "confirmed";
    expect(await screen.findByRole("listitem", { name: "Sent on Ethereum Sepolia: done" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Ready to claim on Ostia: now" })).toHaveTextContent("Confirming…");
    expect(screen.queryByRole("button", { name: "Claim on Ostia" })).toBeNull();
    world.stage = "ready";
    const claim = await screen.findByRole("button", { name: "Claim on Ostia" });
    expect(screen.getByRole("listitem", { name: "Claim on Ostia: now" })).toHaveTextContent("Your move");
    expect(screen.getByText("Your wallet switches to Ostia. Its fee is paid in tROME.")).toBeInTheDocument();
    expect(within(screen.getByRole("tablist", { name: "Other chains" })).getByRole("tab", { name: /Claim/ })).toHaveTextContent("Claim1");
    await userEvent.click(claim);
    await waitFor(() => expect(world.sent).toHaveLength(2));
    expect(world.sent[1]!.tx).toMatchObject({ from: ME, to: OSTIA_BRIDGE, value: "0x0" });
    expect(world.switches).toEqual([OSTIA_ID]);
    expect(screen.queryByRole("button", { name: "Claim on Ostia" })).toBeNull();   // asked once
    world.receipts.set(world.sent[1]!.hash, { status: "0x1", logs: [] });
    expect(await screen.findByRole("listitem", { name: "Arrived. 0.002 WETH is in your wallet." })).toBeInTheDocument();
    expect(world.sent).toHaveLength(2);
  });
  it("picks up where it was after a reload, and signs nothing on its own", async () => {
    wireWallet();
    const first = renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "ready";
    await screen.findByRole("button", { name: "Claim on Ostia" });
    first.unmount();
    renderPage();
    expect(await screen.findByRole("button", { name: "Claim on Ostia" })).toBeInTheDocument();   // the wallet is still connected: the record is found again
    expect(screen.getByRole("listitem", { name: "Sent on Ethereum Sepolia: done" })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
    expect(world.sent).toHaveLength(1);
  });
  it("says Already arrived and sends nothing when the claim was made elsewhere", async () => {
    wireWallet();
    renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "ready";
    await screen.findByRole("button", { name: "Claim on Ostia" });
    world.claimed = true;
    await userEvent.click(screen.getByRole("button", { name: "Claim on Ostia" }));
    expect(await screen.findByText("Already arrived.")).toBeInTheDocument();
    expect(world.sent).toHaveLength(1);
  });
  it("sends once when the button is pressed twice", async () => {
    wireWallet();
    renderPage();
    await connect();
    await type("0.002");
    const button = screen.getByRole("button", { name: "Send to Ostia" });
    await userEvent.dblClick(button);
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(world.sent).toHaveLength(1);
  });
  it("leaves no record and says so in words when the person turns the send down", async () => {
    wireWallet();
    world.next = ["refuse"];
    renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    expect(await screen.findByText("You declined it in your wallet.")).toBeInTheDocument();
    expect(world.sent).toEqual([]);
    expect(screen.queryByRole("listitem", { name: /Sending/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem("agglayer-transfers") ?? "[]")).toEqual([]);
  });
  it("keeps a send the wallet did not answer, asks nothing of the wallet for it again, and looks for it only when asked", async () => {
    wireWallet();
    world.next = ["silent"];
    renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    expect((await screen.findAllByText(/Your wallet did not say whether it sent this\./)).length).toBeGreaterThan(0);
    const row = await screen.findByRole("listitem", { name: "Sending 0.002 ETH to Ostia" });
    expect(within(row).getByText("Check your wallet", { selector: "span.small" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Send to Ostia/ })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Look for it" }));
    expect(await within(row).findByText("Your wallet did not send it. You can send it again.")).toBeInTheDocument();
    await userEvent.click(await within(await screen.findByRole("listitem", { name: "Sending 0.002 ETH to Ostia" })).findByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
  });
  it("says only that the wallet is being asked while its pop-up stays open longer than a look takes: no alert, no Look for it, no give-up", async () => {
    wireWallet();
    let answer!: () => void;
    world.hold = new Promise<void>((r) => { answer = r; });
    renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    const row = await screen.findByRole("listitem", { name: "Sending 0.002 ETH to Ostia" });
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });   // several looks, as the poll is 40 ms here
    expect(within(row).getByRole("listitem", { name: "Sent on Ethereum Sepolia: now" })).toHaveTextContent("Confirm in your wallet…");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Look for it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give this transfer up" })).toBeNull();
    expect(screen.queryByText(/did not say whether/)).toBeNull();
    await act(async () => { answer(); });
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(await screen.findByText("Confirming…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Look for it" })).toBeNull();
  });
  it("says the same of a claim whose pop-up stays open, with no alert and nothing to press", async () => {
    wireWallet();
    renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "ready";
    const claim = await screen.findByRole("button", { name: "Claim on Ostia" });
    let answer!: () => void;
    world.hold = new Promise<void>((r) => { answer = r; });
    await userEvent.click(claim);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    const row = screen.getByRole("listitem", { name: "Sending 0.002 ETH to Ostia" });
    expect(within(row).getByRole("listitem", { name: "Claim on Ostia: now" })).toHaveTextContent("Confirm in your wallet…");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Look for it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give this transfer up" })).toBeNull();
    await act(async () => { answer(); });
    await waitFor(() => expect(world.sent).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Look for it" })).toBeNull();
    expect(await screen.findByRole("listitem", { name: "Claim on Ostia: now" })).toHaveTextContent("Claiming…");
  });
  it("does not start a send in a browser that keeps no site data, and says so", async () => {
    wireWallet();
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      renderPage();
      await connect();
      await type("0.002");
      await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
      expect(await screen.findByText(/This browser does not keep data for this site/)).toBeInTheDocument();
      expect(world.sent).toEqual([]);
      expect(world.switches).toEqual([]);
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real); else Reflect.deleteProperty(window, "localStorage");
    }
  });
  it("says in words when the wallet has too little for the send", async () => {
    wireWallet();
    world.eth = 1n;
    renderPage();
    await connect();
    await type("0.002");
    expect(await screen.findByRole("button", { name: "Not enough ETH" })).toBeDisabled();
  });
});

describe("Ostia to Ethereum Sepolia", () => {
  it("sends the wrapped ether from Ostia to the bridge there, shows the three marks, and the claim on Sepolia is the person's", async () => {
    wireWallet();
    renderPage();
    await connect();
    await userEvent.click(screen.getByRole("button", { name: "Swap direction" }));
    expect(await screen.findByRole("button", { name: "Max" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(screen.getByRole("textbox", { name: "Amount to move" })).toHaveValue("0.003");
    await userEvent.clear(screen.getByRole("textbox", { name: "Amount to move" }));
    await type("0.002");
    expect(screen.queryByText(/Bring your own Sepolia ETH/)).toBeNull();
    expect(screen.getByText("You need a little tROME to send, and a little Sepolia ETH to claim on Ethereum Sepolia.")).toBeInTheDocument();   // said before the send, so nobody is stuck at the claim
    await userEvent.click(screen.getByRole("button", { name: "Send to Ethereum Sepolia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    expect(world.switches).toEqual([OSTIA_ID]);
    expect(world.sent[0]!.tx).toMatchObject({ from: ME, to: OSTIA_BRIDGE, value: "0x0" });
    const row = await screen.findByRole("listitem", { name: "Sending 0.002 ETH to Ethereum Sepolia" });
    expect(within(row).getByRole("list", { name: "How far the move has got" })).toBeInTheDocument();   // Sent, Proven, Final
    mined(0, OSTIA_BRIDGE, 0);
    world.stage = "confirmed";
    expect(await within(row).findByRole("listitem", { name: "Sent on Ostia: done" })).toBeInTheDocument();
    expect(within(row).getByRole("listitem", { name: "Confirmed on Ethereum Sepolia: done" })).toBeInTheDocument();
    world.stage = "ready";
    const claim = await within(row).findByRole("button", { name: "Claim on Ethereum Sepolia" });
    expect(within(row).getByText("Your wallet switches to Ethereum Sepolia. Its fee is paid in Sepolia ETH.")).toBeInTheDocument();
    await userEvent.click(claim);
    await waitFor(() => expect(world.sent).toHaveLength(2));
    expect(world.sent[1]!.tx.to).toBe(SEPOLIA_BRIDGE);
    expect(world.chain).toBe(SEPOLIA_ID);
    world.stage = "claimed";
    expect(await screen.findByRole("listitem", { name: "Arrived. 0.002 ETH is in your wallet on Ethereum Sepolia." })).toBeInTheDocument();
  });
  it("asks for the test coin before a send on Ostia when the wallet has none", async () => {
    wireWallet();
    world.coin = 0n;
    renderPage();
    await connect().catch(() => {});
    await userEvent.click(await screen.findByRole("button", { name: "Swap direction" }));
    const get = await screen.findByRole("button", { name: "Get test tROME" });
    await userEvent.click(get);
    await waitFor(() => expect(world.faucetPosts).toBe(1));
  });
});

describe("Activity and Claim", () => {
  it("lists only the transfers started in this browser, and counts what is open and what is ready to claim", async () => {
    wireWallet();
    renderPage();
    await connect();
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("No transfers have been started in this browser yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Move" }));
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "ready";
    await screen.findByRole("button", { name: "Claim on Ostia" });
    expect(screen.getByRole("tab", { name: /Activity/ })).toHaveTextContent("Activity1");
    await userEvent.click(screen.getByRole("tab", { name: /Claim/ }));
    expect(await screen.findByRole("button", { name: "Claim on Ostia" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect(screen.getByText("Activity lists the transfers started in this browser.")).toBeInTheDocument();
    expect(screen.queryByText(/incoming/i)).toBeNull();
  });
  it("asks the person to connect the wallet to see them", async () => {
    wireWallet();
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Activity" }));
    expect(screen.getByText(/Connect your wallet to see the transfers started in this browser/)).toBeInTheDocument();
  });
});

describe("the words of the page", () => {
  it("never says pending, receive, certificate, proof, trustless, bridgeless or first, and names no time that is not measured", async () => {
    wireWallet();
    renderPage();
    await connect();
    await type("0.002");
    await userEvent.click(screen.getByRole("button", { name: "Send to Ostia" }));
    await waitFor(() => expect(world.sent).toHaveLength(1));
    mined(0, SEPOLIA_BRIDGE, 75);
    world.stage = "ready";
    await screen.findByRole("button", { name: "Claim on Ostia" });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/pending|receiv|certificate|exit root|proof|\bGER\b|trustless|bridgeless|\bfirst\b/i);
    expect(text).not.toMatch(/\bmin\b|minutes|seconds/);
    expect(TOPIC).toMatch(/^0x/);
    expect(WETH).toMatch(/^0x/);
    expect(row().id).toBe("sepolia");
  });
});
