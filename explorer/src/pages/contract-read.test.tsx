// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem";
import type { ContractDetail, ContractSource } from "../api.ts";
import { addr, addressDetail, contractDetail, contractSource, fakeApi, page, renderApp, reply, route, unverifiedSource } from "../test-utils.tsx";

const A = addr(0xcb), IMPL = addr(0xdd), ME = addr(0xe3);
const derived = <T,>(items: T[]) => reply({ ...page(items), derived: true });
export const TOKEN_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];
interface Rpc { method: string; params: unknown[] }
/** The explorer's REST API and its /rpc, both faked; `rpcCalls` is every JSON-RPC call the page made, in order. */
export async function open(tab: string, seen: { detail?: ContractDetail; sources?: Record<string, ContractSource>; rpc?: (c: Rpc) => unknown; events?: (path: string) => unknown } = {}) {
  const d = seen.detail ?? contractDetail();
  const sources = seen.sources ?? { [A]: contractSource(0xcb, { abi: TOKEN_ABI }) };
  const rpcCalls: Rpc[] = [];
  const calls = fakeApi(route({
    contracts: (a, sub, path) => (sub === "source" ? reply(sources[a] ?? unverifiedSource()) : sub === "events" ? reply((seen.events ?? (() => page([])))(path)) : a === A ? reply(d) : reply({ error: "none" }, 404)),
    addresses: (_a, sub) => (sub === "" ? reply(addressDetail({ address: A, kind: "contract" })) : derived([])),
  }));
  const rest = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input !== "/rpc") return rest(input, init);
    const c = JSON.parse(init!.body as string) as Rpc;
    rpcCalls.push(c);
    const r = (seen.rpc ?? ((x: Rpc) => (x.method === "eth_blockNumber" ? "0x15" : "0x")))(c);
    return new Response(JSON.stringify(r instanceof Error ? { error: { code: 3, message: r.message } } : { result: r }), { status: 200 });
  }));
  renderApp(`/contract/${A}?tab=${tab}`);
  await screen.findByRole("heading", { name: "Contract" });
  await screen.findByRole("region", { name: { read: "Read contract", write: "Write contract", events: "Events" }[tab] ?? "Overview" });
  return { calls, rpcCalls };
}
afterEach(() => vi.unstubAllGlobals());
const word = (t: string, v: unknown) => encodeAbiParameters([{ type: t }], [v as never]);

describe("the contract page: Read", () => {
  it("calls the functions that take nothing at once, through /rpc at the final block, and shows the decoded answers", async () => {
    const { rpcCalls } = await open("read", { rpc: (c) => c.method === "eth_blockNumber" ? "0x15" : (c.params[0] as { data: string }).data === "0x06fdde03" ? word("string", "Test USD") : word("address", ME) });
    const name = await screen.findByRole("region", { name: "name" });
    expect(await within(name).findByText("Test USD")).toBeInTheDocument();
    expect(within(name).getByText("answered at block 21")).toBeInTheDocument();
    const owner = screen.getByRole("region", { name: "owner" });
    expect(await within(owner).findByRole("link", { name: ME })).toHaveAttribute("href", `/address/${ME}`);
    const calls = rpcCalls.filter((c) => c.method === "eth_call");
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.params).toEqual([{ to: A, data: expect.stringMatching(/^0x[0-9a-f]{8}$/) }, "0x15"]);
    expect(screen.queryByRole("region", { name: "transfer" })).toBeNull(); // a write is on the Write tab
    expect(screen.getByText(/Nothing is signed and nothing is sent/)).toBeInTheDocument();
  });

  it("asks for typed inputs, encodes them, and shows the answer under the Query button", async () => {
    const { rpcCalls } = await open("read", { rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : word("uint256", 5000n)) });
    const box = screen.getByRole("region", { name: "allowance" });
    await userEvent.click(within(box).getByRole("button", { name: /allowance/ }));
    await userEvent.type(within(box).getByLabelText("owner (address)"), ME);
    await userEvent.type(within(box).getByLabelText("spender (address)"), addr(0xe6));
    await userEvent.click(within(box).getByRole("button", { name: "Query" }));
    expect(await within(box).findByText("5000")).toBeInTheDocument();
    const call = rpcCalls.find((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data.startsWith("0xdd62ed3e"))!;
    expect((call.params[0] as { data: string }).data).toBe("0xdd62ed3e" + ME.slice(2).padStart(64, "0") + addr(0xe6).slice(2).padStart(64, "0"));
  });

  it("says what is wrong with a field and sends nothing", async () => {
    const { rpcCalls } = await open("read");
    const box = screen.getByRole("region", { name: "allowance" });
    await userEvent.click(within(box).getByRole("button", { name: /allowance/ }));
    await userEvent.type(within(box).getByLabelText("owner (address)"), "0x12");
    await userEvent.click(within(box).getByRole("button", { name: "Query" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent(/address is 0x and 40 hex digits/);
    expect(rpcCalls.filter((c) => c.params[0] && (c.params[0] as { data?: string }).data?.startsWith("0xdd62ed3e"))).toHaveLength(0);
  });

  it("shows a revert as the node worded it, and reads again on request", async () => {
    let n = 0;
    const { rpcCalls } = await open("read", { rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : ++n <= 2 ? new Error("execution reverted: not today") : word("string", "Test USD")) });
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("execution reverted: not today");
    await userEvent.click(screen.getByRole("button", { name: "Read again" }));
    expect(await screen.findByText("Test USD")).toBeInTheDocument();
    expect(rpcCalls.filter((c) => c.method === "eth_call").length).toBeGreaterThan(2);
  });

  it("reads a proxy with the implementation's ABI, at the proxy's address", async () => {
    const detail = contractDetail(0xcb, { proxy: { kind: "eip1967", implementation: IMPL, beacon: null, checkedBlock: 21 } });
    const { rpcCalls } = await open("read", {
      detail, sources: { [A]: contractSource(0xcb, { abi: [] }), [IMPL]: contractSource(0xdd, { abi: TOKEN_ABI }) },
      rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : word("string", "Via proxy")),
    });
    expect(await screen.findByText(/Read and Write as proxy/)).toBeInTheDocument();
    expect((await screen.findAllByText("Via proxy")).length).toBeGreaterThan(0);
    for (const c of rpcCalls.filter((x) => x.method === "eth_call")) expect((c.params[0] as { to: string }).to).toBe(A);
  });

  it("says the functions are not known while the source is not verified", async () => {
    const { rpcCalls } = await open("read", { sources: { [A]: unverifiedSource(0xcb) }, detail: contractDetail(0xcb, { verified: false, matchType: null, verification: null }) });
    expect(await screen.findByText(/not verified, so its functions are not known/)).toBeInTheDocument();
    expect(rpcCalls.filter((c) => c.method === "eth_call")).toHaveLength(0);
  });

  it("shows every answer as text, never as markup", async () => {
    await open("read", { rpc: (c) => (c.method === "eth_blockNumber" ? "0x15" : word("string", "<img src=x onerror=alert(1)>")) });
    expect((await screen.findAllByText("<img src=x onerror=alert(1)>"))[0]).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("opens every function that takes input on Expand all", async () => {
    await open("read");
    expect(screen.queryByLabelText("owner (address)")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(screen.getByLabelText("owner (address)")).toBeInTheDocument());
  });
});
