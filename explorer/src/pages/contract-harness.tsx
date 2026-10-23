import { screen } from "@testing-library/react";
import { vi } from "vitest";
import type { ContractDetail, ContractSource } from "../api.ts";
import { addr, addressDetail, contractDetail, contractSource, fakeApi, page, renderApp, reply, route, unverifiedSource } from "../test-utils.tsx";

const A = addr(0xcb);
const derived = <T,>(items: T[]) => reply({ ...page(items), derived: true });
export const TOKEN_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];
interface Rpc { method: string; params: unknown[] }
/** The explorer's REST API and its /rpc, both faked; `rpcCalls` is every JSON-RPC call the page made, in order. */
export async function open(tab: string, seen: { detail?: ContractDetail; sources?: Record<string, ContractSource>; rpc?: (c: Rpc) => unknown; events?: (path: string) => unknown; token?: { name: string; symbol: string; decimals: number } } = {}) {
  const d = seen.detail ?? contractDetail();
  const sources = seen.sources ?? { [A]: contractSource(0xcb, { abi: TOKEN_ABI }) };
  const rpcCalls: Rpc[] = [];
  const calls = fakeApi(route({
    contracts: (a, sub, path) => (sub === "source" ? reply(sources[a] ?? unverifiedSource()) : sub === "events" ? reply((seen.events ?? (() => page([])))(path)) : a === A ? reply(d) : reply({ error: "none" }, 404)),
    addresses: (_a, sub) => (sub === "" ? reply(addressDetail({ address: A, kind: seen.token ? "token" : "contract", token: seen.token ?? null })) : derived([])),
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
