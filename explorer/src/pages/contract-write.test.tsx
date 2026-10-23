// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addr, contractDetail, contractSource } from "../test-utils.tsx";
import { open, TOKEN_ABI } from "./contract-harness.tsx";

const ME = addr(0xe3), OTHER = addr(0xe6);
const ABI = [...TOKEN_ABI, { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }];
interface Call { method: string; params?: unknown[] }
/** A stand-in EIP-1193 wallet: no key, no network. It answers what a wallet answers and records what it was asked. */
function standIn(over: Partial<Record<string, (p?: unknown[]) => unknown>> = {}) {
  const asked: Call[] = [];
  const listeners: Record<string, ((v: unknown) => void)[]> = {};
  const answers: Record<string, (p?: unknown[]) => unknown> = {
    eth_requestAccounts: () => [ME.toUpperCase().replace("0X", "0x")], eth_chainId: () => "0x1", // status() says chain 770101 unless a test changes it
    eth_sendTransaction: () => "0x" + "ab".repeat(32), ...over,
  };
  const wallet = {
    request: vi.fn(async (c: Call) => { asked.push(c); const a = answers[c.method]; if (!a) throw Object.assign(new Error("unsupported"), { code: 4200 }); return a(c.params); }),
    on: (e: string, f: (v: unknown) => void) => { (listeners[e] ??= []).push(f); },
    removeListener: (e: string, f: (v: unknown) => void) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
  };
  vi.stubGlobal("ethereum", wallet);
  Object.defineProperty(window, "ethereum", { value: wallet, configurable: true, writable: true });
  return { asked, emit: (e: string, v: unknown) => (listeners[e] ?? []).forEach((f) => f(v)) };
}
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(window, "ethereum"); });
const sources = { [addr(0xcb)]: contractSource(0xcb, { abi: ABI }) };
const chainHex = async () => { const { status } = await import("../test-utils.tsx"); return "0x" + status().chainId.toString(16); };

