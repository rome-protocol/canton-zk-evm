import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App.tsx";
import type { ApiAddress, ApiBlock, ApiStatus, ApiTx } from "./api.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEYS = "0x" + "cd".repeat(32);
export const hash = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
export const update = (n: number) => "1220" + n.toString(16).padStart(2, "0").repeat(32);
export const T0 = Date.parse("2026-10-04T01:37:08Z") / 1000;

/** A status answer in which everything is well: two final blocks, the second still being followed by a block being proven. */
export function status(over: Partial<ApiStatus> = {}): ApiStatus {
  return {
    chainId: 770101, chainName: "Ostia", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: KEYS, rootC: KEYS, file: "session.txt" },
    ok: true, starting: false, problems: [], evm: true, canton: true,
    final: { number: 3, hash: hash(3), timestamp: T0 + 8, recordTime: "2026-10-04T01:37:23.412Z" },
    proving: { number: 4, hash: hash(4), timestamp: T0 + 16 },
    latest: [
      { number: 3, hash: hash(3), timestamp: T0 + 8, txCount: 1, updateId: update(3), recordTime: "2026-10-04T01:37:23.412Z" },
      { number: 2, hash: hash(2), timestamp: T0, txCount: 0, updateId: update(2), recordTime: "2026-10-04T01:37:08.250Z" },
    ],
    signers: { operator: "operator::1220" + "ab".repeat(32), confirmer: "confirmer::1220" + "cd".repeat(32) }, faucet: { on: false },
    ...over,
  };
}

export const addr = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(20);
export const NOT_FOUND = "Not found. Search takes a block number, a block or transaction hash, an address, or a Canton update id. A block that Canton refused is gone, and cannot be found.";

const TRANSFER_TO = addr(0x5a);
/** Block 3 as the explorer's API answers it: final, with a record on Canton and one transaction, which moves 10 of a token. */
export function block(over: Partial<ApiBlock> = {}): ApiBlock {
  return {
    status: "final", number: 3, hash: hash(3), parentHash: hash(2), timestamp: T0 + 8, txCount: 1, gasUsed: 51698, gasLimit: 30000000, baseFee: "670000000",
    miner: "0x" + "00".repeat(18) + "0fee", stateRoot: hash(0x10), genesisReferenced: null,
    canton: {
      updateId: update(3), recordTime: "2026-10-04T01:37:23.412Z", template: "Zk.Chain:BlockRecord", proofBytes: 1344,
      proof: { programVK: { value: KEYS, ok: true }, rootC: { value: KEYS, ok: true }, blockHash: { value: hash(3), ok: true } },
      hashesMatch: true, headerHex: "22".repeat(612), txsHex: "33".repeat(181), proofHex: "11".repeat(1344),
    },
    transactions: [{ hash: hash(0xf6), from: addr(0x5a + 1), to: addr(0xcb), success: true, transfer: { symbol: "TKA", decimals: 18, to: TRANSFER_TO, value: "10000000000000000000" } }],
    ...over,
  };
}

/** The same transaction, final in block 3. */
export function tx(over: Partial<ApiTx> = {}): ApiTx {
  const transfer = { symbol: "TKA", decimals: 18, to: TRANSFER_TO, value: "10000000000000000000" };
  return {
    hash: hash(0xf6), status: "final", block: { number: 3, hash: hash(3), updateId: update(3) }, from: addr(0x5b), to: addr(0xcb), value: "0", nonce: 1, type: 2, gas: 100000,
    gasUsed: 51698, gasPrice: "1670000000", fee: "86335660000000", success: true,
    input: "0xa9059cbb" + "0".repeat(24) + "5a".repeat(20) + "0".repeat(48) + "8ac7230489e80000",
    logs: [{ address: addr(0xcb), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(24) + "5b".repeat(20), "0x" + "0".repeat(24) + "5a".repeat(20)], data: "0x" + "0".repeat(48) + "8ac7230489e80000" }],
    transfer, toToken: "TKA", created: null,
    ...over,
  };
}

/** A transaction in reth's pool: no block yet, so no result, no gas used and no fee. */
export const waitingTx = (over: Partial<ApiTx> = {}) => tx({ status: "waiting", block: null, gasUsed: null, gasPrice: null, fee: null, success: null, logs: [], ...over });

export function account(over: Partial<ApiAddress> = {}): ApiAddress {
  return { address: addr(0x5b), kind: "account", balance: "9997910000000000000", nonce: 3, token: null, createdBy: null, ...over };
}
export const tokenAddress = () => account({ address: addr(0xcb), kind: "token", balance: "0", nonce: 1, token: { name: "Test token A", symbol: "TKA", decimals: 18 }, createdBy: { txHash: hash(0xf5), block: 2 } });

export type Reply = { status: number; body: unknown };
export const reply = (body: unknown, status = 200): Reply => ({ status, body });
const gone = (): Reply => reply({ error: NOT_FOUND }, 404);

/** What the fake chain answers to each path of the API. The status is always well; anything not given is not found. */
export function route(h: { status?: () => Reply; block?: (id: string) => Reply; tx?: (hash: string) => Reply; address?: (a: string) => Reply; search?: (q: string) => Reply }) {
  return (path: string): Reply => {
    const [, , kind, arg = ""] = path.split("?")[0]!.split("/");
    if (kind === "status") return h.status ? h.status() : reply(status());
    const q = path.split("q=")[1];
    const pick = { block: h.block, tx: h.tx, address: h.address, search: h.search && (() => h.search!(decodeURIComponent(q ?? ""))) }[kind ?? ""];
    return pick ? (pick as (a: string) => Reply)(decodeURIComponent(arg)) : gone();
  };
}

/** The pages' own fetch calls, answered by the given function. The last call's target is kept in `calls`. */
export function fakeApi(answer: (path: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    calls.push(input);
    const a = answer(input);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

/** Renders the whole app at a route. The status is polled every few seconds, so a test of the pages gives it a polling query client with no retries. */
export function renderApp(route = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}

/** Lets time pass for the pages that look again by themselves (the tests fake only the interval timers), then lets the answers they asked for arrive. */
export async function tick(ms = 2000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}
