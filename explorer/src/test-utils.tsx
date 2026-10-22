import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App.tsx";
import type { ApiAddress, ApiBlock, BlockDetail, UpdateDetail, ApiStatus, ApiTxSeen, ApiTxUnseen, BlockListItem, InFlight, Page, TxListItem } from "./api.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const KEYS = "0x" + "cd".repeat(32);
export const hash = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
export const update = (n: number) => "1220" + n.toString(16).padStart(2, "0").repeat(32);
export const T0 = Date.parse("2026-10-04T01:37:08Z") / 1000;

/** A status answer in which everything is well: two final blocks, the second still being followed by a block being proven. */
export function status(over: Partial<ApiStatus> = {}): ApiStatus {
  return {
    chainId: 770101, chainName: "Ostia", networkName: "DevNet", coin: { symbol: "tROME", decimals: 18 }, pins: { programVK: KEYS, rootC: KEYS, file: "session.txt" },
    ok: true, starting: false, problems: [], evm: true, canton: true,
    final: { number: 3, hash: hash(3), timestamp: T0 + 8, recordTime: "2026-10-04T01:37:23.412Z" },
    proving: { number: 4, hash: hash(4), timestamp: T0 + 16 },
    latest: [
      { number: 3, hash: hash(3), timestamp: T0 + 8, txCount: 1, updateId: update(3), recordTime: "2026-10-04T01:37:23.412Z" },
      { number: 2, hash: hash(2), timestamp: T0, txCount: 0, updateId: update(2), recordTime: "2026-10-04T01:37:08.250Z" },
    ],
    signers: { operator: "operator::1220" + "ab".repeat(32), confirmer: "confirmer::1220" + "cd".repeat(32) }, faucet: { on: false }, publicRpc: true,
    indexHead: 3, indexLag: 0, deriveCursor: 3, chainInstance: "instance-1",
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
export function tx(over: Partial<ApiTxSeen> = {}): ApiTxSeen {
  const transfer = { symbol: "TKA", decimals: 18, to: TRANSFER_TO, value: "10000000000000000000" };
  return {
    hash: hash(0xf6), status: "final", reason: null, lifecycle: null, block: { number: 3, hash: hash(3), updateId: update(3) }, from: addr(0x5b), to: addr(0xcb), value: "0", nonce: 1, type: 2, gas: 100000,
    gasUsed: 51698, gasPrice: "1670000000", fee: "86335660000000", success: true,
    input: "0xa9059cbb" + "0".repeat(24) + "5a".repeat(20) + "0".repeat(48) + "8ac7230489e80000",
    logs: [{ address: addr(0xcb), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(24) + "5b".repeat(20), "0x" + "0".repeat(24) + "5a".repeat(20)], data: "0x" + "0".repeat(48) + "8ac7230489e80000" }],
    transfer, toToken: "TKA", created: null,
    ...over,
    // The state follows the status unless a test names it.
    state: over.state ?? (over.status === "waiting" ? "pending" : over.status ?? "final"),
  };
}

/** A transaction in reth's pool: no block yet, so no result, no gas used and no fee. */
export const waitingTx = (over: Partial<ApiTxSeen> = {}) => tx({ status: "waiting", block: null, gasUsed: null, gasPrice: null, fee: null, success: null, logs: [], ...over });

export function account(over: Partial<ApiAddress> = {}): ApiAddress {
  return { address: addr(0x5b), kind: "account", balance: "9997910000000000000", nonce: 3, token: null, createdBy: null, ...over };
}
export const tokenAddress = () => account({ address: addr(0xcb), kind: "token", balance: "0", nonce: 1, token: { name: "Test token A", symbol: "TKA", decimals: 18 }, createdBy: { txHash: hash(0xf5), block: 2 } });

export type Reply = { status: number; body: unknown };
export const reply = (body: unknown, status = 200): Reply => ({ status, body });
const gone = (): Reply => reply({ error: NOT_FOUND }, 404);

/** A block as the list route gives it: the number n was made 8 seconds after n - 1, and committed 7.4 seconds after it was made. */
export function blockItem(n: number, over: Partial<BlockListItem> = {}): BlockListItem {
  const timestamp = T0 + (n - 2) * 8;
  return { number: n, hash: hash(n), timestamp, txCount: n % 3, gasUsed: 21000 * (n % 3), gasLimit: 30000000, miner: "0x" + "00".repeat(18) + "0fee", legsCount: 0, baseFee: "67300000", updateId: update(n), recordTime: new Date(timestamp * 1000 + 7400).toISOString(), proofSeconds: 6.8, finalSeconds: 7.4, commitSeconds: 0.6, ...over };
}
/** A final transaction as the list route gives it: the nth, in block n. */
export function txItem(n: number, over: Partial<TxListItem> = {}): TxListItem {
  return { hash: hash(0xa0 + n), block: n, index: 0, timestamp: T0 + (n - 2) * 8, from: addr(0x5b), to: addr(0xcb), value: "250000000000000000", nonce: n, type: 2, gasUsed: 21000, gasPrice: "1670000000", success: true, created: null, methodId: null, ...over };
}
export const page = <T,>(items: T[], next: string | null = null): Page<T> => ({ items, next });

/** What the in-flight route answers while block 4 is being proven (the producer cut it at T0 + 16, built it in 0.2 s and began its proof 0.4 s after that), with one more transaction in reth's pool. */
export function inFlight(over: Partial<InFlight> = {}): InFlight {
  const at = (s: number) => new Date((T0 + 16 + s) * 1000).toISOString();
  return {
    final: false,
    attempts: [{ number: 4, strategy: "timer", cutReason: "interval", stage: "proving", txCount: 3, poolWaiting: 1, cutAt: at(0), builtAt: at(0.2), proofStartedAt: at(0.6), proofEndedAt: null, submittedAt: null, answeredAt: null, outcome: null }],
    poolWaiting: { waiting: 1, at: at(0.5) },
    transactions: [],
    ...over,
  };
}

/** What the fake chain answers to each path of the API. The status is always well; anything not given is not found. */
export function route(h: {
  status?: () => Reply; block?: (id: string) => Reply; tx?: (hash: string) => Reply; address?: (a: string) => Reply; search?: (q: string) => Reply;
  blocks?: (path: string) => Reply; txs?: () => Reply; inFlight?: () => Reply;
  blockTxs?: (id: string, path: string) => Reply; blockLegs?: (id: string, path: string) => Reply; blockDetail?: (id: string) => Reply; faucet?: () => Reply; updates?: (path: string) => Reply; update?: (id: string) => Reply; around?: (id: string) => Reply;
}) {
  const answer = (path: string): Reply => {
    const [, , kind, arg = "", sub = ""] = path.split("?")[0]!.split("/");
    if (kind === "status") return h.status ? h.status() : reply(status());
    if (kind === "blocks" && arg && sub === "transactions") return h.blockTxs ? h.blockTxs(decodeURIComponent(arg), path) : reply(page([]));
    if (kind === "blocks" && arg && sub === "legs") return h.blockLegs ? h.blockLegs(decodeURIComponent(arg), path) : reply(page([]));
    if (kind === "blocks" && arg) return h.blockDetail ? h.blockDetail(decodeURIComponent(arg)) : gone();
    if (kind === "blocks") return h.blocks ? h.blocks(path) : reply(page([blockItem(3), blockItem(2)]));
    if (kind === "canton" && arg === "updates" && path.split("?")[0]!.split("/")[5] === "around") return h.around ? h.around(decodeURIComponent(sub)) : gone();
    if (kind === "canton" && arg === "updates") return sub ? (h.update ? h.update(decodeURIComponent(sub)) : gone()) : h.updates ? h.updates(path) : reply(page([]));
    if (kind === "faucet") return h.faucet ? h.faucet() : gone();
    if (kind === "txs") return h.txs ? h.txs() : reply(page([txItem(3), txItem(2)]));
    if (kind === "in-flight") return h.inFlight ? h.inFlight() : reply(inFlight({ attempts: [], poolWaiting: null }));
    const q = path.split("q=")[1];
    const pick = { block: h.block, tx: h.tx, address: h.address, search: h.search && (() => h.search!(decodeURIComponent(q ?? ""))) }[kind ?? ""];
    return pick ? (pick as (a: string) => Reply)(decodeURIComponent(arg)) : gone();
  };
  return Object.assign(answer, { routed: true });
}

/** The pages' own fetch calls, answered by the given function. The last call's target is kept in `calls`. */
export function fakeApi(answer: ((path: string) => { status: number; body: unknown }) & { routed?: boolean }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    calls.push(input);
    // A test that answers every path with one body (the status) still gets the plain lists, which it does not care about.
    const a = !answer.routed && /^\/api\/(blocks|txs|in-flight)\b/.test(input) ? route({})(input) : answer(input);
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

/** A transaction the explorer accepted that reth no longer holds. */
export function goneTx(over: Partial<ApiTxUnseen> = {}): ApiTxUnseen {
  return {
    hash: hash(0xf7), status: "dropped", state: "dropped", reason: "The chain refused it 5 times in a row: nonce too low.", lifecycle: null, block: null, from: addr(0x5b), to: null, value: null, nonce: 7, type: null, gas: null,
    gasUsed: null, gasPrice: null, fee: null, success: null, input: null, logs: [], transfer: null, toToken: null, created: null,
    ...over,
  };
}

/** What /api/blocks/:id adds for block 3: the producer cut it 0.1 s before its timestamp, proved it in 6.8 s, and Canton recorded it 0.362 s after it was sent. */
export function blockDetail(over: Partial<BlockDetail> = {}): BlockDetail {
  const at = (s: number) => new Date((T0 + s) * 1000).toISOString();
  return {
    number: 3, legsCount: 0, derived: true,
    lifecycle: { strategy: "timer", cutReason: "interval", cutAt: at(7.9), builtAt: at(8.1), proofStartedAt: at(8.2), proofEndedAt: at(15), submittedAt: at(15.05), answeredAt: at(15.3) },
    ...over,
  };
}

/** The Canton update that carries block n, as its own route gives it: the reader's offset 52, the synchronizer, and what the producer submitted. */
export function updateDetail(n = 3, over: Partial<UpdateDetail> = {}): UpdateDetail {
  return {
    updateId: update(n), recordTime: "2026-10-04T01:37:23.412Z", effectiveAt: null, participant: "reader::1220" + "11".repeat(32), offset: 52, synchronizer: "da::1220" + "e8".repeat(32), block: n,
    template: { packageId: "ab".repeat(32), packageName: "zk-chain", module: "Zk.Chain", entity: "BlockRecord" }, contractId: "00" + "cc".repeat(32), blockHash: hash(n), signatories: [],
    producerRecord: { template: "Zk.Chain:ZkChain", choice: "Advance", commandId: "cmd-1", argumentBytes: 13760, trafficBytes: null },
    ...over,
  };
}