describe("the contract page: Write", () => {
  it("opens with the standard card header, a dashed wallet notice with the Connect button, and names-only function heads", async () => {
    await open("write", { sources });
    const card = await screen.findByRole("region", { name: "Write contract" });
    expect(within(card).getByRole("heading", { level: 2, name: "Write contract" }).closest(".card-head")).not.toBeNull();
    const bar = within(card).getByRole("group", { name: "Wallet" });
    expect(bar).toHaveClass("wallet-bar");
    expect(bar).toHaveTextContent("Waiting, Being proven and Final");
    expect(within(bar).getByRole("button", { name: /Connect wallet/ })).toHaveClass("btn");
    const fn = screen.getByRole("region", { name: "transfer" });
    expect(fn.querySelector(".fn-args")).toHaveTextContent("(to, value)");
    expect(within(fn).getByRole("button", { name: "Write" })).toHaveClass("btn-line");
  });

  it("lists the state-changing functions with their fields, and holds the Write buttons until a wallet is connected", async () => {
    await open("write", { sources });
    expect(screen.getByRole("region", { name: "transfer" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "allowance" })).toBeNull();
    expect(screen.getByText(/The explorer holds no key/)).toBeInTheDocument();
    const t = screen.getByRole("region", { name: "transfer" });
    expect(within(t).getByPlaceholderText("to (address)")).toBeInTheDocument();
    expect(within(t).getByRole("button", { name: "Write" })).toBeDisabled();
    expect(within(t).getByText("Connect a wallet first")).toBeInTheDocument();
  });

  it("connects an injected wallet, encodes the call and sends it through the wallet, then links the transaction", async () => {
    const w = standIn({ eth_chainId: async () => await chainHex() });
    const { rpcCalls } = await open("write", { sources });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
    const t = screen.getByRole("region", { name: "transfer" });
    await userEvent.type(within(t).getByLabelText("to (address)"), OTHER);
    await userEvent.type(within(t).getByLabelText("value (uint256)"), "400");
    await userEvent.click(within(t).getByRole("button", { name: "Write" }));
    const link = await within(t).findByRole("link", { name: /0xabab/ });
    expect(link).toHaveAttribute("href", `/tx/0x${"ab".repeat(32)}`);
    const sent = w.asked.find((c) => c.method === "eth_sendTransaction")!;
    expect(sent.params).toEqual([{ from: ME, to: addr(0xcb), chainId: await chainHex(), data: "0xa9059cbb" + OTHER.slice(2).padStart(64, "0") + (400).toString(16).padStart(64, "0") }]);
    expect(rpcCalls.filter((c) => c.method === "eth_sendRawTransaction" || c.method === "eth_sendTransaction")).toHaveLength(0); // the page itself sends nothing
  });

  it("sends a payable function's value in the coin's units", async () => {
    const w = standIn({ eth_chainId: async () => await chainHex() });
    await open("write", { sources });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await screen.findByText(/Connected/);
    const d = screen.getByRole("region", { name: "deposit" });
    await userEvent.type(within(d).getByLabelText(/^Value/), "0.5");
    await userEvent.click(within(d).getByRole("button", { name: "Write" }));
    await waitFor(() => expect(w.asked.some((c) => c.method === "eth_sendTransaction")).toBe(true));
    const p = (w.asked.find((c) => c.method === "eth_sendTransaction")!.params![0]) as { value: string; data: string };
    expect(p.data).toBe("0xd0e30db0");
    expect(BigInt(p.value)).toBe(5n * 10n ** 17n);
  });

  it("holds the buttons and offers to switch when the wallet is on another chain", async () => {
    const w = standIn({ eth_chainId: () => "0x1", wallet_switchEthereumChain: () => null });
    await open("write", { sources });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByText(/Your wallet is on chain 1/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "transfer" })).getByRole("button", { name: "Write" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Switch network" }));
    expect(w.asked.find((c) => c.method === "wallet_switchEthereumChain")!.params).toEqual([{ chainId: await chainHex() }]);
  });

  it("keeps Write off while it is not known which chain the wallet is on", async () => {
    const w = standIn({ eth_chainId: () => { throw new Error("no chain"); } });
    await open("write", { sources });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    const t = screen.getByRole("region", { name: "transfer" });
    await waitFor(() => expect(within(t).getByText(/Checking which chain/)).toBeInTheDocument());
    expect(within(t).getByRole("button", { name: "Write" })).toBeDisabled();
    expect(w.asked.some((c) => c.method === "eth_sendTransaction")).toBe(false);
  });

  it("says in plain words that the person declined, and that a wallet is missing", async () => {
    standIn({ eth_requestAccounts: () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } });
    await open("write", { sources });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You declined it in your wallet.");
  });

  it("does not offer a wallet that is not there", async () => {
    await open("write", { sources });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect((await screen.findAllByText(/No wallet was found in this browser/)).length).toBeGreaterThan(0);
  });

  it("says what is wrong with a field and asks the wallet nothing", async () => {
    const w = standIn({ eth_chainId: async () => await chainHex() });
    await open("write", { sources });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await screen.findByText(/Connected/);
    const t = screen.getByRole("region", { name: "transfer" });
    await userEvent.type(within(t).getByLabelText("to (address)"), "nope");
    await userEvent.click(within(t).getByRole("button", { name: "Write" }));
    expect(await within(t).findByRole("alert")).toHaveTextContent(/address is 0x and 40 hex digits/);
    expect(w.asked.some((c) => c.method === "eth_sendTransaction")).toBe(false);
  });

  it("writes a proxy through the implementation's ABI, to the proxy's address", async () => {
    const IMPL = addr(0xdd);
    const w = standIn({ eth_chainId: async () => await chainHex() });
    await open("write", { detail: contractDetail(0xcb, { proxy: { kind: "eip1967", implementation: IMPL, beacon: null, checkedBlock: 21 } }), sources: { [addr(0xcb)]: contractSource(0xcb, { abi: [] }), [IMPL]: contractSource(0xdd, { abi: ABI }) } });
    await userEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await screen.findByText(/Connected/);
    const t = screen.getByRole("region", { name: "transfer" });
    await userEvent.type(within(t).getByLabelText("to (address)"), OTHER);
    await userEvent.type(within(t).getByLabelText("value (uint256)"), "1");
    await userEvent.click(within(t).getByRole("button", { name: "Write" }));
    await waitFor(() => expect(w.asked.some((c) => c.method === "eth_sendTransaction")).toBe(true));
    expect((w.asked.find((c) => c.method === "eth_sendTransaction")!.params![0] as { to: string }).to).toBe(addr(0xcb));
  });

  describe("who may call", () => {
    const OWNED = [
      ...TOKEN_ABI,
      { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
      { type: "function", name: "renounceOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },
      { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
    ];
    const word = (a: string) => "0x" + a.slice(2).padStart(64, "0");
    const rpcOf = (owner: string) => (c: { method: string; params: unknown[] }) => c.method === "eth_blockNumber" ? "0x15" : (c.params[0] as { data: string }).data === "0x8da5cb5b" ? word(owner) : "0x";

    it("names the owner on the functions only an owner calls, by an eth_call to owner() at the final block", async () => {
      const { rpcCalls } = await open("write", { sources: { [addr(0xcb)]: contractSource(0xcb, { abi: OWNED }) }, rpc: rpcOf(ME) });
      const t = screen.getByRole("region", { name: "transferOwnership" });
      expect(await within(t).findByText(`only the owner, ${ME.slice(0, 8)}…${ME.slice(-4)}`)).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "renounceOwnership" })).getByText(/^only the owner, /)).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "transfer" })).queryByText(/only the owner/)).toBeNull();
      expect(rpcCalls.filter((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data === "0x8da5cb5b")).toHaveLength(1);
    });

    it("says only that a name like mint is usually limited to the owner, since the ABI cannot show it", async () => {
      await open("write", { sources: { [addr(0xcb)]: contractSource(0xcb, { abi: OWNED }) }, rpc: rpcOf(ME) });
      expect(await within(screen.getByRole("region", { name: "mint" })).findByText(`usually only the owner, ${ME.slice(0, 8)}…${ME.slice(-4)}`)).toBeInTheDocument();
    });

    it("says there is no owner now when ownership was renounced", async () => {
      await open("write", { sources: { [addr(0xcb)]: contractSource(0xcb, { abi: OWNED }) }, rpc: rpcOf("0x" + "00".repeat(20)) });
      expect(await within(screen.getByRole("region", { name: "transferOwnership" })).findByText("only the owner, and there is none now (renounced)")).toBeInTheDocument();
    });

    it("guesses nothing and asks nothing when the ABI has no owner()", async () => {
      const NO = OWNED.filter((f) => f.name !== "owner");
      const { rpcCalls } = await open("write", { sources: { [addr(0xcb)]: contractSource(0xcb, { abi: NO }) }, rpc: rpcOf(ME) });
      await screen.findByRole("region", { name: "transferOwnership" });
      expect(screen.queryByText(/only the owner/)).toBeNull();
      expect(rpcCalls.filter((c) => c.method === "eth_call")).toHaveLength(0);
    });
  });
});
